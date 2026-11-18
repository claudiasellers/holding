#!/usr/bin/env python3
"""Build train/valid JSONL for LoRA from three sources, entirely on this machine.

  seeds/*.jsonl        synthetic dialogues the frontier model wrote (no personal data)
  --app-scripts FILE   the app's lines library (src/data/lines.json), expanded per archetype
  --from-notes N       ask the LOCAL model to write N grounded pairs from redacted/ notes

Rows are chat format: {"messages":[{"role":"system"|"user"|"assistant","content":...}]}
Output: datasets/train.jsonl, datasets/valid.jsonl, datasets/manifest.json (counts only).
"""
import argparse
import hashlib
import json
import random
import re
from pathlib import Path

import privacy_guard as pg
import rag

GEN_PROMPT = """You are helping build training data for a gentle, comforting parent-figure companion.
Archetype: {name}. Persona: {persona}

Below is a private note the person wrote (already redacted). Do NOT copy sentences from it.
Infer what kinds of moments they want comfort in and what kind of reassurance lands for them.
Write {n} short, separate exchanges. Each: "user" is something the person might say (1-2 sentences,
paraphrased, no names, no specifics that could identify them); "assistant" is the parent figure's reply
(1-3 sentences, warm, marked mirroring: name and gently reflect the feeling back slightly exaggerated in
tone, then offer steadiness; no advice lists, no therapy jargon).

Reply as JSON: {{"pairs": [{{"user": "...", "assistant": "..."}}]}}

Note:
{note}"""


def norm(t):
    return re.sub(r"\W+", " ", t.lower()).strip()


def shingles(t, n=5):
    w = norm(t).split()
    return {" ".join(w[i:i + n]) for i in range(max(1, len(w) - n + 1))}


def load_archetypes(v: Path):
    out = {}
    d = v / "archetypes"
    if d.exists():
        for p in d.glob("*.json"):
            a = json.loads(p.read_text())
            out[a.get("id", p.stem)] = a
    return out


def system_for(arch_id, archetypes):
    a = archetypes.get(arch_id or "")
    return (a.get("persona") or a.get("system")) if a else None


def valid_row(r):
    m = r.get("messages")
    if not isinstance(m, list) or not m or m[-1].get("role") != "assistant":
        return False
    return all(isinstance(x.get("content"), str) and x.get("role") in ("system", "user", "assistant") for x in m)


def from_seeds(v, archetypes):
    for p in sorted((v / "seeds").glob("*.jsonl")):
        for line in p.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            meta = r.get("meta", {})
            msgs = r["messages"]
            if msgs[0]["role"] != "system" and (s := system_for(meta.get("archetype"), archetypes)):
                msgs = [{"role": "system", "content": s}] + msgs
            yield {"messages": msgs}, {"source": "seed", "archetype": meta.get("archetype"), "kind": meta.get("kind")}


TOKEN = re.compile(r"\{(\w+)\}")
ARRIVE = "(The person has just arrived and hasn't said anything.)"


def _fill(text, arch):
    endear = ((arch or {}).get("lexicon") or {}).get("endearments") or []

    def sub(m):
        return endear[0] if m.group(1) == "endearment" and endear else ""
    t = TOKEN.sub(sub, text)
    t = re.sub(r"\s+([,.!?…])", r"\1", t)
    t = re.sub(r"^[,\s]+|,\s*(?=[.!?])", "", t)
    return re.sub(r"\s{2,}", " ", t).strip()


def _user_turn(path):
    top = path[0].lower() if path else ""
    if top in ("opening", "openers", "greeting", "welcome"):
        return ARRIVE, "opener"
    if top in ("stillhere", "silence", "quiet"):
        return "...", "silence"
    if top == "affect" and len(path) > 1:
        return f"I'm feeling {path[1]}.", "mirror" if len(path) > 2 and path[2] in ("name", "mirror") else "comfort"
    if top == "safety":
        return "I don't feel safe right now.", "safety"
    if top == "ordinary" and len(path) > 1:
        return f"(It's {path[1]}. The person has just arrived.)", "opener"
    return ARRIVE, top or "opener"


def _walk(x, path=()):
    """Yield (key_path, text) for every line in a nested lines library."""
    if isinstance(x, str):
        yield path, x
    elif isinstance(x, dict):
        txt = x.get("t") or x.get("text") or x.get("line")
        if isinstance(txt, str):
            yield path, txt
            return
        for k, v in x.items():
            if k == "archetype":
                continue
            yield from _walk(v, path + (k,))
    elif isinstance(x, list):
        for v in x:
            yield from _walk(v, path)


def from_app_scripts(src: Path, archetypes):
    """Accepts a file or a directory of JSON. Shapes:
      - the app's lines library: nested by category, lines as str or {t, ...}; tokens like {endearment}
        are filled from each archetype's lexicon or dropped. Shared lines are expanded per archetype.
      - {"archetype": id, "lines": [...]}   or   {archetype-id: [lines]} where the key is a known archetype.
    """
    files = [src] if src.is_file() else sorted(src.glob("*.json"))
    for p in files:
        data = json.loads(p.read_text())
        items = data if isinstance(data, list) else [data]
        for it in items:
            if isinstance(it, dict) and "lines" in it and "archetype" in it:
                groups = [((), it["lines"], [it["archetype"]])]
            elif isinstance(it, dict) and it and all(k in archetypes for k in it):
                groups = [((), v, [k]) for k, v in it.items()]
            else:
                groups = [((), it, list(archetypes) or [None])]
            for _, payload, aids in groups:
                for path, raw in _walk(payload):
                    user, kind = _user_turn(path)
                    for aid in aids:
                        text = _fill(raw, archetypes.get(aid or ""))
                        if len(text) < 6:
                            continue
                        msgs = [{"role": "user", "content": user}, {"role": "assistant", "content": text}]
                        if s := system_for(aid, archetypes):
                            msgs.insert(0, {"role": "system", "content": s})
                        yield {"messages": msgs}, {"source": "app_script", "archetype": aid,
                                                   "kind": kind, "category": ".".join(path)}


def from_notes(v, archetypes, n_pairs, per_chunk=3):
    from local_llm import available, chat
    if not available():
        raise SystemExit("Ollama not reachable on 127.0.0.1: start it, or drop --from-notes")
    cfg = pg.load_config()
    chunks = []
    for p in pg.iter_text_files(v / "redacted"):
        rel = p.relative_to(v / "redacted")
        ns = rel.parts[0] if len(rel.parts) > 1 else None
        chunks += [(ns, c) for c in rag.chunk(pg.read_text(p), 1500, 0)]
    random.shuffle(chunks)
    made = 0
    ids = list(archetypes) or [None]
    for ns, note in chunks:
        if made >= n_pairs:
            break
        aid = ns if ns in archetypes else random.choice(ids)
        a = archetypes.get(aid or "", {})
        try:
            out = json.loads(chat([{"role": "user", "content": GEN_PROMPT.format(
                name=a.get("name", "a steady, kind parent"), persona=(a.get("persona") or "")[:800],
                n=per_chunk, note=note)}], model=cfg["models"]["chat"], temperature=0.8, json_mode=True))
        except Exception:
            continue
        note_sh = shingles(note, 6)
        for pr in out.get("pairs", []):
            u, r = pr.get("user", "").strip(), pr.get("assistant", "").strip()
            if not u or not r:
                continue
            if len(shingles(u + " " + r, 6) & note_sh) > 1:  # copied from the note: drop
                continue
            msgs = [{"role": "user", "content": u}, {"role": "assistant", "content": r}]
            if s := system_for(aid, archetypes):
                msgs.insert(0, {"role": "system", "content": s})
            made += 1
            yield {"messages": msgs}, {"source": "local_gen", "archetype": aid, "kind": "comfort"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-scripts", type=Path, help="app lines library: a JSON file (src/data/lines.json) or a dir")
    ap.add_argument("--from-notes", type=int, default=0)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    random.seed(a.seed)
    v = pg.vault_path()
    pg.assert_private_dir(v)
    cfg = pg.load_config()
    arch = load_archetypes(v)

    gens = [from_seeds(v, arch)]
    if a.app_scripts:
        gens.append(from_app_scripts(a.app_scripts, arch))
    if a.from_notes:
        gens.append(from_notes(v, arch, a.from_notes))

    rows, seen, sh_list, dropped = [], set(), [], {"invalid": 0, "dup": 0, "near_dup": 0}
    for g in gens:
        for r, meta in g:
            if not valid_row(r):
                dropped["invalid"] += 1
                continue
            key = hashlib.sha1(norm(json.dumps(r["messages"][-2:])).encode()).hexdigest()
            if key in seen:
                dropped["dup"] += 1
                continue
            sh = shingles(r["messages"][-1]["content"])
            if any(len(sh & o) / max(1, len(sh | o)) > 0.8 for o in sh_list[-2000:]):
                dropped["near_dup"] += 1
                continue
            seen.add(key)
            sh_list.append(sh)
            rows.append((r, meta))

    random.shuffle(rows)
    nv = max(1, int(len(rows) * cfg["finetune"]["val_fraction"])) if len(rows) > 10 else 0
    valid, train = rows[:nv], rows[nv:]
    out = v / "datasets"
    out.mkdir(exist_ok=True)
    for name, part in (("train.jsonl", train), ("valid.jsonl", valid)):
        (out / name).write_text("\n".join(json.dumps(r) for r, _ in part) + ("\n" if part else ""))

    def tally(part, key):
        t = {}
        for _, m in part:
            t[str(m.get(key))] = t.get(str(m.get(key)), 0) + 1
        return t
    manifest = {"n_train": len(train), "n_valid": len(valid), "dropped": dropped,
                "by_source": tally(rows, "source"), "by_archetype": tally(rows, "archetype"),
                "by_kind": tally(rows, "kind")}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    pg.report(manifest)


if __name__ == "__main__":
    main()
