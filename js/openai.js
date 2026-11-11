// Talks to the OpenAI Responses API directly from the browser with the user's
// own key. The key is read from this device's storage and sent only to
// api.openai.com.

import { getApiKey } from "./store.js";

const URL = "https://api.openai.com/v1/responses";

export async function askOpenAI({ model, system, messages, schema }, fail) {
  const apiKey = getApiKey("openai");
  if (!apiKey) throw fail("Add your OpenAI API key in Settings first.");

  const body = {
    model,
    instructions: system,
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: 16000,
    store: false,
  };
  if (schema) body.text = { format: { type: "json_schema", name: "result", strict: true, schema } };

  let response;
  try {
    response = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    // OpenAI's error replies can be unreadable from a browser, so a rejected
    // key can look the same as having no connection.
    throw fail("Could not get a reply from OpenAI. Check your internet connection and the API key in Settings.");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* handled below */
  }
  if (!response.ok) {
    const detail = data?.error?.message || "";
    if (response.status === 401) throw fail("OpenAI rejected the API key. Check it in Settings.");
    if (response.status === 403) throw fail("This API key is not allowed to use the selected model.");
    if (response.status === 404) throw fail("The selected model was not found for this API key. Pick another model in Settings.");
    if (response.status === 429) throw fail(`OpenAI rate limit or quota reached. ${detail}`.trim());
    throw fail(`OpenAI returned an error (${response.status}). ${detail}`.trim());
  }
  if (!data) throw fail("OpenAI's reply could not be read. Try again.");
  if (data.status === "incomplete") throw fail("The reply was cut off. Try again.");

  const parts = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []);
  if (parts.some((p) => p.type === "refusal")) throw fail("The model declined this request. Try again or pick a different sentence.");
  const text = parts.filter((p) => p.type === "output_text").map((p) => p.text).join("");
  if (!schema) return text.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw fail("The model's reply could not be read. Try again.");
  }
}
