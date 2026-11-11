// How an answer is graded: the instructions and output format given to the
// model, and how its ratings become a score. Kept free of browser code so the
// test harness in tools/ can use exactly what the app uses.

import { CATEGORIES } from "./insight.js";

// Conventions where a sentence can be grammatical yet not what a native
// speaker would say. The grader must name one of these to flag naturalness.
export const CONVENTIONS = {
  de_kinship: "的 with family and close relationships",
  redundant_pronoun: "Repeated or unneeded pronouns and possessives",
  shi_adjective: "是 before an adjective",
  hen_adjective: "很 with adjectives",
  he_clauses: "和 used to join clauses",
  yige_overuse: "一个 where Chinese leaves it out",
  le_usage: "了 used too often or in the wrong place",
  bei_overuse: "被 where an active sentence is normal",
  word_order: "Word order that is possible but unusual",
  measure_word_default: "个 where a specific measure word is usual",
  literal_translation: "A word-for-word rendering of an English phrase",
  register: "Too formal or too written for the situation",
  other: "Another convention of natural usage",
  none: "No naturalness problem",
};

const str = { type: "string" };
const pick = (values) => ({ type: "string", enum: values });
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

// Evidence first (the correction and the mistakes), then the ratings that rest on it.
export const GRADE_SCHEMA = obj({
  corrected: str,
  issues: { type: "array", items: obj({ quote: str, problem: str, fix: str, category: pick(Object.keys(CATEGORIES)) }) },
  meaning: pick(["full", "mostly", "partly", "wrong"]),
  accuracy: pick(["correct", "minor_errors", "major_errors"]),
  naturalness: pick(["natural", "acceptable_marked", "unnatural", "not_applicable"]),
  convention: pick(Object.keys(CONVENTIONS)),
  natural_version: str,
  naturalness_note: str,
  naturalness_confidence: pick(["high", "low"]),
  verdict: str,
  strengths: { type: "array", items: str },
  weak_points: { type: "array", items: str },
  note: str,
});

export const GRADE_SYSTEM = `You grade one learner's English-to-Chinese translation. The learner is a native English speaker writing simplified characters. Make three separate judgements, in this order.

1. CORRECTNESS. Is the answer grammatical Mandarin that conveys the English sentence?
- The reference translation is only one valid answer. Accept any other correct wording, word order or synonym. Never count a difference from the reference as a mistake in itself.
- Ignore missing or different punctuation.
- If a grammar pattern is named, the answer should use it; say so in an issue if it does not.
- "corrected": the learner's own sentence with the SMALLEST changes that make it correct. Change only what is wrong. Do not improve style here. If it is already correct, repeat it unchanged.
- "issues": each real mistake, at most three, most important first: "quote" (the wrong part of their answer, or "" if something is missing), "problem" (why it is wrong, in plain English), "fix" (the corrected Chinese) and "category", the one label that fits best:
  word_choice (a wrong word), measure_word, aspect (了 / 过 / 着), word_order, ba_bei (把 or 被 constructions), complement (result, direction, degree or potential complements), particle (的 / 地 / 得 / 吗 / 呢 / 吧), preposition (在 / 给 / 对 / 跟 / 从 and similar), negation (不 / 没 and adverb placement), connector (linking clauses: 因为, 但是, 如果 ...), missing_word, extra_word, character (a wrong or mistyped character), other.
  Empty when the answer is correct. Naturalness points never go here.
- "meaning": full (everything conveyed), mostly (a small detail lost or changed), partly (an important part lost or changed), wrong (a different meaning, or no real attempt).
- "accuracy": correct (no mistakes), minor_errors (small slips that leave the sentence understandable), major_errors (ungrammatical or confusing).

2. NATURALNESS. Only if the answer is correct or nearly so: is this how a native speaker would normally say it?
- "naturalness": natural; acceptable_marked (fine, but a native speaker would more often say it another way); unnatural (grammatical, yet a native speaker would not say it this way); not_applicable (the answer has major errors or the wrong meaning).
- Flag naturalness ONLY when you can name the specific convention involved. If you cannot name one, or you are unsure, answer natural. A different but equally normal wording is natural.
- "convention": de_kinship (的 is normally dropped with family and close relationships: 我妈妈, 我朋友, 我们学校), redundant_pronoun (repeating 我, or possessives English needs and Chinese drops: 我洗手, not 我洗我的手), shi_adjective (是 before an adjective: 他很高, not 他是很高), hen_adjective (a bare adjective predicate that sounds comparative or abrupt without 很), he_clauses (和 joining clauses or verbs where Chinese uses a comma, 也, 还 or 然后), yige_overuse (一个 where Chinese omits it: 她是老师), le_usage (了 after every verb, or missing where expected), bei_overuse (被 where an active sentence is normal), word_order (possible but unusual order, such as time or place after the verb phrase), measure_word_default (个 where a specific measure word is usual), literal_translation (word-for-word from an English phrase where Chinese has a set way to say it), register (written or formal words such as 因此, 以及, or 您 to a friend, in an everyday sentence), other, none.
- "natural_version": the sentence a native speaker would most naturally say, keeping the learner's meaning and as much of their wording as possible. "" when naturalness is natural or not_applicable.
- "naturalness_note": one sentence in plain English naming the convention and why. "" when natural or not_applicable.
- "naturalness_confidence": high when most native speakers would agree; low when it is a matter of taste, region or context.
- Never flag regional or register choices that suit the sentence: Mainland and Taiwan vocabulary are both fine, 您 is right where respect fits, and formal wording is right for a formal English sentence.

Examples of naturalness judgements (the learner's answer is grammatical in every case):
- "This is my mum." 这是我的妈妈。 -> unnatural, de_kinship, 这是我妈妈。
- "I wash my hands before eating." 我吃饭以前洗我的手。 -> unnatural, redundant_pronoun, 我吃饭以前洗手。
- "She is a teacher." 她是一个老师。 -> acceptable_marked, yige_overuse, 她是老师。
- "I went to the shop and bought fruit." 我去了商店和买了水果。 -> unnatural, he_clauses, 我去商店买了水果。
- "This book was read by me." given as 这本书被我看了。 for "I read this book." -> unnatural, bei_overuse, 我看了这本书。
- "So I didn't go." 因此我没去。 in an everyday sentence -> acceptable_marked, register, 所以我没去。
- "I got home, I had dinner and I went to bed." 我回家了，我吃了晚饭，我睡觉了。 -> unnatural, redundant_pronoun, 我回家吃了晚饭就睡觉了。 (once the subject is set, later clauses drop it)
- "She is very pretty." 她很漂亮。 -> natural (很 is the normal link here).
- "I like this video." 我喜欢这个影片。 -> natural (regional vocabulary).
- "My friend has a camera." 我的朋友有相机。 -> acceptable_marked, de_kinship, low confidence (我朋友 is more usual, but 我的朋友 is common).

3. SUMMARY.
- "verdict": three to six words summarising the result.
- "strengths": zero to two short points about what the learner got right, naming the words or structure.
- "weak_points": up to three Chinese words or grammar patterns, in Chinese characters only (for example 相机 or 把), that the learner got wrong or clearly did not know. Empty when the answer was correct.
- "note": one sentence of the most useful advice for next time, or "".

Write explanations in English. Be accurate and direct. Do not praise wrong answers, and do not invent problems in correct ones.`;

export function gradeRequest({ english, reference, answer, grammar, dispute }) {
  return [
    `English sentence: ${english}`,
    `Reference translation (one valid answer): ${reference}`,
    grammar ? `Grammar pattern being practised: ${grammar}` : "",
    `Learner's answer: ${answer}`,
    dispute ? `The learner disagrees with an earlier grading of this answer, which said: "${dispute}". Grade it again from scratch and independently. Check especially whether the answer is in fact acceptable, and whether each problem you report is real.` : "",
  ].filter(Boolean).join("\n");
}

const MEANING_POINTS = { full: 60, mostly: 45, partly: 25, wrong: 5 };
// Any reported mistake keeps the score under the pass mark of 80, so the
// sentence comes back sooner.
const ACCURACY_POINTS = { correct: 40, minor_errors: 18, major_errors: 8 };

// The score is worked out here from the model's ratings, not chosen by the
// model, so the same ratings always give the same number. Naturalness takes
// off a few points at most and never turns a correct answer into a failed one.
export function normaliseGrade(result) {
  const meaning = MEANING_POINTS[result.meaning] != null ? result.meaning : "partly";
  const issues = (result.issues || []).filter((i) => i && (i.problem || i.fix)).slice(0, 3);
  let accuracy = ACCURACY_POINTS[result.accuracy] != null ? result.accuracy : "minor_errors";
  // The rating and the list of mistakes must agree.
  if (accuracy === "correct" && issues.length) accuracy = "minor_errors";
  // Naturalness is judged only for answers with no mistakes: a sentence that
  // still needs correcting has more important things to fix first.
  const gradable = (meaning === "full" || meaning === "mostly") && accuracy === "correct";
  let naturalness = ["natural", "acceptable_marked", "unnatural"].includes(result.naturalness) && gradable ? result.naturalness : gradable ? "natural" : "not_applicable";
  const naturalVersion = String(result.natural_version || "").trim();
  // A naturalness flag needs a named convention and a suggested wording to be shown.
  if (naturalness !== "natural" && naturalness !== "not_applicable" && (!naturalVersion || !result.convention || result.convention === "none")) naturalness = "natural";

  let score = MEANING_POINTS[meaning] + ACCURACY_POINTS[accuracy];
  if (meaning === "wrong") score = Math.min(score, 25);
  const sure = result.naturalness_confidence === "high";
  if (naturalness === "unnatural") score -= sure ? 8 : 4;
  else if (naturalness === "acceptable_marked") score -= sure ? 3 : 0;

  const flagged = naturalness === "unnatural" || naturalness === "acceptable_marked";
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    meaning,
    accuracy,
    naturalness,
    naturalVersion: flagged ? naturalVersion : "",
    naturalnessNote: flagged ? String(result.naturalness_note || "").trim() : "",
    convention: flagged ? result.convention : "none",
    naturalnessSure: flagged ? sure : true,
    verdict: String(result.verdict || ""),
    corrected: String(result.corrected || ""),
    strengths: (result.strengths || []).map(String).filter(Boolean).slice(0, 2),
    issues,
    weak: (result.weak_points || []).map((w) => String(w).replace(/[^一-鿿]/g, "")).filter(Boolean).slice(0, 3),
    note: String(result.note || ""),
  };
}

export const MEANING_LABEL = { full: "Meaning: complete", mostly: "Meaning: mostly there", partly: "Meaning: partly lost", wrong: "Meaning: wrong" };
export const ACCURACY_LABEL = { correct: "Grammar: correct", minor_errors: "Grammar: small slips", major_errors: "Grammar: errors" };
export const NATURALNESS_LABEL = { natural: "Sounds natural", acceptable_marked: "Fine, but not the usual way", unnatural: "Correct, but unnatural", not_applicable: "" };
