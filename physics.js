/**
 * physics.js — force-directed layout, the same shape of simulation the main
 * planner runs: Coulomb repulsion between courses, Hooke springs along edges,
 * central gravity, and subject clustering, integrated with adaptive damping.
 *
 * Every node feels repulsion and gravity, logic nodes included. The main
 * engine exempts them on the grounds that they are notation rather than
 * places, and that repelling them inflates the layout. The second half of that
 * is true — it costs about 20% more area — but at this scale the first half
 * does not pay. Settling all 51 non-trivial CPSC graphs with logic nodes
 * carried by springs alone leaves 63 pairs of shapes overlapping and 281 edge
 * crossings; letting them repel on the same terms as courses gives 1 and 186,
 * and settles in roughly half the ticks. A diamond sitting on top of a prose
 * box is not cheaper to read for being notation.
 *
 * Clustering is the exception, and stays on courses. It groups by subject, and
 * a logic node has none; grouping them by kind instead would drag every AND in
 * the graph toward every other one, which is not a relationship that exists.
 *
 * Springs are longer and the Coulomb constant higher than the main project's
 * defaults, for the same reason: this slice is small. Those numbers were
 * picked by settling all 51 non-trivial CPSC graphs and counting course pairs
 * that end up closer than a course label is wide. At the main project's
 * defaults, 193 pairs overlap; at these, none do, and the largest graph grows
 * only to about 1160 x 1500.
 *
 * This page never exceeds a few dozen nodes, so the direct O(N²) sum is used
 * and neither the cutoff nor the multipole engine is needed.
 */

export const PARAMS = {
  repulsion: 20000,
  minDist: 25,
  maxForce: 40,

  centralGravity: 0.002,
  gravityExponent: 1,

  springLength: 160,
  springK: 0.03,
  springKRec: 1,
  springKCo: 1,

  clusterK: 0.015,
  clusterRange: 500,
  subjectRepulsion: 120,
  subjectMinDist: 80,
  maxSubjectForce: 1.2,

  timestep: 0.4,
  dampingStart: 0.82,
  dampingFloor: 0.4,
  dampingDecay: 0.0003,
  maxVelocity: 35,

  settleMotion: 0.15,
  maxTicks: 4000,
};

/**
 * How far the seed is thrown apart before settling.
 *
 * Dropping the seed straight into the simulation leaves it in whatever knots
 * the layered pass created; the springs are already near their rest length, so
 * nothing has the energy to pull a crossed pair through each other. Scaling
 * the seed outward first stretches every spring, and the graph pulls itself
 * back in through a configuration with far fewer crossings. Over the 51
 * non-trivial CPSC graphs: 476 edge crossings settling from the seed as-is,
 * 280 after exploding. Past roughly x2.5 it stops helping and starts costing
 * ticks — at x3 some graphs no longer settle inside the cap.
 */
export const EXPLODE = 2.2;

/** Throw the nodes outward from their centroid, in place. */
export function explode(nodes, factor = EXPLODE) {
  if (!nodes.length) return nodes;
  let cx = 0, cy = 0;
  for (const n of nodes) { cx += n.x; cy += n.y; }
  cx /= nodes.length;
  cy /= nodes.length;
  for (const n of nodes) {
    n.x = cx + (n.x - cx) * factor;
    n.y = cy + (n.y - cy) * factor;
    n.vx = 0;
    n.vy = 0;
  }
  return nodes;
}

/**
 * One run of the simulation over `nodes` and `edges`.
 *
 * A node is `{ id, kind, subject, x, y, vx, vy, pinned }`; an edge is
 * `{ s, t, r }`. Positions are mutated in place, so a caller can draw from the
 * same objects every frame.
 */
export class Simulation {
  constructor(nodes, edges, params = PARAMS) {
    this.nodes = nodes;
    this.edges = edges;
    this.params = { ...PARAMS, ...params };
    this.byId = new Map(nodes.map(n => [n.id, n]));
    this.courses = nodes.filter(n => n.kind === 'COURSE');
    this.ticks = 0;
    this.motion = Infinity;
    for (const n of nodes) { n.vx ||= 0; n.vy ||= 0; }
  }

  get settled() {
    const p = this.params;
    return this.ticks >= p.maxTicks
      || (p.settleMotion > 0 && this.ticks > 30 && this.motion < p.settleMotion);
  }

  /** Advance one step. Returns the mean node speed for this tick. */
  tick() {
    const p = this.params;
    const { nodes } = this;

    for (const n of nodes) { n.fx = 0; n.fy = 0; }

    // Coulomb repulsion over everything drawn.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        // Wide nodes keep their distance by their own half-width, so a long
        // prose box clears its neighbours rather than merely its centre.
        const floor = Math.max(p.minDist, ((a.r || 0) + (b.r || 0)) * 0.6);
        let d = Math.hypot(dx, dy);
        d = Math.max(d, floor);
        const force = Math.min(p.repulsion / (d * d), p.maxForce);
        const fx = (force * dx) / d;
        const fy = (force * dy) / d;
        a.fx += fx; a.fy += fy;
        b.fx -= fx; b.fy -= fy;
      }
    }

    // Springs along the edges.
    for (const e of this.edges) {
      const s = this.byId.get(e.s);
      const t = this.byId.get(e.t);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      let stiffness = p.springK;
      if (e.r === 'REC') stiffness *= p.springKRec;
      else if (e.r === 'CO') stiffness *= p.springKCo;
      const force = stiffness * (d - p.springLength);
      const fx = (force * dx) / d;
      const fy = (force * dy) / d;
      s.fx += fx; s.fy += fy;
      t.fx -= fx; t.fy -= fy;
    }

    // Central gravity, on everything.
    for (const n of nodes) {
      if (p.gravityExponent === 1) {
        n.fx -= n.x * p.centralGravity;
        n.fy -= n.y * p.centralGravity;
        continue;
      }
      const d = Math.hypot(n.x, n.y);
      if (d < 1e-9) continue;
      const magnitude = p.centralGravity * Math.pow(d, p.gravityExponent);
      n.fx -= (magnitude * n.x) / d;
      n.fy -= (magnitude * n.y) / d;
    }

    this.#cluster();

    // Integrate with damping that decays toward a floor.
    const damping = Math.max(p.dampingFloor, p.dampingStart - this.ticks * p.dampingDecay);
    const dt = p.timestep;
    let total = 0;

    for (const n of nodes) {
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.vx = (n.vx + n.fx * dt) * damping;
      n.vy = (n.vy + n.fy * dt) * damping;

      const speed = Math.hypot(n.vx, n.vy);
      if (speed > p.maxVelocity) {
        n.vx = (n.vx / speed) * p.maxVelocity;
        n.vy = (n.vy / speed) * p.maxVelocity;
      }
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      total += speed;
    }

    this.ticks++;
    this.motion = nodes.length ? total / nodes.length : 0;
    return this.motion;
  }

  /** Same subject attracts; different subjects push apart as whole groups. */
  #cluster() {
    const p = this.params;
    const groups = new Map();
    for (const n of this.courses) {
      if (!groups.has(n.subject)) groups.set(n.subject, []);
      groups.get(n.subject).push(n);
    }

    const centroids = [];
    for (const members of groups.values()) {
      let cx = 0, cy = 0;
      for (const n of members) { cx += n.x; cy += n.y; }
      centroids.push({ x: cx / members.length, y: cy / members.length, members });
    }

    for (const { x: cx, y: cy, members } of centroids) {
      if (members.length < 2) continue;
      for (const n of members) {
        const dx = cx - n.x;
        const dy = cy - n.y;
        const d = Math.hypot(dx, dy);
        if (d < 1 || d > p.clusterRange) continue;
        n.fx += dx * p.clusterK;
        n.fy += dy * p.clusterK;
      }
    }

    for (let a = 0; a < centroids.length; a++) {
      for (let b = a + 1; b < centroids.length; b++) {
        const dx = centroids[a].x - centroids[b].x;
        const dy = centroids[a].y - centroids[b].y;
        const d = Math.max(Math.hypot(dx, dy), p.subjectMinDist);
        const force = Math.min(p.subjectRepulsion / d, p.maxSubjectForce);
        const fx = (force * dx) / d;
        const fy = (force * dy) / d;
        for (const n of centroids[a].members) { n.fx += fx; n.fy += fy; }
        for (const n of centroids[b].members) { n.fx -= fx; n.fy -= fy; }
      }
    }
  }

  /** Run to settle without drawing. Used by the tests and for a warm start. */
  run(limit = this.params.maxTicks) {
    while (this.ticks < limit && !this.settled) this.tick();
    return this;
  }
}
