// Talks to the OpenAI Responses API directly from the browser with the user's
// own key. The key is read from this device's storage and sent only to
// api.openai.com.

import { getApiKey, cleanApiKey } from "./store.js";

const URL = "https://api.openai.com/v1/responses";

// Release number of this file; Settings compares it with the main script's.
export const OPENAI_MODULE_VERSION = 22;

export async function askOpenAI({ model, system, messages, effort, schema }, fail) {
  // Spaces and invisible characters saved with an older version are dropped here.
  const { key: apiKey, bad } = cleanApiKey(getApiKey("openai"));
  if (!apiKey) throw fail("Add your OpenAI API key in Settings first.");

  // Streamed, so data keeps flowing while the model works: mobile browsers
  // drop a connection that stays silent for about a minute.
  const body = {
    model,
    instructions: system,
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: 16000,
    reasoning: { effort: effort === "medium" ? "medium" : "low" },
    store: false,
    stream: true,
  };
  if (schema) body.text = { format: { type: "json_schema", name: "result", strict: true, schema } };

  if (bad.length) {
    throw fail(`The saved OpenAI key contains characters a key cannot have (${bad.slice(0, 5).join(" ")}). Paste the key again in Settings.`);
  }

  // Says where the request died and what the browser reported, so a failure
  // on one device can be told apart from a real network problem.
  let received = 0;
  const dropped = (stage, error) => fail(
    `The connection to OpenAI failed or was interrupted. Check your internet connection and try again. (Details: ${stage}; ${error ? `${error.name}: ${error.message}` : "no error reported"}; ${received} bytes received; key ${apiKey.length} characters.)`
  );

  let response;
  try {
    response = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw dropped("the request could not be sent or was blocked", error);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.error?.message || "";
    } catch {
      /* no readable body */
    }
    if (response.status === 401) throw fail("OpenAI rejected the API key. Check it in Settings.");
    if (response.status === 403) throw fail("This API key is not allowed to use the selected model.");
    if (response.status === 404) throw fail("The selected model was not found for this API key. Pick another model in Settings.");
    if (response.status === 429) throw fail(`OpenAI rate limit or quota reached. ${detail}`.trim());
    throw fail(`OpenAI returned an error (${response.status}). ${detail}`.trim());
  }

  // Read the server-sent events and collect the text as it arrives.
  let text = "";
  let refused = false;
  let finished = false;
  const reported = (message) => Object.assign(fail(message), { fromReply: true });
  const handle = (event) => {
    if (event.type === "response.output_text.delta") text += event.delta || "";
    else if (event.type === "response.refusal.delta" || event.type === "response.refusal.done") refused = true;
    else if (event.type === "response.completed") finished = true;
    else if (event.type === "response.incomplete") throw reported("The reply was cut off. Try again.");
    else if (event.type === "response.failed") throw reported(`OpenAI could not finish the reply. ${event.response?.error?.message || ""}`.trim());
    else if (event.type === "error") throw reported(`OpenAI returned an error. ${event.message || ""}`.trim());
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        handle(event);
      }
    }
  } catch (error) {
    if (error?.fromReply) throw error; // a problem OpenAI reported, not a lost connection
    throw dropped("the reply stopped while it was being read", error);
  }
  if (refused) throw fail("The model declined this request. Try again or pick a different sentence.");
  if (!finished) throw dropped("the reply ended before it was complete", null);
  if (!schema) return text.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw fail("The model's reply could not be read. Try again.");
  }
}
