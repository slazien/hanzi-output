// Talks to the OpenAI Responses API directly from the browser with the user's
// own key. The key is read from this device's storage and sent only to
// api.openai.com.

import { getApiKey } from "./store.js";

const URL = "https://api.openai.com/v1/responses";

export async function askOpenAI({ model, system, messages, effort, schema }, fail) {
  const apiKey = getApiKey("openai");
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

  const dropped = () => fail("The connection to OpenAI failed or was interrupted. Check your internet connection and try again.");

  let response;
  try {
    response = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw dropped();
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
    throw dropped();
  }
  if (refused) throw fail("The model declined this request. Try again or pick a different sentence.");
  if (!finished) throw dropped();
  if (!schema) return text.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw fail("The model's reply could not be read. Try again.");
  }
}
