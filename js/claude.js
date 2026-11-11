// Sentence generation, grading and follow-ups. Requests go straight from the
// browser to the chosen provider (Anthropic here, OpenAI in openai.js) with the
// user's own key, which is read from this device's storage.

import Anthropic from "../vendor/anthropic-sdk.js";
import { getApiKey, cleanApiKey } from "./store.js";
import { askOpenAI, OPENAI_MODULE_VERSION } from "./openai.js";
import { GRADE_SCHEMA, GRADE_SYSTEM, gradeRequest, normaliseGrade } from "./grading.js";

export const MODULE_VERSION = OPENAI_MODULE_VERSION ?? 0;

// Prices are list prices in US dollars per million input / output tokens,
// checked in November 2026. They are shown for comparison only.
export const PROVIDERS = { openai: "OpenAI", anthropic: "Anthropic" };
export const MODELS = [
  { id: "gpt-6-luna", provider: "openai", label: "GPT-6 Luna", price: "$0.10 / $0.50" },
  { id: "gpt-6.1-terra", provider: "openai", label: "GPT-6.1 Terra", price: "$1 / $5" },
  { id: "claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", price: "$0.10 / $0.50" },
  { id: "claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", price: "$2 / $10" },
];
export const DEFAULT_MODEL = MODELS[0].id; // the cheapest
export const providerOf = (model) => MODELS.find((m) => m.id === model)?.provider || "anthropic";

export class ClaudeError extends Error {}

function client() {
  const apiKey = getApiKey();
  if (!apiKey) throw new ClaudeError("Add your Anthropic API key in Settings first.");
  const { bad } = cleanApiKey(apiKey);
  if (bad.length) {
    throw new ClaudeError(`The saved Anthropic key contains characters a key cannot have (${bad.slice(0, 5).join(" ")}). Paste the key again in Settings.`);
  }
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
    return new ClaudeError(`The connection to Anthropic failed or was interrupted. Check your internet connection and try again. (Details: ${error.cause?.name || error.name}: ${error.cause?.message || error.message}.)`);
  }
  if (error instanceof Anthropic.APIError) {
    return new ClaudeError(`Anthropic returned an error (${error.status ?? "unknown"}): ${error.message}`);
  }
  return new ClaudeError(error?.message || "Something went wrong.");
}

async function ask({ model, system, messages, effort, schema }) {
  if (providerOf(model) === "openai") {
    return askOpenAI({ model, system, messages, effort, schema }, (message) => new ClaudeError(message));
  }
  let response;
  try {
    // Streamed, so data keeps flowing while the model works: mobile browsers
    // drop a connection that stays silent for about a minute.
    const stream = client().beta.messages.stream({
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
    response = await stream.finalMessage();
  } catch (error) {
    throw explain(error);
  }
  if (response.stop_reason === "refusal") {
    throw new ClaudeError("The model declined this request. Try again or pick a different sentence.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new ClaudeError("The reply was cut off. Try again.");
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!schema) return text.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new ClaudeError("The model's reply could not be read. Try again.");
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
      note: str,
      theme: str,
    }),
  },
});

const GENERATE_SYSTEM = `You write English-to-Chinese translation exercises for one adult learner of Mandarin who reads and writes simplified characters.

For each exercise give:
- "english": a natural English sentence for the learner to translate.
- "chinese": the most natural simplified Chinese translation, with normal Chinese punctuation.
- "words": the Chinese sentence split into words in order, each with tone-marked pinyin and a short English gloss that fits this sentence. Give punctuation its own entry with empty pinyin and gloss. Joined together, the "text" values must reproduce "chinese" exactly.
- "note": one short sentence for the learner pointing out the key grammar point, word order or word choice in the Chinese sentence. Use "" when there is nothing worth pointing out.
- "theme": the theme the sentence belongs to, copied exactly from the theme or theme list given in the request.

The learner's known characters and words are hard constraints, described in each request. Count characters and words in your Chinese sentence before you answer, and rewrite any sentence that breaks the limit. Sentences must still be correct, natural Chinese that a native speaker would say; prefer a simpler idea over an awkward sentence. Vary the subjects, situations and sentence types across the set.`;

export async function generateSentences({ model, count, known, knownWords, maxNewPct, maxNewWordsPct, hskLabel, grammar, theme, themes, focus, avoid, feedback }) {
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
  if (maxNewWordsPct < 100) {
    lines.push(
      maxNewWordsPct <= 0
        ? "Every word in each sentence must be a known word: one from the studied words list, or a single known character."
        : `In each sentence, at most ${maxNewWordsPct}% of the words (as you split them in "words", ignoring punctuation) may be new. A word is known if it is in the studied words list or is a single known character; any other word is new, even when all its characters are known.`
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
  if (theme) {
    lines.push(`Theme: every sentence must be about "${theme}". Cover different situations within that theme.`);
  } else if (themes?.length) {
    lines.push(`Themes: give each sentence a different theme, in this order where the vocabulary allows: ${themes.join("; ")}.`);
  }
  if (focus?.length) {
    lines.push(`The learner recently got these wrong: ${focus.join(" ")}. Use several of them again, each in a new sentence and a different context, wherever they fit naturally and the limits above allow.`);
  }
  if (avoid?.length) {
    lines.push("", "Do not repeat or closely paraphrase these recent sentences:", ...avoid.map((s) => `- ${s}`));
  }
  if (feedback?.length) {
    lines.push("", "Your previous attempt included sentences that broke the limits. Avoid these problems:", ...feedback.map((s) => `- ${s}`));
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

// `dispute` is the earlier verdict when the learner asks for a second opinion.
export async function gradeAnswer({ model, english, reference, answer, grammar, dispute }) {
  const result = await ask({
    model,
    system: GRADE_SYSTEM,
    messages: [{ role: "user", content: gradeRequest({ english, reference, answer, grammar, dispute }) }],
    effort: "medium",
    schema: GRADE_SCHEMA,
  });
  return normaliseGrade(result);
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

// A tiny request to check that the key, the model and the connection work.
export async function testConnection(model) {
  const started = Date.now();
  const reply = await ask({
    model,
    system: "You are a connection test. Reply with the single word OK.",
    messages: [{ role: "user", content: "Reply with OK." }],
    effort: "low",
  });
  return { reply, seconds: (Date.now() - started) / 1000 };
}
