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
  let items = 0;
  let components = 0;
  if (!entries) return { chars, words, items, components };

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
    if (han.length > 1) words.push(han.join(""));
  }
  return { chars, words, items, components };
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
  return { chars, words: fromHanly.words, hanlyCount: fromHanly.chars.size, added, items: fromHanly.items, components: fromHanly.components };
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
