"""Cut a single-subject slice out of the parent project's planner graph.

Everything a course in the chosen subject needs is kept. A prerequisite from
another subject is kept as a *boundary* node: its title and description travel
with it so the page can explain what it is, but its own prerequisites are left
behind, so the slice stops at the edge of the subject.

    python tools/build_slice.py \
        --source ../UBC-CourseGraph-v2/public/graph.js \
        --subject CPSC --out graph.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_planner_graph(path: Path) -> dict:
    """public/graph.js is a JS module whose body is one JSON object."""
    text = path.read_text(encoding="utf-8")
    try:
        start = text.index("{")
    except ValueError as exc:  # pragma: no cover - a corrupt source file
        raise SystemExit(f"{path}: no JSON object found") from exc
    return json.loads(text[start:].rstrip().rstrip(";"))


def build(graph: dict, subject: str) -> dict:
    courses = {c["id"]: c for c in graph["courses"]}
    logic = {n["id"]: n for n in graph["logicNodes"]}

    incoming: dict[str, list[dict]] = {}
    for edge in graph["edges"]:
        incoming.setdefault(edge["t"], []).append(edge)

    roots = sorted(cid for cid, c in courses.items() if c["s"] == subject)
    if not roots:
        raise SystemExit(f"no courses found for subject {subject!r}")

    kept: set[str] = set(roots)
    boundary: set[str] = set()
    kept_edges: list[dict] = []
    seen: set[tuple] = set()

    def walk(start: str) -> None:
        stack = [start]
        while stack:
            current = stack.pop()
            for edge in incoming.get(current, []):
                key = (edge["s"], edge["t"], edge.get("r"))
                if key in seen:
                    continue
                seen.add(key)
                kept_edges.append(edge)

                source = edge["s"]
                if source in courses and courses[source]["s"] != subject:
                    # Another subject: keep the node, drop what sits behind it.
                    boundary.add(source)
                    kept.add(source)
                    continue
                if source in logic or source in courses:
                    if source not in kept:
                        kept.add(source)
                        stack.append(source)

    for root in roots:
        walk(root)

    out_courses = []
    for cid in sorted(n for n in kept if n in courses):
        course = dict(courses[cid])
        course["boundary"] = cid in boundary
        out_courses.append(course)

    out_logic = [logic[n] for n in sorted(n for n in kept if n in logic)]
    node_ids = {c["id"] for c in out_courses} | {n["id"] for n in out_logic}

    out_edges = [e for e in kept_edges if e["s"] in node_ids and e["t"] in node_ids]
    out_logic, out_edges = simplify_operators(out_logic, out_edges)
    node_ids = {c["id"] for c in out_courses} | {n["id"] for n in out_logic}
    out_edges = [e for e in out_edges if e["s"] in node_ids and e["t"] in node_ids]

    subjects = sorted({c["s"] for c in out_courses})
    # Equivalencies and exclusions are deliberately dropped. They say what a
    # course cannot be taken *with*, not what it needs, so on a map of
    # prerequisites they are a second kind of relationship competing for the
    # reader's attention. The viewer never read them either.
    return {
        "subject": subject,
        "courses": out_courses,
        "logicNodes": out_logic,
        "edges": out_edges,
        "subjectColors": {
            s: graph["subjectColors"][s] for s in subjects if s in graph["subjectColors"]
        },
    }


def simplify_operators(logic_nodes, edges):
    """Drop operators that no longer join anything, and collapse those left
    holding a single branch.

    Dropping equivalencies and exclusions leaves operators behind. CPSC 203
    states "one of seven courses" *and* "not for students with credit for
    CPSC 210 or CPEN 221"; the exclusion goes, and the conjunction is left
    wrapping one choice. An AND with one branch is that branch, and an OF with
    one branch is "one of one" -- both draw a shape the reader has to interpret
    and that means nothing.

    Repeated until stable, since collapsing one can empty or orphan the next.
    """
    kinds = {n["id"]: n["tp"] for n in logic_nodes}
    removed = set()

    while True:
        children = {}
        parents = {}
        for e in edges:
            if e["s"] in removed or e["t"] in removed:
                continue
            children.setdefault(e["t"], []).append(e)
            parents.setdefault(e["s"], []).append(e)

        changed = False
        for node_id, kind in kinds.items():
            if node_id in removed or kind not in ("AND", "OF"):
                continue
            own = children.get(node_id, [])
            if len(own) > 1:
                continue

            if own:
                # One branch: hand it straight to whatever this fed.
                child = own[0]["s"]
                for up in parents.get(node_id, []):
                    edges.append({"s": child, "t": up["t"], "r": up.get("r")})
            removed.add(node_id)
            changed = True

        edges = [
            e for e in edges if e["s"] not in removed and e["t"] not in removed
        ]
        if not changed:
            break

    seen = set()
    deduped = []
    for e in edges:
        key = (e["s"], e["t"], e.get("r"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(e)

    return [n for n in logic_nodes if n["id"] not in removed], deduped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path,
                        help="path to the parent project's public/graph.js")
    parser.add_argument("--subject", default="CPSC", help="subject code to keep (default: CPSC)")
    parser.add_argument("--out", default=Path("graph.json"), type=Path)
    args = parser.parse_args()

    data = build(load_planner_graph(args.source), args.subject)
    args.out.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    boundary = sum(1 for c in data["courses"] if c["boundary"])
    print(f"subject        : {args.subject}")
    print(f"courses        : {len(data['courses'])} ({boundary} boundary)")
    print(f"logic nodes    : {len(data['logicNodes'])}")
    print(f"edges          : {len(data['edges'])}")
    print(f"wrote          : {args.out} ({args.out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
