// All app data lives in this browser's localStorage. Nothing is sent anywhere
// except the sentence text that goes to the Anthropic API.

const KEY = "juzi.v1";
const API_KEYS = { anthropic: "juzi.apiKey", openai: "juzi.openaiKey" };
const HISTORY_LIMIT = 500;

export const DEFAULTS = {
  settings: {
    model: "claude-opus-5-5",
    knownRule: "reverse", // reverse | normal | both | any
    cutoff: 0.5, // Hanly progressPercent needed to count as known
    maxNewPct: 20, // maximum share of new characters in a sentence
    maxNewWordsPct: 50, // maximum share of new words in a sentence
    showPinyin: true, // pinyin printed above the reference answer
    hskScheme: "new", // new = HSK 3.0, old = HSK 2.0
    hskCap: 2, // 1-6, or 0 for no cap
    sessionLength: 10,
    grammar: "", // pattern text, "" = any
    theme: "", // one theme, or "" for a random mix
  },
  onboarded: false, // first-run setup finished or skipped
  hanly: null, // { importedAt, fileName, entries: { key: progressPercent } }
  extraKnown: "", // characters the user marked as known in this app
  extraWords: [], // words the user marked as known in this app
  reviews: [], // low-scoring sentences scheduled to come back
  history: [], // newest first
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const data = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...data,
      settings: { ...DEFAULTS.settings, ...(data.settings || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const state = read();

export function save() {
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function getApiKey(provider = "anthropic") {
  try {
    return localStorage.getItem(API_KEYS[provider]) || "";
  } catch {
    return "";
  }
}

export function setApiKey(value, provider = "anthropic") {
  try {
    if (value) localStorage.setItem(API_KEYS[provider], value);
    else localStorage.removeItem(API_KEYS[provider]);
  } catch {
    /* storage unavailable */
  }
}

// Backup deliberately leaves the API keys out.
export function exportData() {
  return JSON.stringify({ app: "juzi", version: 1, exportedAt: new Date().toISOString(), data: state }, null, 1);
}

export function importData(text) {
  const parsed = JSON.parse(text);
  if (parsed?.app !== "juzi" || typeof parsed.data !== "object") {
    throw new Error("This is not a backup file from this app.");
  }
  const d = parsed.data;
  Object.assign(state, structuredClone(DEFAULTS), d, {
    settings: { ...DEFAULTS.settings, ...(d.settings || {}) },
    onboarded: true,
  });
  save();
}

export function resetAll() {
  Object.assign(state, structuredClone(DEFAULTS));
  save();
}
