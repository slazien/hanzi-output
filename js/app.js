import { state, save, getApiKey, setApiKey, exportData, importData, resetAll } from "./store.js";
import { parseHanly, buildKnown, isHan, hanChars, hskLevelOf, isKnownWord, measure, measureWords } from "./known.js";
import { MODELS, PROVIDERS, providerOf, gradeAnswer, followUp } from "./claude.js";
import { buildSession, dueReviews, scheduleReview, recordAttempt, hskLabel, PASS_SCORE } from "./session.js";
import { GRAMMAR } from "../data/grammar.js";
import { THEMES, ALL_THEMES } from "../data/themes.js";

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
  document.querySelectorAll(".tab").forEach((tab) => {
    if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });
  const content = view === "history" ? historyView() : view === "settings" ? settingsView() : practiceView();
  main.replaceChildren(...[content].flat());
}

// ---------- practice ----------

function practiceView() {
  switch (P.phase) {
    case "loading":
      return h("section", { class: "card" }, h("div", { class: "loading", role: "status" }, h("div", { class: "brush" }), h("div", {}, P.message || "Writing sentences…")));
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

  const file = h("input", { type: "file", id: "ob-hanly", accept: ".json,application/json", onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      state.hanly = { importedAt: Date.now(), fileName: f.name, entries: parseHanly(await f.text()) };
      save();
      note("ob-hanly", "ok", `Imported. ${buildKnown(state).hanlyCount} characters count as known.`);
    } catch (error) {
      note("ob-hanly", "error", error.message);
    }
  } });

  const keyInput = h("input", { type: "password", id: "ob-key", autocomplete: "off", placeholder: getApiKey(provider()) ? "A key is saved on this device" : keyHint(),
    // Updated in place (no re-render, no layout shift) so a tap on another control right after typing is not lost.
    onchange: (e) => { const v = e.target.value.trim(); if (v) { setApiKey(v, provider()); keyStatus.textContent = "Key saved on this device."; } } });
  const keyStatus = h("div", { class: "hint", role: "status" }, getApiKey(provider()) ? "Key saved on this device." : "No key saved yet.");

  const pctLabel = h("span", {}, newPctText(s.maxNewPct));
  const wordsLabel = h("span", {}, newPctText(s.maxNewWordsPct));
  const levels = [1, 2, 3, 4, 5, 6];

  return [
    h("section", { class: "card" },
      h("h1", {}, "Set up your practice"),
      h("p", { class: "lede" }, "Four quick choices so sentences match what you already know. Everything here can be changed later in Settings.")),

    h("section", { class: "card" },
      h("h2", {}, "1. Bring in your Hanly progress"),
      h("p", { class: "muted small" }, "Choose the learning progress export (.json) from Hanly. Characters you have learned there become the characters sentences are built from. The file stays on this device."),
      flashFor("ob-hanly"),
      state.hanly && !flashFor("ob-hanly") ? h("div", { class: "notice ok" }, `${state.hanly.fileName} is imported. ${known.hanlyCount} characters count as known.`) : null,
      file),

    h("section", { class: "card" },
      h("h2", {}, "2. Choose a model and add your API key"),
      h("p", { class: "muted small" }, "An AI model writes the sentences and grades your answers, using your own Anthropic or OpenAI key. The key is stored only in this browser and sent only to that provider."),
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

  return h("section", { class: "card" },
    h("h1", {}, "Sentence practice"),
    h("p", { class: "lede" }, "Read an English sentence, write it in Chinese, and get feedback on your answer."),
    !getApiKey(provider()) && h("div", { class: "notice" }, `Add your ${providerName()} API key to generate and grade sentences. `, h("button", { class: "linkish", type: "button", onclick: () => go("settings") }, "Open Settings")),
    !state.hanly && h("div", { class: "notice" }, "No Hanly progress imported yet, so the app does not know which characters you know. ", h("button", { class: "linkish", type: "button", onclick: () => go("settings") }, "Import it in Settings")),
    P.error && h("div", { class: "notice error", role: "alert" }, P.error),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, known.chars.size), h("span", {}, "characters you know")),
      h("div", { class: "stat" }, h("b", {}, due), h("span", {}, due === 1 ? "sentence due for review" : "sentences due for review"))),
    h("h3", {}, "This session"),
    h("div", { class: "field" },
      h("label", { for: "theme" }, "Theme"),
      themeSelect,
      h("div", { class: "hint" }, "Practise one theme at a time, or leave it on the random mix.")),
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
      segmented("hskCap", [[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"], [0, "No cap"]])),
    h("div", { class: "field" },
      h("label", { for: "grammar" }, "Grammar pattern"),
      grammarSelect),
    h("button", { class: "btn primary wide", type: "button", disabled: !getApiKey(provider()), onclick: startSession }, "Start session"));
}

const newPctText = (pct) => (pct === 0 ? "none" : pct >= 100 ? "no limit" : `up to ${pct}%`);

async function startSession() {
  P = { phase: "loading", message: "Writing sentences…" };
  render();
  try {
    const items = await buildSession((message) => {
      P.message = message;
      if (view === "practice" && P.phase === "loading") render();
    });
    P = { phase: "answer", items, index: 0, results: [], draft: "" };
  } catch (error) {
    P = { phase: "setup", error: error.message };
  }
  render();
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
    item.reviewId && h("span", { class: "tag review" }, "Review"),
    item.theme && h("span", { class: "tag" }, item.theme),
    item.grammar && h("span", { class: "tag hanzi" }, item.grammar),
    item.hsk && h("span", { class: "tag" }, item.hsk),
    h("span", { class: "tag" }, newShareText(item)),
    item.overLimit && h("span", { class: "tag review" }, "Over your limit for new material"));
}

function newShareText(item) {
  const c = Math.round(measure(item.chinese, known.chars, null).pct);
  const w = item.words ? Math.round(measureWords(item.words, known).pct) : null;
  if (!c && !w) return "Nothing new";
  return w == null ? `${c}% new characters` : `${c}% new characters · ${w}% new words`;
}

function answerView() {
  const item = P.items[P.index];
  const grading = P.phase === "grading";
  const input = h("textarea", {
    id: "answer", class: "answer-input", lang: "zh-Hans", rows: "2", placeholder: "用中文写…",
    autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Your Chinese translation",
    disabled: grading, value: P.draft || "",
    oninput: (e) => { P.draft = e.target.value; check.disabled = !P.draft.trim(); },
    onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) submitAnswer(); },
  });
  const check = h("button", { class: "btn primary grow", type: "button", disabled: grading || !(P.draft || "").trim(), onclick: submitAnswer }, grading ? "Checking…" : "Check answer");
  return h("section", { class: "card" },
    progressBar(),
    itemTags(item),
    h("p", { class: "prompt" }, item.english),
    P.error && h("div", { class: "notice error", role: "alert" }, P.error),
    h("div", { class: "field" }, input),
    h("div", { class: "row" },
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
  finishItem(item, "", { score: 0, verdict: "Answer shown", corrected: "", strengths: [], issues: [], note: "", skipped: true });
}

function finishItem(item, answer, grade) {
  recordAttempt(item, answer, grade);
  const reviewNote = scheduleReview(item, grade.score);
  P.results.push({ item, answer, grade });
  P.current = { item, answer, grade, reviewNote, thread: [], selected: -1 };
  P.phase = "feedback";
  P.error = "";
  render();
  window.scrollTo(0, 0);
}

// The reference sentence, Hanly-style: pinyin above each word, words you know
// underlined. Tap a word for its meaning.
function referenceBlock(item, cur) {
  if (!item.words) return h("p", { class: "line-zh", lang: "zh-Hans" }, item.chinese);
  const showPinyin = state.settings.showPinyin;

  const panel = h("div", { class: "gloss", hidden: cur.selected < 0 });
  const fill = () => {
    const w = item.words[cur.selected];
    if (!w) { panel.hidden = true; return; }
    panel.hidden = false;
    const word = hanChars(w.text).join("");
    const freshChars = [...new Set(hanChars(w.text).filter((c) => !known.chars.has(c)))];
    const parts = [h("div", { class: "py" }, w.pinyin || "—"), h("div", {}, w.gloss || "")];
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
    if (!hanChars(w.text).length) return h("span", { class: "word punct" }, showPinyin && h("span", { class: "py-top" }, "\u00a0"), h("span", { class: "zh" }, w.text));
    return h("button", {
      class: `word${isKnownWord(w.text, known) ? " known" : ""}`, type: "button", "aria-pressed": String(cur.selected === i),
      onclick: () => {
        cur.selected = cur.selected === i ? -1 : i;
        buttons.forEach((b, j) => b.tagName === "BUTTON" && b.setAttribute("aria-pressed", String(j === cur.selected)));
        fill();
      },
    }, showPinyin && h("span", { class: "py-top", lang: "zh-Latn" }, w.pinyin || "\u00a0"), h("span", { class: "zh" }, w.text));
  });
  fill();
  return h("div", {},
    h("div", { class: "words", lang: "zh-Hans" }, buttons),
    panel,
    h("div", { class: "row between ref-foot" },
      h("span", { class: "muted small" }, "Underlined words are ones you know. Tap a word for its meaning."),
      h("button", { class: "linkish muted small", type: "button", onclick: () => { state.settings.showPinyin = !showPinyin; save(); render(); } }, showPinyin ? "Hide pinyin" : "Show pinyin")));
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

function feedbackView() {
  const cur = P.current;
  const { item, answer, grade } = cur;
  const last = P.index >= P.items.length - 1;
  const changed = grade.corrected && grade.corrected.replace(/\s+/g, "") !== answer.replace(/\s+/g, "");

  const threadBox = h("div", { class: "thread" }, cur.thread.map((m) => h("div", { class: `bubble ${m.role}` }, m.text)));
  const question = h("input", { type: "text", id: "followup", placeholder: "Ask about this sentence…", "aria-label": "Follow-up question", enterkeyhint: "send", disabled: cur.asking,
    onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) ask(); } });
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

  return h("section", { class: "card" },
    progressBar(),
    h("div", { class: "result-head" },
      h("div", { class: `score ${scoreClass(grade.score)}`, "aria-label": `Score ${grade.score} out of 100` }, grade.skipped ? "–" : grade.score),
      h("div", {}, h("div", { class: "verdict" }, grade.verdict), cur.reviewNote && h("div", { class: "muted small" }, cur.reviewNote))),
    h("p", { class: "muted" }, item.english),

    !grade.skipped && [h("h3", {}, "Your answer"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, answer)],
    changed && [h("h3", {}, "Your answer, corrected"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, grade.corrected)],

    h("h3", {}, "Reference answer", item.hsk ? h("span", { class: "tag inline" }, item.hsk) : null),
    referenceBlock(item, cur),
    item.note && h("p", { class: "ref-note" }, item.note),

    grade.issues.length ? [h("h3", {}, "What to fix"), grade.issues.map((i) =>
      h("div", { class: "issue" },
        h("div", {}, i.quote && h("span", { class: "quote", lang: "zh-Hans" }, i.quote), i.fix && h("span", { class: "fix", lang: "zh-Hans" }, i.fix)),
        h("div", {}, i.problem)))] : null,
    grade.strengths.length ? [h("h3", {}, "What worked"), h("ul", { class: "points" }, grade.strengths.map((t) => h("li", {}, t)))] : null,
    grade.note && [h("h3", {}, "For next time"), h("p", {}, grade.note)],

    h("h3", {}, "Ask a follow-up"),
    threadBox,
    cur.asking && h("p", { class: "muted small", role: "status" }, "Thinking…"),
    cur.askError && h("div", { class: "notice error", role: "alert" }, cur.askError),
    h("div", { class: "row" }, h("div", { class: "grow" }, question), h("button", { class: "btn", type: "button", disabled: cur.asking, onclick: ask }, "Ask")),

    h("div", { class: "sticky-actions" },
      h("button", { class: "btn primary wide", type: "button", onclick: nextItem }, last ? "Finish session" : "Next sentence")));
}

function nextItem() {
  if (P.index >= P.items.length - 1) return endSession();
  P.index += 1;
  P.phase = "answer";
  P.draft = "";
  P.current = null;
  render();
  window.scrollTo(0, 0);
  focusAnswer();
}

function endSession() {
  P = P.results?.length ? { phase: "summary", results: P.results } : { phase: "setup" };
  render();
  window.scrollTo(0, 0);
}

function summaryView() {
  const results = P.results;
  const average = Math.round(results.reduce((sum, r) => sum + r.grade.score, 0) / results.length);
  const passed = results.filter((r) => r.grade.score >= PASS_SCORE).length;
  return h("section", { class: "card" },
    h("h1", {}, "Session finished"),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, results.length), h("span", {}, results.length === 1 ? "sentence" : "sentences")),
      h("div", { class: "stat" }, h("b", {}, average), h("span", {}, "average score")),
      h("div", { class: "stat" }, h("b", {}, passed), h("span", {}, `scored ${PASS_SCORE} or more`))),
    h("h3", {}, "Sentences"),
    results.map((r) => attemptRow({ ...r.grade, english: r.item.english, chinese: r.item.chinese, words: r.item.words, hsk: r.item.hsk, sentenceNote: r.item.note, answer: r.answer })),
    h("div", { class: "sticky-actions" }, h("button", { class: "btn primary wide", type: "button", onclick: () => { P = { phase: "setup" }; render(); } }, "New session")));
}

// ---------- history ----------

function attemptRow(a) {
  return h("details", { class: "hist" },
    h("summary", {},
      h("div", { class: `score sm ${scoreClass(a.score)}` }, a.answer ? a.score : "–"),
      h("div", { class: "grow" },
        h("div", { class: "en" }, a.english),
        h("div", { class: "zh", lang: "zh-Hans" }, a.answer || "(answer shown)"),
        a.at && h("div", { class: "when" }, new Date(a.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }), a.review ? " · review" : "", a.theme ? ` · ${a.theme}` : ""))),
    h("div", { class: "body" },
      h("h3", {}, "Reference answer", a.hsk ? h("span", { class: "tag inline" }, a.hsk) : null),
      referenceBlock(a, { selected: -1 }),
      a.sentenceNote && h("p", { class: "ref-note" }, a.sentenceNote),
      a.corrected && a.corrected !== a.answer && [h("h3", {}, "Your answer, corrected"), h("p", { class: "line-zh sm", lang: "zh-Hans" }, a.corrected)],
      a.issues?.length ? [h("h3", {}, "What to fix"), a.issues.map((i) => h("div", { class: "issue" },
        h("div", {}, i.quote && h("span", { class: "quote" }, i.quote), i.fix && h("span", { class: "fix" }, i.fix)), h("div", {}, i.problem)))] : null,
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
      h("div", { class: "stat" }, h("b", {}, state.reviews.length), h("span", {}, "waiting for review"))),
    h("h3", {}, "Most recent first"),
    list.map(attemptRow));
}

// ---------- settings ----------

let flash = null; // { section, kind, text }
const flashFor = (section) => (flash?.section === section ? h("div", { class: `notice ${flash.kind}`, role: "status" }, flash.text) : null);
function note(section, kind, text) {
  flash = { section, kind, text };
  render();
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
      h("div", { class: "hint" }, "Used to write sentences, grade answers and answer follow-ups. Prices are each provider's list price per million input / output tokens as of November 2026, charged to your own account; check the provider's pricing page for current figures.")),
    h("div", { class: "field" },
      h("label", { for: "apikey" }, `${providerName()} API key`),
      keyInput,
      h("div", { class: "hint" }, `Needed for the model selected above. Stored only in this browser on this device and sent only to ${providerName()}. It is not included in backups. Anyone who can open this browser's data on your unlocked device could read it.`)),
    h("div", { class: "row" },
      h("button", { class: "btn primary", type: "button", onclick: () => {
        const value = keyInput.value.trim();
        if (!value) return note("api", "error", "Paste a key first.");
        setApiKey(value, provider());
        note("api", "ok", `${providerName()} key saved on this device.`);
      } }, "Save key"),
      getApiKey(provider()) && h("button", { class: "btn danger", type: "button", onclick: () => { setApiKey("", provider()); note("api", "ok", `${providerName()} key removed from this device.`); } }, "Remove key")));

  // --- Hanly
  const cutoffLabel = h("span", {}, `${Math.round(s.cutoff * 100)}%`);
  const ruleSelect = h("select", { id: "rule", onchange: (e) => set("knownRule", e.target.value) },
    h("option", { value: "reverse" }, "Reverse score reaches the cut-off"),
    h("option", { value: "normal" }, "Normal score reaches the cut-off"),
    h("option", { value: "both" }, "Both scores reach the cut-off"),
    h("option", { value: "any" }, "Everything in the file counts"));
  ruleSelect.value = s.knownRule;
  const file = h("input", { type: "file", id: "hanlyfile", accept: ".json,application/json", onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const entries = parseHanly(await f.text());
      state.hanly = { importedAt: Date.now(), fileName: f.name, entries };
      save();
      const k = buildKnown(state);
      note("hanly", "ok", `Imported ${k.items} Hanly items. ${k.hanlyCount} characters count as known with the current rule.`);
    } catch (error) {
      note("hanly", "error", error.message);
    }
  } });
  const extra = h("textarea", { id: "extra", rows: "2", lang: "zh-Hans", class: "hanzi", value: state.extraKnown || "",
    onchange: (e) => { state.extraKnown = [...new Set([...e.target.value].filter(isHan))].join(""); save(); render(); } });
  const extraWords = h("textarea", { id: "extrawords", rows: "2", lang: "zh-Hans", class: "hanzi", value: (state.extraWords || []).join(" "),
    onchange: (e) => { state.extraWords = [...new Set(e.target.value.split(/[^\u4e00-\u9fff]+/).filter(Boolean))]; save(); render(); } });
  const hanlyCard = h("section", { class: "card" },
    h("h2", {}, "Characters and words you know"),
    flashFor("hanly"),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, known.chars.size), h("span", {}, "known characters")),
      h("div", { class: "stat" }, h("b", {}, known.hanlyCount), h("span", {}, "from Hanly")),
      h("div", { class: "stat" }, h("b", {}, known.added), h("span", {}, "added here")),
      h("div", { class: "stat" }, h("b", {}, known.wordSet.size), h("span", {}, "known words"))),
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
  const restore = h("input", { type: "file", id: "restore", accept: ".json,application/json", onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      importData(await f.text());
      P = { phase: "setup" };
      note("backup", "ok", "Backup restored.");
    } catch (error) {
      note("backup", "error", error.message || "The file could not be read.");
    }
  } });
  const dataCard = h("section", { class: "card" },
    h("h2", {}, "Your data"),
    flashFor("backup"),
    h("p", { class: "small muted" }, "Progress is kept only on this device. To use the app on another device, download a backup here and restore it there. Add the app to your Home Screen on iPad so Safari keeps its data."),
    h("div", { class: "field" }, h("button", { class: "btn", type: "button", onclick: downloadBackup }, "Download backup")),
    h("div", { class: "field" }, h("label", { for: "restore" }, "Restore from a backup"), restore,
      h("div", { class: "hint" }, "Replaces everything in the app on this device except API keys.")),
    h("div", { class: "field" }, h("button", { class: "btn", type: "button", onclick: () => { state.onboarded = false; save(); P = { phase: "setup" }; go("practice"); } }, "Run first-time setup again")),
    h("div", { class: "row" },
      h("button", { class: "btn danger", type: "button", onclick: () => {
        if (!confirm("Delete all practice history from this device?")) return;
        state.history = [];
        save();
        note("backup", "ok", "History deleted.");
      } }, "Delete history"),
      h("button", { class: "btn danger", type: "button", onclick: () => {
        if (!confirm("Delete everything in the app on this device, including the Hanly import, history and reviews? API keys are kept.")) return;
        resetAll();
        P = { phase: "setup" };
        note("backup", "ok", "Everything was deleted.");
      } }, "Delete everything")));

  const about = h("p", { class: "small muted" }, "HSK character levels are derived from the complete-hsk-vocabulary word lists by Yanis Zafirópulos (MIT licence).");
  return [apiCard, hanlyCard, hskCard, dataCard, about];
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

render();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
