// One-off quality pass over data/bank.json. Sends sentence pairs to a model in
// batches and records the ones it judges unfit for practice. Results go to
// tools/bank_audit.json; tools/build_bank.py leaves out the rejected pairs.
//
//   OPENAI_API_KEY=... node tools/audit_bank.mjs [model] [limit] [offset]
//
// Safe to stop and restart: finished batches are kept.

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const model = process.argv[2] || "gpt-6-luna";
const limit = Number(process.argv[3]) || Infinity;
const offset = Number(process.argv[4]) || 0;
const key = process.env.OPENAI_API_KEY || "proxy-injected";
const BATCH = 25, PARALLEL = 8;

const bank = JSON.parse(readFileSync(join(root, "data/bank.json"), "utf8"));
const pairs = bank.sentences.map((s) => ({ zh: s[0].replace(/ /g, ""), en: s[1] }));
const outPath = join(root, "tools/bank_audit.json");
const audit = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { model, checked: {}, rejected: [] };

const SYSTEM = `You check sentence pairs for a Chinese learning app. A learner sees the English and must write the Chinese, so the Chinese must be something a native Mandarin speaker would naturally say, and the English must be an accurate, natural translation of it.

For each numbered pair decide:
- "ok": fit for practice. Minor freedom in translation is fine. Short, plain or textbook-like sentences are fine. Mainland or Taiwan usage are both fine.
- "bad_chinese": the Chinese is ungrammatical, contains a wrong character, or is clearly not how a native speaker would say it.
- "bad_english": the English is ungrammatical or garbled, though the meaning matches.
- "mismatch": the English says something clearly different from the Chinese (wrong subject, tense that changes the meaning, missing or added information that matters).
- "unsuitable": a fragment that is not a sentence, offensive content, or a sentence that cannot be translated without context that is not given.

Be conservative: answer "ok" unless the problem is clear. Report only the pairs that are not ok, with a short reason.`;
const SCHEMA = { type: "object", additionalProperties: false, required: ["problems"], properties: { problems: { type: "array", items: { type: "object", additionalProperties: false, required: ["n", "verdict", "reason"], properties: { n: { type: "integer" }, verdict: { type: "string", enum: ["bad_chinese", "bad_english", "mismatch", "unsuitable"] }, reason: { type: "string" } } } } } };

const tmp = mkdtempSync(join(tmpdir(), "bank-audit-"));
let tokensIn = 0, tokensOut = 0;
function call(batch, id) {
  const body = { model, instructions: SYSTEM, input: [{ role: "user", content: batch.map((p, i) => `${i + 1}. ${p.zh} = ${p.en}`).join("\n") }], max_output_tokens: 8000, reasoning: { effort: "low" }, store: false, text: { format: { type: "json_schema", name: "result", strict: true, schema: SCHEMA } } };
  const file = join(tmp, `${id}.json`);
  writeFileSync(file, JSON.stringify(body));
  return new Promise((resolve, reject) => execFile("curl", ["-sS", "-m", "180", "--retry", "3", "--retry-all-errors", "-X", "POST", "https://api.openai.com/v1/responses", "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${key}`, "-d", `@${file}`], { maxBuffer: 1e8 }, (err, out) => {
    if (err) return reject(err);
    try {
      const json = JSON.parse(out);
      if (json.error) return reject(new Error(json.error.message));
      tokensIn += json.usage?.input_tokens || 0; tokensOut += json.usage?.output_tokens || 0;
      const text = (json.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((p) => p.type === "output_text").map((p) => p.text).join("");
      resolve(JSON.parse(text).problems);
    } catch (e) { reject(e); }
  }));
}

const todo = pairs.slice(offset, offset + limit).filter((p) => !audit.checked[p.zh + "\t" + p.en]);
const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
console.log(`${todo.length} pairs to check in ${batches.length} batches (${model})`);
let next = 0, failed = 0;
async function worker() {
  while (next < batches.length) {
    const id = next++, batch = batches[id];
    try {
      const problems = await call(batch, id);
      for (const p of batch) audit.checked[p.zh + "\t" + p.en] = 1;
      for (const pr of problems) { const p = batch[pr.n - 1]; if (p) audit.rejected.push({ zh: p.zh, en: p.en, verdict: pr.verdict, reason: pr.reason }); }
    } catch (e) { failed++; console.error(`batch ${id}: ${String(e.message).slice(0, 200)}`); }
    if (id % 20 === 0) { writeFileSync(outPath, JSON.stringify(audit)); process.stderr.write(`${id}/${batches.length} `); }
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
writeFileSync(outPath, JSON.stringify(audit));
const counts = {};
for (const r of audit.rejected) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
console.log(`\nChecked so far: ${Object.keys(audit.checked).length}; rejected: ${audit.rejected.length}`, counts, `| failed batches this run: ${failed} | tokens: ${tokensIn} in, ${tokensOut} out`);
