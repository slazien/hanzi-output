"""Applies the result of tools/audit_bank.mjs.

Reads tools/bank_audit.json, writes the rejected pairs to
tools/bank_rejected.tsv (kept in the repository, and honoured by
build_bank.py on the next rebuild) and removes them from data/bank.json.

    python3 tools/apply_audit.py
"""
import json, os, re, collections

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
audit = json.load(open(os.path.join(ROOT, "tools", "bank_audit.json"), encoding="utf8"))
# Chinese does not mark tense, so "the English is in the past tense" is not a
# real mismatch: those pairs are kept.
TENSE_ONLY = re.compile(r"tense|时态|过去时|现在时|does(?: not|n['’]t) (?:mark|specify|indicate|state|say) (?:the |a |any )?(?:time|past|tense|action as past)|not marked", re.I)
rejected = {}
kept_tense = 0
for r in audit["rejected"]:
    if r["verdict"] == "mismatch" and TENSE_ONLY.search(r["reason"]):
        kept_tense += 1
        continue
    rejected.setdefault((r["zh"], r["en"]), (r["verdict"], " ".join(r["reason"].split())))

tsv = os.path.join(ROOT, "tools", "bank_rejected.tsv")
with open(tsv, "w", encoding="utf8") as f:
    f.write("# Sentence pairs left out of the bank after the quality pass (tools/audit_bank.mjs).\n# chinese\tenglish\tverdict\treason\n")
    for (zh, en), (verdict, reason) in sorted(rejected.items()):
        f.write("\t".join([zh, en.replace("\t", " "), verdict, reason]) + "\n")

path = os.path.join(ROOT, "data", "bank.json")
bank = json.load(open(path, encoding="utf8"))
before = len(bank["sentences"])
bank["sentences"] = [s for s in bank["sentences"] if (s[0].replace(" ", ""), s[1]) not in rejected]
used = {w for s in bank["sentences"] for w in s[0].split(" ")}
bank["dict"] = {w: v for w, v in bank["dict"].items() if w in used}
json.dump(bank, open(path, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
by = collections.Counter(v for v, _ in rejected.values())
by_src = collections.Counter(bank["sources"][s[3]]["id"] for s in bank["sentences"])
print(f"kept {kept_tense} pairs flagged only for tense")
print(f"checked {len(audit['checked'])}, rejected {len(rejected)} {dict(by)}; bank {before} -> {len(bank['sentences'])} {dict(by_src)}; bytes {os.path.getsize(path)}")
