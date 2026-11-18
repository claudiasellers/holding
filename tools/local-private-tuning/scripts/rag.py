"""Local retrieval core: chunking, BM25 (zero-dep), dense (Ollama embeddings + numpy), hybrid.

Namespaces: a file at redacted/<archetype-id>/... is tagged with that archetype id;
anything else is "shared". Queries for an archetype search its namespace plus shared.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from pathlib import Path

import privacy_guard as pg

TOK = re.compile(r"[a-z0-9']+")
STOP = set("a an the and or but if of to in on at for with is are was were be been it this that i you he she we they my your me".split())


def tokens(t):
    return [w for w in TOK.findall(t.lower()) if w not in STOP]


def chunk(text, size, overlap):
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 2 <= size:
            cur = f"{cur}\n\n{p}" if cur else p
            continue
        if cur:
            out.append(cur)
        while len(p) > size:
            cut = p.rfind(". ", 0, size)
            cut = cut + 1 if cut > size // 2 else size
            out.append(p[:cut].strip())
            p = p[max(0, cut - overlap):].strip()
        cur = p
    if cur:
        out.append(cur)
    return out


class Index:
    def __init__(self, root: Path):
        self.root = root
        self.meta = json.loads((root / "meta.json").read_text())
        self.chunks = [json.loads(l) for l in (root / "chunks.jsonl").read_text().splitlines() if l.strip()]
        self.df = Counter()
        self.tfs = []
        for c in self.chunks:
            tf = Counter(tokens(c["text"]))
            self.tfs.append(tf)
            self.df.update(tf.keys())
        self.avgdl = sum(sum(t.values()) for t in self.tfs) / max(1, len(self.tfs))
        self.vecs = None
        if self.meta.get("dense") and (root / "vectors.npy").exists():
            import numpy as np
            self.vecs = np.load(root / "vectors.npy")

    def _bm25(self, q, k1=1.4, b=0.75):
        qt = tokens(q)
        N = len(self.chunks)
        scores = []
        for tf in self.tfs:
            dl = sum(tf.values()) or 1
            s = 0.0
            for w in qt:
                if w in tf:
                    idf = math.log(1 + (N - self.df[w] + 0.5) / (self.df[w] + 0.5))
                    s += idf * tf[w] * (k1 + 1) / (tf[w] + k1 * (1 - b + b * dl / self.avgdl))
            scores.append(s)
        return scores

    def _dense(self, q):
        import numpy as np
        from local_llm import embed
        v = np.array(embed([q], kind="query")[0], dtype="float32")
        v /= np.linalg.norm(v) + 1e-9
        return (self.vecs @ v).tolist()

    def search(self, q, k=4, archetype=None):
        allowed = [i for i, c in enumerate(self.chunks) if c["ns"] in ("shared", archetype)]
        if not allowed:
            return []
        bm = self._bm25(q)
        if self.vecs is not None:
            try:
                de = self._dense(q)
            except Exception:
                de = None
        else:
            de = None
        # reciprocal rank fusion
        def ranks(scores):
            order = sorted(allowed, key=lambda i: -scores[i])
            return {i: r for r, i in enumerate(order)}
        rb = ranks(bm)
        fused = {i: 1 / (60 + rb[i]) for i in allowed}
        if de:
            rd = ranks(de)
            for i in allowed:
                fused[i] += 1 / (60 + rd[i])
        top = sorted(allowed, key=lambda i: -fused[i])[:k]
        return [{"text": self.chunks[i]["text"], "source": self.chunks[i]["source"],
                 "ns": self.chunks[i]["ns"], "score": round(fused[i], 5)} for i in top if bm[i] > 0 or de]


def load(vault=None):
    v = vault or pg.vault_path()
    return Index(v / "index")
