/**
 * app.js — the page around the map.
 *
 * The whole window is the graph. You pick one Computer Science course and it
 * draws the entire prerequisite tree behind it, laid out by the same kind of
 * force simulation the main planner runs. Prerequisites from other subjects
 * are drawn faded: described, but not followed further.
 *
 * Graph reasoning lives in graph-core.js and the simulation in physics.js;
 * this file is the shell, the drawing, and the input.
 */

import {
  COURSE_R, STYLE, EDGE_COLOR, EDGE_FALLBACK,
  indexGraph, subgraphFor, seedPositions, matches,
  labelFor, truncate, clean, boxFor,
} from './graph-core.js';
import { Simulation, explode } from './physics.js';

const SVG = 'http://www.w3.org/2000/svg';
const PAD = 48;
const MIN_SCALE = 0.12;
/** Clearance between an arrow tip and the shape it points at. */
const ARROW_GAP = 4;
/** The course you asked for, drawn to dominate the map. */
const ROOT_R = 42;
/** How much bigger a node gets while it is selected. */
const SELECTED_GROWTH = 6;
/** Out-of-subject courses recede so the prose conditions read first. */
const BOUNDARY_FILL = '#dde1e7';
const BOUNDARY_INK = '#93a0b4';
/**
 * The ring around the course you asked for. Green rather than black: the map
 * has a dark mode, and black on a near-black background reads as a bite taken
 * out of the node instead of a ring around it. This carries on both.
 */
const ROOT_RING = '#22c55e';
const MAX_SCALE = 3;

const el = {
  stage: document.getElementById('stage'),
  svg: document.getElementById('graph'),
  empty: document.getElementById('empty'),
  search: document.getElementById('search'),
  clear: document.getElementById('clear'),
  results: document.getElementById('results'),
  menuBtn: document.getElementById('menu-btn'),
  menu: document.getElementById('menu'),
  about: document.getElementById('about'),
  sheet: document.getElementById('sheet'),
  sheetBody: document.getElementById('sheet-body'),
  sheetClose: document.getElementById('sheet-close'),
  fit: document.getElementById('fit'),
  shake: document.getElementById('shake'),
  statCourses: document.getElementById('stat-courses'),
};

let index = null;
let root = null;
let sim = null;
let frame = null;
let drawn = { nodes: new Map(), edges: [] };
let view = { k: 1, tx: 0, ty: 0 };
let viewport = null;
let settleTimer = null;
let revealTimer = null;

/* ── drawing helpers ───────────────────────────────────────────────── */

function make(tag, attrs, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function polygonPoints(r, sides, rotation) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * 2 * Math.PI) / sides;
    pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function courseFill(course) {
  if (course.boundary) return BOUNDARY_FILL;
  return course.c || index.data.subjectColors[course.s] || '#4b8bf5';
}

/** The drawn radius of a course: the chosen one is larger than the rest. */
function courseRadius(id) {
  return id === root ? ROOT_R : COURSE_R;
}

function radiusOf(n, id) {
  if (n.kind === 'COURSE') return courseRadius(id);
  const st = STYLE[n.kind] || STYLE.NC;
  // A prose box is far wider than it is tall; use half its width so the fit
  // and the halo account for the whole shape.
  return st.shape === 'rect' ? boxFor(n).w / 2 : st.r;
}

/** Half-extents and shape, for stopping an edge at the outline. */
function halfExtents(n, id) {
  if (n.kind === 'COURSE') {
    const r = courseRadius(id);
    return { shape: 'circle', hw: r, hh: r };
  }
  const st = STYLE[n.kind] || STYLE.NC;
  if (st.shape === 'rect') {
    const b = boxFor(n);
    return { shape: 'rect', hw: b.w / 2, hh: b.h / 2 };
  }
  return { shape: st.shape, hw: st.r, hh: st.r };
}

/** Distance from a node's centre to its outline along (ux, uy). */
function boundary(node, ux, uy) {
  if (node.shape !== 'rect') return node.r;
  const tx = Math.abs(ux) < 1e-6 ? Infinity : node.hw / Math.abs(ux);
  const ty = Math.abs(uy) < 1e-6 ? Infinity : node.hh / Math.abs(uy);
  return Math.min(tx, ty);
}

/* ── render ────────────────────────────────────────────────────────── */

function render(rootId) {
  clearTimeout(settleTimer);
  if (frame) { cancelAnimationFrame(frame); frame = null; }
  clearTimeout(revealTimer);
  root = rootId;
  const course = index.byId.get(rootId);

  const sub = subgraphFor(index, rootId, Infinity);
  el.empty.hidden = sub.nodes.size > 1;
  if (sub.nodes.size === 1) {
    el.empty.textContent = `${course.id} has no prerequisites stated in the Calendar.`;
  }

  // A layered seed gives the simulation something sensible to relax from, so
  // it settles into a readable shape instead of untangling from noise.
  const seeded = seedPositions(index, sub);
  const nodes = [...sub.nodes].map(id => {
    const n = index.byId.get(id);
    const p = seeded.get(id);
    return {
      id, kind: n.kind,
      subject: n.kind === 'COURSE' ? n.s : `__${n.kind}`,
      x: p.x, y: p.y, vx: 0, vy: 0, pinned: false,
      r: radiusOf(n, id),
      ...halfExtents(n, id),
    };
  });

  // Throw the seed apart, then let it pull itself back together. The student
  // never watches this: the map is hidden until the layout has settled, so a
  // course appears already arranged rather than writhing into place.
  explode(nodes);
  sim = new Simulation(nodes, sub.edges);
  buildSvg(sub, sim);
  closeSheet();
  settleThenReveal();
}

/**
 * How long to settle before yielding to the page. The largest graph here is 64
 * nodes and settles in about 40ms, so in practice the first pass finishes the
 * job and nothing is ever handed to a timer.
 */
const SETTLE_SLICE_MS = 60;
/** However badly it is going, show something by now. */
const SETTLE_CAP_MS = 2500;

/**
 * Settle off-screen, then reveal.
 *
 * Deliberately not on requestAnimationFrame. A page opened in a background tab
 * — which is exactly what a QR code often does — reports `hidden`, and hidden
 * pages get no animation frames at all. A reveal driven by rAF would leave
 * such a visitor staring at a blank map until they focused the tab. Timers
 * still fire when hidden, and the first synchronous slice almost always
 * finishes the work anyway.
 */
function settleThenReveal() {
  el.stage.classList.add('is-settling');
  clearTimeout(revealTimer);
  clearTimeout(settleTimer);
  const startedAt = performance.now();

  const reveal = () => {
    settleTimer = null;
    clearTimeout(revealTimer);
    syncPositions();
    fitView();
    el.stage.classList.remove('is-settling', 'is-slow');
    startLoop();
  };

  const slice = () => {
    const deadline = performance.now() + SETTLE_SLICE_MS;
    while (!sim.settled && performance.now() < deadline) sim.tick();
    if (sim.settled || performance.now() - startedAt >= SETTLE_CAP_MS) {
      reveal();
      return true;
    }
    return false;
  };

  if (slice()) return;

  // Still going: say so, and finish in slices so the page stays responsive.
  revealTimer = setTimeout(() => el.stage.classList.add('is-slow'), 350);
  const step = () => { if (!slice()) settleTimer = setTimeout(step, 0); };
  settleTimer = setTimeout(step, 0);
}

const markerId = colour => `arrow-${colour.replace('#', '')}`;

/** One arrowhead per edge colour in play, so each arrow matches its line. */
function buildMarkers(colours) {
  const defs = make('defs', {});
  for (const colour of colours) {
    const marker = make('marker', {
      id: markerId(colour),
      viewBox: '0 0 10 10',
      refX: 10, refY: 5,
      markerWidth: 9, markerHeight: 9,
      orient: 'auto',
      markerUnits: 'userSpaceOnUse',
    });
    marker.append(make('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: colour }));
    defs.append(marker);
  }
  return defs;
}

function buildSvg(sub, simulation) {
  el.svg.replaceChildren();
  viewport = make('g', {});
  const edgeLayer = make('g', { 'stroke-linecap': 'round', fill: 'none' });
  const nodeLayer = make('g', {});
  viewport.append(edgeLayer, nodeLayer);
  el.svg.append(viewport);

  drawn = { nodes: new Map(), edges: [] };

  const colours = new Set(sub.edges.map(e => EDGE_COLOR[e.r] || EDGE_FALLBACK));
  el.svg.append(buildMarkers(colours));

  for (const e of sub.edges) {
    const colour = EDGE_COLOR[e.r] || EDGE_FALLBACK;
    const line = make('line', {
      stroke: colour,
      'stroke-width': e.r === 'CO' ? 2.6 : 2.2,
      'stroke-dasharray': e.r === 'CO' ? '6 4' : '',
      'marker-end': `url(#${markerId(colour)})`,
      opacity: 0.85,
    });
    edgeLayer.append(line);
    drawn.edges.push({ el: line, s: e.s, t: e.t });
  }

  for (const nd of simulation.nodes) {
    const parts = drawNode(nd);
    nodeLayer.append(parts.g);
    drawn.nodes.set(nd.id, { el: parts.g, node: nd, ...parts });
  }
}

function drawNode(nd) {
  const n = index.byId.get(nd.id);
  const g = make('g', { class: 'node', tabindex: '0', role: 'button' });
  g.dataset.id = nd.id;
  const halo = make('circle', {
    class: 'halo', r: nd.r + 9,
    fill: 'none', stroke: '#4b8bf5', 'stroke-width': 3.5,
  });
  g.append(halo);

  if (n.kind === 'COURSE') {
    const isRoot = nd.id === root;
    const baseR = courseRadius(nd.id);
    const baseFont = isRoot ? 22 : 13;
    const baseStroke = isRoot ? 9 : 2.5;
    const shape = make('circle', {
      r: baseR,
      fill: courseFill(n),
      stroke: isRoot ? ROOT_RING : '#ffffff',
      'stroke-width': baseStroke,
      'stroke-dasharray': n.boundary ? '5 3' : '',
    });
    const label = make('text', {
      y: baseR + baseFont + 5, 'text-anchor': 'middle',
      'font-size': baseFont, 'font-weight': isRoot ? 800 : 700,
      // Out-of-subject courses are context, not the subject of the map.
      fill: n.boundary ? BOUNDARY_INK : 'currentColor',
    }, n.id);
    g.append(shape, label);
    return { g, halo, shape, label, isRoot, baseR, baseFont, baseStroke };
  }
  {
    const st = STYLE[n.kind] || STYLE.NC;
    if (st.shape === 'hexagon') {
      g.append(make('polygon', {
        points: polygonPoints(st.r, 6, 0),
        fill: st.fill, stroke: st.stroke, 'stroke-width': 2.5,
      }));
    } else if (st.shape === 'diamond') {
      g.append(make('polygon', {
        points: polygonPoints(st.r, 4, -Math.PI / 2),
        fill: st.fill, stroke: st.stroke, 'stroke-width': 2.5,
      }));
    } else {
      const b = boxFor(n);
      g.append(make('rect', {
        x: -b.w / 2, y: -b.h / 2, width: b.w, height: b.h, rx: 7,
        fill: st.fill, stroke: st.stroke, 'stroke-width': 2.2,
        'stroke-dasharray': st.dashed ? '6 4' : '',
      }));
    }
    const inside = st.shape === 'rect';
    g.append(make('text', {
      y: inside ? 4 : st.r + 15,
      'text-anchor': 'middle',
      'font-size': inside ? 12 : 12.5,
      'font-weight': 700,
      fill: inside ? (st.ink || '#ffffff') : 'currentColor',
    }, inside ? truncate(labelFor(n), 26) : labelFor(n)));
  }
  return { g, halo, shape: null, label: null, isRoot: false };
}

/**
 * A selected course grows and its code is set heavier, so the thing you tapped
 * reads as the subject of the panel below. Only the drawing changes: the node's
 * physics radius stays put, or selecting something would shove the layout.
 */
function emphasise(entry, on) {
  if (!entry || !entry.shape) return;
  // Grow from whatever this node's own size is, so selecting the chosen
  // course makes it larger still rather than shrinking it to everyone else's.
  const r = entry.baseR + (on ? SELECTED_GROWTH : 0);
  const font = entry.baseFont + (on ? 2 : 0);
  entry.shape.setAttribute('r', r);
  entry.shape.setAttribute('stroke-width', entry.baseStroke + (on ? 1 : 0));
  entry.halo.setAttribute('r', r + 9);
  entry.label.setAttribute('y', r + font + 5);
  entry.label.setAttribute('font-size', font);
  entry.label.setAttribute('font-weight', on ? 800 : (entry.isRoot ? 800 : 700));
}

function syncPositions() {
  for (const { el: g, node } of drawn.nodes.values()) {
    g.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`);
  }
  for (const e of drawn.edges) {
    const s = sim.byId.get(e.s);
    const t = sim.byId.get(e.t);
    if (!s || !t) continue;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    // Leave the source and stop short of the target, so the arrowhead lands on
    // the outline rather than under the shape.
    const from = boundary(s, ux, uy) + 2;
    const to = boundary(t, ux, uy) + ARROW_GAP;
    e.el.setAttribute('x1', (s.x + ux * from).toFixed(1));
    e.el.setAttribute('y1', (s.y + uy * from).toFixed(1));
    e.el.setAttribute('x2', (t.x - ux * to).toFixed(1));
    e.el.setAttribute('y2', (t.y - uy * to).toFixed(1));
  }
}

function startLoop() {
  if (frame) cancelAnimationFrame(frame);
  const step = () => {
    if (!sim) return;
    if (!sim.settled || dragging) {
      sim.tick();
      syncPositions();
      frame = requestAnimationFrame(step);
    } else {
      frame = null;
    }
  };
  frame = requestAnimationFrame(step);
}

function nudge() {
  if (!sim) return;
  sim.ticks = 0;
  sim.motion = Infinity;
  for (const n of sim.nodes) {
    n.vx += (Math.random() - 0.5) * 6;
    n.vy += (Math.random() - 0.5) * 6;
  }
  startLoop();
}

/* ── view transform ────────────────────────────────────────────────── */

function applyView() {
  if (viewport) viewport.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
}

function stageSize() {
  const r = el.stage.getBoundingClientRect();
  return { w: Math.max(r.width, 1), h: Math.max(r.height, 1) };
}

function fitView() {
  if (!sim || !sim.nodes.length) return;
  const { w, h } = stageSize();
  el.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of sim.nodes) {
    minX = Math.min(minX, n.x - n.r);
    maxX = Math.max(maxX, n.x + n.r);
    minY = Math.min(minY, n.y - n.r);
    maxY = Math.max(maxY, n.y + n.r + 22);
  }
  const cw = maxX - minX || 1;
  const ch = maxY - minY || 1;
  // Leave the top bar and the sheet some room rather than filling edge to edge.
  const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((w - PAD * 2) / cw, (h - PAD * 3) / ch)));
  view = {
    k,
    tx: w / 2 - ((minX + maxX) / 2) * k,
    ty: h / 2 - ((minY + maxY) / 2) * k,
  };
  applyView();
}

function zoomAt(cx, cy, factor) {
  const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.k * factor));
  const scale = k / view.k;
  view.tx = cx - (cx - view.tx) * scale;
  view.ty = cy - (cy - view.ty) * scale;
  view.k = k;
  applyView();
}

/* ── input: pan, zoom, drag a node ─────────────────────────────────── */

let dragging = null;

function bindStage() {
  const pointers = new Map();
  let pinchDist = 0;

  const local = ev => {
    const r = el.stage.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const toGraph = p => ({ x: (p.x - view.tx) / view.k, y: (p.y - view.ty) / view.k });

  el.stage.addEventListener('pointerdown', ev => {
    el.stage.setPointerCapture(ev.pointerId);
    const p = local(ev);
    pointers.set(ev.pointerId, p);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dragging) { dragging.node.pinned = false; dragging = null; }
      return;
    }

    const hit = ev.target.closest?.('.node');
    if (hit && pointers.size === 1) {
      const entry = drawn.nodes.get(hit.dataset.id);
      if (entry) {
        dragging = { id: hit.dataset.id, node: entry.node, moved: false, pointerId: ev.pointerId };
        entry.node.pinned = true;
        startLoop();
      }
    }
  });

  el.stage.addEventListener('pointermove', ev => {
    if (!pointers.has(ev.pointerId)) return;
    const prev = pointers.get(ev.pointerId);
    const now = local(ev);
    pointers.set(ev.pointerId, now);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, dist / pinchDist);
      pinchDist = dist;
      return;
    }

    if (dragging && dragging.pointerId === ev.pointerId) {
      const g = toGraph(now);
      dragging.node.x = g.x;
      dragging.node.y = g.y;
      dragging.node.vx = 0;
      dragging.node.vy = 0;
      if (Math.hypot(now.x - prev.x, now.y - prev.y) > 0.5) dragging.moved = true;
      syncPositions();
      return;
    }

    view.tx += now.x - prev.x;
    view.ty += now.y - prev.y;
    applyView();
  });

  const release = ev => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (dragging && dragging.pointerId === ev.pointerId) {
      dragging.node.pinned = false;
      if (!dragging.moved) select(dragging.id);
      dragging = null;
      nudgeSettle();
    }
  };
  el.stage.addEventListener('pointerup', release);
  el.stage.addEventListener('pointercancel', release);

  el.stage.addEventListener('wheel', ev => {
    ev.preventDefault();
    const p = local(ev);
    zoomAt(p.x, p.y, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  // keyboard route to the same selection
  el.svg.addEventListener('keydown', ev => {
    const hit = ev.target.closest?.('.node');
    if (hit && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(hit.dataset.id); }
  });

  el.fit.addEventListener('click', fitView);
  el.shake.addEventListener('click', nudge);
}

/** Let the layout relax a little after a drag, without a full re-settle. */
function nudgeSettle() {
  if (!sim) return;
  sim.motion = Infinity;
  sim.ticks = Math.min(sim.ticks, 1200);
  startLoop();
}

/* ── the sheet ─────────────────────────────────────────────────────── */

function tag(text, variant) {
  const s = document.createElement('span');
  s.className = variant ? `tag ${variant}` : 'tag';
  s.textContent = text;
  return s;
}

function para(text, cls) {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
}

function closeSheet() {
  el.sheet.hidden = true;
  for (const entry of drawn.nodes.values()) {
    entry.el.classList.remove('is-selected');
    emphasise(entry, false);
  }
}

function select(id) {
  for (const entry of drawn.nodes.values()) {
    const on = entry.el.dataset.id === id;
    entry.el.classList.toggle('is-selected', on);
    emphasise(entry, on);
  }
  const n = index.byId.get(id);
  if (!n) return;
  el.sheetBody.replaceChildren();

  const h = document.createElement('h2');

  if (n.kind === 'COURSE') {
    h.textContent = `${n.id} — ${n.t}`;
    el.sheetBody.append(h, para(n.f || '', 'sub'));

    const tags = document.createElement('p');
    if (n.boundary) tags.append(tag('Outside Computer Science', 'off'));
    else if (n.logicStatus === 'parsed') tags.append(tag('Requirements read from the Calendar'));
    else if (n.logicStatus === 'none') tags.append(tag('No requirements stated', 'off'));
    else tags.append(tag('Requirements could not be confirmed', 'warn'));
    if (n.credits) tags.append(tag(`${n.credits} credits`, 'off'));
    el.sheetBody.append(tags);

    if (n.d) el.sheetBody.append(para(n.d, 'desc'));

    if (n.boundary) {
      el.sheetBody.append(para(
        'This is a prerequisite from another subject. This page describes it but '
        + 'does not follow its own prerequisites — those are outside the slice.',
        'note',
      ));
    } else if (id !== root) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill';
      b.textContent = `Map ${n.id} instead`;
      b.addEventListener('click', () => choose(id));
      el.sheetBody.append(b);
    }
  } else {
    h.textContent = n.kind === 'OF' ? `Choice — ${labelFor(n)}` : n.kind;
    el.sheetBody.append(h, para('Logic node', 'sub'));
    // AND has no wording of its own, and OF's is already the heading.
    if (n.lb && n.kind !== 'AND' && n.kind !== 'OF') {
      el.sheetBody.append(para(`As the Calendar states it: “${clean(n.lb)}”`, 'desc'));
    }
    const { from, to } = wiring(id);
    // A choice or a conjunction is worth reading in both directions; a
    // condition has nothing feeding it, so only say what it stands in the way
    // of.
    if (n.kind === 'AND' || n.kind === 'OF') {
      el.sheetBody.append(
        flow('Satisfied by', from, n.kind === 'OF' ? 'any of these' : 'all of these'),
      );
    }
    el.sheetBody.append(flow('Counts toward', to, null));
  }
  el.sheet.hidden = false;
}

/** What feeds a logic node, and what it feeds in turn. */
function wiring(id) {
  const name = nodeId => {
    const n = index.byId.get(nodeId);
    if (!n) return nodeId;
    if (n.kind === 'COURSE') return n.id;
    if (n.kind === 'OF') return `a choice of ${labelFor(n)}`;
    if (n.kind === 'AND') return 'a group of requirements';
    return truncate(clean(n.lb || n.kind), 48);
  };
  const from = [];
  const seenFrom = new Set();
  for (const e of index.incoming.get(id) || []) {
    if (seenFrom.has(e.s)) continue;
    seenFrom.add(e.s);
    from.push(name(e.s));
  }

  // Follow the operators forward until a course. "Counts toward: CPSC 445"
  // tells a student something; "counts toward a group of requirements" does
  // not, and an operator is never the thing they are trying to reach.
  const to = [];
  const seenTo = new Set();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of index.outgoing.get(cur) || []) {
      if (seenTo.has(e.t)) continue;
      seenTo.add(e.t);
      const next = index.byId.get(e.t);
      if (!next) continue;
      if (next.kind === 'COURSE') to.push(next.id);
      else queue.push(e.t);
    }
  }
  return { from, to };
}

/** One 'from' or 'to' line in the sheet. */
function flow(heading, items, qualifier) {
  const p = document.createElement('p');
  p.className = 'flow';
  const b = document.createElement('b');
  b.textContent = `${heading}: `;
  p.append(b);
  p.append(document.createTextNode(items.length ? items.join(', ') : '—'));
  if (qualifier && items.length > 1) {
    const q = document.createElement('i');
    q.textContent = ` (${qualifier})`;
    p.append(q);
  }
  return p;
}

/* ── picker, menu, views ───────────────────────────────────────────── */

function showResults(list) {
  el.results.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'No Computer Science course matches that.';
    el.results.append(li);
  }
  for (const c of list) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = c.id;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = c.t;
    li.append(code, title);
    li.addEventListener('click', () => choose(c.id));
    el.results.append(li);
  }
  el.results.hidden = false;
  el.search.setAttribute('aria-expanded', 'true');
}

function hideResults() {
  el.results.hidden = true;
  el.search.setAttribute('aria-expanded', 'false');
}

function choose(id) {
  hideResults();
  el.search.value = '';
  el.clear.hidden = true;
  el.search.blur();
  showView('map');
  render(id);
  history.replaceState(null, '', `#${encodeURIComponent(id)}`);
}

function showView(name) {
  const isAbout = name === 'about';
  el.about.hidden = !isAbout;
  for (const b of el.menu.querySelectorAll('button')) {
    b.classList.toggle('is-current', b.dataset.view === name);
  }
  el.menu.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
  if (!isAbout) setTimeout(fitView, 0);
}

function bindChrome() {
  el.search.addEventListener('focus', () => showResults(matches(index.pickable, el.search.value)));
  el.search.addEventListener('input', () => {
    el.clear.hidden = !el.search.value;
    showResults(matches(index.pickable, el.search.value));
  });
  el.search.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { hideResults(); el.search.blur(); }
    if (ev.key === 'Enter') {
      const first = matches(index.pickable, el.search.value)[0];
      if (first) choose(first.id);
    }
  });
  el.clear.addEventListener('click', () => {
    el.search.value = '';
    el.clear.hidden = true;
    el.search.focus();
    showResults(matches(index.pickable, ''));
  });

  el.menuBtn.addEventListener('click', () => {
    const open = el.menu.hidden;
    el.menu.hidden = !open;
    el.menuBtn.setAttribute('aria-expanded', String(open));
  });

  for (const b of document.querySelectorAll('[data-view]')) {
    b.addEventListener('click', () => showView(b.dataset.view));
  }

  el.sheetClose.addEventListener('click', closeSheet);

  document.addEventListener('pointerdown', ev => {
    if (!ev.target.closest('.search-wrap')) hideResults();
    if (!ev.target.closest('.menu') && !ev.target.closest('#menu-btn')) {
      el.menu.hidden = true;
      el.menuBtn.setAttribute('aria-expanded', 'false');
    }
  }, true);

  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!el.about.hidden) showView('map');
    else if (!el.sheet.hidden) closeSheet();
  });

  let timer;
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(fitView, 160);
  });
  addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
    if (id && id !== root && index.pickable.some(c => c.id === id)) render(id);
  });
}

/* ── boot ──────────────────────────────────────────────────────────── */

function startingCourse() {
  const has = id => index.pickable.some(c => c.id === id);
  const fromHash = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  if (fromHash && has(fromHash)) return fromHash;
  for (const preferred of ['CPSC 320', 'CPSC 445', 'CPSC 221']) {
    if (has(preferred)) return preferred;
  }
  return index.pickable[0]?.id;
}

fetch('graph.json')
  .then(res => {
    if (!res.ok) throw new Error(`graph.json returned HTTP ${res.status}`);
    return res.json();
  })
  .then(data => {
    index = indexGraph(data);
    if (el.statCourses) el.statCourses.textContent = String(index.pickable.length);
    bindStage();
    bindChrome();
    const start = startingCourse();
    if (start) render(start);
  })
  .catch(err => {
    el.empty.hidden = false;
    el.empty.textContent = `Could not load the graph — ${err.message || err}`;
  });
