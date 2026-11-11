// The sentence bank: stored sentences the app picks from, so no AI is needed
// to get something to practise. Built by tools/build_bank.py into data/bank.json.

import { hanChars, isKnownWord } from "./known.js";

let loading = null;
let bank = null;

// Loads the bank once. Each sentence is unpacked on first use.
export function loadBank() {
  if (!loading) {
    loading = fetch("data/bank.json")
      .then((r) => {
        if (!r.ok) throw new Error(`The sentence bank could not be loaded (${r.status}).`);
        return r.json();
      })
      .then((data) => {
        bank = {
          sources: data.sources,
          themes: data.themes,
          dict: data.dict,
          rows: data.sentences.map((row) => {
            const tokens = row[0].split(" ");
            const chinese = tokens.join("");
            return { tokens, chinese, han: hanChars(chinese), english: row[1], theme: row[2] >= 0 ? data.themes[row[2]] : "", src: row[3], ref: row[4], note: row[5], over: row[6] || null };
          }),
        };
        return bank;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
  }
  return loading;
}

export const bankReady = () => bank;

function wordsOf(row) {
  return row.tokens.map((text, i) => {
    const entry = bank.dict[text];
    if (!entry) return { text, pinyin: "", gloss: "" };
    const pinyin = row.over?.[i] || entry[0];
    return { text, pinyin, gloss: entry[2]?.[pinyin] || entry[1] || "" };
  });
}

// Where a sentence came from, for the credit line under the reference answer.
export function creditOf(item) {
  const source = bank?.sources[item.src];
  if (!source) return null;
  if (source.id === "tatoeba") return { text: `Tatoeba #${item.ref}`, url: `https://tatoeba.org/sentences/show/${item.ref}`, licence: source.licence };
  if (source.id === "cgw") return { text: "Chinese Grammar Wiki, AllSet Learning", url: item.ref ? `https://resources.allsetlearning.com/chinese/grammar/${item.ref}` : source.url, licence: source.licence };
  if (source.id === "hsk") return { text: "HSK Sentences Audio", url: source.url, licence: source.licence };
  return null;
}

// Rows that fit the learner's limits and the chosen theme and grammar.
export function fitting({ known, allowedNew, maxNewPct, maxNewWordsPct, theme, grammarRe, contains }) {
  if (!bank) return [];
  const re = grammarRe ? new RegExp(grammarRe) : null;
  const out = [];
  for (const row of bank.rows) {
    if (theme && row.theme !== theme) continue;
    if (contains && !row.chinese.includes(contains)) continue;
    if (re && !re.test(row.chinese)) continue;
    let fresh = 0;
    let over = false;
    for (const c of row.han) {
      if (!known.chars.has(c)) {
        fresh++;
        if (allowedNew && !allowedNew.has(c)) { over = true; break; }
      }
    }
    if (over || (fresh / row.han.length) * 100 > maxNewPct + 0.01) continue;
    if (maxNewWordsPct < 100) {
      let words = 0;
      let newWords = 0;
      for (const t of row.tokens) {
        if (!hanChars(t).length) continue;
        words++;
        if (!isKnownWord(t, known)) newWords++;
      }
      if ((newWords / words) * 100 > maxNewWordsPct + 0.01) continue;
    }
    out.push(row);
  }
  return out;
}

const toItem = (row) => ({
  english: row.english,
  chinese: row.chinese,
  words: wordsOf(row),
  theme: row.theme,
  note: row.note || "",
  src: row.src,
  ref: row.ref,
});

// A different sentence that reuses words from `chinese`, for reviewing the
// same material without repeating the sentence word for word. Returns null
// when nothing among `rows` shares a word of two or more characters with it.
export function variantOf(chinese, words, rows, avoid = new Set()) {
  const keys = [...new Set((words || []).map((w) => w.text).filter((t) => hanChars(t).length >= 2))];
  if (!keys.length) return null;
  let best = null;
  let bestShared = 0;
  for (const row of rows) {
    if (row.chinese === chinese || avoid.has(row.chinese)) continue;
    const shared = keys.filter((k) => row.chinese.includes(k)).length;
    if (shared > bestShared || (shared === bestShared && shared > 0 && Math.random() < 0.3)) {
      best = row;
      bestShared = shared;
    }
  }
  return best ? toItem(best) : null;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks `count` sentences from the fitting rows: ones containing recent weak
// points first (up to a third), then a spread across themes, skipping
// sentences practised recently when there are enough others.
export function pick(rows, { count, weak = [], avoid = new Set(), spreadThemes = false }) {
  const freshRows = rows.filter((r) => !avoid.has(r.chinese));
  const pool = shuffle(freshRows.length >= count ? freshRows : rows);
  const chosen = [];
  const used = new Set();
  const take = (row) => {
    if (used.has(row.chinese) || chosen.length >= count) return false;
    used.add(row.chinese);
    chosen.push(row);
    return true;
  };
  if (weak.length) {
    const limit = Math.ceil(count / 3);
    for (const row of pool) {
      if (chosen.length >= limit) break;
      if (weak.some((w) => row.chinese.includes(w))) take(row);
    }
  }
  if (spreadThemes) {
    const perTheme = new Map();
    for (const row of pool) {
      const n = perTheme.get(row.theme) || 0;
      if (n >= 2 && row.theme) continue; // at most two per theme in a mixed session
      if (take(row)) perTheme.set(row.theme, n + 1);
    }
  }
  for (const row of pool) take(row);
  return shuffle(chosen).map(toItem);
}
