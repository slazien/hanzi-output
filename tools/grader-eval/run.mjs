#!/usr/bin/env node
// Measures the grader against cases with known right answers, using exactly
// the prompt and scoring the app uses (js/grading.js).
//
//   OPENAI_API_KEY=sk-... node tools/grader-eval/run.mjs [model] [runs]
//
// Reports: false alarms on correct, natural answers; how many unnatural
// answers are flagged (and with the expected convention); how many wrong
// answers are caught; and how much scores move between repeated runs.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GRADE_SCHEMA, GRADE_SYSTEM, gradeRequest, normaliseGrade } from "../../js/grading.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const model = process.argv[2] || "gpt-6-luna";
const runs = Number(process.argv[3] || 1);
const key = process.env.OPENAI_API_KEY || "proxy-injected";
const tmp = mkdtempSync(join(tmpdir(), "grader-eval-"));

// curl is used so the request goes through any HTTPS proxy configured in the environment.
function grade(c, n) {
  const body = {
    model, instructions: GRADE_SYSTEM, input: [{ role: "user", content: gradeRequest(c) }],
    max_output_tokens: 16000, reasoning: { effort: "medium" }, store: false,
    text: { format: { type: "json_schema", name: "result", strict: true, schema: GRADE_SCHEMA } },
  };
  const file = join(tmp, `${c.id}-${n}.json`);
  writeFileSync(file, JSON.stringify(body));
  const out = execFileSync("curl", ["-sS", "-m", "120", "--retry", "2", "--retry-all-errors", "-X", "POST", "https://api.openai.com/v1/responses", "-H", "Content-Type: application/json", "-H", `Authorization: Bearer ${key}`, "-d", `@${file}`], { maxBuffer: 1e8 }).toString();
  const json = JSON.parse(out);
  if (json.error) throw new Error(json.error.message);
  const text = (json.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((p) => p.type === "output_text").map((p) => p.text).join("");
  return { raw: JSON.parse(text), grade: normaliseGrade(JSON.parse(text)), usage: json.usage };
}

const rows = [];
let tokensIn = 0, tokensOut = 0;
for (const c of cases) {
  const results = [];
  for (let n = 0; n < runs; n++) {
    try { const r = grade(c, n); results.push(r); tokensIn += r.usage?.input_tokens || 0; tokensOut += r.usage?.output_tokens || 0; }
    catch (e) { console.error(`${c.id}: ${e.message}`); }
  }
  if (results.length) rows.push({ c, results });
  process.stderr.write(".");
}
process.stderr.write("\n");

const flagged = (g) => g.naturalness === "unnatural" || g.naturalness === "acceptable_marked";
const hasError = (g) => g.accuracy !== "correct" || g.meaning !== "full" || g.issues.length > 0;
const first = (r) => r.results[0].grade;
const of = (kind) => rows.filter((r) => r.c.kind === kind);
const share = (list, test) => `${list.filter(test).length}/${list.length}`;

const natural = of("natural"), unnatural = of("unnatural"), errors = of("error");
console.log(`\nModel ${model}, ${runs} run(s) per case, ${rows.length} cases`);
console.log(`\nCorrect and natural answers (${natural.length})`);
console.log(`  wrongly marked as having a mistake: ${share(natural, (r) => hasError(first(r)))}`);
console.log(`  wrongly flagged as unnatural:       ${share(natural, (r) => flagged(first(r)))}`);
console.log(`  average score: ${Math.round(natural.reduce((s, r) => s + first(r).score, 0) / natural.length)}`);
console.log(`\nCorrect but unnatural answers (${unnatural.length})`);
console.log(`  flagged (as unnatural, or as a mistake): ${share(unnatural, (r) => flagged(first(r)) || hasError(first(r)))}`);
console.log(`  flagged as a naturalness point:          ${share(unnatural, (r) => flagged(first(r)))}`);
console.log(`  with the expected convention:            ${share(unnatural, (r) => first(r).convention === r.c.convention)}`);
console.log(`  average score: ${Math.round(unnatural.reduce((s, r) => s + first(r).score, 0) / unnatural.length)}`);
console.log(`\nWrong answers (${errors.length})`);
console.log(`  caught (a mistake reported):  ${share(errors, (r) => hasError(first(r)))}`);
console.log(`  scored under 80:              ${share(errors, (r) => first(r).score < 80)}`);
console.log(`  average score: ${Math.round(errors.reduce((s, r) => s + first(r).score, 0) / errors.length)}`);
if (runs > 1) {
  const spread = rows.map((r) => Math.max(...r.results.map((x) => x.grade.score)) - Math.min(...r.results.map((x) => x.grade.score)));
  // What the app would suggest: the outcome that decides when a sentence comes back.
  const band = (g) => (g.score < 50 ? "forgot" : g.score < 80 || (g.naturalness === "unnatural" && g.naturalnessSure) ? "hard" : "pass");
  const sameBand = rows.filter((r) => new Set(r.results.map((x) => band(x.grade))).size === 1).length;
  console.log(`\nSame suggested outcome (forgot / hard / pass) every run: ${sameBand}/${rows.length} cases`);
  console.log(`Repeat-run stability: same score every run in ${spread.filter((s) => s === 0).length}/${rows.length} cases; largest swing ${Math.max(...spread)} points`);
}
console.log(`\nTokens: ${tokensIn} in, ${tokensOut} out`);
console.log("\nCases worth reading:");
for (const r of rows) {
  const g = first(r);
  const bad = (r.c.kind === "natural" && (hasError(g) || flagged(g))) || (r.c.kind === "unnatural" && !flagged(g)) || (r.c.kind === "error" && !hasError(g));
  if (bad) console.log(`  ${r.c.id} [${r.c.kind}] ${r.c.answer} -> ${g.score}, ${g.meaning}/${g.accuracy}/${g.naturalness}${g.naturalVersion ? ` => ${g.naturalVersion}` : ""}${g.issues.length ? ` | ${g.issues.map((i) => `${i.category}: ${i.fix}`).join("; ")}` : ""}`);
}
writeFileSync(join(tmp, "results.json"), JSON.stringify(rows.map((r) => ({ id: r.c.id, kind: r.c.kind, answer: r.c.answer, grades: r.results.map((x) => x.grade) })), null, 1));
console.log(`\nFull results: ${join(tmp, "results.json")}`);
