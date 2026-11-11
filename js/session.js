// Builds a practice session (due reviews + freshly generated sentences) and
// keeps the spaced-review schedule.

import { state, save } from "./store.js";
import { buildKnown, hskAllowed, measure, measureWords, sentenceHsk, hanChars } from "./known.js";
import { generateSentences, ClaudeError } from "./claude.js";
import { ALL_THEMES } from "../data/themes.js";

export const PASS_SCORE = 80;
const LEGACY_DAYS = [1, 3, 7, 14]; // gaps used by review records saved before self-rating
const DAY = 24 * 60 * 60 * 1000;
const MAX_ROUNDS = 3;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const squash = (s) => String(s || "").replace(/\s+/g, "");

export function dueReviews(now = Date.now()) {
  return state.reviews.filter((r) => r.due <= now).sort((a, b) => a.due - b.due);
}

export function hskLabel() {
  const { hskCap, hskScheme } = state.settings;
  if (!hskCap) return "";
  const version = hskScheme === "old" ? "HSK 2.0" : "HSK 3.0";
  return hskCap === 1 ? `${version} level 1` : `${version} levels 1-${hskCap}`;
}

// Keep the word breakdown only if it really reproduces the sentence.
function cleanWords(sentence) {
  const words = Array.isArray(sentence.words) ? sentence.words.filter((w) => w && typeof w.text === "string" && w.text) : [];
  const joined = squash(words.map((w) => w.text).join(""));
  if (!words.length || joined !== squash(sentence.chinese)) return null;
  return words.map((w) => ({ text: w.text.trim(), pinyin: String(w.pinyin || ""), gloss: String(w.gloss || "") })).filter((w) => w.text);
}

export async function buildSession(onProgress = () => {}) {
  const s = state.settings;
  const known = buildKnown(state);
  if (!known.chars.size && s.maxNewPct < 100) {
    throw new ClaudeError("No known characters yet. Import your Hanly export in Settings, or set new characters to 100%.");
  }
  const allowedNew = hskAllowed(s.hskScheme, s.hskCap);
  const length = s.sessionLength;

  const reviews = dueReviews().slice(0, Math.ceil(length / 2));
  const freshNeeded = length - reviews.length;

  const accepted = [];
  const rejected = [];
  const avoid = state.history.slice(0, 15).map((h) => h.english);
  let feedback = [];
  const seen = new Set(reviews.map((r) => squash(r.chinese)));

  for (let round = 1; round <= MAX_ROUNDS && accepted.length < freshNeeded; round++) {
    onProgress(round === 1 ? "Writing sentences…" : "Replacing sentences that used too many new characters…");
    const missing = freshNeeded - accepted.length;
    const candidates = await generateSentences({
      model: s.model,
      count: missing + 2,
      known: [...known.chars].join(""),
      knownWords: known.words,
      maxNewPct: s.maxNewPct,
      maxNewWordsPct: s.maxNewWordsPct,
      hskLabel: hskLabel(),
      grammar: s.grammar,
      theme: s.theme,
      // For a random mix, draw the themes here so the spread is really random.
      themes: s.theme ? null : shuffle(ALL_THEMES).slice(0, missing + 2),
      avoid: [...avoid, ...accepted.map((a) => a.english)],
      feedback,
    });
    feedback = [];
    for (const c of candidates) {
      if (!c?.english || !c?.chinese || !hanChars(c.chinese).length) continue;
      const key = squash(c.chinese);
      if (seen.has(key)) continue;
      seen.add(key);
      const m = measure(c.chinese, known.chars, allowedNew);
      const words = cleanWords(c);
      const item = {
        id: uid(), english: c.english.trim(), chinese: c.chinese.trim(), words, grammar: s.grammar,
        theme: s.theme || (ALL_THEMES.includes(c.theme) ? c.theme : ""),
        note: String(c.note || "").trim(), hsk: sentenceHsk(c.chinese, s.hskScheme),
      };
      const overPct = m.pct > s.maxNewPct + 0.01;
      // The word limit can only be checked when the word breakdown is usable.
      const limitWords = s.maxNewWordsPct < 100;
      const mw = words ? measureWords(words, known) : null;
      const overWords = limitWords && (!mw || mw.pct > s.maxNewWordsPct + 0.01);
      if (!overPct && !overWords && !m.overCap.length) {
        if (accepted.length < freshNeeded) accepted.push(item);
        continue;
      }
      rejected.push({ item, excess: Math.max(0, m.pct - s.maxNewPct) + (mw ? Math.max(0, mw.pct - s.maxNewWordsPct) : limitWords ? 50 : 0) + m.overCap.length * 100 });
      const reasons = [];
      if (overPct) reasons.push(`${Math.round(m.pct)}% of its characters are outside the known list (${m.distinctNew.join(" ")}); the limit is ${s.maxNewPct}%`);
      if (overWords && mw) reasons.push(`${Math.round(mw.pct)}% of its words are new (${mw.newWords.join(" ")}); the limit is ${s.maxNewWordsPct}%`);
      if (overWords && !mw) reasons.push('its "words" list did not reproduce the sentence exactly');
      if (m.overCap.length) reasons.push(`${m.overCap.join(" ")} ${m.overCap.length > 1 ? "are" : "is"} above ${hskLabel()}`);
      feedback.push(`${c.chinese} — ${reasons.join("; ")}`);
    }
  }

  // If Claude could not stay inside the limit after several tries, use the
  // closest sentences and say so rather than end up with a short session.
  if (accepted.length < freshNeeded) {
    rejected.sort((a, b) => a.excess - b.excess);
    for (const r of rejected) {
      if (accepted.length >= freshNeeded) break;
      accepted.push({ ...r.item, overLimit: true });
    }
  }

  const reviewItems = reviews.map((r) => ({
    id: uid(),
    reviewId: r.id,
    english: r.english,
    chinese: r.chinese,
    words: r.words || null,
    grammar: r.grammar || "",
    theme: r.theme || "",
    note: r.note || "",
    hsk: sentenceHsk(r.chinese, s.hskScheme),
  }));

  // Spread the review sentences through the session.
  const items = [];
  const fresh = [...accepted];
  const rev = [...reviewItems];
  while (fresh.length || rev.length) {
    if (fresh.length) items.push(fresh.shift());
    if (rev.length) items.push(rev.shift());
  }
  if (!items.length) throw new ClaudeError("The model did not return any usable sentences. Try again.");
  return items;
}

// ---------- self-rated spaced review ----------
// After each sentence the learner rates how it went. The rating, not the AI
// score, decides when the sentence comes back.

export const RATINGS = [
  { id: "forgot", label: "Forgot" },
  { id: "hard", label: "Hard" },
  { id: "recalled", label: "Recalled" },
  { id: "easy", label: "Easy" },
];
const MINUTE = 1 / (24 * 60); // in days
const RETIRE_AFTER_DAYS = 120; // a sentence this well known stops coming back

function reviewOf(item) {
  return item.reviewId ? state.reviews.find((r) => r.id === item.reviewId) : null;
}

// Current gap for a sentence in days (0 for one not yet in review).
export function currentInterval(item) {
  const r = reviewOf(item);
  if (!r) return 0;
  return r.interval ?? LEGACY_DAYS[r.step] ?? 1;
}

// The next gap in days for a rating: short retries for Forgot and Hard on new
// sentences, then gaps that grow each time the sentence is recalled.
export function nextInterval(prevDays, rating) {
  if (rating === "forgot") return 10 * MINUTE;
  if (rating === "hard") return prevDays < 1 ? 15 * MINUTE : prevDays * 1.2;
  if (rating === "easy") return prevDays < 1 ? 2 : prevDays * 4;
  return prevDays < 1 ? 1 : prevDays * 2.5;
}

export function intervalText(days) {
  if (days < 1 / 24) return `${Math.round(days / MINUTE)} minutes`;
  if (days < 1) return `${Math.round(days * 24)} hours`;
  if (days > RETIRE_AFTER_DAYS) return "done";
  const d = Math.round(days);
  if (d < 31) return d === 1 ? "1 day" : `${d} days`;
  const months = Math.round(d / 30);
  return months === 1 ? "1 month" : `${months} months`;
}

// What the AI's score would suggest; the learner can overrule it.
export function suggestRating(grade) {
  if (grade.skipped || grade.score < 50) return "forgot";
  if (grade.score < PASS_SCORE) return "hard";
  return grade.score >= 95 ? "easy" : "recalled";
}

// Applies a rating. Returns true when the sentence should be retried soon
// (its new gap is under a day).
export function scheduleReview(item, rating, now = Date.now()) {
  const interval = nextInterval(currentInterval(item), rating);
  let record = reviewOf(item);
  if (interval > RETIRE_AFTER_DAYS) {
    if (record) state.reviews = state.reviews.filter((r) => r !== record);
    save();
    return false;
  }
  if (!record) {
    record = {
      id: uid(),
      english: item.english,
      chinese: item.chinese,
      words: item.words,
      grammar: item.grammar,
      theme: item.theme || "",
      note: item.note || "",
    };
    state.reviews.push(record);
    item.reviewId = record.id;
  }
  delete record.step;
  record.interval = interval;
  record.due = now + interval * DAY;
  save();
  return interval < 1;
}

export function setLastRating(rating) {
  if (state.history[0]) {
    state.history[0].rating = rating;
    save();
  }
}

export function recordAttempt(item, answer, grade) {
  state.history.unshift({
    id: uid(),
    at: Date.now(),
    english: item.english,
    chinese: item.chinese,
    words: item.words || null,
    sentenceNote: item.note || "",
    hsk: item.hsk || "",
    theme: item.theme || "",
    grammar: item.grammar || "",
    answer,
    review: Boolean(item.reviewId),
    score: grade.score,
    verdict: grade.verdict,
    corrected: grade.corrected,
    strengths: grade.strengths,
    issues: grade.issues,
    note: grade.note,
  });
  save();
}
