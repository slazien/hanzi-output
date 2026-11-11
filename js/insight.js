// Turns the attempt log into a picture of progress and of weak areas.
// Everything here is computed on the device from state.log.

import { GRAMMAR } from "../data/grammar.js";

const DAY = 24 * 60 * 60 * 1000;

// Error categories the grader chooses from, one per mistake.
export const CATEGORIES = {
  word_choice: "Word choice",
  measure_word: "Measure words",
  aspect: "了 / 过 / 着",
  word_order: "Word order",
  ba_bei: "把 / 被",
  complement: "Complements",
  particle: "Particles (的 地 得 吗 呢)",
  preposition: "Prepositions (在 给 对 跟)",
  negation: "Negation and adverbs",
  connector: "Linking clauses",
  missing_word: "Missing word",
  extra_word: "Extra word",
  character: "Wrong character",
  other: "Other",
};

// Labels for display. "natural" is recorded by the app when an answer was
// correct but not how a native speaker would say it; the grader cannot pick it
// as a mistake type.
export const CATEGORY_LABELS = { ...CATEGORIES, natural: "Natural phrasing" };

// Bank sentences that exercise a category, where a simple test exists.
export const CATEGORY_RE = {
  measure_word: "[一二两三四五六七八九十几这那每][个本杯件只张条位口家块辆双]",
  aspect: "[\\u4e00-\\u9fff](了|过|着)",
  ba_bei: "把|被",
  complement: "看见|听懂|做完|吃完|找到|听到|看到|学会|写完|买到|记住|上来|上去|下来|下去|进来|进去|出来|出去|回来|回去|过来|起来|得(很|不|太|真|非常)",
  particle: "[\\u4e00-\\u9fff](的|地|得)[\\u4e00-\\u9fff]|吗|呢|吧",
  preposition: "在|给|对|跟|从|向|往|离",
  negation: "不|没|别",
  connector: "因为|所以|但是|可是|如果|虽然|而且|然后|或者|还是",
  word_order: "昨天|今天|明天|每天|以前|以后|的时候|在.+(吃|看|学|工作|住|买|等)",
};

// A miss counts fully when the sentence was forgotten or the answer shown,
// and half when it was rated Hard or scored under 60.
function missOf(e) {
  if (e.r === 1 || e.sc == null) return 1;
  if (e.r === 2 || e.sc < 60) return 0.5;
  return 0;
}

// Grammar patterns an attempt exercised: the one chosen for the session and
// the ones found in the sentence.
const patternsIn = (e) => [...new Set([e.g, ...(e.p || [])].filter(Boolean))];

// ---------- weak areas ----------
// Each area keeps a time-decayed count of attempts and misses (half-life two
// weeks), smoothed so one bad sentence cannot put an area at the top.
const HALF_LIFE = 14;
const PRIOR_ATTEMPTS = 4;
const MIN_ATTEMPTS = 3; // effective (decayed) attempts before an area is listed
const MIN_RATIO = 1.5; // how much worse than overall an area must be

export function weakAreas(log, now = Date.now()) {
  const areas = new Map();
  const bump = (kind, key, weight, miss) => {
    const id = `${kind}:${key}`;
    const a = areas.get(id) || { kind, key, n: 0, e: 0, raw: 0 };
    a.n += weight;
    a.e += weight * miss;
    a.raw += 1;
    areas.set(id, a);
  };
  let total = 0;
  let totalMiss = 0;
  let graded = 0; // decayed count of attempts that could show an error category
  for (const e of log) {
    const w = Math.pow(0.5, (now - e.t) / DAY / HALF_LIFE);
    if (w < 0.02) continue;
    const miss = missOf(e);
    total += w;
    totalMiss += w * miss;
    if (e.th) bump("theme", e.th, w, miss);
    for (const g of patternsIn(e)) bump("grammar", g, w, miss);
    if (e.sc != null) {
      graded += w;
      for (const c of e.c || []) bump("category", c, w, 1);
    }
    for (const word of e.w || []) bump("word", word, w, 1);
  }
  if (total < MIN_ATTEMPTS) return [];
  const overall = (totalMiss + 1) / (total + PRIOR_ATTEMPTS);

  const out = [];
  for (const a of areas.values()) {
    if (a.kind === "theme" || a.kind === "grammar") {
      if (a.n < MIN_ATTEMPTS) continue;
      const rate = (a.e + overall * PRIOR_ATTEMPTS) / (a.n + PRIOR_ATTEMPTS);
      if (rate < overall * MIN_RATIO || rate < 0.2) continue;
      out.push({ ...a, rate, strength: rate / overall, label: a.kind === "theme" ? a.key : a.key,
        detail: `missed about ${Math.round(rate * 100)}% of ${a.raw} recent ${a.raw === 1 ? "sentence" : "sentences"}` });
    } else if (a.kind === "category") {
      // Share of graded answers that had this kind of mistake.
      if (a.e < 2 || !CATEGORY_LABELS[a.key] || a.key === "other") continue;
      const rate = a.e / Math.max(graded, 1);
      if (rate < 0.12) continue;
      out.push({ ...a, rate, strength: 1 + rate * 6, label: CATEGORY_LABELS[a.key],
        detail: `in about ${Math.round(rate * 100)}% of recent answers (${a.raw} times)` });
    } else if (a.e >= 1.6) {
      out.push({ ...a, rate: 1, strength: 1 + a.e / 2, label: a.key, detail: `missed ${a.raw} times recently` });
    }
  }
  return out.sort((x, y) => y.strength - x.strength).slice(0, 8);
}

// What a focused session should look for in the bank.
export function focusFilter(area) {
  if (area.kind === "theme") return { theme: area.key };
  if (area.kind === "grammar") return { grammarRe: GRAMMAR.find((g) => g.pattern === area.key)?.re || "" };
  if (area.kind === "category") return CATEGORY_RE[area.key] ? { grammarRe: CATEGORY_RE[area.key] } : null;
  return { contains: area.key };
}

// ---------- progress ----------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Share of reviews in the last `days` that were recalled (Recalled or Easy).
export function recallRate(log, days = 30, now = Date.now()) {
  const reviews = log.filter((e) => e.rv && now - e.t <= days * DAY);
  return { n: reviews.length, rate: reviews.length ? reviews.filter((e) => e.r >= 3).length / reviews.length : null };
}

// Average score for each of the last `weeks` weeks, oldest first.
export function weeklyScores(log, weeks = 8, now = Date.now()) {
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = now - i * 7 * DAY;
    const scores = log.filter((e) => e.sc != null && e.t > end - 7 * DAY && e.t <= end).map((e) => e.sc);
    out.push({ end, n: scores.length, score: mean(scores) });
  }
  return out;
}

// Results grouped by a field of the log, over the last `days`.
export function breakdown(log, field, days = 60, minN = 5, now = Date.now()) {
  const groups = new Map();
  for (const e of log) {
    if (now - e.t > days * DAY) continue;
    const keys = field === "g" ? patternsIn(e) : e[field] == null ? [] : [e[field]];
    for (const key of keys) {
      const g = groups.get(key) || { key, n: 0, scores: [], miss: 0 };
      g.n += 1;
      if (e.sc != null) g.scores.push(e.sc);
      g.miss += missOf(e);
      groups.set(key, g);
    }
  }
  return [...groups.values()]
    .filter((g) => g.n >= minN)
    .map((g) => ({ key: g.key, n: g.n, score: mean(g.scores), missRate: g.miss / g.n }))
    .sort((a, b) => b.missRate - a.missRate);
}

// Sentences due on each of the next `days` days (index 0 = today, including overdue).
export function forecast(reviews, days = 7, now = Date.now()) {
  const start = new Date(now).setHours(0, 0, 0, 0);
  const out = new Array(days).fill(0);
  for (const r of reviews) {
    const i = Math.max(0, Math.floor((r.due - start) / DAY));
    if (i < days) out[i] += 1;
  }
  return out;
}

// Sentences practised on each of the last `weeks` weeks of days, oldest first.
export function calendar(log, weeks = 12, now = Date.now()) {
  const today = new Date(now).setHours(0, 0, 0, 0);
  const days = weeks * 7;
  const counts = new Array(days).fill(0);
  for (const e of log) {
    const i = days - 1 - Math.floor((today - new Date(e.t).setHours(0, 0, 0, 0)) / DAY);
    if (i >= 0 && i < days) counts[i] += 1;
  }
  return counts.map((n, i) => ({ date: today - (days - 1 - i) * DAY, n }));
}

// ---------- weekly goal ----------

// The days of the current week (Monday first) and whether each was practised.
export function weekDays(log, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const out = [];
  for (let d = 0; d < 7; d++) {
    const start = new Date(monday);
    start.setDate(monday.getDate() + d);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    out.push({ date: start.getTime(), done: log.some((e) => e.t >= start.getTime() && e.t < end.getTime()), today: start.getTime() === today.getTime(), future: start.getTime() > today.getTime() });
  }
  return out;
}

// ---------- what a session showed ----------
// Plain statements of fact about a finished session, each backed by the log.
// Nothing is returned when there is nothing true to say.
//   results: [{ item, grade, rating, hints, before }] in the order answered
//   log: attempts from before the session started
export function sessionNotes(results, log, now = Date.now()) {
  const notes = [];
  const firsts = results.filter((r) => !r.item.tries);
  const passed = (r) => r.rating === "recalled" || r.rating === "easy";

  // Sentences that were missed last time and recalled now.
  const recovered = firsts.filter((r) => r.before && r.before.missed && passed(r));

  // Themes and grammar patterns that went clearly better than over the last month.
  const prior = log.filter((e) => now - e.t <= 30 * DAY);
  const areas = new Map();
  for (const r of firsts) {
    const keys = [r.item.theme && ["th", r.item.theme], ...[...new Set([r.item.grammar, ...(r.item.patterns || [])].filter(Boolean))].map((p) => ["g", p])].filter(Boolean);
    for (const [kind, key] of keys) {
      const a = areas.get(kind + key) || { kind, key, n: 0, ok: 0 };
      a.n += 1;
      if (passed(r)) a.ok += 1;
      areas.set(kind + key, a);
    }
  }
  const better = [];
  for (const a of areas.values()) {
    if (a.n < 2) continue;
    const before = prior.filter((e) => (a.kind === "th" ? e.th === a.key : patternsIn(e).includes(a.key)));
    if (before.length < 4) continue;
    const was = before.filter((e) => e.r >= 3).length / before.length;
    const now_ = a.ok / a.n;
    if (was <= 0.6 && now_ - was >= 0.25) better.push({ ...a, was, gain: now_ - was });
  }
  better.sort((x, y) => y.gain - x.gain);
  for (const a of better.slice(0, 2)) {
    notes.push({ hanzi: a.kind === "g", label: a.key, text: `${a.ok} of ${a.n} recalled this session. Over the last month it was ${Math.round(a.was * 100)}% of ${before_n(prior, a)}.` });
  }

  // The session's average score against the last month's.
  const scores = firsts.filter((r) => !r.grade.skipped).map((r) => r.grade.score);
  const earlier = prior.filter((e) => e.sc != null).map((e) => e.sc);
  if (scores.length >= 3 && earlier.length >= 20) {
    const diff = Math.round(mean(scores) - mean(earlier));
    if (diff >= 5) notes.push({ label: "Average score", text: `${Math.round(mean(scores))} this session, ${diff} points above your average for the last month (${Math.round(mean(earlier))}).` });
  }

  // Answers that needed no help.
  const unaided = firsts.filter((r) => passed(r) && !r.hints && !r.grade.skipped).length;
  if (firsts.length >= 3 && unaided) notes.push({ label: "Without hints", text: `${unaided} of ${firsts.length} ${firsts.length === 1 ? "sentence" : "sentences"} recalled with no hint.` });

  return { recovered, notes };
}
function before_n(prior, a) {
  const n = prior.filter((e) => (a.kind === "th" ? e.th === a.key : patternsIn(e).includes(a.key))).length;
  return `${n} ${n === 1 ? "sentence" : "sentences"}`;
}
