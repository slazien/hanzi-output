import { state, save, getApiKey, setApiKey, cleanApiKey, exportData, importData, resetAll } from "./store.js";
import { parseHanly, buildKnown, isHan, hanChars, hskLevelOf, hskAllowed, isKnownWord, measure, measureWords } from "./known.js";
import { MODELS, DEFAULT_MODEL, PROVIDERS, providerOf, gradeAnswer, followUp, testConnection, MODULE_VERSION } from "./claude.js";
import { buildSession, dueReviews, scheduleReview, recordAttempt, setLastRating, addWeak, easeWeak, countFitting, hskLabel, PASS_SCORE, RATINGS, previewInterval, intervalText, suggestRating, logAttempt, reviewsLeftToday } from "./session.js";
import { GRAMMAR } from "../data/grammar.js";
import { loadBank, bankReady, creditOf, fitting } from "./bank.js";
import { accountsEnabled, emailSignIn, status as syncStatus, initSync, onSyncChange, signInWithGoogle, sendEmailCode, verifyEmailCode, signOut, syncNow, deleteSynced } from "./sync.js";
import { weakAreas, recallRate, weeklyScores, breakdown, forecast, calendar, CATEGORIES } from "./insight.js";
import { THEMES, ALL_THEMES } from "../data/themes.js";

// Shown at the bottom of Settings, to tell which release a device is running.
const APP_VERSION = 21;

const main = document.getElementById("main");

// ---------- tiny DOM helper ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const scoreClass = (score) => (score >= PASS_SCORE ? "" : score >= 50 ? "mid" : "low");

// A saved model that is no longer offered falls back to the cheapest one.
if (!MODELS.some((m) => m.id === state.settings.model)) {
  state.settings.model = DEFAULT_MODEL;
  save();
}

// The provider (Anthropic or OpenAI) of the model currently selected.
const provider = () => providerOf(state.settings.model);
const providerName = () => PROVIDERS[provider()];
const keyHint = () => (provider() === "openai" ? "sk-…" : "sk-ant-…");
function modelPicker(id, onchange) {
  const select = h("select", { id, onchange },
    Object.entries(PROVIDERS).map(([key, name]) => h("optgroup", { label: name },
      MODELS.filter((m) => m.provider === key).map((m) => h("option", { value: m.id }, `${m.label} — ${m.price} per million tokens`)))));
  select.value = state.settings.model;
  return select;
}

// A styled file chooser: a button, with the chosen file's name beside it.
function filePicker(id, label, onFile) {
  const name = h("span", { class: "file-name muted small" });
  const input = h("input", { type: "file", id, accept: ".json,application/json", onchange: (e) => {
    const f = e.target.files[0];
    if (!f) return;
    name.textContent = f.name;
    onFile(f);
  } });
  return h("div", { class: "file" }, h("label", { class: "btn", for: id }, label), input, name);
}

// ---------- navigation ----------

let view = "practice";
let known = buildKnown(state);

// Practice state for the session in progress (kept in memory only).
let P = { phase: "setup" };

function go(next) {
  view = next;
  render();
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => go(tab.dataset.view)));

function render() {
  known = buildKnown(state);
  if (typeof trackKnown === "function") trackKnown();
  document.querySelectorAll(".tab").forEach((tab) => {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  const content = view === "history" ? historyView() : view === "progress" ? progressView() : view === "settings" ? settingsView() : practiceView();
  // Short practice screens sit in the middle of the page on a tall display.
  main.classList.toggle("centered", view === "practice" && ["loading", "answer", "grading"].includes(P.phase));
  main.replaceChildren(...[content].flat());
}

// ---------- practice ----------

function practiceView() {
  switch (P.phase) {
    case "loading":
      return h("section", { class: "card" }, h("div", { class: "loading", role: "status" }, h("div", { class: "brush" }), h("div", {}, P.message || "Choosing sentences…")));
    case "answer":
    case "grading":
      return answerView();
    case "feedback":
      return feedbackView();
    case "summary":
      return summaryView();
    default:
      return state.onboarded ? setupView() : onboardingView();
  }
}

// First-run setup: the same settings as the Settings screen, in one place.
function onboardingView() {
  const s = state.settings;
  const finish = () => { state.onboarded = true; flash = null; save(); render(); window.scrollTo(0, 0); };

  const file = filePicker("ob-hanly", "Choose Hanly file", async (f) => {
    try {
      state.hanly = { importedAt: Date.now(), fileName: f.name, entries: parseHanly(await f.text()) };
      save();
      note("ob-hanly", "ok", `Imported. ${buildKnown(state).hanlyCount} characters count as known.`);
    } catch (error) {
      note("ob-hanly", "error", error.message);
    }
  });

  const keyInput = h("input", { type: "password", id: "ob-key", autocomplete: "off", placeholder: keyHint(),
    // Updated in place (no re-render, no layout shift) so a tap on another control right after typing is not lost.
    onchange: (e) => {
      const { key, bad } = cleanApiKey(e.target.value);
      if (!key) return;
      if (bad.length) { keyStatus.textContent = `Not saved: a key cannot contain ${bad.slice(0, 5).join(" ")}. Paste it again.`; return; }
      setApiKey(key, provider());
      keyStatus.textContent = "Key saved on this device.";
    } });
  const keyStatus = h("div", { class: "hint", role: "status" }, getApiKey(provider()) ? "Key saved on this device." : "No key saved yet.");

  const pctLabel = h("span", {}, newPctText(s.maxNewPct));
  const wordsLabel = h("span", {}, newPctText(s.maxNewWordsPct));
  const levels = [1, 2, 3, 4, 5, 6];

  return [
    h("section", { class: "card" },
      h("h1", {}, "Set up your practice"),
      h("p", { class: "lede tight" }, "Four quick choices so sentences match what you already know. Everything here can be changed later in Settings.")),

    h("section", { class: "card" },
      h("h2", {}, "1. Bring in your Hanly progress"),
      h("p", { class: "muted small" }, "Choose the learning progress export (.json) from Hanly. Characters you have learned there become the characters sentences are built from. The file stays on this device."),
      flashFor("ob-hanly"),
      state.hanly && !flashFor("ob-hanly") ? h("div", { class: "notice ok" }, `${state.hanly.fileName} is imported. ${known.hanlyCount} characters count as known.`) : null,
      file),

    h("section", { class: "card" },
      h("h2", {}, "2. Choose a model and add your API key"),
      h("p", { class: "muted small" }, "Sentences come from a stored bank. An AI model grades your answers and answers follow-up questions, using your own OpenAI or Anthropic key. The key is stored only in this browser and sent only to that provider."),
      h("div", { class: "field" }, modelPicker("ob-model", (e) => { s.model = e.target.value; save(); render(); })),
      h("label", { for: "ob-key" }, `${providerName()} API key`),
      h("div", { class: "field" }, keyInput, keyStatus)),

    h("section", { class: "card" },
      h("h2", {}, "3. Which HSK level are you studying?"),
      h("p", { class: "muted small" }, "New characters and grammar in your sentences will come from this level and below."),
      h("div", { class: "segmented", role: "group" },
        levels.map((n) => h("button", { type: "button", "aria-pressed": String(s.hskCap === n), onclick: () => { s.hskCap = n; save(); render(); } }, `HSK ${n}`)))),

    h("section", { class: "card" },
      h("h2", {}, "4. How much new material per sentence?"),
      h("div", { class: "field" },
        h("label", { for: "ob-maxnew" }, "New characters: ", pctLabel),
        h("input", { type: "range", id: "ob-maxnew", min: "0", max: "100", step: "5", value: String(s.maxNewPct),
          oninput: (e) => { pctLabel.textContent = newPctText(Number(e.target.value)); },
          onchange: (e) => { s.maxNewPct = Number(e.target.value); save(); } }),
        h("div", { class: "hint" }, "The largest share of a sentence's characters that may be ones you have not learned. At 0% sentences use only characters you know.")),
      h("div", { class: "field" },
        h("label", { for: "ob-maxnewwords" }, "New words: ", wordsLabel),
        h("input", { type: "range", id: "ob-maxnewwords", min: "0", max: "100", step: "5", value: String(s.maxNewWordsPct),
          oninput: (e) => { wordsLabel.textContent = newPctText(Number(e.target.value)); },
          onchange: (e) => { s.maxNewWordsPct = Number(e.target.value); save(); } }),
        h("div", { class: "hint" }, "The largest share of a sentence's words that may be new. A word is known if you studied it in Hanly or it is a single character you know."))),

    h("div", { class: "row between" },
      h("button", { class: "btn quiet", type: "button", onclick: finish }, "Skip for now"),
      h("button", { class: "btn primary", type: "button", onclick: finish }, "Start practising")),
  ];
}

let adjustOpen = false; // whether "Adjust session" is expanded on the setup screen

function setupView() {
  const s = state.settings;
  const due = dueReviews().length;
  const set = (key, value) => {
    s[key] = value;
    save();
    render();
  };

  const grammarOptions = [h("option", { value: "" }, "Any grammar")];
  for (let level = 1; level <= 6; level++) {
    if (s.hskCap && level > s.hskCap) break;
    const group = h("optgroup", { label: `HSK ${level}` });
    GRAMMAR.filter((g) => g.level === level).forEach((g) => group.append(h("option", { value: g.pattern }, `${g.pattern} — ${g.name}`)));
    grammarOptions.push(group);
  }
  const grammarSelect = h("select", { id: "grammar", onchange: (e) => set("grammar", e.target.value) }, grammarOptions);
  grammarSelect.value = s.grammar;
  if (grammarSelect.value !== s.grammar) {
    s.grammar = "";
    grammarSelect.value = "";
    save();
  }

  const themeSelect = h("select", { id: "theme", onchange: (e) => set("theme", e.target.value) },
    h("option", { value: "" }, "Random mix of themes"),
    THEMES.map((g) => h("optgroup", { label: g.group }, g.items.map((t) => h("option", { value: t }, t)))));
  themeSelect.value = ALL_THEMES.includes(s.theme) ? s.theme : "";

  const pctLabel = h("span", {}, newPctText(s.maxNewPct));
  const slider = h("input", {
    type: "range", id: "maxnew", min: "0", max: "100", step: "5", value: String(s.maxNewPct),
    oninput: (e) => { pctLabel.textContent = newPctText(Number(e.target.value)); },
    onchange: (e) => set("maxNewPct", Number(e.target.value)),
  });

  const wordsLabel = h("span", {}, newPctText(s.maxNewWordsPct));
  const wordsSlider = h("input", {
    type: "range", id: "maxnewwords", min: "0", max: "100", step: "5", value: String(s.maxNewWordsPct),
    oninput: (e) => { wordsLabel.textContent = newPctText(Number(e.target.value)); },
    onchange: (e) => set("maxNewWordsPct", Number(e.target.value)),
  });

  const segmented = (key, options) =>
    h("div", { class: "segmented", role: "group" },
      options.map(([value, label]) => h("button", { type: "button", "aria-pressed": String(s[key] === value), onclick: () => set(key, value) }, label)));

  // How many stored sentences fit the settings (shown once the bank has loaded).
  const fit = countFitting();
  const fitText = fit == null ? "Loading the sentence bank…"
    : fit === 0 ? "No sentences in the bank fit these settings. Allow more new characters or words, or change the theme or grammar."
      : `${fit.toLocaleString()} ${fit === 1 ? "sentence fits" : "sentences fit"} these settings.`;

  const weak = state.weak || [];
  const summary = [
    `${newPctText(s.maxNewPct)} new characters`,
    `${newPctText(s.maxNewWordsPct)} new words`,
    hskLabel() || "no HSK cap",
    s.grammar || "any grammar",
  ].join(" · ");

  return h("section", { class: "card" },
    h("h1", {}, "Sentence practice"),
    h("p", { class: "lede" }, `${due} due for review · ${known.chars.size} characters known`),
    !getApiKey(provider()) && h("div", { class: "notice" }, `Add your ${providerName()} API key so your answers can be graded. `, h("button", { class: "linkish", type: "button", onclick: () => go("settings") }, "Open Settings")),
    !state.hanly && h("div", { class: "notice" }, "No Hanly progress imported yet, so the app does not know which characters you know. ", h("button", { class: "linkish", type: "button", onclick: () => go("settings") }, "Import it in Settings")),
    P.error && h("div", { class: "notice error", role: "alert" }, P.error),
    h("button", { class: "btn primary wide big", type: "button", id: "start", disabled: !getApiKey(provider()) || fit === 0, onclick: () => startSession() }, `Start · ${s.sessionLength} sentences`),
    h("p", { class: `small fit-line ${fit === 0 ? "warn" : "muted"}`, role: "status" }, fitText),
    weak.length ? h("p", { class: "muted small focus-line" }, "Coming back in new sentences: ", h("span", { class: "hanzi", lang: "zh-Hans" }, weak.slice(0, 8).map((w) => w.text).join(" ")), " ",
      h("button", { class: "linkish", type: "button", onclick: () => { state.weak = []; save(); render(); } }, "Clear")) : null,
    h("div", { class: "field" },
      h("label", { for: "theme" }, "Theme"),
      themeSelect),
    weakList(),
    h("details", { class: "adjust", open: adjustOpen, ontoggle: (e) => { adjustOpen = e.target.open; } },
      h("summary", {}, h("span", { class: "adjust-title" }, "Adjust session"), h("span", { class: "muted small" }, summary)),
      h("div", { class: "field" },
        h("div", { class: "label" }, "Number of sentences"),
        segmented("sessionLength", [[5, "5"], [10, "10"], [15, "15"], [20, "20"]])),
      h("div", { class: "field" },
        h("label", { for: "maxnew" }, "New characters per sentence: ", pctLabel),
        slider,
        h("div", { class: "hint" }, "The largest share of a sentence's characters that may be ones you have not learned. At 0% sentences use only characters you know.")),
      h("div", { class: "field" },
        h("label", { for: "maxnewwords" }, "New words per sentence: ", wordsLabel),
        wordsSlider,
        h("div", { class: "hint" }, "The largest share of a sentence's words that may be new. A word is known if you studied it in Hanly, marked it here, or it is a single character you know.")),
      h("div", { class: "field" },
        h("div", { class: "label" }, `New characters and grammar up to (${s.hskScheme === "old" ? "HSK 2.0" : "HSK 3.0"})`),
        segmented("hskCap", [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"], [0, "None"]])),
      h("div", { class: "field" },
        h("label", { for: "grammar" }, "Grammar pattern"),
        grammarSelect)));
}

// Weak areas found in recent practice, each with a button for a focused session.
function weakList() {
  const areas = weakAreas(state.log || []).slice(0, 5);
  if (!areas.length) return null;
  const kind = { theme: "Theme", grammar: "Grammar", category: "Mistake type", word: "Word" };
  return h("div", { class: "weak" },
    h("h3", {}, "Weak areas"),
    areas.map((a) => h("div", { class: "weak-row" },
      h("div", { class: "grow" },
        h("div", {}, h("span", { class: "muted small" }, `${kind[a.kind]}: `), h("b", { class: a.kind === "word" || a.kind === "grammar" ? "hanzi" : "" }, a.label)),
        h("div", { class: "muted small" }, a.detail)),
      h("button", { class: "btn", type: "button", disabled: !getApiKey(provider()), onclick: () => startSession(a) }, "Practise this"))),
    h("p", { class: "muted small" }, "A focused session gives about 60% of its sentences to the area and mixes in ordinary ones."));
}

const newPctText = (pct) => (pct === 0 ? "no" : pct >= 100 ? "any" : `up to ${pct}%`);

async function startSession(focus = null) {
  P = { phase: "loading", message: "Choosing sentences…" };
  render();
  try {
    const { items, notice } = await buildSession((message) => {
      P.message = message;
      if (view === "practice" && P.phase === "loading") render();
    }, focus);
    beginSession(items, notice);
  } catch (error) {
    P = { phase: "setup", error: error.message };
    render();
  }
}

function beginSession(items, notice = "") {
  P = { phase: "answer", items, index: 0, results: [], draft: "", hintLevel: 0, newShown: false, notice };
  render();
  window.scrollTo(0, 0);
  focusAnswer();
}

function focusAnswer() {
  if (view === "practice" && P.phase === "answer") document.getElementById("answer")?.focus();
}

function progressBar() {
  const bar = h("i");
  bar.style.width = `${(P.index / P.items.length) * 100}%`;
  return h("div", { class: "progress" },
    h("span", {}, `${P.index + 1} of ${P.items.length}`),
    h("div", { class: "bar" }, bar),
    h("button", { class: "linkish", type: "button", onclick: endSession }, "End session"));
}

function itemTags(item) {
  return h("div", { class: "tags" },
    item.tries ? h("span", { class: "tag review" }, "Again") : item.reviewId && h("span", { class: "tag review" }, item.variantOf ? "Review, new wording" : "Review"),
    item.focus && h("span", { class: "tag review" }, `Focus: ${item.focus}`),
    item.theme && h("span", { class: "tag" }, item.theme),
    item.grammar && h("span", { class: "tag hanzi" }, item.grammar),
    item.hsk && h("span", { class: "tag" }, item.hsk),
    h("span", { class: "tag" }, newShareText(item)));
}

function newShareText(item) {
  const c = Math.round(measure(item.chinese, known.chars, null).pct);
  const w = item.words ? Math.round(measureWords(item.words, known).pct) : null;
  if (!c && !w) return "Nothing new";
  return w == null ? `${c}% new characters` : `${c}% new characters · ${w}% new words`;
}

// Words in the sentence the learner has not studied, without repeats.
function newWordsOf(item) {
  const seen = new Set();
  return (item.words || []).filter((w) => {
    if (!hanChars(w.text).length || isKnownWord(w.text, known) || seen.has(w.text)) return false;
    seen.add(w.text);
    return true;
  });
}

// Enter on its own submits; Shift+Enter makes a new line. Enter that confirms
// a pinyin candidate (composition) is left alone.
const isPlainEnter = (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;

function answerView() {
  const item = P.items[P.index];
  const grading = P.phase === "grading";
  const input = h("textarea", {
    id: "answer", class: "answer-input", lang: "zh-Hans", rows: "2", placeholder: "用中文写…",
    autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Your Chinese translation", enterkeyhint: "done",
    disabled: grading, value: P.draft || "",
    oninput: (e) => { P.draft = e.target.value; check.disabled = !P.draft.trim(); },
    onkeydown: (e) => { if (isPlainEnter(e)) { e.preventDefault(); submitAnswer(); } },
  });
  const check = h("button", { class: "btn primary grow", type: "button", disabled: grading || !(P.draft || "").trim(), onclick: submitAnswer }, grading ? "Checking…" : "Check answer");

  // New words are given, so the sentence stays something you can produce.
  const fresh = newWordsOf(item);
  const showNew = P.newShown || item.overLimit;
  const newWords = fresh.length ? h("div", { class: "newwords" },
    showNew
      ? [h("div", { class: "newwords-title" }, item.overLimit ? "This sentence goes past your limit, so its new words are given:" : "New words in this sentence:"),
        h("ul", {}, fresh.map((w) => h("li", {}, h("span", { class: "hanzi nw", lang: "zh-Hans" }, w.text), h("span", { class: "muted" }, ` ${w.pinyin}`), w.gloss ? ` — ${w.gloss}` : "")))]
      : h("button", { class: "linkish", type: "button", onclick: () => { P.newShown = true; render(); focusAnswer(); } }, fresh.length === 1 ? "Show the 1 new word" : `Show the ${fresh.length} new words`)) : null;

  // Hints: first word, then the pinyin of the whole sentence.
  const words = (item.words || []).filter((w) => hanChars(w.text).length);
  const maxHint = words.length ? 2 : 1;
  const hintText = P.hintLevel >= 2
    ? [h("span", { class: "muted" }, "Pinyin: "), words.map((w) => w.pinyin).join(" ")]
    : P.hintLevel === 1
      ? [h("span", { class: "muted" }, "Starts with: "), h("span", { class: "hanzi nw", lang: "zh-Hans" }, words.length ? words[0].text : [...item.chinese][0]), "…"]
      : null;

  return h("section", { class: "card" },
    progressBar(),
    itemTags(item),
    h("p", { class: "prompt" }, item.english),
    newWords,
    P.notice && P.index === 0 && h("div", { class: "notice" }, P.notice),
    P.error && h("div", { class: "notice error", role: "alert" }, P.error),
    h("div", { class: "field" }, input, hintText && h("div", { class: "hintline", role: "status" }, hintText)),
    h("div", { class: "row" },
      h("button", { class: "btn", type: "button", disabled: grading || P.hintLevel >= maxHint, onclick: () => { P.hintLevel += 1; render(); focusAnswer(); } }, P.hintLevel ? "Another hint" : "Hint"),
      h("button", { class: "btn", type: "button", disabled: grading, onclick: skipAnswer }, "Show answer"),
      check));
}

async function submitAnswer() {
  const answer = (P.draft || "").trim();
  if (!answer || P.phase !== "answer") return;
  const item = P.items[P.index];
  P.phase = "grading";
  P.error = "";
  render();
  try {
    const grade = await gradeAnswer({ model: state.settings.model, english: item.english, reference: item.chinese, answer, grammar: item.grammar });
    finishItem(item, answer, grade);
  } catch (error) {
    P.phase = "answer";
    P.error = error.message;
    render();
    focusAnswer();
  }
}

function skipAnswer() {
  const item = P.items[P.index];
  finishItem(item, "", { score: 0, verdict: "Answer shown", corrected: "", strengths: [], issues: [], weak: [], note: "", skipped: true });
}

function finishItem(item, answer, grade) {
  recordAttempt(item, answer, grade);
  addWeak(grade.weak);
  // A hint means the sentence was not fully recalled, whatever the score.
  let suggested = suggestRating(grade);
  const order = RATINGS.map((r) => r.id);
  const cap = P.hintLevel >= 2 ? "hard" : P.hintLevel === 1 ? "recalled" : "easy";
  if (order.indexOf(suggested) > order.indexOf(cap)) suggested = cap;
  const result = { item, answer, grade, rating: null };
  P.results.push(result);
  P.current = { item, answer, grade, result, suggested, rated: false, thread: [], selected: -1, retry: null };
  P.phase = "feedback";
  P.error = "";
  render();
  window.scrollTo(0, 0);
}

// ---------- comparing two Chinese strings ----------

const squashText = (t) => String(t || "").replace(/\s+/g, "");
const hanOnly = (t) => hanChars(String(t || "")).join("");

// Marks which characters of `a` and `b` are shared (longest common
// subsequence). Punctuation is never marked as a difference.
function diffChars(a, b) {
  const x = [...squashText(a)];
  const y = [...squashText(b)];
  const m = x.length;
  const n = y.length;
  const t = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const sameX = new Array(m).fill(false);
  const sameY = new Array(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) { sameX[i++] = true; sameY[j++] = true; }
    else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  const mark = (chars, same) => chars.map((ch, k) => ({ ch, same: same[k] || !isHan(ch) }));
  return [mark(x, sameX), mark(y, sameY)];
}

const diffLine = (marks, cls) => marks.map((c) => (c.same ? c.ch : h("span", { class: cls }, c.ch)));

// ---------- audio ----------

const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
function speak(text) {
  if (!canSpeak) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN";
  u.rate = 0.9;
  const voice = speechSynthesis.getVoices().find((v) => /^zh([-_](CN|Hans))?/i.test(v.lang));
  if (voice) u.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// The reference sentence, Hanly-style: pinyin above each word, words you know
// underlined, new words dotted. Tap a word for its meaning.
function referenceBlock(item, cur) {
  const listen = canSpeak ? h("button", { class: "linkish muted small", type: "button", onclick: () => speak(item.chinese) }, "Listen") : null;
  if (!item.words) return h("div", {}, h("p", { class: "line-zh", lang: "zh-Hans" }, item.chinese), listen);
  const showPinyin = state.settings.showPinyin;

  // The panel always takes up its space, so tapping a word moves nothing.
  const panel = h("div", { class: "gloss" });
  const fill = () => {
    const w = item.words[cur.selected];
    if (!w) {
      panel.classList.add("empty");
      panel.replaceChildren("Tap a word for its meaning.");
      return;
    }
    panel.classList.remove("empty");
    const word = hanChars(w.text).join("");
    const freshChars = [...new Set(hanChars(w.text).filter((c) => !known.chars.has(c)))];
    const parts = [h("div", { class: "gloss-main" }, h("span", { class: "py" }, w.pinyin || "—"), h("span", {}, w.gloss || ""))];
    const actions = [];
    if (!isKnownWord(w.text, known) && word.length > 1) {
      actions.push(h("button", { class: "btn", type: "button", onclick: () => markWordKnown(word) }, `I know ${word}`));
    }
    freshChars.forEach((c) => {
      const level = hskLevelOf(c, state.settings.hskScheme);
      actions.push(h("button", { class: "btn", type: "button", onclick: () => markKnown(c) }, `I know ${c}`, level ? h("span", { class: "muted" }, ` · HSK ${level === 7 ? "7-9" : level}`) : null));
    });
    if (actions.length) parts.push(h("div", { class: "row" }, actions));
    panel.replaceChildren(...parts);
  };
  const buttons = item.words.map((w, i) => {
    if (!hanChars(w.text).length) return h("span", { class: "word punct" }, showPinyin && h("span", { class: "py-top" }, " "), h("span", { class: "zh" }, w.text));
    return h("button", {
      class: `word ${isKnownWord(w.text, known) ? "known" : "new"}`, type: "button", "aria-pressed": String(cur.selected === i),
      onclick: () => {
        cur.selected = cur.selected === i ? -1 : i;
        buttons.forEach((b, j) => b.tagName === "BUTTON" && b.setAttribute("aria-pressed", String(j === cur.selected)));
        fill();
      },
    }, showPinyin && h("span", { class: "py-top", lang: "zh-Latn" }, w.pinyin || " "), h("span", { class: "zh" }, w.text));
  });
  fill();
  return h("div", {},
    h("div", { class: "words", lang: "zh-Hans" }, buttons),
    panel,
    h("div", { class: "row between ref-foot" },
      h("span", { class: "muted small" }, "Solid underline: words you know. Dotted: new words.", creditLine(item)),
      h("span", { class: "row" }, listen,
        h("button", { class: "linkish muted small", type: "button", onclick: () => { state.settings.showPinyin = !showPinyin; save(); render(); } }, showPinyin ? "Hide pinyin" : "Show pinyin"))));
}

// Credit for sentences taken from an open collection.
function creditLine(item) {
  const credit = item.src == null ? null : creditOf(item);
  if (!credit) return null;
  return [" Sentence: ", h("a", { href: credit.url, target: "_blank", rel: "noopener" }, credit.text), ` (${credit.licence}).`];
}

function markKnown(ch) {
  if (!known.chars.has(ch)) {
    state.extraKnown = (state.extraKnown || "") + ch;
    save();
  }
  render();
}

function markWordKnown(word) {
  if (!(state.extraWords || []).includes(word)) {
    state.extraWords = [...(state.extraWords || []), word];
    save();
  }
  render();
}

const issueList = (issues) => issues.map((i) =>
  h("div", { class: "issue" },
    h("div", {}, i.quote && h("span", { class: "quote", lang: "zh-Hans" }, i.quote), i.fix && h("span", { class: "fix", lang: "zh-Hans" }, i.fix)),
    h("div", {}, i.problem)));

// "Try again from memory": the answers are hidden, the learner retypes the
// sentence, and it is compared on the device (no AI call).
function retryView(cur) {
  const { item, grade } = cur;
  const r = cur.retry;
  const compare = () => {
    const typed = (r.text || "").trim();
    if (!typed) return;
    const targets = [item.chinese, grade.corrected].filter(Boolean);
    r.match = targets.some((t) => hanOnly(t) === hanOnly(typed));
    // Show the difference against whichever version is closer.
    const scored = targets.map((t) => ({ t, same: diffChars(typed, t)[1].filter((c) => c.same).length / Math.max(1, [...squashText(t)].length) }));
    r.target = scored.sort((a, b) => b.same - a.same)[0].t;
    r.checked = true;
    render();
  };
  const input = h("textarea", {
    id: "retry", class: "answer-input", lang: "zh-Hans", rows: "2", placeholder: "再写一次…", "aria-label": "Write the sentence again",
    autocapitalize: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "done", value: r.text || "", disabled: r.checked,
    oninput: (e) => { r.text = e.target.value; },
    onkeydown: (e) => { if (isPlainEnter(e)) { e.preventDefault(); compare(); } },
  });
  let result = null;
  if (r.checked) {
    const [mine, theirs] = diffChars(r.text, r.target);
    result = r.match
      ? h("div", { class: "notice ok", role: "status" }, "That matches. Well recalled.")
      : [h("div", { class: "notice", role: "status" }, "Not quite the same. The marked characters differ."),
        h("h3", {}, "You wrote"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, diffLine(mine, "del")),
        h("h3", {}, "Correct sentence"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, diffLine(theirs, "chg"))];
  }
  return h("section", { class: "card" },
    progressBar(),
    h("div", { class: "tags" }, h("span", { class: "tag review" }, "From memory")),
    h("p", { class: "prompt" }, item.english),
    h("div", { class: "field" }, input),
    result,
    h("div", { class: "row" },
      !r.checked && h("button", { class: "btn primary grow", type: "button", onclick: compare }, "Compare"),
      r.checked && !r.match && h("button", { class: "btn", type: "button", onclick: () => { cur.retry = { text: "" }; render(); document.getElementById("retry")?.focus(); } }, "Try once more"),
      h("button", { class: r.checked ? "btn primary grow" : "btn", type: "button", onclick: () => { cur.retry = null; render(); window.scrollTo(0, 0); } }, "Back to feedback")));
}

function feedbackView() {
  const cur = P.current;
  if (cur.retry) return retryView(cur);
  const { item, answer, grade } = cur;
  const changed = grade.corrected && hanOnly(grade.corrected) !== hanOnly(answer);
  const [mine, fixed] = changed ? diffChars(answer, grade.corrected) : [null, null];

  const threadBox = h("div", { class: "thread" }, cur.thread.map((m) => h("div", { class: `bubble ${m.role}` }, m.text)));
  const question = h("input", { type: "text", id: "followup", placeholder: "Ask about this sentence…", "aria-label": "Follow-up question", enterkeyhint: "send", disabled: cur.asking,
    onkeydown: (e) => { if (isPlainEnter(e)) ask(); } });
  const ask = async () => {
    const text = question.value.trim();
    if (!text || cur.asking) return;
    cur.thread.push({ role: "user", text });
    cur.asking = true;
    cur.askError = "";
    render();
    try {
      const reply = await followUp({ model: state.settings.model, item, answer, grade: grade.skipped ? null : grade, thread: cur.thread });
      cur.thread.push({ role: "assistant", text: reply });
    } catch (error) {
      cur.thread.pop();
      cur.askError = error.message;
      cur.pending = text;
    }
    cur.asking = false;
    if (P.current === cur) {
      render();
      document.getElementById("followup")?.focus();
    }
  };
  if (cur.pending) { question.value = cur.pending; cur.pending = ""; }

  const more = grade.strengths.length || grade.note || item.note;

  return h("section", { class: "card" },
    progressBar(),
    h("div", { class: "result-head" },
      h("div", { class: `score ${grade.skipped ? "none" : scoreClass(grade.score)}`, "aria-label": grade.skipped ? "Answer shown" : `Score ${grade.score} out of 100` }, grade.skipped ? "–" : grade.score),
      h("div", {}, h("div", { class: "verdict" }, grade.verdict), h("div", { class: "muted" }, item.english))),

    grade.issues.length ? [h("h3", {}, "What to fix"), issueList(grade.issues)] : null,

    !grade.skipped && [h("h3", {}, "Your answer"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, changed ? diffLine(mine, "del") : answer)],
    changed && [h("h3", {}, "Corrected"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, diffLine(fixed, "chg"))],

    h("h3", {}, "Reference answer", item.hsk ? h("span", { class: "tag inline" }, item.hsk) : null),
    referenceBlock(item, cur),

    h("div", { class: "row retry-row" },
      h("button", { class: "btn", type: "button", onclick: () => { cur.retry = { text: "" }; render(); window.scrollTo(0, 0); document.getElementById("retry")?.focus(); } }, "Try again from memory"),
      h("span", { class: "muted small" }, "Hides the answers so you can write the sentence once more.")),

    more ? h("details", { class: "more" },
      h("summary", {}, "More feedback"),
      item.note && [h("h3", {}, "About this sentence"), h("p", {}, item.note)],
      grade.strengths.length ? [h("h3", {}, "What worked"), h("ul", { class: "points" }, grade.strengths.map((t) => h("li", {}, t)))] : null,
      grade.note && [h("h3", {}, "For next time"), h("p", {}, grade.note)]) : null,

    h("h3", {}, "Ask a follow-up"),
    threadBox,
    cur.asking && h("p", { class: "muted small", role: "status" }, "Thinking…"),
    cur.askError && h("div", { class: "notice error", role: "alert" }, cur.askError),
    h("div", { class: "row" }, h("div", { class: "grow" }, question), h("button", { class: "btn", type: "button", disabled: cur.asking, onclick: ask }, "Ask")),

    h("div", { class: "rate-box" },
      h("div", { class: "row between" },
        h("h3", {}, "How did that feel?"),
        h("span", { class: "tag" }, `AI suggests: ${RATINGS.find((r) => r.id === cur.suggested).label}`)),
      h("div", { class: "rates" }, RATINGS.map((r, i) =>
        h("button", { class: `rate ${r.id}${r.id === cur.suggested ? " suggested" : ""}`, type: "button", "data-r": r.id, onclick: () => rate(r.id) },
          h("span", { class: "rate-label" }, `${i + 1}. ${r.label}`),
          h("span", { class: "rate-when" }, intervalText(previewInterval(item, r.id)))))),
      h("p", { class: "muted small" }, "Your rating decides when this sentence comes back, and moves on. Forgot and Hard also bring it back at the end of this session. Return accepts the suggestion.")));
}

// Applies the rating to the current sentence. A sentence rated Forgot or Hard
// is added to the end of the session, at most twice.
function applyRating(rating) {
  const cur = P.current;
  if (!cur || cur.rated) return;
  cur.rated = true;
  cur.result.rating = rating;
  setLastRating(rating);
  if (rating === "recalled" || rating === "easy") easeWeak(cur.item.chinese, cur.grade.weak);
  const record = cur.item.reviewId ? state.reviews.find((r) => r.id === cur.item.reviewId) : null;
  logAttempt(cur.item, cur.grade, rating, Boolean(record), record?.last ? (Date.now() - record.last) / 86400000 : 0);
  const retry = scheduleReview(cur.item, rating);
  const tries = cur.item.tries || 0;
  if (retry && tries < 2) P.items.push({ ...cur.item, id: `${cur.item.id}-r${tries + 1}`, tries: tries + 1 });
}

function rate(rating) {
  applyRating(rating);
  nextItem();
}

// On the feedback screen, 1-4 rate the sentence and Return accepts the
// suggested rating, unless the learner is typing somewhere.
document.addEventListener("keydown", (e) => {
  if (view !== "practice" || P.phase !== "feedback" || P.current?.retry || e.metaKey || e.ctrlKey || e.altKey) return;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY"].includes(document.activeElement?.tagName)) return;
  const r = RATINGS[Number(e.key) - 1];
  if (r) rate(r.id);
  else if (isPlainEnter(e)) rate(P.current.suggested);
});

function nextItem() {
  if (P.index >= P.items.length - 1) return endSession();
  P.index += 1;
  P.phase = "answer";
  P.draft = "";
  P.hintLevel = 0;
  P.newShown = false;
  P.current = null;
  render();
  window.scrollTo(0, 0);
  focusAnswer();
}

function endSession() {
  // Leaving on a feedback screen without rating: use the AI's suggestion.
  if (P.phase === "feedback" && P.current && !P.current.rated) {
    const items = P.items.length;
    applyRating(P.current.suggested);
    P.items.length = items; // the session is ending, so no retry is queued
  }
  P = P.results?.length ? { phase: "summary", results: P.results } : { phase: "setup" };
  render();
  window.scrollTo(0, 0);
}

function summaryView() {
  const results = P.results;
  const graded = results.filter((r) => !r.grade.skipped);
  const average = graded.length ? Math.round(graded.reduce((sum, r) => sum + r.grade.score, 0) / graded.length) : null;
  // A sentence counts as missed when its last rating in the session was Forgot or Hard.
  const last = new Map();
  results.forEach((r) => last.set(r.item.chinese, r));
  const missed = [...last.values()].filter((r) => r.rating === "forgot" || r.rating === "hard");
  const retryMissed = () => beginSession(missed.map((r, i) => ({ ...r.item, id: `${r.item.id}-m${i}`, tries: 0 })));

  return h("section", { class: "card" },
    h("h1", {}, "Session finished"),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, last.size), h("span", {}, last.size === 1 ? "sentence" : "sentences")),
      h("div", { class: "stat" }, h("b", {}, average ?? "–"), h("span", {}, "average score")),
      h("div", { class: "stat" }, h("b", {}, missed.length), h("span", {}, "to practise again"))),
    results.length > graded.length && h("p", { class: "muted small" }, "Sentences where you chose Show answer are left out of the average."),
    h("div", { class: "row summary-actions" },
      missed.length ? h("button", { class: "btn primary grow", type: "button", onclick: retryMissed }, missed.length === 1 ? "Retry the 1 missed sentence" : `Retry the ${missed.length} missed sentences`) : null,
      h("button", { class: missed.length ? "btn" : "btn primary grow", type: "button", onclick: () => { P = { phase: "setup" }; render(); } }, "New session")),
    h("h3", {}, "Sentences"),
    results.map((r) => attemptRow({ ...r.grade, rating: r.rating, english: r.item.english, chinese: r.item.chinese, words: r.item.words, hsk: r.item.hsk, src: r.item.src, ref: r.item.ref, sentenceNote: r.item.note, answer: r.answer })));
}

// ---------- history ----------

function attemptRow(a) {
  const changed = a.corrected && hanOnly(a.corrected) !== hanOnly(a.answer);
  return h("details", { class: "hist" },
    h("summary", {},
      h("div", { class: `score sm ${a.answer ? scoreClass(a.score) : "none"}` }, a.answer ? a.score : "–"),
      h("div", { class: "grow" },
        h("div", { class: "en" }, a.english),
        a.answer ? h("div", { class: "zh", lang: "zh-Hans" }, a.answer) : h("div", { class: "muted small" }, "Answer shown"),
        h("div", { class: "when" }, [a.at && new Date(a.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }), a.review && "review", a.rating && `rated ${RATINGS.find((r) => r.id === a.rating)?.label || a.rating}`, a.theme].filter(Boolean).join(" · ")))),
    h("div", { class: "body" },
      a.issues?.length ? [h("h3", {}, "What to fix"), issueList(a.issues)] : null,
      changed && [h("h3", {}, "Corrected"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, diffLine(diffChars(a.answer, a.corrected)[1], "chg"))],
      h("h3", {}, "Reference answer", a.hsk ? h("span", { class: "tag inline" }, a.hsk) : null),
      referenceBlock(a, { selected: -1 }),
      a.sentenceNote && [h("h3", {}, "About this sentence"), h("p", {}, a.sentenceNote)],
      a.strengths?.length ? [h("h3", {}, "What worked"), h("ul", { class: "points" }, a.strengths.map((t) => h("li", {}, t)))] : null,
      a.note && [h("h3", {}, "For next time"), h("p", {}, a.note)]));
}

function historyView() {
  const list = state.history;
  if (!list.length) {
    return h("section", { class: "card" }, h("h1", {}, "History"), h("p", { class: "lede" }, "Sentences you practise will be listed here with your answers and feedback."));
  }
  const graded = list.filter((a) => a.answer);
  const average = graded.length ? Math.round(graded.reduce((s, a) => s + a.score, 0) / graded.length) : 0;
  return h("section", { class: "card" },
    h("h1", {}, "History"),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, list.length), h("span", {}, "sentences practised")),
      h("div", { class: "stat" }, h("b", {}, graded.length ? average : "–"), h("span", {}, "average score")),
      h("div", { class: "stat" }, h("b", {}, state.reviews.length), h("span", {}, "in review"))),
    h("h3", {}, "Most recent first"),
    list.map(attemptRow));
}

// ---------- progress ----------

const pct = (x) => `${Math.round(x * 100)}%`;

function barChart(items, { max, label, title }) {
  return h("div", { class: "bars", role: "img", "aria-label": title },
    items.map((it) => {
      const bar = h("i");
      bar.style.height = `${it.value == null ? 0 : Math.max(2, (it.value / max) * 100)}%`;
      return h("div", { class: "bar-col" }, h("span", { class: "bar-val" }, it.value == null ? "–" : label(it)), h("div", { class: "bar-track" }, bar), h("span", { class: "bar-cap" }, it.caption));
    }));
}

// SVG elements need their own namespace.
function svg(tag, attrs, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
  for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}

// Average score per week as one line. Weeks with no practice leave a gap;
// weeks with fewer than five sentences are drawn hollow, as they move a lot by chance.
function scoreLine(weeks) {
  const W = 640, H = 230, left = 34, right = 40, top = 16, bottom = 30;
  const have = weeks.filter((w) => w.score != null);
  if (!have.length) return h("p", { class: "muted small" }, "No graded sentences in the last eight weeks yet.");
  const lo = Math.max(0, Math.floor((Math.min(...have.map((w) => w.score)) - 8) / 10) * 10);
  const x = (i) => left + (i * (W - left - right)) / (weeks.length - 1);
  const y = (v) => top + ((100 - v) * (H - top - bottom)) / (100 - lo);
  const ticks = [];
  for (let v = lo; v <= 100; v += lo >= 60 ? 10 : 20) ticks.push(v);

  // One path per unbroken run of weeks.
  const runs = [];
  let run = [];
  weeks.forEach((w, i) => {
    if (w.score == null) { if (run.length) runs.push(run); run = []; }
    else run.push([x(i), y(w.score)]);
  });
  if (run.length) runs.push(run);

  const tip = h("div", { class: "chart-tip", role: "status" }, "Tap a point for that week's details.");
  const date = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  const show = (w) => { tip.textContent = `Week ending ${date(w.end)}: average ${Math.round(w.score)} over ${w.n} ${w.n === 1 ? "sentence" : "sentences"}${w.n < 5 ? " (too few to read much into)" : ""}.`; };
  const lastIdx = weeks.map((w) => w.score != null).lastIndexOf(true);

  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": `Average score by week: ${have.map((w) => `${date(w.end)} ${Math.round(w.score)}`).join(", ")}` },
    ticks.map((v) => [svg("line", { class: "grid", x1: left, x2: W - right, y1: y(v), y2: y(v) }), svg("text", { class: "axis", x: left - 8, y: y(v) + 4, "text-anchor": "end" }, v)]),
    weeks.map((w, i) => (i % 2 === (weeks.length - 1) % 2 ? svg("text", { class: "axis", x: x(i), y: H - 8, "text-anchor": "middle" }, date(w.end)) : null)),
    runs.map((pts) => svg("path", { class: "line", d: pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") })),
    weeks.map((w, i) => (w.score == null ? null : [
      svg("circle", { class: w.n < 5 ? "dot hollow" : "dot", cx: x(i), cy: y(w.score), r: 5 }),
      i === lastIdx ? svg("text", { class: "value", x: x(i) + 10, y: y(w.score) + 5 }, Math.round(w.score)) : null,
      (() => { const hit = svg("circle", { class: "hit", cx: x(i), cy: y(w.score), r: 20, tabindex: 0 }); hit.addEventListener("pointerenter", () => show(w)); hit.addEventListener("click", () => show(w)); hit.addEventListener("focus", () => show(w)); return hit; })(),
    ])));
  return h("div", {}, chart, tip);
}

// One row per area: a bar for its average score against a marker for your
// overall average, weakest first, so the eye lands on what needs work.
function strengthRows(rows, overall, format = (k) => k, hanzi = false) {
  if (!rows.length) return h("p", { class: "muted small" }, "Not enough practice here yet. An entry appears once it has 5 sentences in the last 60 days.");
  const sorted = rows.filter((r) => r.score != null).sort((a, b) => a.score - b.score);
  return h("div", { class: "strength" }, sorted.map((r) => {
    const diff = r.score - overall;
    const kind = r.n >= 8 && diff <= -8 ? "weak" : r.n >= 8 && diff >= 8 ? "strong" : "";
    const fill = h("i", { class: `s-fill ${kind}` });
    fill.style.width = `${Math.max(2, r.score)}%`;
    const mark = h("i", { class: "s-avg" });
    mark.style.left = `${overall}%`;
    return h("div", { class: "s-row", title: `${format(r.key)}: average ${Math.round(r.score)} over ${r.n} sentences, ${pct(r.missRate)} missed` },
      h("div", { class: `s-name${hanzi ? " hanzi" : ""}` }, format(r.key), kind && h("span", { class: `s-badge ${kind}` }, kind === "weak" ? "Weak" : "Strong")),
      h("div", { class: "s-track" }, fill, mark),
      h("div", { class: "s-score" }, Math.round(r.score)),
      h("div", { class: "s-n muted" }, `${r.n}`));
  }));
}

function progressView() {
  const log = state.log || [];
  if (!log.length) {
    return h("section", { class: "card" }, h("h1", {}, "Progress"), h("p", { class: "lede" }, "Rate a few sentences and your progress will appear here: recall on reviews, score trends, weak and strong areas, and what is coming up."));
  }
  const now = Date.now();
  const recall = recallRate(log);
  const week = log.filter((e) => now - e.t <= 7 * 86400000).length;
  const weeks = weeklyScores(log);
  const fc = forecast(state.reviews);
  const cal = calendar(log);
  const calMax = Math.max(1, ...cal.map((d) => d.n));
  const dayName = (t) => new Date(t).toLocaleDateString([], { weekday: "short" });
  const today = new Date(now).setHours(0, 0, 0, 0);

  // How much of the bank is within reach.
  let reach = null;
  if (bankReady()) {
    const base = { known, allowedNew: null, maxNewWordsPct: 100 };
    reach = { total: bankReady().rows.length, onlyKnown: fitting({ ...base, maxNewPct: 0 }).length, oneFifth: fitting({ ...base, maxNewPct: 20 }).length };
  }
  const kl = state.knownLog || [];
  const first = kl[0];

  return [
    h("section", { class: "card" },
      h("h1", {}, "Progress"),
      h("div", { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, recall.n >= 10 ? pct(recall.rate) : "–"), h("span", {}, recall.n >= 10 ? `recalled on review, last 30 days (${recall.n} reviews)` : `recall on review: needs 10 reviews (${recall.n} so far)`)),
        h("div", { class: "stat" }, h("b", {}, week), h("span", {}, "sentences in the last 7 days")),
        h("div", { class: "stat" }, h("b", {}, state.reviews.length), h("span", {}, `in review, ${fc[0]} due today`))),
      h("h3", {}, "Average score by week"),
      scoreLine(weeks)),

    (() => {
      const graded = log.filter((e) => e.sc != null && now - e.t <= 60 * 86400000);
      const overall = graded.length ? graded.reduce((sum, e) => sum + e.sc, 0) / graded.length : 0;
      const themes = breakdown(log, "th");
      const scored = themes.filter((r) => r.score != null).sort((a, b) => a.score - b.score);
      const headline = scored.length >= 2
        ? ["Weakest theme: ", h("b", {}, scored[0].key), ` (${Math.round(scored[0].score)}). Strongest: `, h("b", {}, scored[scored.length - 1].key), ` (${Math.round(scored[scored.length - 1].score)}).`]
        : "Bars show your average score in each area over the last 60 days.";
      return h("section", { class: "card" },
        h("h2", {}, "Where you are strong and weak"),
        h("p", {}, headline),
        h("div", { class: "s-legend muted small" },
          h("span", {}, h("i", { class: "s-avg key" }), ` your overall average (${Math.round(overall)})`),
          h("span", {}, "bar = average score, 0 to 100"),
          h("span", {}, "right-hand number = sentences")),
        h("h3", {}, "Themes"), strengthRows(themes, overall),
        h("h3", {}, "Grammar patterns"), strengthRows(breakdown(log, "g"), overall, (k) => k, true),
        h("h3", {}, "HSK levels"), strengthRows(breakdown(log, "h"), overall, (k) => (k === 7 ? "HSK 7-9" : `HSK ${k}`)),
        h("h3", {}, "Most common mistakes"),
        h("p", { class: "muted small" }, "How often each kind of mistake appeared, with its share of graded answers."),
        mistakeBars(log));
    })(),

    h("section", { class: "card" },
      h("h2", {}, "Coming up and recent days"),
      h("h3", {}, "Reviews due in the next 7 days"),
      barChart(fc.map((n, i) => ({ value: n, caption: i === 0 ? "Today" : dayName(today + i * 86400000) })), { max: Math.max(5, ...fc), title: "Reviews due on each of the next seven days", label: (it) => `${it.value}` }),
      h("p", { class: "muted small" }, `Today includes anything overdue. At most 40 reviews are given per day; ${reviewsLeftToday()} left today.`),
      h("h3", {}, "Days practised, last 12 weeks"),
      h("div", { class: "cal", role: "img", "aria-label": "Sentences practised on each of the last 84 days" },
        cal.map((d) => h("i", { class: `cal-day l${d.n === 0 ? 0 : Math.min(4, 1 + Math.floor((d.n / calMax) * 3))}`, title: `${new Date(d.date).toLocaleDateString([], { month: "short", day: "numeric" })}: ${d.n}` }))),
      h("p", { class: "muted small" }, `Oldest at the top left, today at the bottom right. Darker means more sentences. ${cal.filter((d) => d.n).length} of 84 days practised.`)),

    h("section", { class: "card" },
      h("h2", {}, "Characters and words"),
      h("div", { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, known.chars.size), h("span", {}, first && first.chars !== known.chars.size ? `characters known (${known.chars.size - first.chars >= 0 ? "+" : ""}${known.chars.size - first.chars} since ${new Date(first.t).toLocaleDateString([], { month: "short", day: "numeric" })})` : "characters known")),
        h("div", { class: "stat" }, h("b", {}, known.wordSet.size), h("span", {}, first && first.words !== known.wordSet.size ? `words known (${known.wordSet.size - first.words >= 0 ? "+" : ""}${known.wordSet.size - first.words})` : "words known"))),
      reach ? h("p", {}, `Of the ${reach.total.toLocaleString()} sentences in the bank, `, h("b", {}, reach.onlyKnown.toLocaleString()), " use only characters you know and ", h("b", {}, reach.oneFifth.toLocaleString()), " have at most 20% new characters.")
        : h("p", { class: "muted small" }, "Loading the sentence bank…"),
      h("p", { class: "muted small" }, "Known characters and words change when you import a newer Hanly file or tap “I know” on a word in feedback.")),
  ];
}

function mistakeBars(log) {
  const now = Date.now();
  const recent = log.filter((e) => e.sc != null && now - e.t <= 60 * 86400000);
  const counts = new Map();
  recent.forEach((e) => (e.c || []).forEach((c) => counts.set(c, (counts.get(c) || 0) + 1)));
  const rows = [...counts.entries()].filter(([c]) => CATEGORIES[c]).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return h("p", { class: "muted small" }, "No labelled mistakes yet. Each mistake the grader finds is given a type from now on.");
  const max = rows[0][1];
  return h("div", { class: "strength" }, rows.map(([c, n]) => {
    const fill = h("i", { class: "s-fill" });
    fill.style.width = `${Math.max(2, (n / max) * 100)}%`;
    return h("div", { class: "s-row", title: `${CATEGORIES[c]}: ${n} times, in ${pct(n / recent.length)} of graded answers` },
      h("div", { class: "s-name" }, CATEGORIES[c]),
      h("div", { class: "s-track" }, fill),
      h("div", { class: "s-score" }, n),
      h("div", { class: "s-n muted" }, pct(n / recent.length)));
  }));
}

// ---------- settings ----------

let flash = null; // { section, kind, text }
const flashFor = (section) => (flash?.section === section ? h("div", { class: `notice ${flash.kind}`, role: "status" }, flash.text) : null);
function note(section, kind, text) {
  flash = { section, kind, text };
  render();
}

// Settings → Test connection: one small request, reported in full.
let testing = false;
async function runConnectionTest() {
  testing = true;
  flash = null;
  render();
  try {
    const { reply, seconds } = await testConnection(state.settings.model);
    testing = false;
    note("api", "ok", `Connection works: ${providerName()} answered “${reply.slice(0, 40)}” in ${seconds.toFixed(1)} seconds.`);
  } catch (error) {
    testing = false;
    note("api", "error", error.message);
  }
}

// Settings → Account. Signing in is optional; without it everything stays on this device.
const account = { email: "", codeSent: false, busy: false };
function accountCard() {
  if (!accountsEnabled) return null;
  const run = async (fn, okText) => {
    account.busy = true; flash = null; render();
    try { await fn(); account.busy = false; if (okText) note("account", "ok", okText); else render(); }
    catch (error) { account.busy = false; note("account", "error", error.message); }
  };
  if (syncStatus.email) {
    const when = syncStatus.syncing ? "Syncing…" : syncStatus.lastSync ? `Last synced ${new Date(syncStatus.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Not synced yet.";
    return h("section", { class: "card" },
      h("h2", {}, "Account"),
      flashFor("account"),
      syncStatus.error && h("div", { class: "notice error", role: "alert" }, syncStatus.error),
      h("p", {}, "Signed in as ", h("b", {}, syncStatus.email), ". ", h("span", { class: "muted", id: "syncwhen" }, when)),
      h("p", { class: "small muted" }, "Your progress is saved to your account and kept in step on every device where you sign in. API keys stay on each device and are never uploaded."),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", disabled: syncStatus.syncing, onclick: () => syncNow() }, "Sync now"),
        h("button", { class: "btn", type: "button", disabled: account.busy, onclick: () => run(signOut, "") }, "Sign out"),
        h("button", { class: "btn danger", type: "button", id: "acct-delete", disabled: account.busy, onclick: () => {
          if (!confirm("Delete the practice data saved in your account and sign out? What is on this device stays here.")) return;
          run(deleteSynced, "Your synced data was deleted from your account and you were signed out. The copy on this device is untouched.");
        } }, "Delete my synced data")));
  }
  const email = h("input", { type: "text", id: "acct-email", inputmode: "email", autocomplete: "email", autocapitalize: "off", placeholder: "you@example.com", value: account.email, oninput: (e) => { account.email = e.target.value.trim(); } });
  const code = h("input", { type: "text", id: "acct-code", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "6-digit code" });
  return h("section", { class: "card" },
    h("h2", {}, "Account"),
    flashFor("account"),
    h("p", { class: "small muted" }, "Optional. Sign in to keep your progress safe and in step across devices. What is on this device now is combined with your account, not replaced. See the ", h("a", { href: "privacy.html" }, "privacy policy"), "."),
    syncStatus.google && h("div", { class: "field" }, h("button", { class: "btn wide", type: "button", id: "acct-google", disabled: account.busy, onclick: () => run(signInWithGoogle, "") }, "Continue with Google")),
    !syncStatus.google && !emailSignIn && h("p", { class: "muted small" }, "Checking which sign-in options are available…"),
    emailSignIn && [
      h("div", { class: "field" },
        h("label", { for: "acct-email" }, syncStatus.google ? "Or sign in by email" : "Sign in by email"),
        email,
        h("div", { class: "hint" }, "We email you a sign-in link. No password.")),
      !account.codeSent
        ? h("button", { class: "btn", type: "button", id: "acct-send", disabled: account.busy, onclick: () => {
            if (!/^\S+@\S+\.\S+$/.test(account.email)) return note("account", "error", "Enter your email address first.");
            run(async () => { await sendEmailCode(account.email); account.codeSent = true; }, `Email sent to ${account.email}. It can take a minute to arrive.`);
          } }, "Email me a sign-in link")
        : [h("p", {}, "Open the link in the email ", h("b", {}, "in this browser"), ". If your mail app opens a different browser, press and hold the link, copy it, and paste it into this browser's address bar."),
          h("div", { class: "field" }, h("label", { for: "acct-code" }, "Or, if the email shows a 6-digit code, enter it here"), code),
          h("div", { class: "row" },
            h("button", { class: "btn primary", type: "button", id: "acct-verify", disabled: account.busy, onclick: () => {
              const token = code.value.replace(/\D/g, "");
              if (token.length < 6) return note("account", "error", "Enter the 6-digit code from the email.");
              run(async () => { await verifyEmailCode(account.email, token); account.codeSent = false; }, "");
            } }, "Sign in with code"),
            h("button", { class: "btn quiet", type: "button", onclick: () => { account.codeSent = false; flash = null; render(); } }, "Use a different email"))],
    ]);
}

function settingsView() {
  const s = state.settings;
  const set = (key, value) => { s[key] = value; save(); flash = null; render(); };

  // --- API key
  const keyInput = h("input", { type: "password", id: "apikey", autocomplete: "off", placeholder: getApiKey(provider()) ? "A key is saved on this device" : keyHint() });
  const apiCard = h("section", { class: "card" },
    h("h2", {}, "AI model"),
    flashFor("api"),
    h("div", { class: "field" },
      h("label", { for: "model" }, "Model"),
      modelPicker("model", (e) => set("model", e.target.value)),
      h("div", { class: "hint" }, "Used to grade answers and answer follow-ups; sentences come from the stored bank, not from AI. Prices are each provider's list price per million input / output tokens as of November 2026, charged to your own account; check the provider's pricing page for current figures.")),
    h("div", { class: "field" },
      h("label", { for: "apikey" }, `${providerName()} API key`),
      keyInput,
      h("div", { class: "hint" }, `Needed for the model selected above. Stored only in this browser on this device and sent only to ${providerName()}. It is not included in backups. Anyone who can open this browser's data on your unlocked device could read it.`)),
    h("div", { class: "row" },
      h("button", { class: "btn primary", type: "button", onclick: () => {
        const value = keyInput.value.trim();
        if (!value) return note("api", "error", "Paste a key first.");
        const { key, bad } = cleanApiKey(value);
        if (bad.length) return note("api", "error", `Not saved: a key cannot contain ${bad.slice(0, 5).join(" ")}. Copy the key again and paste it.`);
        setApiKey(key, provider());
        note("api", "ok", `${providerName()} key saved on this device.`);
      } }, "Save key"),
      getApiKey(provider()) && h("button", { class: "btn", type: "button", id: "testconn", disabled: testing, onclick: runConnectionTest }, testing ? "Testing…" : "Test connection"),
      getApiKey(provider()) && h("button", { class: "btn danger", type: "button", onclick: () => { setApiKey("", provider()); note("api", "ok", `${providerName()} key removed from this device.`); } }, "Remove key")));

  // --- Hanly
  const cutoffLabel = h("span", {}, `${Math.round(s.cutoff * 100)}%`);
  const ruleSelect = h("select", { id: "rule", onchange: (e) => set("knownRule", e.target.value) },
    h("option", { value: "reverse" }, "Reverse score reaches the cut-off"),
    h("option", { value: "normal" }, "Normal score reaches the cut-off"),
    h("option", { value: "both" }, "Both scores reach the cut-off"),
    h("option", { value: "any" }, "Everything in the file counts"));
  ruleSelect.value = s.knownRule;
  const file = filePicker("hanlyfile", state.hanly ? "Choose a newer Hanly file" : "Choose Hanly file", async (f) => {
    try {
      const entries = parseHanly(await f.text());
      state.hanly = { importedAt: Date.now(), fileName: f.name, entries };
      save();
      const k = buildKnown(state);
      note("hanly", "ok", `Imported ${k.items} Hanly items. ${k.hanlyCount} characters count as known with the current rule.`);
    } catch (error) {
      note("hanly", "error", error.message);
    }
  });
  const extra = h("textarea", { id: "extra", rows: "2", lang: "zh-Hans", class: "hanzi", value: state.extraKnown || "",
    onchange: (e) => { state.extraKnown = [...new Set([...e.target.value].filter(isHan))].join(""); save(); render(); } });
  const extraWords = h("textarea", { id: "extrawords", rows: "2", lang: "zh-Hans", class: "hanzi", value: (state.extraWords || []).join(" "),
    onchange: (e) => { state.extraWords = [...new Set(e.target.value.split(/[^\u4e00-\u9fff]+/).filter(Boolean))]; save(); render(); } });
  const hanlyCard = h("section", { class: "card" },
    h("h2", {}, "Characters and words you know"),
    flashFor("hanly"),
    h("p", { class: "count-line" }, h("b", {}, known.chars.size), " characters and ", h("b", {}, known.wordSet.size), " words known",
      h("span", { class: "muted" }, ` · ${known.hanlyCount} characters from Hanly, ${known.added} added here`)),
    h("div", { class: "field" },
      h("h3", {}, "Hanly progress file"),
      state.hanly
        ? h("p", { class: "small muted" }, `${state.hanly.fileName} · imported ${new Date(state.hanly.importedAt).toLocaleDateString([], { dateStyle: "medium" })} · ${known.items} items, of which ${known.components} are components and are not counted.`)
        : h("p", { class: "small muted" }, "Choose the learning progress export (.json) from Hanly."),
      file,
      h("div", { class: "hint" }, "Importing again replaces the earlier import. The file stays on this device.")),
    h("div", { class: "field" }, h("label", { for: "rule" }, "A Hanly item counts as known when"), ruleSelect),
    s.knownRule !== "any" && h("div", { class: "field" },
      h("label", { for: "cutoff" }, "Cut-off score: ", cutoffLabel),
      h("input", { type: "range", id: "cutoff", min: "0", max: "100", step: "5", value: String(Math.round(s.cutoff * 100)),
        oninput: (e) => { cutoffLabel.textContent = `${e.target.value}%`; },
        onchange: (e) => set("cutoff", Number(e.target.value) / 100) }),
      h("div", { class: "hint" }, "Hanly's progress for an item, from 0% to 100%. A character also counts when a word containing it passes.")),
    h("div", { class: "field" },
      h("label", { for: "extra" }, "Characters added here"),
      extra,
      h("div", { class: "hint" }, "Characters you marked “I know” during practice. You can add or delete characters by hand.")),
    h("div", { class: "field" },
      h("label", { for: "extrawords" }, "Words added here"),
      extraWords,
      h("div", { class: "hint" }, "Words you marked “I know” during practice, separated by spaces. Known words include every passing Hanly item, single characters too.")),
    known.chars.size ? [h("h3", {}, "All known characters"), h("div", { class: "known-chars", lang: "zh-Hans", tabindex: "0" }, [...known.chars].join(""))] : null);

  // --- HSK
  const hskSelect = h("select", { id: "hsk", onchange: (e) => set("hskScheme", e.target.value) },
    h("option", { value: "new" }, "HSK 3.0 (2021 standard)"),
    h("option", { value: "old" }, "HSK 2.0 (older six-level lists)"));
  hskSelect.value = s.hskScheme;
  const hskCard = h("section", { class: "card" },
    h("h2", {}, "HSK version"),
    h("div", { class: "field" }, h("label", { for: "hsk" }, "Level lists used for the new-character cap"), hskSelect,
      h("div", { class: "hint" }, hskLabel() ? `Current cap: ${hskLabel()}. Change the level on the Practice screen.` : "No cap is set. Change it on the Practice screen.")));

  // --- Backup
  const restore = filePicker("restore", "Choose backup file", async (f) => {
    try {
      importData(await f.text());
      P = { phase: "setup" };
      note("backup", "ok", "Backup restored.");
    } catch (error) {
      note("backup", "error", error.message || "The file could not be read.");
    }
  });
  const dataCard = h("section", { class: "card" },
    h("h2", {}, "Your data"),
    flashFor("backup"),
    h("p", { class: "small muted" }, "Progress is kept only on this device. To use the app on another device, download a backup here and restore it there. Add the app to your Home Screen on iPad so Safari keeps its data."),
    h("div", { class: "field" }, h("button", { class: "btn", type: "button", onclick: downloadBackup }, "Download backup")),
    h("div", { class: "field" }, h("label", { for: "restore" }, "Restore from a backup"), restore,
      h("div", { class: "hint" }, "Replaces everything in the app on this device except API keys.")),
    h("div", { class: "field" }, h("button", { class: "btn", type: "button", onclick: () => { state.onboarded = false; save(); P = { phase: "setup" }; go("practice"); } }, "Run first-time setup again")));

  const dangerCard = h("section", { class: "card danger-zone" },
    h("h2", {}, "Delete data"),
    flashFor("danger"),
    h("p", { class: "small muted" }, "These cannot be undone. Download a backup first if you might want the data again."),
    h("div", { class: "row" },
      h("button", { class: "btn danger", type: "button", onclick: () => {
        if (!confirm("Delete all practice history from this device?")) return;
        state.history = [];
        save();
        note("danger", "ok", "History deleted.");
      } }, "Delete history"),
      h("button", { class: "btn danger", type: "button", onclick: () => {
        if (!confirm("Delete everything in the app on this device, including the Hanly import, history and reviews? API keys are kept.")) return;
        resetAll();
        P = { phase: "setup" };
        note("danger", "ok", "Everything was deleted.");
      } }, "Delete everything")));

  const sources = bankReady()?.sources || [];
  const about = h("section", { class: "card" },
    h("h2", {}, "Sentence sources and credits"),
    h("p", { class: "small muted" }, "Practice sentences come from these collections. Each sentence's source is shown under its reference answer."),
    h("ul", { class: "points small" },
      sources.map((src) => h("li", {}, src.url ? h("a", { href: src.url, target: "_blank", rel: "noopener" }, src.name) : src.name, ` — ${src.licence}`)),
      h("li", {}, "Word meanings: ", h("a", { href: "https://www.mdbg.net/chinese/dictionary?page=cc-cedict", target: "_blank", rel: "noopener" }, "CC-CEDICT"), " — CC BY-SA 4.0"),
      h("li", {}, "HSK levels: ", h("a", { href: "https://github.com/drkameleon/complete-hsk-vocabulary", target: "_blank", rel: "noopener" }, "complete-hsk-vocabulary"), " by Yanis Zafirópulos — MIT")),
    h("p", { class: "small muted" }, "Chinese Grammar Wiki sentences are licensed for non-commercial use only. Pinyin and word splitting for Tatoeba sentences are added automatically and can contain mistakes."),
    h("p", { class: "small muted" }, h("a", { href: "about.html" }, "About Juzi"), " · ", h("a", { href: "privacy.html" }, "Privacy policy"), " · ", h("a", { href: "terms.html" }, "Terms of use")),
    h("p", { class: "small muted", id: "version" }, MODULE_VERSION === APP_VERSION
      ? `App version ${APP_VERSION}.`
      : `App version ${APP_VERSION}, but an older part (${MODULE_VERSION}) is still loaded. Reload the page.`));
  return [accountCard(), apiCard, hanlyCard, hskCard, dataCard, dangerCard, about].filter(Boolean);
}

function downloadBackup() {
  const blob = new Blob([exportData()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `juzi-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- start ----------

// Accounts: refresh the screen when the sign-in state or synced data changes,
// but never while an answer is being typed or graded.
initSync();
onSyncChange((dataChanged) => {
  const busy = view === "practice" && ["answer", "grading", "feedback", "loading"].includes(P.phase);
  if (view === "settings" || (dataChanged && !busy)) render();
});

// Devices that practised before the attempt log existed: rebuild it from the detailed history.
if (!(state.log || []).length && state.history.length) {
  const grade = { forgot: 1, hard: 2, recalled: 3, easy: 4 };
  state.log = [...state.history].reverse().map((a) => {
    const e = { t: a.at, sc: a.answer ? a.score : null, r: grade[a.rating] || (!a.answer ? 1 : a.score >= 80 ? 3 : a.score >= 50 ? 2 : 1) };
    if (a.theme) e.th = a.theme;
    const hsk = Number(String(a.hsk || "").replace(/\D+/g, "").slice(0, 1));
    if (hsk) e.h = hsk;
    if (a.grammar) e.g = a.grammar;
    if (a.review) e.rv = 1;
    return e;
  });
  save();
}

// Keep a dated record of how many characters and words are known.
function trackKnown() {
  const k = buildKnown(state);
  const kl = (state.knownLog = state.knownLog || []);
  const last = kl[kl.length - 1];
  if (!k.chars.size || (last && last.chars === k.chars.size && last.words === k.wordSet.size)) return;
  kl.push({ t: Date.now(), chars: k.chars.size, words: k.wordSet.size });
  if (kl.length > 400) kl.splice(1, kl.length - 400);
  save();
}
trackKnown();

render();
// Once the bank has loaded, refresh the session screen so it can show how many
// sentences fit. Other screens are left alone so nothing being typed is lost.
loadBank().then(() => { if ((state.onboarded && view === "practice" && P.phase === "setup") || view === "progress") render(); }).catch(() => {});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
