#!/usr/bin/env python3
"""Compare two V8 heapsnapshots; focus on Buffer/ArrayBuffer growth + retainer paths."""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

NODE_FIELDS = ["type", "name", "id", "self_size", "edge_count", "detachedness"]
EDGE_FIELDS = ["type", "name_or_index", "to_node"]

INTERESTING = (
    "arraybuffer",
    "array buffer",
    "array_buffer",
    "buffer",
    "uint8array",
    "uint8",
    "arraybuffer",
    "backing",
    "undici",
    "request",
    "response",
    "fetch",
    "socket",
    "tls",
    "http",
    "stream",
    "body",
    "blob",
    "cache",
)


def load(path: Path):
    print(f"loading {path} ({path.stat().st_size/1e6:.0f}MB)...", flush=True)
    with path.open() as f:
        data = json.load(f)
    meta = data["snapshot"]["meta"]
    node_types = meta["node_types"][0]
    edge_types = meta["edge_types"][0]
    strings = data["strings"]
    nodes = data["nodes"]
    edges = data["edges"]
    nf = len(meta["node_fields"])
    ef = len(meta["edge_fields"])
    ncount = data["snapshot"]["node_count"]
    print(f"  nodes={ncount} edges={data['snapshot']['edge_count']} strings={len(strings)}", flush=True)
    return {
        "node_types": node_types,
        "edge_types": edge_types,
        "strings": strings,
        "nodes": nodes,
        "edges": edges,
        "nf": nf,
        "ef": ef,
        "ncount": ncount,
    }


def iter_nodes(snap):
    nodes, nf, strings, node_types = snap["nodes"], snap["nf"], snap["strings"], snap["node_types"]
    for i in range(snap["ncount"]):
        base = i * nf
        t = node_types[nodes[base]]
        name = strings[nodes[base + 1]]
        nid = nodes[base + 2]
        size = nodes[base + 3]
        edge_count = nodes[base + 4]
        yield i, t, name, nid, size, edge_count


def build_edge_index(snap):
    """incoming: to_node_index -> list of (from_idx, etype, ename)"""
    edges, ef, strings, edge_types = snap["edges"], snap["ef"], snap["strings"], snap["edge_types"]
    nf = snap["nf"]
    node_edge_counts = [0] * snap["ncount"]
    for i, t, name, nid, size, edge_count in iter_nodes(snap):
        node_edge_counts[i] = edge_count
    incoming = defaultdict(list)
    pos = 0
    for i, ec in enumerate(node_edge_counts):
        for _ in range(ec):
            et = edge_types[edges[pos]]
            name_or_index = edges[pos + 1]
            to_node = edges[pos + 2] // nf
            if et == "element":
                ename = f"[{name_or_index}]"
            else:
                try:
                    ename = strings[name_or_index]
                except Exception:
                    ename = str(name_or_index)
            if et != "weak":
                incoming[to_node].append((i, et, ename))
            pos += ef
    return incoming, node_edge_counts


def aggregate(snap):
    by_key = Counter()  # (type, name) -> (count, size)
    sizes = Counter()
    counts = Counter()
    big = []  # large nodes
    for i, t, name, nid, size, edge_count in iter_nodes(snap):
        key = (t, name)
        counts[key] += 1
        sizes[key] += size
        if size >= 256 * 1024:  # >=256KB
            big.append((size, t, name, nid, i))
    return counts, sizes, sorted(big, reverse=True)


def interesting_name(name: str) -> bool:
    n = name.lower()
    return any(x in n for x in INTERESTING)


def retainer_path(snap, incoming, node_idx, max_depth=12):
    strings = snap["strings"]
    # BFS one path to GC roots (synthetic / distance)
    path = []
    seen = set()
    cur = node_idx
    for _ in range(max_depth):
        if cur in seen:
            path.append("...(cycle)")
            break
        seen.add(cur)
        # describe cur
        # find node fields
        base = cur * snap["nf"]
        t = snap["node_types"][snap["nodes"][base]]
        name = strings[snap["nodes"][base + 1]]
        size = snap["nodes"][base + 3]
        path.append(f"{t}:{name}#{snap['nodes'][base+2]} ({size}B)")
        refs = incoming.get(cur) or []
        if not refs:
            break
        # prefer non-hidden, non-internal edges from objects with interesting names
        refs_sorted = sorted(
            refs,
            key=lambda r: (
                0 if interesting_name(strings[snap["nodes"][r[0] * snap["nf"] + 1]]) else 1,
                0 if r[1] in ("property", "element", "context") else 1,
                -snap["nodes"][r[0] * snap["nf"] + 3],
            ),
        )
        frm, et, ename = refs_sorted[0]
        path.append(f"  <-{et}:{ename}-")
        cur = frm
    return path


def main():
    snap1_path = Path(sys.argv[1])
    snap2_path = Path(sys.argv[2])
    out_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("heap-diff-report.txt")

    lines = []
    def w(s=""):
        print(s, flush=True)
        lines.append(s)

    s1 = load(snap1_path)
    c1, z1, big1 = aggregate(s1)
    # free nodes arrays later - keep aggregates; for retainers need s2 full
    del s1["edges"]  # free some before loading s2? still need s2 edges
    # Actually drop s1 entirely after aggregates
    s1_ncount = s1["ncount"]
    del s1

    s2 = load(snap2_path)
    c2, z2, big2 = aggregate(s2)

    w("=== TOP size growth by (type, name) ===")
    keys = set(z1) | set(z2)
    growth = []
    for k in keys:
        dsize = z2.get(k, 0) - z1.get(k, 0)
        dcount = c2.get(k, 0) - c1.get(k, 0)
        if dsize > 64 * 1024 or (interesting_name(k[1]) and abs(dsize) > 4096):
            growth.append((dsize, dcount, k[0], k[1], z2.get(k, 0), c2.get(k, 0)))
    growth.sort(reverse=True)
    for dsize, dcount, t, name, total, cnt in growth[:40]:
        w(f"  {dsize/1e6:+8.2f}MB  n{dcount:+6d}  {t:10s}  {name[:80]:<80s}  now={total/1e6:.2f}MB x{cnt}")

    w()
    w("=== Interesting types only (Buffer/ArrayBuffer/etc) ===")
    for dsize, dcount, t, name, total, cnt in growth:
        if interesting_name(name) or t == "native" and dsize > 100_000:
            w(f"  {dsize/1e6:+8.2f}MB  n{dcount:+6d}  {t:10s}  {name[:80]}")

    w()
    w("=== Largest nodes in snap2 (>=256KB) ===")
    for size, t, name, nid, idx in big2[:30]:
        w(f"  {size/1e6:7.2f}MB  {t:10s}  {name[:60]}  id={nid} idx={idx}")

    w()
    w("=== Building incoming edge index for retainer paths (snap2) ===")
    incoming, _ = build_edge_index(s2)
    w(f"  nodes with inbound refs: {len(incoming)}")

    # Top ArrayBuffer / Buffer / native large
    w()
    w("=== Retainer paths for largest interesting nodes ===")
    targets = [
        (size, t, name, nid, idx)
        for size, t, name, nid, idx in big2
        if interesting_name(name) or t in ("native", "array") and size >= 512 * 1024
    ][:15]
    if not targets:
        targets = big2[:10]

    for size, t, name, nid, idx in targets:
        w(f"\n--- {size/1e6:.2f}MB {t}:{name} id={nid} ---")
        for line in retainer_path(s2, incoming, idx):
            w(line)

    # Also: sum self_size of all nodes named like ArrayBuffer / system / Buffer
    w()
    w("=== Totals by name match ===")
    for label, pred in [
        ("name~ArrayBuffer", lambda n: "arraybuffer" in n.lower() or n == "ArrayBuffer"),
        ("name~Buffer", lambda n: n == "Buffer" or n.startswith("Buffer")),
        ("name~Uint8Array", lambda n: "uint8" in n.lower()),
        ("type=native", lambda n: False),
    ]:
        pass
    for tname in ["ArrayBuffer", "system / ArrayBuffer", "Buffer", "Uint8Array", "(object elements)", "BackingStore"]:
        s = z2.get(("native", tname), 0) + z2.get(("object", tname), 0) + z2.get(("array", tname), 0)
        # search all keys
        total = sum(sz for (t, n), sz in z2.items() if n == tname)
        cnt = sum(c for (t, n), c in c2.items() if n == tname)
        if cnt:
            w(f"  exact '{tname}': {total/1e6:.2f}MB x{cnt}")

    # fuzzy
    fuzzy = Counter()
    fuzzy_c = Counter()
    for (t, n), sz in z2.items():
        nl = n.lower()
        if "arraybuffer" in nl or n == "Buffer" or "uint8array" in nl or "backing" in nl:
            fuzzy[n] += sz
            fuzzy_c[n] += c2[(t, n)]
    w("  fuzzy matches:")
    for n, sz in fuzzy.most_common(20):
        w(f"    {sz/1e6:8.2f}MB x{fuzzy_c[n]}  {n}")

    out_path.write_text("\n".join(lines) + "\n")
    w(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
