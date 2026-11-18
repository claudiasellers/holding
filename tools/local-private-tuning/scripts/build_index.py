#!/usr/bin/env python3
"""Chunk redacted/ (and optionally seeds/ and the app's scripted lines) into a local index.

  build_index.py [--backend auto|bm25|dense] [--include-seeds] [--app-scripts FILE_OR_DIR]

Files under redacted/<archetype-id>/ are namespaced to that archetype; everything else is shared.
Refuses to index raw/ — run redact.py first. Prints counts only.
"""
import argparse
import json
import re
from pathlib import Path

import privacy_guard as pg
import rag


def collect(root: Path, ns_from_dir=True, default_ns="shared"):
    for p in ([root] if root.is_file() else pg.iter_text_files(root)):
        rel = Path(p.name) if root.is_file() else p.relative_to(root)
        ns = rel.parts[0] if ns_from_dir and len(rel.parts) > 1 else default_ns
        text = pg.read_text(p)
        if p.suffix == ".jsonl":  # seed dialogues: index the assistant turns
            parts = []
            for line in text.splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                parts += [m["content"] for m in row.get("messages", []) if m.get("role") == "assistant"]
                ns = row.get("meta", {}).get("archetype", ns) or ns
            text = "\n\n".join(parts)
        elif p.suffix == ".json":
            try:
                text = "\n\n".join(re.sub(r"\{\w+\}", "", x) for x in _strings(json.loads(text)))
            except json.JSONDecodeError:
                pass
        yield str(rel), ns, text


def _strings(x):
    if isinstance(x, str):
        if len(x) > 20:
            yield x
    elif isinstance(x, dict):
        for k, v in x.items():
            if k in ("t", "text", "line") or not isinstance(v, str):
                yield from _strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from _strings(v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default=None, choices=["auto", "bm25", "dense"])
    ap.add_argument("--include-seeds", action="store_true")
    ap.add_argument("--app-scripts", type=Path, help="app lines library file (holding/src/data/lines.json) or a dir of JSON")
    a = ap.parse_args()
    cfg = pg.load_config()
    v = pg.vault_path()
    pg.assert_private_dir(v)
    backend = a.backend or cfg["rag"]["backend"]

    rows = []
    sources = [(v / "redacted", True, "shared")]
    if a.include_seeds:
        sources.append((v / "seeds", False, "shared"))
    if a.app_scripts:
        sources.append((a.app_scripts, False, "shared"))
    for root, nsdir, dflt in sources:
        if not root.exists():
            continue
        for src, ns, text in collect(root, nsdir, dflt):
            for c in rag.chunk(text, cfg["rag"]["chunk_chars"], cfg["rag"]["overlap_chars"]):
                rows.append({"id": len(rows), "source": src, "ns": ns, "text": c})

    out = v / "index"
    out.mkdir(exist_ok=True)
    (out / "chunks.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    dense = False
    if backend in ("auto", "dense") and rows:
        from local_llm import available, embed
        try:
            import numpy as np
            if available():
                vecs = np.array(embed([r["text"] for r in rows]), dtype="float32")
                vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9
                np.save(out / "vectors.npy", vecs)
                dense = True
            elif backend == "dense":
                raise SystemExit("Ollama not reachable on 127.0.0.1; start it or use --backend bm25")
        except ImportError:
            if backend == "dense":
                raise SystemExit("numpy missing: pip install numpy")
    meta = {"n_chunks": len(rows), "dense": dense, "embed_model": cfg["models"]["embed"] if dense else None,
            "namespaces": sorted({r["ns"] for r in rows}),
            "n_by_ns": {ns: sum(r["ns"] == ns for r in rows) for ns in {r["ns"] for r in rows}}}
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    pg.report(meta)


if __name__ == "__main__":
    main()
