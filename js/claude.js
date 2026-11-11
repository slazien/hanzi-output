// Talks to the Claude API directly from the browser with the user's own key.
// The key is read from this device's storage and sent only to api.anthropic.com.

import Anthropic from "../vendor/anthropic-sdk.js";
import { getApiKey } from "./store.js";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — strongest grading" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — faster, cheaper" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 — fastest, cheapest" },
];

export class ClaudeError extends Error {}

function client() {
  const apiKey = getApiKey();
  if (!apiKey) throw new ClaudeError("Add your Anthropic API key in Settings first.");
  // Browser use is intentional here: this is a single-user app and the key
  // never leaves the user's own device except to reach Anthropic.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function explain(error) {
  if (error instanceof ClaudeError) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    return new ClaudeError("Anthropic rejected the API key. Check it in Settings.");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError("This API key is not allowed to use the selected model.");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ClaudeError("The selected model was not found for this API key. Pick another model in Settings.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ClaudeError("Rate limit reached. Wait a moment and try again.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ClaudeError("Could not reach Anthropic. Check your internet connection.");
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeError(`Anthropic returned an error (${error.status ?? "unknown"}): ${error.message}`);
  }
  return new ClaudeError(error?.message || "Something went wrong.");
}

async function ask({ model, system, messages, effort, schema }) {
  let response;
  try {
    response = await client().beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages,
      // If the model declines a request, let the API retry it on its default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort,
        ...(schema ? { format: { type: "json_schema", schema } } : {}),
      },
    });
  } catch (error) {
    throw explain(error);
  }
  if (response.stop_reason === "refusal") {
    throw new ClaudeError("Claude declined this request. Try again or pick a different sentence.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new ClaudeError("Claude's reply was cut off. Try again.");
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!schema) return text.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError("Claude's reply could not be read. Try again.");
  }
}

const str = { type: "string" };
const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const SENTENCES_SCHEMA = obj({
  sentences: {
    type: "array",
    items: obj({
      english: str,
      chinese: str,
      words: { type: "array", items: obj({ text: str, pinyin: str, gloss: str }) },
    }),
  },
});

const GRADE_SCHEMA = obj({
  score: { type: "integer" },
  verdict: str,
  corrected: str,
  strengths: { type: "array", items: str },
  issues: { type: "array", items: obj({ quote: str, problem: str, fix: str }) },
  note: str,
});

const GENERATE_SYSTEM = `You write English-to-Chinese translation exercises for one adult learner of Mandarin who reads and writes simplified characters.

For each exercise give:
- "english": a natural English sentence for the learner to translate.
- "chinese": the most natural simplified Chinese translation, with normal Chinese punctuation.
- "words": the Chinese sentence split into words in order, each with tone-marked pinyin and a short English gloss that fits this sentence. Give punctuation its own entry with empty pinyin and gloss. Joined together, the "text" values must reproduce "chinese" exactly.

The learner's known characters are a hard constraint, described in each request. Count characters in your Chinese sentence before you answer, and rewrite any sentence that breaks the limit. Sentences must still be correct, natural Chinese that a native speaker would say; prefer a simpler idea over an awkward sentence. Vary the subjects, situations and sentence types across the set.`;

export async function generateSentences({ model, count, known, knownWords, maxNewPct, hskLabel, grammar, avoid, feedback }) {
  const lines = [
    `Write ${count} exercises.`,
    "",
    `Characters the learner knows (${known.length}): ${known}`,
  ];
  if (knownWords.length) lines.push(`Words the learner has studied: ${knownWords.join(" ")}`);
  lines.push("");
  if (maxNewPct <= 0) {
    lines.push("Every Chinese character in each sentence must come from the known list. No other characters at all.");
  } else if (maxNewPct >= 100) {
    lines.push("Characters outside the known list are allowed freely.");
  } else {
    lines.push(
      `In each sentence, at most ${maxNewPct}% of the Chinese characters (counting every occurrence, ignoring punctuation) may be outside the known list. Fewer is fine. Choose new characters that are common and worth learning.`
    );
  }
  if (hskLabel && maxNewPct > 0) {
    lines.push(`Any character outside the known list must belong to ${hskLabel}. Keep the grammar within that level too.`);
  }
  if (grammar) {
    lines.push(`Every sentence must need this grammar pattern in its Chinese translation: ${grammar}`);
  } else {
    lines.push("Use a mix of everyday grammar suited to this vocabulary.");
  }
  if (avoid?.length) {
    lines.push("", "Do not repeat or closely paraphrase these recent sentences:", ...avoid.map((s) => `- ${s}`));
  }
  if (feedback?.length) {
    lines.push("", "Your previous attempt included sentences that broke the character limit. Avoid these problems:", ...feedback.map((s) => `- ${s}`));
  }
  const result = await ask({
    model,
    system: GENERATE_SYSTEM,
    messages: [{ role: "user", content: lines.join("\n") }],
    effort: "low",
    schema: SENTENCES_SCHEMA,
  });
  return Array.isArray(result?.sentences) ? result.sentences : [];
}

const GRADE_SYSTEM = `You grade one learner's English-to-Chinese translation. The learner writes simplified characters.

Judge the learner's answer on whether it is correct, natural Mandarin that conveys the English sentence. The reference translation is only one valid answer: accept any other correct wording, word order or synonym at full marks. Ignore missing or different punctuation. If a grammar pattern is named, the answer should use it; otherwise note that in an issue.

Return:
- "score": 0-100. 90+ correct and natural; 70-89 understandable with minor errors; 40-69 meaning partly lost or clear grammar errors; below 40 mostly wrong or empty.
- "verdict": three to six words summarising the result.
- "corrected": the learner's own sentence with the smallest changes that make it correct. If it is already correct, repeat it unchanged.
- "strengths": zero to three short points about what the learner got right, naming the words or structure.
- "issues": each real mistake, with "quote" (the wrong part of their answer, or "" if something is missing), "problem" (why it is wrong, in plain English) and "fix" (the corrected Chinese). Empty when there are no mistakes.
- "note": one or two sentences of the most useful advice for next time, or "" if there is nothing to add.

Write explanations in English. Be accurate and direct; do not praise wrong answers.`;

export async function gradeAnswer({ model, english, reference, answer, grammar }) {
  const content = [
    `English sentence: ${english}`,
    `Reference translation: ${reference}`,
    grammar ? `Grammar pattern being practised: ${grammar}` : "",
    `Learner's answer: ${answer}`,
  ]
    .filter(Boolean)
    .join("\n");
  const result = await ask({
    model,
    system: GRADE_SYSTEM,
    messages: [{ role: "user", content }],
    effort: "medium",
    schema: GRADE_SCHEMA,
  });
  const score = Math.max(0, Math.min(100, Math.round(Number(result.score) || 0)));
  return {
    score,
    verdict: String(result.verdict || ""),
    corrected: String(result.corrected || ""),
    strengths: (result.strengths || []).map(String).filter(Boolean),
    issues: (result.issues || []).filter((i) => i && (i.problem || i.fix)),
    note: String(result.note || ""),
  };
}

const FOLLOWUP_SYSTEM = `You are a Mandarin tutor answering a learner's follow-up questions about one translation exercise they just did. Answer in English, briefly and concretely, with short Chinese examples (simplified characters with pinyin) where they help. Plain text only: no markdown, headings or bullet symbols.`;

export async function followUp({ model, item, answer, grade, thread }) {
  const context = [
    `English sentence: ${item.english}`,
    `Reference translation: ${item.chinese}`,
    item.grammar ? `Grammar pattern: ${item.grammar}` : "",
    `Learner's answer: ${answer || "(skipped)"}`,
    grade ? `Score given: ${grade.score}. Corrected answer: ${grade.corrected}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return ask({
    model,
    system: `${FOLLOWUP_SYSTEM}\n\nThe exercise:\n${context}`,
    messages: thread.map((m) => ({ role: m.role, content: m.text })),
    effort: "low",
  });
}
