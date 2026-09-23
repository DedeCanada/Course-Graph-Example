/**
 * The slice has to hold two promises: it stops at the edge of Computer
 * Science, and every course you can pick actually draws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  indexGraph, subgraphFor, layout, bounds, matches, boxFor, labelFor, truncate, clean,
  seedPositions,
} from '../graph-core.js';
import { Simulation, explode, EXPLODE } from '../physics.js';

const data = JSON.parse(
  readFileSync(fileURLToPath(new URL('../graph.json', import.meta.url)), 'utf8'),
);
const index = indexGraph(data);

test('every edge joins two nodes that exist', () => {
  const ids = new Set([...data.courses.map(c => c.id), ...data.logicNodes.map(n => n.id)]);
  const dangling = data.edges.filter(e => !ids.has(e.s) || !ids.has(e.t));
  assert.deepEqual(dangling, []);
});

test('the slice stops at the edge of Computer Science', () => {
  const withPrereqs = data.courses
    .filter(c => c.boundary)
    .filter(c => (index.incoming.get(c.id) || []).length > 0)
    .map(c => c.id);
  assert.deepEqual(withPrereqs, [], 'a boundary course must carry no prerequisites');
});

test('every course outside the subject is marked as a boundary', () => {
  const unmarked = data.courses.filter(c => c.s !== data.subject && !c.boundary).map(c => c.id);
  assert.deepEqual(unmarked, []);
});

test('a boundary course still explains itself', () => {
  const boundary = data.courses.filter(c => c.boundary);
  assert.ok(boundary.length > 0);
  for (const c of boundary) {
    assert.equal(typeof c.t, 'string');
    assert.ok(c.t.length > 0, `${c.id} has no title`);
  }
});

test('nothing identifying rides along in the data', () => {
  const raw = readFileSync(fileURLToPath(new URL('../graph.json', import.meta.url)), 'utf8');
  for (const pattern of [/@[\w.-]+\.(com|ca|org|net)/i, /sk-[A-Za-z0-9]{16}/, /api[_-]?key/i, /\bBearer\b/]) {
    assert.equal(pattern.test(raw), false, `graph.json matches ${pattern}`);
  }
});

test('only the chosen subject is selectable', () => {
  assert.ok(index.pickable.length > 0);
  for (const c of index.pickable) {
    assert.equal(c.s, data.subject);
    assert.equal(c.boundary, false);
  }
});

test('every selectable course lays out to a finite, non-overlapping picture', () => {
  for (const hops of [1, 2, 99]) {
  for (const c of index.pickable) {
    const sub = subgraphFor(index, c.id, hops);
    assert.ok(sub.nodes.has(c.id));

    const laid = layout(index, sub);
    assert.equal(laid.pos.size, sub.nodes.size, `${c.id}: a node went unplaced`);
    for (const [id, p] of laid.pos) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${c.id}: ${id} has no position`);
    }
    assert.equal(laid.depth.get(c.id), 0, `${c.id} should sit at the top`);

    const b = bounds(laid);
    assert.ok(b && b.maxX >= b.minX && b.maxY >= b.minY);

    // Within one layer, boxes must not overlap.
    for (const layer of laid.layers) {
      const sorted = [...layer].sort((x, y) => laid.pos.get(x).x - laid.pos.get(y).x);
      for (let i = 1; i < sorted.length; i++) {
        const left = laid.pos.get(sorted[i - 1]).x + laid.box.get(sorted[i - 1]).w / 2;
        const right = laid.pos.get(sorted[i]).x - laid.box.get(sorted[i]).w / 2;
        assert.ok(right >= left - 0.01, `${c.id}: ${sorted[i - 1]} and ${sorted[i]} overlap`);
      }
    }
  }
  }
});

test('a prerequisite always sits below the course that needs it', () => {
  for (const c of index.pickable) {
    const sub = subgraphFor(index, c.id, 99);
    const laid = layout(index, sub);
    for (const e of sub.edges) {
      assert.ok(
        laid.depth.get(e.s) > laid.depth.get(e.t),
        `${c.id}: ${e.s} should sit below ${e.t}`,
      );
    }
  }
});

test('search finds a course by code and by title', () => {
  assert.ok(matches(index.pickable, 'cpsc 320').some(c => c.id === 'CPSC 320'));
  assert.ok(matches(index.pickable, 'bioinformatics').some(c => c.id === 'CPSC 445'));
  assert.deepEqual(matches(index.pickable, 'zzzzz'), []);
  assert.ok(matches(index.pickable, '').length > 0);
});

test('labels are readable rather than raw', () => {
  assert.equal(clean('"permission of the department"'), 'permission of the department');
  assert.equal(clean('a  b\tc'), 'a b c');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(labelFor({ kind: 'AND' }), 'all of');
  assert.equal(labelFor({ kind: 'OF', lb: '2 of' }), '2 of');
  assert.equal(labelFor({ kind: 'COURSE', id: 'CPSC 110' }), 'CPSC 110');
});

test('a long prose condition still gets a box with room for its text', () => {
  const long = { kind: 'NC', lb: 'permission of the department and third-year standing' };
  const box = boxFor(long);
  assert.ok(box.w >= 74 && box.h === 40);
});

test('the poster example reads the way the poster says it does', () => {
  const sub = subgraphFor(index, 'CPSC 445', 1);
  const kinds = [...sub.nodes].map(id => index.byId.get(id).kind).sort();
  assert.deepEqual(kinds, ['AND', 'COURSE', 'COURSE', 'COURSE', 'NC', 'OF']);
  assert.ok([...sub.nodes].includes('BMEG 250'));
  assert.equal(index.byId.get('BMEG 250').boundary, true);
  assert.equal(index.byId.get('CPSC 320').boundary, false);
});

test('one hop draws a requirement in full and stops at the next course', () => {
  for (const c of index.pickable) {
    const sub = subgraphFor(index, c.id, 1);
    for (const id of sub.nodes) {
      if (id === c.id) continue;
      if (index.byId.get(id).kind !== 'COURSE') continue;
      // Only edges actually drawn count. preprocess.py shares an identical
      // logic subtree between courses, so a node can sit in this subgraph for
      // the root's own sake while also being another course's prerequisite.
      const drawn = sub.edges.filter(e => e.t === id);
      assert.deepEqual(drawn, [], `${c.id}: ${id} was expanded at one hop`);
    }
  }
});

test('a shared logic node never drags in an edge that was not asked for', () => {
  // CPSC 330 lists a choice that is also CPSC 210's prerequisite.
  const sub = subgraphFor(index, 'CPSC 330', 1);
  assert.ok(sub.nodes.has('CPSC 210'));
  assert.deepEqual(sub.edges.filter(e => e.t === 'CPSC 210'), []);
  assert.ok(sub.collapsed.has('CPSC 210'), 'CPSC 210 should still show it has more behind it');
});

test('a course is flagged as having more only when it really does', () => {
  for (const c of index.pickable) {
    const sub = subgraphFor(index, c.id, 1);
    for (const id of sub.collapsed) {
      assert.ok((index.incoming.get(id) || []).length > 0, `${id} flagged but has nothing behind it`);
      assert.equal(index.byId.get(id).boundary, false, `${id} is outside the subject`);
    }
    // going all the way down leaves nothing to expand
    const full = subgraphFor(index, c.id, 99);
    assert.equal(full.collapsed.size, 0, `${c.id}: still collapsed at full depth`);
  }
});

test('more depth never shows less', () => {
  for (const c of index.pickable) {
    const one = subgraphFor(index, c.id, 1);
    const all = subgraphFor(index, c.id, 99);
    for (const id of one.nodes) {
      assert.ok(all.nodes.has(id), `${c.id}: ${id} vanished at full depth`);
    }
    assert.ok(all.nodes.size >= one.nodes.size);
  }
});

/* ── the simulation ────────────────────────────────────────────────── */

test('seed positions cover every node and sit around the origin', () => {
  for (const c of index.pickable.slice(0, 40)) {
    const sub = subgraphFor(index, c.id, 99);
    const seed = seedPositions(index, sub);
    assert.equal(seed.size, sub.nodes.size, `${c.id}: a node was not seeded`);
    let cx = 0, cy = 0;
    for (const p of seed.values()) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${c.id}: bad seed`);
      cx += p.x; cy += p.y;
    }
    assert.ok(Math.abs(cx / seed.size) < 400 && Math.abs(cy / seed.size) < 400);
  }
});

test('the simulation settles and never produces a broken coordinate', () => {
  for (const c of index.pickable) {
    const sub = subgraphFor(index, c.id, 99);
    if (sub.nodes.size < 2) continue;
    const seed = seedPositions(index, sub);
    const nodes = [...sub.nodes].map(id => {
      const n = index.byId.get(id);
      return {
        id, kind: n.kind,
        subject: n.kind === 'COURSE' ? n.s : `__${n.kind}`,
        ...seed.get(id), vx: 0, vy: 0, r: 20,
      };
    });
    const sim = new Simulation(nodes, sub.edges).run();
    assert.ok(sim.settled, `${c.id}: never settled in ${sim.ticks} ticks`);
    for (const n of sim.nodes) {
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${c.id}: ${n.id} flew off`);
      assert.ok(Math.abs(n.x) < 1e5 && Math.abs(n.y) < 1e5, `${c.id}: ${n.id} diverged`);
    }
  }
});

test('a settled layout does not pile courses on top of each other', () => {
  const sub = subgraphFor(index, 'CPSC 340', 99);
  const seed = seedPositions(index, sub);
  const nodes = [...sub.nodes].map(id => {
    const n = index.byId.get(id);
    return {
      id, kind: n.kind,
      subject: n.kind === 'COURSE' ? n.s : `__${n.kind}`,
      ...seed.get(id), vx: 0, vy: 0, r: 20,
    };
  });
  const sim = new Simulation(nodes, sub.edges).run();
  const courses = sim.nodes.filter(n => n.kind === 'COURSE');
  let tooClose = 0;
  for (let i = 0; i < courses.length; i++) {
    for (let j = i + 1; j < courses.length; j++) {
      if (Math.hypot(courses[i].x - courses[j].x, courses[i].y - courses[j].y) < 30) tooClose++;
    }
  }
  assert.equal(tooClose, 0, `${tooClose} course pairs overlap after settling`);
});

test('a pinned node stays exactly where it was put', () => {
  const sub = subgraphFor(index, 'CPSC 445', 99);
  const seed = seedPositions(index, sub);
  const nodes = [...sub.nodes].map(id => {
    const n = index.byId.get(id);
    return {
      id, kind: n.kind,
      subject: n.kind === 'COURSE' ? n.s : `__${n.kind}`,
      ...seed.get(id), vx: 0, vy: 0, r: 20,
    };
  });
  const pinned = nodes[0];
  pinned.pinned = true;
  pinned.x = 123; pinned.y = -456;
  new Simulation(nodes, sub.edges).run(200);
  assert.equal(pinned.x, 123);
  assert.equal(pinned.y, -456);
});

test('a settled layout leaves room for every course label', () => {
  // A course label is about 70px wide at the size it is drawn. Two courses
  // closer than that print their codes on top of each other.
  const LABEL = 72;
  let overlapping = 0;
  for (const c of index.pickable) {
    const sub = subgraphFor(index, c.id, 99);
    if (sub.nodes.size < 3) continue;
    const seed = seedPositions(index, sub);
    const nodes = [...sub.nodes].map(id => {
      const n = index.byId.get(id);
      const box = boxFor(n);
      return {
        id, kind: n.kind,
        subject: n.kind === 'COURSE' ? n.s : `__${n.kind}`,
        ...seed.get(id), vx: 0, vy: 0,
        r: n.kind === 'COURSE' ? 23 : box.w / 2,
      };
    });
    explode(nodes);
    const courses = new Simulation(nodes, sub.edges).run().nodes.filter(n => n.kind === 'COURSE');
    for (let i = 0; i < courses.length; i++) {
      for (let j = i + 1; j < courses.length; j++) {
        if (Math.hypot(courses[i].x - courses[j].x, courses[i].y - courses[j].y) < LABEL) overlapping++;
      }
    }
  }
  assert.equal(overlapping, 0, `${overlapping} course pairs sit closer than a label is wide`);
});

/* ── spawn, explode, settle ─────────────────────────────────────────── */

function bodies(id) {
  const sub = subgraphFor(index, id, 99);
  const seed = seedPositions(index, sub);
  const nodes = [...sub.nodes].map(nid => {
    const n = index.byId.get(nid);
    const box = boxFor(n);
    return {
      id: nid, kind: n.kind,
      subject: n.kind === 'COURSE' ? n.s : `__${n.kind}`,
      ...seed.get(nid), vx: 0, vy: 0,
      r: n.kind === 'COURSE' ? 23 : box.w / 2,
      hw: n.kind === 'COURSE' ? 23 : box.w / 2,
      hh: n.kind === 'COURSE' ? 23 : box.h / 2,
    };
  });
  return { nodes, edges: sub.edges };
}

function crossings(nodes, edges) {
  const by = new Map(nodes.map(n => [n.id, n]));
  const segs = edges.map(e => [by.get(e.s), by.get(e.t)]).filter(s => s[0] && s[1]);
  const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
  let count = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = segs[i];
      const [p, q] = segs[j];
      if (a === p || a === q || b === p || b === q) continue;
      if (ccw(a, p, q) !== ccw(b, p, q) && ccw(a, b, p) !== ccw(a, b, q)) count++;
    }
  }
  return count;
}

test('exploding scales about the centroid and drops any motion', () => {
  const nodes = [
    { x: 0, y: 0, vx: 9, vy: 9 },
    { x: 10, y: 0, vx: -3, vy: 1 },
    { x: 0, y: 10, vx: 0, vy: 4 },
    { x: 10, y: 10, vx: 1, vy: 1 },
  ];
  explode(nodes, 2);
  // centroid was (5, 5) and must not move
  const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
  const cy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
  assert.ok(Math.abs(cx - 5) < 1e-9 && Math.abs(cy - 5) < 1e-9);
  assert.deepEqual(nodes[0], { x: -5, y: -5, vx: 0, vy: 0 });
  assert.equal(explode([]).length, 0, 'an empty graph must not divide by zero');
});

test('exploding before settling untangles the graph', () => {
  let asSeeded = 0;
  let exploded = 0;
  for (const c of index.pickable) {
    const plain = bodies(c.id);
    if (plain.nodes.length < 3) continue;
    asSeeded += crossings(new Simulation(plain.nodes, plain.edges).run().nodes, plain.edges);

    const thrown = bodies(c.id);
    explode(thrown.nodes);
    exploded += crossings(new Simulation(thrown.nodes, thrown.edges).run().nodes, thrown.edges);
  }
  assert.ok(
    exploded < asSeeded * 0.8,
    `exploding should cut crossings well below ${asSeeded}, got ${exploded}`,
  );
});

test('every graph settles within the tick cap after being exploded', () => {
  for (const c of index.pickable) {
    const { nodes, edges } = bodies(c.id);
    if (nodes.length < 2) continue;
    explode(nodes);
    const sim = new Simulation(nodes, edges).run();
    assert.ok(sim.settled, `${c.id}: did not settle`);
    assert.ok(
      sim.ticks < sim.params.maxTicks,
      `${c.id}: needed the whole tick cap (${sim.ticks}), so it never truly settled`,
    );
  }
});

test('the explode factor stays in the range that actually helps', () => {
  assert.ok(EXPLODE > 1.5 && EXPLODE <= 2.5, `EXPLODE is ${EXPLODE}`);
});

test('no two shapes end up on top of each other', () => {
  // Logic nodes feel the same repulsion as courses, so a diamond should never
  // settle under a prose box. This is the guarantee that exemption cost.
  let overlapping = 0;
  for (const c of index.pickable) {
    const { nodes, edges } = bodies(c.id);
    if (nodes.length < 3) continue;
    explode(nodes);                       // as the page does
    const settled = new Simulation(nodes, edges).run().nodes;
    for (let i = 0; i < settled.length; i++) {
      for (let j = i + 1; j < settled.length; j++) {
        const a = settled[i];
        const b = settled[j];
        if (Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh) overlapping++;
      }
    }
  }
  assert.equal(overlapping, 0, `${overlapping} pairs of shapes overlap after settling`);
});

test('logic nodes are pulled in like anything else', () => {
  // Carried by springs alone they used to drift; gravity should keep them in
  // the same neighbourhood as the courses they join.
  const { nodes, edges } = bodies('CPSC 423');
  explode(nodes);
  const settled = new Simulation(nodes, edges).run().nodes;
  const spread = kind => {
    const picked = settled.filter(n => (kind === 'COURSE' ? n.kind === 'COURSE' : n.kind !== 'COURSE'));
    const d = picked.map(n => Math.hypot(n.x, n.y));
    return Math.max(...d);
  };
  assert.ok(
    spread('LOGIC') < spread('COURSE') * 1.5,
    'logic nodes should not sit far outside the courses',
  );
});

test('an NC node carries the same physics as everything else', () => {
  // NC is prose rather than a course, and the widest thing on the map. It has
  // to repel, feel gravity, and end up clear of its neighbours like any node.
  const wide = { kind: 'NC', lb: 'a long standing requirement stated in prose' };
  const box = boxFor(wide);
  assert.ok(box.w > 74, 'a prose box is sized to its text');

  const a = { id: 'a', kind: 'NC', subject: '__NC', x: -4, y: 0, vx: 0, vy: 0, r: box.w / 2 };
  const b = { id: 'b', kind: 'NC', subject: '__NC', x: 4, y: 0, vx: 0, vy: 0, r: box.w / 2 };
  new Simulation([a, b], []).run();
  assert.ok(
    Math.abs(b.x - a.x) >= box.w,
    'two prose boxes settle at least their own width apart',
  );

  const lone = { id: 'c', kind: 'NC', subject: '__NC', x: 900, y: 900, vx: 0, vy: 0, r: box.w / 2 };
  new Simulation([lone], []).run();
  assert.ok(Math.hypot(lone.x, lone.y) < Math.hypot(900, 900), 'gravity reaches it');
});

test('a real NC node ends up clear of its neighbours on the map', () => {
  // CPSC 320's requirement is mostly one very long NC condition.
  const { nodes, edges } = bodies('CPSC 320');
  explode(nodes);
  const settled = new Simulation(nodes, edges).run().nodes;
  const ncNodes = settled.filter(n => n.kind === 'NC');
  assert.ok(ncNodes.length > 0, 'this course should have an NC node');
  for (const nc of ncNodes) {
    for (const other of settled) {
      if (other === nc) continue;
      assert.ok(
        Math.abs(nc.x - other.x) >= nc.hw + other.hw
          || Math.abs(nc.y - other.y) >= nc.hh + other.hh,
        `${nc.id} overlaps ${other.id}`,
      );
    }
  }
});
