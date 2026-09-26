/**
 * graph-core.js — everything about the graph that does not touch the DOM.
 *
 * Kept separate from app.js so the walk and the layout can be tested without a
 * browser. Nothing here reads or writes the page.
 */

export const COURSE_R = 23;
export const LAYER_H = 118;
export const X_GAP = 26;

export const STYLE = {
  AND:     { shape: 'hexagon', r: 19, fill: '#6d3fc4', stroke: '#4c2a8f' },
  OF:      { shape: 'diamond', r: 21, fill: '#f2c23e', stroke: '#c99e22' },
  NC:      { shape: 'rect',    r: 15, fill: '#ffffff', stroke: '#6b7280', ink: '#3f4756' },
  YEAR:    { shape: 'rect',    r: 15, fill: '#7c3aed', stroke: '#6d28d9' },
  PROGRAM: { shape: 'rect',    r: 15, fill: '#db2777', stroke: '#be185d' },
  FACULTY: { shape: 'rect',    r: 15, fill: '#0891b2', stroke: '#0e7490' },
};

export const EDGE_COLOR = { AND: '#6d3fc4', OF: '#c99e22', NC: '#9ca3af', CO: '#e94560' };
export const EDGE_FALLBACK = '#5b6c85';

export function clean(text) {
  return String(text).replace(/^"+|"+$/g, '').replace(/\s+/g, ' ').trim();
}

export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Rough text width; good enough to keep boxes from colliding. */
export function textWidth(text, size) {
  return text.length * size * 0.58;
}

export function labelFor(node) {
  if (node.kind === 'COURSE') return node.id;
  if (node.kind === 'OF') return node.lb || 'choice';
  if (node.kind === 'AND') return 'all of';
  return clean(node.lb || node.kind);
}

export function boxFor(node) {
  if (node.kind === 'COURSE') {
    return {
      w: Math.max(COURSE_R * 2, textWidth(node.id, 13) + 16),
      h: COURSE_R * 2 + 22,
      r: COURSE_R,
    };
  }
  const st = STYLE[node.kind] || STYLE.NC;
  if (st.shape === 'rect') {
    return { w: Math.max(74, textWidth(truncate(labelFor(node), 26), 12) + 22), h: 40, r: st.r };
  }
  return { w: st.r * 2 + 8, h: st.r * 2 + 8, r: st.r };
}

/** Build the lookups the viewer works from. Ignores edges with a missing end. */
export function indexGraph(data) {
  const byId = new Map();
  const incoming = new Map();
  const outgoing = new Map();

  for (const c of data.courses) byId.set(c.id, { ...c, kind: 'COURSE' });
  for (const n of data.logicNodes) byId.set(n.id, { ...n, kind: n.tp });

  for (const e of data.edges) {
    if (!byId.has(e.s) || !byId.has(e.t)) continue;
    if (!incoming.has(e.t)) incoming.set(e.t, []);
    if (!outgoing.has(e.s)) outgoing.set(e.s, []);
    incoming.get(e.t).push(e);
    outgoing.get(e.s).push(e);
  }

  // Discontinued courses stay in the graph, because other courses still name
  // them as prerequisites and the requirement above them would make no sense
  // without them. They are kept out of the search list: they have no title, no
  // description and no calendar entry, so choosing one deliberately gets you a
  // blank node and nothing to read.
  const pickable = data.courses
    .filter(c => c.s === data.subject && !c.boundary && !c.phantom)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  return { data, byId, incoming, outgoing, pickable };
}

/**
 * Walk backwards from `id`, collecting what it requires.
 *
 * `hops` counts course-to-course steps, not edges: logic nodes are part of the
 * sentence that names a course, so they never cost a hop and always expand.
 * At the default of 1 you get one course's requirement in full and stop — which
 * on a phone is the difference between six nodes and sixty. Pass Infinity for
 * the whole chain. `collapsed` names the courses that were cut short, so the
 * view can say there is more behind them.
 *
 * Boundary courses carry no incoming edges in the data, so they end the walk
 * on their own whatever `hops` says.
 */
export function subgraphFor(index, id, hops = 1) {
  const nodes = new Set([id]);
  const edges = [];
  const seen = new Set();
  const depth = new Map([[id, 0]]);
  const collapsed = new Set();
  const queue = [id];

  while (queue.length) {
    const cur = queue.shift();
    const curHops = depth.get(cur);
    const node = index.byId.get(cur);
    const prereqs = index.incoming.get(cur) || [];

    // A course that sits at the hop limit is drawn but not opened. Its own
    // requirement — logic nodes included — belongs to the next hop.
    if (node.kind === 'COURSE' && curHops >= hops) {
      if (prereqs.length) collapsed.add(cur);
      continue;
    }

    for (const e of prereqs) {
      const src = index.byId.get(e.s);
      if (!src) continue;
      const nextHops = curHops + (src.kind === 'COURSE' ? 1 : 0);

      const key = `${e.s}>${e.t}:${e.r || ''}`;
      if (!seen.has(key)) { seen.add(key); edges.push(e); }

      if (!nodes.has(e.s)) {
        nodes.add(e.s);
        depth.set(e.s, nextHops);
        queue.push(e.s);
      } else if (nextHops < depth.get(e.s)) {
        depth.set(e.s, nextHops);
        queue.push(e.s);
      }
    }
  }

  collapsed.delete(id);
  return { nodes, edges, collapsed };
}

/** Layered layout: the chosen course at depth 0, its prerequisites below it. */
export function layout(index, sub) {
  const ids = [...sub.nodes];
  const depth = new Map();

  const depthOf = (id, guard = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (guard.has(id)) return 0;              // a cycle cannot deepen the layout
    guard.add(id);
    let d = 0;
    for (const e of index.outgoing.get(id) || []) {
      if (sub.nodes.has(e.t)) d = Math.max(d, depthOf(e.t, guard) + 1);
    }
    guard.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);

  const layers = [];
  for (const id of ids) (layers[depth.get(id)] ||= []).push(id);
  for (let i = 0; i < layers.length; i++) layers[i] ||= [];

  const box = new Map(ids.map(id => [id, boxFor(index.byId.get(id))]));
  const pos = new Map();

  const pack = layer => {
    const total = layer.reduce((s, id) => s + box.get(id).w, 0) + X_GAP * (layer.length - 1);
    let x = -total / 2;
    for (const id of layer) {
      const w = box.get(id).w;
      pos.set(id, { x: x + w / 2, y: depth.get(id) * LAYER_H });
      x += w + X_GAP;
    }
  };
  layers.forEach(pack);

  // Pull each node toward whatever it points at, to keep the edges untangled.
  for (let pass = 0; pass < 4; pass++) {
    for (let d = 1; d < layers.length; d++) {
      const score = new Map();
      for (const id of layers[d]) {
        const xs = (index.outgoing.get(id) || [])
          .filter(e => sub.nodes.has(e.t) && depth.get(e.t) === d - 1)
          .map(e => pos.get(e.t).x);
        score.set(id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : pos.get(id).x);
      }
      layers[d].sort((a, b) => score.get(a) - score.get(b));
      pack(layers[d]);
    }
  }

  return { pos, box, depth, layers };
}

/**
 * Starting positions for the simulation.
 *
 * A force layout dropped on random points spends its first seconds untangling
 * itself. Seeding from the layered layout — course at the top, prerequisites
 * below — means it starts in roughly the right shape and only has to relax,
 * which settles faster and lands somewhere readable. Coordinates are centred
 * on the origin, because gravity in physics.js pulls toward (0, 0).
 */
export function seedPositions(index, sub, random = Math.random) {
  const laid = layout(index, sub);
  const box = bounds(laid);
  const cx = box ? (box.minX + box.maxX) / 2 : 0;
  const cy = box ? (box.minY + box.maxY) / 2 : 0;

  const out = new Map();
  for (const [id, p] of laid.pos) {
    // A touch of jitter keeps nodes stacked at the same seed point from
    // starting exactly on top of each other, where repulsion has no direction.
    out.set(id, {
      x: p.x - cx + (random() - 0.5) * 2,
      y: p.y - cy + (random() - 0.5) * 2,
    });
  }
  return out;
}

/** Bounding box of a laid-out subgraph, in graph coordinates. */
export function bounds({ pos, box }) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [id, p] of pos) {
    const b = box.get(id);
    minX = Math.min(minX, p.x - b.w / 2);
    maxX = Math.max(maxX, p.x + b.w / 2);
    minY = Math.min(minY, p.y - b.h / 2);
    maxY = Math.max(maxY, p.y + b.h / 2);
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

/** Courses matching a query, best kept short for a phone-sized list. */
export function matches(pickable, query, limit = 40) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return pickable.slice(0, limit);
  const terms = q.split(/\s+/);
  return pickable
    .filter(c => {
      const hay = `${c.id} ${c.t}`.toLowerCase();
      return terms.every(t => hay.includes(t));
    })
    .slice(0, limit);
}
