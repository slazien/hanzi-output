#!/usr/bin/env python3
"""Builds data/bank.json, the sentence bank the app practises from.

Usage: python3 tools/build_bank.py <downloads-dir>

The downloads directory must hold (see tools/README.md for the URLs):
  hsk.jsonl                       HSK Sentences Audio (CC BY-SA 4.0)
  ud.conllu                       UD Chinese-Beginner / Chinese Grammar Wiki (CC BY-NC-SA 3.0)
  cmn_sentences_detailed.tsv.bz2  Tatoeba Mandarin sentences (CC BY 2.0 FR)
  cmn-eng_links.tsv.bz2           Tatoeba Mandarin-English links
  eng_sentences.tsv.bz2           Tatoeba English sentences
  cedict.gz                       CC-CEDICT (CC BY-SA 4.0), for word meanings
  complete.json                   complete-hsk-vocabulary (MIT), for word list and levels
Needs: pip install pypinyin opencc-python-reimplemented
"""
import bz2, collections, gzip, json, os, re, sys, random
from pypinyin import lazy_pinyin, Style
from opencc import OpenCC

SRC = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
random.seed(7)
t2s = OpenCC("t2s")

def is_han(c): return "一" <= c <= "鿿"
def han(s): return [c for c in s if is_han(c)]

THEMES = json.load(open(os.path.join(ROOT, "tools", "themes.json"), encoding="utf8"))
SOURCES = [
    {"id": "hsk", "name": "HSK Sentences Audio", "licence": "CC BY-SA 4.0", "url": "https://huggingface.co/datasets/no7z/hsk-sentences-audio"},
    {"id": "cgw", "name": "Chinese Grammar Wiki (AllSet Learning), via UD Chinese-Beginner", "licence": "CC BY-NC-SA 3.0", "url": "https://resources.allsetlearning.com/chinese/grammar/"},
    {"id": "tatoeba", "name": "Tatoeba", "licence": "CC BY 2.0 FR", "url": "https://tatoeba.org/sentences/show/"},
    {"id": "juzi", "name": "Written for this app", "licence": "CC BY-SA 4.0", "url": ""},
]
SRC_IDX = {s["id"]: i for i, s in enumerate(SOURCES)}

# ---------- HSK levels (characters), to keep the bank within HSK 1-6 ----------
vocab = json.load(open(os.path.join(SRC, "complete.json"), encoding="utf8"))
char_level = {}
for w in vocab:
    ls = [int(l.split("-")[1]) for l in w["level"] if l.startswith("new-")]
    if ls:
        for c in w["simplified"]:
            if is_han(c): char_level[c] = min(char_level.get(c, 99), min(ls))
def max_level(zh): return max((char_level.get(c, 99) for c in han(zh)), default=0)

# ---------- CC-CEDICT: meanings, and a word list for splitting ----------
def tone_marks(numbered):
    out = []
    for syl in numbered.split():
        syl = syl.replace("u:", "ü").replace("U:", "Ü")
        m = re.match(r"^([A-Za-zü]+)([1-5])$", syl)
        if not m: out.append(syl); continue
        body, tone = m.group(1), int(m.group(2))
        if tone == 5: out.append(body); continue
        marks = {"a": "āáǎà", "e": "ēéěè", "i": "īíǐì", "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ"}
        low = body.lower()
        pos = next((low.index(v) for v in "ae" if v in low), None)
        if pos is None: pos = low.index("ou") if "ou" in low else max((i for i, ch in enumerate(low) if ch in "aeiouü"), default=None)
        if pos is None: out.append(body); continue
        out.append(body[:pos] + marks[low[pos]][tone - 1] + body[pos + 1:])
    return "".join(out).lower()

def clean_gloss(defs):
    senses = [d for d in defs if not re.match(r"^(variant of|old variant|surname |CL:|see |used in |abbr\. for|erhua variant|\(bound form\)$)", d)] or defs
    g = senses[0]
    g = re.sub(r"\s*\([^)]{18,}\)", "", g)          # long asides
    g = re.sub(r"\[[^\]]*\]", "", g)                   # pinyin in brackets
    g = re.sub(r"[一-鿿|]+", "", g).strip(" ;,")
    g = g.split(";")[0].strip()
    return g[:48]

cedict = collections.defaultdict(list)  # simplified -> [(pinyin, gloss, is_proper)]
with gzip.open(os.path.join(SRC, "cedict.gz"), "rt", encoding="utf8") as f:
    for line in f:
        m = re.match(r"^(\S+) (\S+) \[([^\]]+)\] /(.+)/\s*$", line)
        if not m: continue
        simp, py, defs = m.group(2), m.group(3), m.group(4).split("/")
        if not all(is_han(c) for c in simp): continue
        g = clean_gloss(defs)
        if g: cedict[simp].append((tone_marks(py), g, py[:1].isupper()))

# Cost of each word for splitting: common HSK words are cheap, dictionary-only
# words dearer, so 不|知道 beats 不知|道 and 这|种 beats 这种.
import math
word_cost = {}
for w in vocab:
    if all(is_han(c) for c in w["simplified"]):
        word_cost[w["simplified"]] = min(word_cost.get(w["simplified"], 99), 1.5 + math.log(w.get("frequency", 20000) + 10) / 1.6)
for w in cedict:
    if 2 <= len(w) <= 4 and w not in word_cost and not all(c[2] for c in cedict[w]): word_cost[w] = 12.0

# Readings for single-character words that pypinyin gets wrong out of context.
SINGLE = {"了": "le", "的": "de", "得": "de", "着": "zhe", "吗": "ma", "呢": "ne", "吧": "ba", "啊": "a", "么": "me", "们": "men",
          "教": "jiāo", "干": "gàn", "还": "hái", "都": "dōu", "长": "cháng", "行": "xíng", "只": "zhǐ", "为": "wèi", "和": "hé",
          "重": "zhòng", "种": "zhǒng", "给": "gěi", "没": "méi", "会": "huì", "要": "yào", "少": "shǎo", "数": "shù", "发": "fā",
          "差": "chà", "当": "dāng", "便": "biàn", "倒": "dào", "相": "xiāng", "乐": "lè", "觉": "jué", "看": "kàn", "好": "hǎo",
          "那": "nà", "哪": "nǎ", "谁": "shéi", "地": "de", "过": "guò", "个": "gè", "大": "dà", "不": "bù", "一": "yī"}
NOUN_BEFORE_DI = set("土草外本当各此内空田陆天大场基营工")

def pinyin_of(word, prev=""):
    if len(word) == 1:
        if word == "地" and (not prev or prev[-1] in NOUN_BEFORE_DI or len(prev) == 1 and prev not in "慢快"): return "dì"
        if word in SINGLE: return SINGLE[word]
    else:
        # A dictionary reading keeps neutral tones (告诉 gàosu) and erhua (哪儿 nǎr).
        plain = {c[0] for c in cedict.get(word, []) if not c[2]}
        if len(plain) == 1: return next(iter(plain))
        if word.endswith("儿") and word not in ("女儿", "婴儿", "孤儿", "幼儿", "少儿"):
            return "".join(lazy_pinyin(word[:-1], style=Style.TONE)) + "r"
    return "".join(lazy_pinyin(word, style=Style.TONE))

def split_han(run):
    """Cheapest split of a run of Chinese characters into words (dynamic programming)."""
    n = len(run)
    best = [(0.0, 0)] + [(1e9, 0)] * n
    for i in range(1, n + 1):
        for L in range(1, min(4, i) + 1):
            w = run[i - L:i]
            cost = word_cost.get(w, 14.0 if L == 1 else None)
            if cost is None: continue
            if best[i - L][0] + cost < best[i][0]: best[i] = (best[i - L][0] + cost, L)
    out, i = [], n
    while i > 0:
        L = best[i][1]; out.append(run[i - L:i]); i -= L
    return out[::-1]

def segment(zh):
    """Word splitting; punctuation and other symbols become their own tokens."""
    out, run = [], ""
    for c in zh:
        if is_han(c): run += c; continue
        if run: out += split_han(run); run = ""
        if not c.isspace(): out.append(c)
    if run: out += split_han(run)
    return out

# ---------- themes for sentences that come without one ----------
KEYWORDS = [
    ("Shopping", r"\b(buy|bought|shop|shopping|store|sell|sold|sale|cheap|expensive|supermarket|market)\b"),
    ("Money and prices", r"\b(money|price|cost|costs|pay|paid|dollars?|yuan|cash|bank|salary|rich|poor)\b"),
    ("Eating out", r"\b(restaurant|menu|order|waiter|dish|dishes|delicious|tasty|lunch|dinner|breakfast|noodles|dumplings|hungry|eat out)\b"),
    ("Cooking and groceries", r"\b(cook|cooking|kitchen|rice|vegetables?|fruit|apples?|eggs?|meat|bread|milk)\b"),
    ("Drinks and cafés", r"\b(tea|coffee|drink|drinks|drank|beer|wine|juice|water|thirsty|café|cafe)\b"),
    ("Family", r"\b(mother|father|mom|mum|dad|parents?|brother|sister|son|daughter|grandfather|grandmother|grandma|grandpa|husband|wife|family|uncle|aunt)\b"),
    ("Friends and relationships", r"\b(friends?|boyfriend|girlfriend|classmates?|neighbou?rs?|love|marry|married)\b"),
    ("Home and housework", r"\b(house|home|room|bed|door|window|clean|wash|washing|furniture|apartment|table|chair)\b"),
    ("Weather and seasons", r"\b(weather|rain|raining|rainy|snow|snowing|wind|windy|cold|hot|warm|sunny|cloudy|spring|summer|autumn|winter)\b"),
    ("Time and dates", r"\b(o'clock|today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|year|minutes?|hours?|morning|afternoon|evening|tonight|late|early)\b"),
    ("Getting around town", r"\b(bus|subway|metro|taxi|train|station|bike|bicycle|car|drive|driving|drove|traffic|ride)\b"),
    ("Asking for directions", r"\b(where is|where's|how do i get|turn left|turn right|straight|near|nearby|far from|next to|opposite|behind|in front of)\b"),
    ("Travel and hotels", r"\b(travel|trip|hotel|airport|plane|flight|ticket|passport|luggage|tourist|vacation|abroad|beijing|shanghai|china)\b"),
    ("School and studying", r"\b(school|student|students|teacher|class|classroom|homework|exam|test|study|studying|studied|university|college|lesson|library)\b"),
    ("Work and the office", r"\b(work|working|worked|job|office|company|boss|colleagues?|meeting|busy|manager|business)\b"),
    ("Learning Chinese", r"\b(chinese|mandarin|characters?|pinyin|pronunciation|language|languages|english|speak|translate)\b"),
    ("Phones and technology", r"\b(computer|internet|online|phone|cell ?phone|mobile|email|website|camera|tv|television|app)\b"),
    ("Phone calls and messages", r"\b(call|called|calling|message|text me|letter|reply|answer the phone)\b"),
    ("Health and the doctor", r"\b(doctor|hospital|sick|ill|medicine|headache|fever|a cold|hurt|hurts|pain|tired|health|healthy)\b"),
    ("Sports and exercise", r"\b(sport|sports|exercise|run|running|ran|swim|swimming|football|soccer|basketball|tennis|gym|ball)\b"),
    ("Clothes and appearance", r"\b(clothes|shirt|dress|shoes|wear|wearing|wore|hat|coat|pants|trousers|skirt|tall|short|pretty|beautiful|handsome|hair)\b"),
    ("Hobbies", r"\b(hobby|hobbies|like to|likes to|sing|singing|dance|dancing|draw|paint|play the|game|games)\b"),
    ("Films, music and books", r"\b(movie|movies|film|films|music|song|songs|book|books|read|reading|novel|story|newspaper)\b"),
    ("Holidays and festivals", r"\b(holiday|festival|new year|birthday|christmas|gift|present|party|celebrate)\b"),
    ("Nature and animals", r"\b(dog|dogs|cat|cats|bird|birds|fish|horse|animal|animals|tree|trees|flower|flowers|mountain|river|sea|lake|park|moon|sun|sky)\b"),
    ("City and countryside", r"\b(city|town|village|countryside|street|road|building|bridge)\b"),
    ("Feelings and opinions", r"\b(happy|sad|angry|afraid|worried|think|thinks|thought|feel|feels|felt|hope|like|likes|hate|interesting|boring)\b"),
    ("Plans and invitations", r"\b(let's|shall we|would you like|want to go|plan|plans|invite|together|come with)\b"),
    ("Asking for help", r"\b(help|please|could you|can you|may i|excuse me|sorry)\b"),
    ("Past experiences", r"\b(have you ever|has been to|have been to|never been|once|used to|last year|last week|ago)\b"),
    ("Hopes and future plans", r"\b(will|going to|next year|next week|in the future|want to be|wish)\b"),
    ("Greetings and introductions", r"\b(hello|hi|good morning|goodbye|bye|my name|nice to meet|thank you|thanks|how are you|welcome)\b"),
    ("Daily routine", r"\b(get up|got up|gets up|go to bed|sleep|sleeping|every day|shower|usually|often)\b"),
    ("Describing people", r"\b(he is a|she is a|years old|kind|clever|smart|lazy|friendly|young|old man|old woman)\b"),
    ("Going out", r"\b(go out|going out|cinema|bar|concert|see a movie|tonight)\b"),
]
KEYWORDS = [(THEMES.index(t), re.compile(r)) for t, r in KEYWORDS]
HSK_TOPIC = {"greetings": "Greetings and introductions", "school_work": "School and studying", "shopping": "Shopping", "transport": "Getting around town",
             "location": "Asking for directions", "nature": "Nature and animals", "health_body": "Health and the doctor", "time": "Time and dates",
             "food": "Eating out", "family": "Family", "weather_state": "Weather and seasons", "sports_leisure": "Sports and exercise",
             "feelings": "Feelings and opinions", "identity": "Describing people", "daily_actions": "Daily routine"}

def theme_of(en, given=None):
    low = en.lower()
    if given in THEMES:
        return THEMES.index(given)
    for idx, rx in KEYWORDS:
        if rx.search(low): return idx
    return -1

# ---------- collect sentences ----------
entries = []   # dict(tokens=[(word, pinyin)], en, theme, src, ref, note)
seen = set()
def add(tokens, en, theme, src, ref="", note=""):
    zh = "".join(w for w, _ in tokens)
    key = "".join(han(zh))
    if not key or key in seen: return False
    if not (2 <= len(key) <= 26) or max_level(zh) > 6: return False
    seen.add(key)
    entries.append({"tokens": tokens, "en": en.strip(), "theme": theme, "src": SRC_IDX[src], "ref": ref, "note": note.strip()})
    return True

def annotate(zh):
    toks, prev, seg = [], "", segment(zh)
    for i, w in enumerate(seg):
        nxt = seg[i + 1] if i + 1 < len(seg) else ""
        if w == "长" and nxt in ("得", "大", "了", "高"): py = "zhǎng"        # to grow
        elif w == "只" and prev and prev[-1] in "这那一两三四五六七八九十几每": py = "zhī"  # measure word
        else: py = pinyin_of(w, prev) if is_han(w[0]) else ""
        toks.append((w, py))
        prev = w if is_han(w[0]) else ""
    return toks

# 1. Sentences written for this app (theme<TAB>Chinese<TAB>English)
for line in open(os.path.join(ROOT, "tools", "own_sentences.tsv"), encoding="utf8"):
    line = line.rstrip("\n")
    if not line or line.startswith("#"): continue
    theme, zh, en = line.split("\t")
    assert theme in THEMES, theme
    add(annotate(zh), en, THEMES.index(theme), "juzi")

# 2. HSK Sentences Audio: comes with words, pinyin and a grammar point
gloss_given = {}
for line in open(os.path.join(SRC, "hsk.jsonl"), encoding="utf8"):
    r = json.loads(line)
    zh, toks, i = r["chinese"], [], 0
    ok = True
    for t in r["tokens"]:
        j = zh.find(t["word"], i)
        if j < 0: ok = False; break
        toks += [(c, "") for c in zh[i:j] if not c.isspace()]
        toks.append((t["word"], t["pinyin"].replace(" ", "").lower()))
        gloss_given.setdefault(t["word"], t.get("gloss_en", ""))
        i = j + len(t["word"])
    if not ok: continue
    toks += [(c, "") for c in zh[i:] if not c.isspace()]
    gp = r.get("grammar_points") or []
    add(toks, r["translation"]["en"], theme_of(r["translation"]["en"], HSK_TOPIC.get(r["topic"])), "hsk", r["id"], gp[0] if gp else "")

# 3. Chinese Grammar Wiki sentences (UD Chinese-Beginner treebank)
meta, toks = {}, []
def flush():
    if meta.get("text") and meta.get("text_en") and toks:
        note = meta.get("structure_verbose", "")
        if meta.get("structure"): note = f"{note}: {meta['structure']}" if note else meta["structure"]
        add(list(toks), meta["text_en"], theme_of(meta["text_en"]), "cgw", meta.get("url", "").rsplit("/", 1)[-1], note)
for line in open(os.path.join(SRC, "ud.conllu"), encoding="utf8"):
    line = line.rstrip("\n")
    if line.startswith("# "):
        if line.startswith("# sent_id"): flush(); meta, toks = {}, []
        k, _, v = line[2:].partition(" = ")
        meta[k] = v
    elif line and line[0].isdigit():
        cols = line.split("\t")
        if "-" in cols[0] or "." in cols[0]: continue
        form = cols[1]
        tr = re.search(r"Translit=([^|]+)", cols[9])
        py = tr.group(1).replace("_", "").lower() if tr and is_han(form[0]) else ""
        toks.append((form, py))
flush()

# 4. Tatoeba: short everyday pairs, converted to simplified characters
cmn = {}
with bz2.open(os.path.join(SRC, "cmn_sentences_detailed.tsv.bz2"), "rt", encoding="utf8") as f:
    for line in f:
        p = line.rstrip("\n").split("\t")
        if len(p) >= 3: cmn[p[0]] = p[2]
links = collections.defaultdict(list)
with bz2.open(os.path.join(SRC, "cmn-eng_links.tsv.bz2"), "rt") as f:
    for line in f:
        a, b = line.split()
        if a in cmn: links[b].append(a)
best = {}
with bz2.open(os.path.join(SRC, "eng_sentences.tsv.bz2"), "rt", encoding="utf8") as f:
    for line in f:
        p = line.rstrip("\n").split("\t")
        if len(p) < 3 or p[0] not in links: continue
        en = p[2]
        if not (6 <= len(en) <= 80) or re.search(r"\bTom\b|\bMary\b", en): continue   # Tatoeba's stock names
        for cid in links[p[0]]:
            if cid not in best or len(en) < len(best[cid]): best[cid] = en
tat = []
for cid, en in best.items():
    zh = t2s.convert(cmn[cid]).strip()
    if re.search(r"[A-Za-z0-9０-９“”\"「」『』…—·《》（）()]", zh) or "甚" in zh: continue
    h = han(zh)
    if not (3 <= len(h) <= 18) or zh[-1] not in "。？！": continue
    if sum(zh.count(c) for c in "。？！") != 1: continue
    tat.append((max_level(zh), len(h), cid, zh, en))
# A capped sample per HSK level, weighted towards the easier levels.
random.shuffle(tat)
quota = {1: 3000, 2: 3000, 3: 2500, 4: 1500, 5: 800, 6: 500}
for lvl, _, cid, zh, en in tat:
    if quota.get(lvl, 0) <= 0: continue
    if add(annotate(zh), en, theme_of(en), "tatoeba", cid): quota[lvl] -= 1

# Meanings for grammar words, where a dictionary's first sense misleads.
PARTICLES = {("了", "le"): "(completed action or change)", ("的", "de"): "(possessive or describing particle)", ("吗", "ma"): "(question particle)",
             ("呢", "ne"): "(question or ongoing particle)", ("吧", "ba"): "(suggestion particle)", ("着", "zhe"): "(ongoing state)",
             ("过", "guo"): "(past experience)", ("过", "guò"): "to pass; (past experience)", ("得", "de"): "(links a verb to how it is done)",
             ("地", "de"): "(-ly, adverb particle)", ("们", "men"): "(plural for people)", ("啊", "a"): "(exclamation particle)",
             ("没有", "méiyǒu"): "not have; did not", ("没", "méi"): "not; not have", ("个", "gè"): "(general measure word)",
             ("把", "bǎ"): "(marks the object acted on)", ("被", "bèi"): "by (passive)", ("在", "zài"): "at; in; (in progress)",
             ("会", "huì"): "can; will", ("要", "yào"): "to want; will; must", ("就", "jiù"): "then; right away; just",
             ("才", "cái"): "only then; just", ("还", "hái"): "still; also", ("都", "dōu"): "all; both", ("也", "yě"): "also; too"}

def gloss_for(w, py):
    if (w, py) in PARTICLES: return PARTICLES[(w, py)]
    cands = cedict.get(w, [])
    match = [c for c in cands if c[0] == py and not c[2]] or [c for c in cands if not c[2]] or cands
    if match: return match[0][1]
    return clean_gloss(re.split(r"[;/]", gloss_given[w])) if gloss_given.get(w) else ""

# ---------- word dictionary: default pinyin and a short meaning ----------
readings = collections.defaultdict(collections.Counter)
for e in entries:
    for w, py in e["tokens"]:
        if py: readings[w][py] += 1
dictionary = {}
for w, counter in readings.items():
    default = counter.most_common(1)[0][0]
    entry = [default, gloss_for(w, default)]
    # Meanings for the other readings that occur (长 cháng / zhǎng, 地 dì / de ...).
    alt = {py: gloss_for(w, py) for py in counter if py != default}
    alt = {py: g for py, g in alt.items() if g and g != entry[1]}
    if alt: entry.append(alt)
    dictionary[w] = entry

# ---------- write ----------
rows = []
for e in entries:
    z = " ".join(w for w, _ in e["tokens"])
    over = {str(i): py for i, (w, py) in enumerate(e["tokens"]) if py and dictionary[w][0] != py}
    row = [z, e["en"], e["theme"], e["src"], e["ref"], e["note"]]
    if over: row.append(over)
    rows.append(row)
out = {"version": 1, "sources": SOURCES, "themes": THEMES, "dict": dictionary, "sentences": rows}
path = os.path.join(ROOT, "data", "bank.json")
json.dump(out, open(path, "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
by_src = collections.Counter(SOURCES[e["src"]]["id"] for e in entries)
print("sentences:", len(rows), dict(by_src), "| words:", len(dictionary), "| bytes:", os.path.getsize(path))
print("without theme:", sum(1 for e in entries if e["theme"] < 0))
