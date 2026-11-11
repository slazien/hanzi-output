// Turns a Hanly "learning progress" export into the set of characters you know,
// and measures sentences against that set.

import { HSK_CHARS } from "../data/hsk.js";

const REVERSE = "_reverse";

export const isHan = (ch) => ch >= "一" && ch <= "鿿";
export const hanChars = (text) => [...text].filter(isHan);

// Hanly export: { "字": {progressPercent, learningStatus}, "字_reverse": {...}, ... }
export function parseHanly(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("The file does not look like a Hanly progress export.");
  }
  const entries = {};
  for (const [key, value] of Object.entries(json)) {
    const p = value?.progressPercent;
    if (typeof p === "number" && Number.isFinite(p)) entries[key] = p;
  }
  if (!Object.keys(entries).length) {
    throw new Error("No entries with a progressPercent were found in the file.");
  }
  return entries;
}

// Returns { chars:Set, words:string[], items, components } for the chosen rule.
// - A single-character entry with no "_reverse" twin is treated as a component
//   (氵, 亻, 辶 ...) and never counts as a known character.
// - A character counts as known when its own entry passes, or when a
//   multi-character entry containing it passes.
export function knownFromHanly(entries, rule, cutoff) {
  const chars = new Set();
  const words = [];
  const wordSet = new Set(); // every passing item, single characters included
  let items = 0;
  let components = 0;
  if (!entries) return { chars, words, wordSet, items, components };

  for (const key of Object.keys(entries)) {
    if (key.endsWith(REVERSE)) continue;
    items++;
    const normal = entries[key];
    const reverse = entries[key + REVERSE];
    const hasReverse = typeof reverse === "number";
    const han = hanChars(key);
    if ([...key].length === 1 && !hasReverse) {
      components++;
      continue;
    }
    if (!han.length) continue;
    let pass;
    if (rule === "any") pass = true;
    else if (rule === "normal") pass = normal >= cutoff;
    else if (rule === "both") pass = hasReverse && normal >= cutoff && reverse >= cutoff;
    else pass = hasReverse && reverse >= cutoff;
    if (!pass) continue;
    han.forEach((c) => chars.add(c));
    wordSet.add(han.join(""));
    if (han.length > 1) words.push(han.join(""));
  }
  return { chars, words, wordSet, items, components };
}

export function buildKnown(state) {
  const s = state.settings;
  const fromHanly = knownFromHanly(state.hanly?.entries, s.knownRule, s.cutoff);
  const chars = new Set(fromHanly.chars);
  let added = 0;
  for (const c of hanChars(state.extraKnown || "")) {
    if (!chars.has(c)) {
      chars.add(c);
      added++;
    }
  }
  // A starting HSK level: every character first taught up to that level counts as known.
  let fromLevel = 0;
  const level = Number(s.baseLevel) || 0;
  if (level) {
    const lists = HSK_CHARS[s.hskScheme] || HSK_CHARS.new;
    for (const c of lists.slice(0, level).join("")) {
      if (!chars.has(c)) {
        chars.add(c);
        fromLevel++;
      }
    }
  }
  const wordSet = new Set(fromHanly.wordSet);
  const words = [...fromHanly.words];
  for (const w of state.extraWords || []) {
    if (!wordSet.has(w)) {
      wordSet.add(w);
      if ([...w].length > 1) words.push(w);
    }
  }
  // With a starting level there is no list of studied words, so a word made
  // entirely of known characters counts as known.
  return { chars, words, wordSet, hanlyCount: fromHanly.chars.size, added, fromLevel, loose: Boolean(level), items: fromHanly.items, components: fromHanly.components };
}

// Characters allowed as "new" under the HSK cap (0 = no cap).
export function hskAllowed(scheme, cap) {
  if (!cap) return null;
  const levels = HSK_CHARS[scheme] || HSK_CHARS.new;
  return new Set(levels.slice(0, cap).join(""));
}

export function hskLevelOf(ch, scheme) {
  const levels = HSK_CHARS[scheme] || HSK_CHARS.new;
  const i = levels.findIndex((l) => l.includes(ch));
  return i < 0 ? null : i + 1;
}

// Share of new characters = new Han characters / all Han characters in the
// sentence, counting every occurrence.
export function measure(chinese, known, allowedNew) {
  const han = hanChars(chinese);
  const newOnes = han.filter((c) => !known.has(c));
  const distinctNew = [...new Set(newOnes)];
  const overCap = allowedNew ? distinctNew.filter((c) => !allowedNew.has(c)) : [];
  return {
    total: han.length,
    newCount: newOnes.length,
    pct: han.length ? (newOnes.length / han.length) * 100 : 0,
    distinctNew,
    overCap,
  };
}

// A word counts as known when it was studied (a passing Hanly item or one
// marked in this app) or when it is a single known character.
export function isKnownWord(text, known) {
  const han = hanChars(text).join("");
  if (!han) return true;
  if (known.wordSet.has(han) || (han.length === 1 && known.chars.has(han))) return true;
  return Boolean(known.loose) && [...han].every((c) => known.chars.has(c));
}

// Share of new words = words not known / all words in the sentence
// (punctuation ignored), using the word breakdown that came with the sentence.
export function measureWords(words, known) {
  const real = (words || []).filter((w) => hanChars(w.text).length);
  const fresh = real.filter((w) => !isKnownWord(w.text, known));
  return {
    total: real.length,
    newCount: fresh.length,
    pct: real.length ? (fresh.length / real.length) * 100 : 0,
    newWords: [...new Set(fresh.map((w) => w.text))],
  };
}

// The hardest HSK level among a sentence's characters, as a label.
export function sentenceHsk(chinese, scheme) {
  let max = 0;
  for (const c of new Set(hanChars(chinese))) {
    const level = hskLevelOf(c, scheme);
    if (level == null) return "Beyond HSK";
    if (level > max) max = level;
  }
  if (!max) return "";
  return max === 7 ? "HSK 7-9" : `HSK ${max}`;
}
