# UBC CPSC Prerequisite Graph — public example

A small, static page that draws what a UBC Computer Science course actually
requires: not just prerequisite arrows, but the **choices** and **conditions**
the Academic Calendar states in prose.

It is the public example for a larger project that reads all 9,489 courses in
the Vancouver calendar. This page carries one slice of that result and nothing
else — no pipeline, no models, no keys, no scraper.

## What is here

| File | What it is |
|---|---|
| `index.html` | the page |
| `style.css` | styling, including the phone layout and dark mode |
| `app.js` | the page: search, menu, drawing, pan, zoom and dragging |
| `graph-core.js` | the graph walk and the seed layout, with no DOM in it |
| `physics.js` | the force simulation, also with no DOM in it |
| `graph.json` | the data slice |
| `full-graph.webp` / `.jpg` | the figure in About, showing what the graph looks like with no subject boundary |
| `test/graph-core.test.mjs` | tests over the real `graph.json` |

## The slice

`graph.json` holds:

- every **CPSC** course, with its title, faculty, description and the logic
  behind its requirements;
- the **logic nodes** those requirements are built from — `AND`, `OF`, `NC`,
  `YEAR`, `PROGRAM`;
- any course from another subject that a CPSC requirement names, kept as a
  **boundary** node: the title and description travel with it so the page can
  say what it is, but its own prerequisites are not included.

That last rule is what keeps the slice small and is checked by the tests: a
course marked `boundary` must carry no prerequisites of its own.

Three things are deliberately left out or cleaned up on the way in:

- **Equivalencies and exclusions.** They say what a course cannot be taken
  *with*, not what it needs, so on a map of prerequisites they are a second
  kind of relationship competing for attention. The viewer never read them.
- **Operators left holding fewer than two branches.** Dropping the exclusions
  strands them: CPSC 203 states "one of seven courses" *and* an exclusion, so
  the conjunction was left wrapping a single choice, and CPSC 103 — whose entry
  is nothing but exclusions — was left with an empty one. An `AND` with one
  branch is that branch; an `OF` with one is "one of one". Both are collapsed,
  repeatedly, since collapsing one can strand the next. A test holds every
  operator on the map to at least two branches.
- **Discontinued courses** stay on the graph, because courses that still exist
  name them as prerequisites, but they are kept out of the search list. CPSC
  260, 261 and 301 have no title, faculty or description, so choosing one
  deliberately would get you a blank node and nothing to read.

## How to read the picture

| Shape | Meaning |
|---|---|
| Circle | a course; its colour is its subject |
| Purple hexagon | `AND` — every branch below is required |
| Gold diamond | `OF` — a choice; the label says how many you need |
| Dashed grey box | `NC` — a condition that names no course: a standing, a permission, a credit count |
| Grey dashed circle | a prerequisite outside Computer Science; described, not expanded, and drawn to recede |

The course you searched for is drawn much larger than the rest, with a heavy
dark ring and a bigger label, so the map and the panel below always agree on
what you are looking at. Selecting any node grows it from its own size rather
than to a fixed one, so selecting the chosen course makes it larger still.

Choosing a course draws its **whole** prerequisite tree, down to the point
where the chain leaves Computer Science.

## Using it

The map fills the window. Search for a course in the bar at the top; the menu
at the top right switches between **Map** and **About**. Drag the background to
pan, pinch or scroll to zoom, and drag a node to move it — let go and the
layout settles around it again. **Fit** re-frames the graph and **Re-settle**
shakes it loose if it lands somewhere awkward.

Tap any node and its description appears at the bottom of the screen: a sheet
on a phone, a card in the corner on a wider screen. The selected course is
drawn larger and its code heavier, so the map and the panel agree on what you
are looking at. Tapping an `AND` or an `OF` also says what it is **satisfied
by** and what it **counts toward**, following the operators forward until it
reaches a real course.

Edges carry arrowheads pointing from a prerequisite to the course that needs
it, coloured to match the operator they belong to and stopped at the outline of
the shape rather than under it.

## The layout

`physics.js` is a force-directed simulation of the same shape the main planner
runs — Coulomb repulsion, Hooke springs along the edges, central gravity,
subject clustering, and adaptive damping — seeded from a layered pass so it
starts in roughly the right shape rather than untangling from noise.

Choosing a course runs the whole thing off-screen before you see anything:

1. **Spawn** — the layered pass places the course at the top and its
   prerequisites below, so the simulation starts in roughly the right shape
   instead of untangling from noise.
2. **Explode** — the seed is thrown outward from its centroid, which stretches
   every spring and gives the graph the energy to pull crossed edges through
   each other. Over the 51 non-trivial CPSC graphs this takes edge crossings
   from 476 down to 280. Past about x2.5 it stops helping and some graphs stop
   settling inside the tick cap.
3. **Settle** — ticks run in 10ms slices so the page never blocks, and the map
   stays blank until the layout has stopped moving. The largest graph, CPSC 423
   at 64 nodes, takes about 300ms; if it ever ran past 350ms a quiet
   "Laying out…" appears, and past 2.5s it gives up and shows what it has.
4. **Reveal** — the finished layout fades in, already arranged.

It differs from the main engine in two ways, both because this slice is small.

**Every node repels, logic nodes included.** The main engine exempts them: they
are notation rather than places, and repelling them inflates the layout. The
second half is true here too, costing about 20% more width — but the first half
does not pay at this size. Settled across all 51 non-trivial CPSC graphs:

| | overlapping shapes | edge crossings | slowest settle |
|---|---|---|---|
| logic nodes carried by springs alone | 63 | 281 | 3,041 ticks |
| every node repelling equally | **0** | **164** | **1,742 ticks** |

A diamond sitting under a prose box is not cheaper to read for being notation.
Clustering is the one force still reserved for courses: it groups by subject,
and a logic node has none — grouping them by kind instead would drag every AND
in the graph toward every other one, which is not a relationship that exists.

**The springs and Coulomb constant are stronger.** Chosen the same way, by
counting course pairs closer together than a course label is wide: 193 such
pairs at the main project's defaults, none at these.

Tests hold both at zero, so neither can regress quietly.

## Running it

Any static server works — the page fetches `graph.json`, so opening the file
directly with `file://` will not work.

```sh
python -m http.server 8000
# then open http://localhost:8000
```

Tests:

```sh
node --test test/*.test.mjs
```

## Publishing to GitHub Pages

The repository is already in the right shape: everything sits at the root and
there is no build step.

1. Push this directory to a GitHub repository.
2. **Settings → Pages → Build and deployment**, source **Deploy from a branch**.
3. Branch `main`, folder `/ (root)`. Save.

The page appears at `https://<user>.github.io/<repo>/` within a minute or two.
`.nojekyll` is included so GitHub serves every file as-is.

Linking to one course works through the fragment, which is handy for a QR code:

```
https://<user>.github.io/<repo>/#CPSC%20445
```

## Regenerating the data

`graph.json` is cut from the parent project's `public/graph.js` by
`tools/build_slice.py`, which lives here for reference. It needs that project
checked out; point `--source` at its `public/graph.js`.

```sh
python tools/build_slice.py --source ../UBC-CourseGraph-v2/public/graph.js --subject CPSC --out graph.json
```

## Credit and licence

Made by **Daniel Simões Brandão**, UBC Computer Science.

This page is one subject out of a project covering every course in the
Vancouver calendar; the full version is intended to be public in future.
Suggestions welcome.

- [danielbrandao.ca@gmail.com](mailto:danielbrandao.ca@gmail.com)
- [LinkedIn](https://www.linkedin.com/in/daniel-simoes-brandao/)
- [github.com/DedeCanada](https://github.com/DedeCanada)

Course titles and descriptions come from the
[UBC Academic Calendar](https://vancouver.calendar.ubc.ca/) and remain UBC's.
The Calendar is the authority on requirements; this page is a reading of it and
can be wrong. Check with an advisor before you register for anything.
