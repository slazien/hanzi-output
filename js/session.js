// Builds a practice session (due reviews + freshly generated sentences) and
// keeps the spaced-review schedule.

import { state, save } from "./store.js";
import { buildKnown, hskAllowed, measure, measureWords, sentenceHsk, hanChars } from "./known.js";
import { generateSentences, ClaudeError } from "./claude.js";
import { ALL_THEMES } from "../data/themes.js";
import { GRAMMAR } from "../data/grammar.js";
import { loadBank, bankReady, fitting, pick, variantOf } from "./bank.js";
import { focusFilter } from "./insight.js";
import { review as fsrsReview, intervalFor, retrievability } from "./fsrs.js";

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

const DAILY_REVIEW_CAP = 40;

// Sentences due for review, the ones most likely to be forgotten first.
export function dueReviews(now = Date.now()) {
  return state.reviews.filter((r) => r.due <= now).sort((a, b) => recallNow(a, now) - recallNow(b, now));
}

// How many more reviews today's cap allows.
export function reviewsLeftToday(now = Date.now()) {
  const start = new Date(now).setHours(0, 0, 0, 0);
  const done = (state.log || []).filter((e) => e.rv && e.t >= start).length;
  return Math.max(0, DAILY_REVIEW_CAP - done);
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

// Sentences come from the stored bank. Writing them with AI is switched off;
// buildWithAI below is kept so it can be turned back on.
export const AI_SENTENCES = false;

function grammarRe() {
  return GRAMMAR.find((g) => g.pattern === state.settings.grammar)?.re || "";
}

// How many bank sentences fit the current settings (null until the bank loads).
export function countFitting() {
  if (!bankReady()) return null;
  const s = state.settings;
  return fitting({
    known: buildKnown(state), allowedNew: hskAllowed(s.hskScheme, s.hskCap),
    maxNewPct: s.maxNewPct, maxNewWordsPct: s.maxNewWordsPct, theme: s.theme, grammarRe: grammarRe(),
  }).length;
}

// A sentence whose review gap has grown past this many days is sometimes
// reviewed through a different sentence that reuses its words.
const VARY_AFTER_DAYS = 21;
const VARY_CHANCE = 0.5;

// Builds a session. With `focus` (a weak area from insight.js), about 60% of
// the new sentences target that area and the rest are ordinary ones.
export async function buildSession(onProgress = () => {}, focus = null) {
  const s = state.settings;
  const known = buildKnown(state);
  if (!known.chars.size && s.maxNewPct < 100) {
    throw new ClaudeError("The app does not know which characters you know yet. Choose your level or import a Hanly export in Settings, or set new characters to any.");
  }
  const length = s.sessionLength;
  const reviewShare = focus ? 0.2 : 0.5;
  const reviews = dueReviews().slice(0, Math.min(Math.ceil(length * reviewShare), reviewsLeftToday()));
  const freshNeeded = length - reviews.length;

  let fresh;
  let notice = "";
  let rows = [];
  const base = { known, allowedNew: hskAllowed(s.hskScheme, s.hskCap), maxNewPct: s.maxNewPct, maxNewWordsPct: s.maxNewWordsPct };
  const avoid = new Set([...state.history.slice(0, 300).map((h) => h.chinese), ...state.reviews.map((r) => r.chinese)]);
  if (AI_SENTENCES) {
    fresh = await buildWithAI(freshNeeded, known, reviews, onProgress);
  } else {
    onProgress("Choosing sentences…");
    await loadBank();
    const weak = (state.weak || []).map((w) => w.text);
    const decorate = (item) => ({ ...item, id: uid(), grammar: s.grammar, hsk: sentenceHsk(item.chinese, s.hskScheme) });
    if (focus) {
      const filter = focusFilter(focus);
      // When the focus is a word, its own characters do not count against the
      // new-material limits, or the word could never appear.
      const focusKnown = focus.kind === "word"
        ? { ...known, chars: new Set([...known.chars, ...hanChars(focus.key)]), wordSet: new Set([...known.wordSet, focus.key]) }
        : known;
      const focusRows = filter ? fitting({ ...base, known: focusKnown, ...filter }) : [];
      rows = fitting(base);
      const focused = pick(focusRows, { count: Math.min(freshNeeded, Math.ceil(length * 0.6)), weak, avoid }).map((i) => ({ ...decorate(i), grammar: focus.kind === "grammar" ? focus.key : "", focus: focus.label }));
      const taken = new Set([...avoid, ...focused.map((i) => i.chinese)]);
      const others = pick(rows, { count: freshNeeded - focused.length, weak, avoid: taken, spreadThemes: true }).map((i) => ({ ...decorate(i), grammar: "" }));
      fresh = shuffle([...focused, ...others]);
      if (!focused.length) notice = `No sentences in the bank target “${focus.label}” within your current limits, so this is an ordinary session.`;
      else if (focused.length < Math.ceil(length * 0.6) && focused.length < freshNeeded) notice = `Only ${focused.length} ${focused.length === 1 ? "sentence targets" : "sentences target"} “${focus.label}” within your current limits; the rest are ordinary sentences.`;
    } else {
      rows = fitting({ ...base, theme: s.theme, grammarRe: grammarRe() });
      fresh = pick(rows, { count: freshNeeded, weak, avoid, spreadThemes: !s.theme }).map(decorate);
      if (fresh.length && fresh.length < freshNeeded) {
        notice = `Only ${fresh.length} ${fresh.length === 1 ? "sentence fits" : "sentences fit"} these settings, so this session is shorter. Allow more new characters or words, or pick another theme, to get more.`;
      }
    }
  }

  const everything = bankReady() ? fitting(base) : [];
  const reviewItems = reviews.map((r) => {
    const item = {
      id: uid(),
      reviewId: r.id,
      english: r.english,
      chinese: r.chinese,
      words: r.words || null,
      grammar: r.grammar || "",
      theme: r.theme || "",
      note: r.note || "",
      src: r.src,
      ref: r.ref,
      hsk: sentenceHsk(r.chinese, s.hskScheme),
    };
    // Well-established sentences are sometimes reviewed through a different
    // sentence with the same words, so the wording is not learned by heart.
    if (r.s >= VARY_AFTER_DAYS && Math.random() < VARY_CHANCE) {
      const variant = variantOf(r.chinese, r.words, everything, avoid);
      if (variant) return { ...item, ...variant, grammar: "", hsk: sentenceHsk(variant.chinese, s.hskScheme), variantOf: r.chinese };
    }
    return item;
  });

  // Spread the review sentences through the session.
  const items = [];
  const rev = [...reviewItems];
  while (fresh.length || rev.length) {
    if (fresh.length) items.push(fresh.shift());
    if (rev.length) items.push(rev.shift());
  }
  if (!items.length) {
    throw new ClaudeError("No sentences in the bank fit these settings. Allow more new characters or words, raise the HSK level, or choose another theme or grammar pattern.");
  }
  return { items, notice };
}

// Writes sentences with the AI model (unused while AI_SENTENCES is false).
async function buildWithAI(freshNeeded, known, reviews, onProgress) {
  const s = state.settings;
  const allowedNew = hskAllowed(s.hskScheme, s.hskCap);
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
      themes: s.theme ? null : shuffle(ALL_THEMES).slice(0, missing + 2),
      focus: (state.weak || []).slice(0, 8).map((w) => w.text),
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
  if (accepted.length < freshNeeded) {
    rejected.sort((a, b) => a.excess - b.excess);
    for (const r of rejected) {
      if (accepted.length >= freshNeeded) break;
      accepted.push({ ...r.item, overLimit: true });
    }
  }
  return accepted;
}

// ---------- self-rated spaced review (FSRS) ----------
// After each sentence the learner rates how it went. The rating, not the AI
// score, decides when the sentence comes back; the timing comes from FSRS.

export const RATINGS = [
  { id: "forgot", label: "Forgot" },
  { id: "hard", label: "Hard" },
  { id: "recalled", label: "Recalled" },
  { id: "easy", label: "Easy" },
];
const GRADE = { forgot: 1, hard: 2, recalled: 3, easy: 4 };
const MINUTE = 1 / (24 * 60); // in days
const RELEARN_MINUTES = 10; // a forgotten sentence is due again this soon

function reviewOf(item) {
  return item.reviewId ? state.reviews.find((r) => r.id === item.reviewId) : null;
}

// Memory state of a review record. Records saved before FSRS only have a gap
// in days: that gap is taken as the stability, with a middling difficulty.
function memoryOf(record) {
  if (!record) return null;
  if (record.s) return { s: record.s, d: record.d, last: record.last };
  const gap = record.interval ?? LEGACY_DAYS[record.step] ?? 1;
  return { s: Math.max(0.5, gap), d: 5, last: (record.due || Date.now()) - gap * DAY };
}

// Chance (0-1) that a sentence in review would be recalled right now.
export function recallNow(record, now = Date.now()) {
  const m = memoryOf(record);
  return m ? retrievability((now - m.last) / DAY, m.s) : 1;
}

// What a rating would do: the new memory state and the gap until the next review, in days.
function outcome(item, rating, now) {
  const m = memoryOf(reviewOf(item));
  const next = fsrsReview(m && { s: m.s, d: m.d }, GRADE[rating], m ? (now - m.last) / DAY : 0);
  const gap = rating === "forgot" ? RELEARN_MINUTES * MINUTE : intervalFor(next.s);
  return { ...next, gap };
}

// The gap shown on each rating button.
export function previewInterval(item, rating, now = Date.now()) {
  return outcome(item, rating, now).gap;
}

export function intervalText(days) {
  if (days < 1 / 24) return `${Math.round(days / MINUTE)} minutes`;
  if (days < 1) return `${Math.round(days * 24)} hours`;
  const d = Math.round(days);
  if (d < 31) return d === 1 ? "1 day" : `${d} days`;
  if (d < 365) { const months = Math.round(d / 30); return months === 1 ? "1 month" : `${months} months`; }
  return "1 year";
}

// What the AI's score would suggest; the learner can overrule it.
export function suggestRating(grade) {
  if (grade.skipped || grade.score < 50) return "forgot";
  if (grade.score < PASS_SCORE) return "hard";
  // Correct but not how a native speaker would say it: worth seeing again soon.
  if (grade.naturalness === "unnatural" && grade.naturalnessSure) return "hard";
  if (grade.naturalness === "unnatural" || grade.naturalness === "acceptable_marked") return "recalled";
  return grade.score >= 95 ? "easy" : "recalled";
}

// Applies a rating. Returns true when the sentence should be retried in this
// session (Forgot, or Hard on a sentence seen for the first time).
export function scheduleReview(item, rating, now = Date.now()) {
  let record = reviewOf(item);
  const first = !record;
  const next = outcome(item, rating, now);
  if (!record) {
    // A variation shown in place of a review keeps updating the original record.
    record = {
      id: uid(),
      english: item.english,
      chinese: item.chinese,
      words: item.words,
      grammar: item.grammar,
      theme: item.theme || "",
      note: item.note || "",
      src: item.src,
      ref: item.ref,
      reps: 0,
      lapses: 0,
    };
    state.reviews.push(record);
    item.reviewId = record.id;
  }
  delete record.step;
  delete record.interval;
  record.s = next.s;
  record.d = next.d;
  record.last = now;
  record.due = now + next.gap * DAY;
  record.reps = (record.reps || 0) + 1;
  if (rating === "forgot") record.lapses = (record.lapses || 0) + 1;
  save();
  return rating === "forgot" || (rating === "hard" && first);
}

// ---------- attempt log ----------
// A compact line per rated attempt, kept much longer than the detailed
// history, for the Progress screen and for finding weak areas.
const LOG_LIMIT = 6000;

export function logAttempt(item, grade, rating, wasReview, gapBefore, now = Date.now()) {
  const hsk = Number(String(item.hsk || "").replace(/\D+/g, "").slice(0, 1)) || 0;
  const entry = { t: now, sc: grade.skipped ? null : grade.score, r: GRADE[rating] };
  if (item.theme) entry.th = item.theme;
  if (hsk) entry.h = hsk;
  if (item.grammar) entry.g = item.grammar;
  const cats = [...new Set((grade.issues || []).map((i) => i.category).filter(Boolean))];
  if (grade.naturalness === "unnatural" || (grade.naturalness === "acceptable_marked" && grade.naturalnessSure)) cats.push("natural");
  if (cats.length) entry.c = cats;
  if (grade.weak?.length) entry.w = grade.weak;
  if (wasReview) { entry.rv = 1; entry.iv = Math.round(gapBefore * 10) / 10; }
  state.log = state.log || [];
  state.log.push(entry);
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  save();
}

// Words and patterns the learner got wrong are remembered so that new
// sentences can bring them back in a different context.
export function addWeak(texts) {
  const list = state.weak || [];
  for (const text of texts || []) {
    const found = list.find((w) => w.text === text);
    if (found) found.at = Date.now();
    else list.unshift({ text, at: Date.now() });
  }
  state.weak = list.sort((a, b) => b.at - a.at).slice(0, 30);
  save();
}

// A weak point is cleared once a sentence containing it is recalled.
export function easeWeak(chinese, except = []) {
  state.weak = (state.weak || []).filter((w) => except.includes(w.text) || !chinese.includes(w.text));
  save();
}

export function setLastRating(rating) {
  if (state.history[0]) {
    state.history[0].rating = rating;
    save();
  }
}

const gradeFields = (grade) => ({
  score: grade.score,
  verdict: grade.verdict,
  corrected: grade.corrected,
  strengths: grade.strengths,
  issues: grade.issues,
  note: grade.note,
  meaning: grade.meaning,
  accuracy: grade.accuracy,
  naturalness: grade.naturalness,
  naturalVersion: grade.naturalVersion,
  naturalnessNote: grade.naturalnessNote,
  naturalnessSure: grade.naturalnessSure,
});

// After a second opinion: replace the grade on the newest history entry and
// keep both verdicts, so disputed cases can be reviewed and added to the
// grader's test set.
export function recordDispute(item, answer, before, after) {
  if (state.history[0]) Object.assign(state.history[0], gradeFields(after), { disputed: true });
  state.disputes = state.disputes || [];
  state.disputes.unshift({ t: Date.now(), english: item.english, reference: item.chinese, answer, before: gradeFields(before), after: gradeFields(after) });
  state.disputes.length = Math.min(state.disputes.length, 100);
  save();
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
    src: item.src,
    ref: item.ref,
    theme: item.theme || "",
    grammar: item.grammar || "",
    answer,
    review: Boolean(item.reviewId),
    ...gradeFields(grade),
  });
  save();
}
