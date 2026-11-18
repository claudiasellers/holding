#!/usr/bin/env python3
"""Redact raw/ -> redacted/. Prints category tallies only.

Layers:
  1. Regex: email, phone, URL, IP, SSN-like, payment card (Luhn), street address, postcode, dates of birth.
  2. Names list: vault/names.txt (one per line, written by the person locally). Pseudonymised
     consistently: every mention of the same name becomes the same [PERSON_n].
  3. Optional local-LLM pass (config redaction.llm_pass or --llm): asks the local model for
     remaining personal names/places as JSON spans. Runs on 127.0.0.1 only.

Usage: redact.py [--llm] [--keep-dates]
"""
import argparse
import json
import re

import privacy_guard as pg

PATTERNS = [
    ("EMAIL", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    ("URL", re.compile(r"\bhttps?://\S+|\bwww\.\S+", re.I)),
    ("IP", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("PHONE", re.compile(r"(?<!\w)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\w)")),
    ("ADDRESS", re.compile(r"\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Boulevard|Blvd|Way|Place|Pl|Terrace|Close)\b\.?")),
    ("POSTCODE", re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b|\b\d{5}(?:-\d{4})?\b")),
    ("DOB", re.compile(r"\b(?:born|dob|birthday)[:\s]+\S+(?:\s\S+){0,2}", re.I)),
]


def luhn_ok(s):
    d = [int(c) for c in re.sub(r"\D", "", s)]
    if not 13 <= len(d) <= 19:
        return False
    tot = 0
    for i, x in enumerate(reversed(d)):
        if i % 2:
            x *= 2
            x -= 9 if x > 9 else 0
        tot += x
    return tot % 10 == 0


class Pseudonymiser:
    def __init__(self, names):
        self.map = {}
        self.names = sorted({n.strip() for n in names if n.strip()}, key=len, reverse=True)
        self.rx = re.compile(r"\b(" + "|".join(map(re.escape, self.names)) + r")\b", re.I) if self.names else None

    def tag(self, name):
        key = name.lower()
        if key not in self.map:
            self.map[key] = f"[PERSON_{len(self.map) + 1}]"
        return self.map[key]

    def apply(self, text, tally):
        if not self.rx:
            return text

        def sub(m):
            tally["NAME_LIST"] = tally.get("NAME_LIST", 0) + 1
            return self.tag(m.group(0))
        return self.rx.sub(sub, text)


def regex_pass(text, tally, keep_dates):
    for cat, rx in PATTERNS:
        if cat == "DOB" and keep_dates:
            continue

        def sub(m, cat=cat):
            if cat == "CARD" and not luhn_ok(m.group(0)):
                return m.group(0)
            tally[cat] = tally.get(cat, 0) + 1
            return f"[{cat}]"
        text = rx.sub(sub, text)
    return text


LLM_PROMPT = (
    "List every personal name of a real individual, nickname, specific place name (town, school, street, "
    "workplace) and organisation in the text below. Do not list family-role words like mom, dad, grandma. "
    'Reply as JSON: {"names": [...], "places": [...], "orgs": [...]}. Text:\n\n'
)


def llm_pass(text, pseudo, tally):
    from local_llm import chat
    out = text
    for i in range(0, len(text), 3000):
        try:
            found = json.loads(chat([{"role": "user", "content": LLM_PROMPT + text[i:i + 3000]}],
                                    model=pg.load_config()["models"]["redact_helper"], temperature=0, json_mode=True))
        except Exception:
            tally["LLM_ERRORS"] = tally.get("LLM_ERRORS", 0) + 1
            continue
        for cat, key in (("PERSON", "names"), ("PLACE", "places"), ("ORG", "orgs")):
            for ent in found.get(key, []) or []:
                if not isinstance(ent, str) or len(ent) < 2 or ent.startswith("["):
                    continue
                rep = pseudo.tag(ent) if cat == "PERSON" else f"[{cat}]"
                out, n = re.subn(r"\b" + re.escape(ent) + r"\b", rep, out)
                if n:
                    tally["LLM_" + cat] = tally.get("LLM_" + cat, 0) + n
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--llm", action="store_true", help="add local-LLM name/place pass (needs Ollama)")
    ap.add_argument("--keep-dates", action="store_true")
    a = ap.parse_args()
    v = pg.vault_path()
    pg.assert_private_dir(v)
    names_file = v / "names.txt"
    pseudo = Pseudonymiser(pg.read_text(names_file).splitlines() if names_file.exists() else [])
    use_llm = a.llm or pg.load_config()["redaction"]["llm_pass"]
    tally, n_files = {}, 0
    for p in pg.iter_text_files(v / "raw"):
        text = pg.read_text(p)
        text = regex_pass(text, tally, a.keep_dates)
        text = pseudo.apply(text, tally)
        if use_llm:
            text = llm_pass(text, pseudo, tally)
        dest = v / "redacted" / p.relative_to(v / "raw")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
        n_files += 1
    rep = {"n_files_redacted": n_files, "replacements_by_category": tally,
           "n_distinct_people_pseudonymised": len(pseudo.map), "llm_pass": bool(use_llm),
           "names_list_entries": len(pseudo.names)}
    (v / "logs" / "redaction_report.json").write_text(json.dumps(rep, indent=2))
    pg.report(rep)


if __name__ == "__main__":
    main()
