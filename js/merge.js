// Combines the practice data of two devices into one, record by record, so
// that signing in on a second device never throws work away.

const HISTORY_LIMIT = 500;
const LOG_LIMIT = 6000;

const unionBy = (a, b, key) => {
  const map = new Map();
  for (const x of [...(a || []), ...(b || [])]) {
    const k = key(x);
    if (!map.has(k)) map.set(k, x);
  }
  return [...map.values()];
};

// `local` and `remote` are app states. Returns the merged state.
export function mergeStates(local, remote) {
  if (!remote || typeof remote !== "object") return local;
  const out = { ...local };

  // Settings and the Hanly import: whichever was changed most recently.
  if ((remote.settingsAt || 0) > (local.settingsAt || 0)) {
    out.settings = { ...local.settings, ...remote.settings };
    out.settingsAt = remote.settingsAt;
  }
  if ((remote.hanly?.importedAt || 0) > (local.hanly?.importedAt || 0)) out.hanly = remote.hanly;
  out.onboarded = Boolean(local.onboarded || remote.onboarded);

  // Things marked as known on either device stay known.
  out.extraKnown = [...new Set([...(local.extraKnown || ""), ...(remote.extraKnown || "")])].join("");
  out.extraWords = [...new Set([...(local.extraWords || []), ...(remote.extraWords || [])])];

  // Attempts are only ever added, so keep every one from both sides.
  out.log = unionBy(local.log, remote.log, (e) => `${e.t}:${e.sc}:${e.r}`).sort((a, b) => a.t - b.t).slice(-LOG_LIMIT);
  out.history = unionBy(local.history, remote.history, (h) => h.id).sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
  out.knownLog = unionBy(local.knownLog, remote.knownLog, (k) => k.t).sort((a, b) => a.t - b.t);

  // A sentence in review: keep the copy that was reviewed most recently.
  const reviews = new Map();
  for (const r of [...(local.reviews || []), ...(remote.reviews || [])]) {
    const key = r.chinese;
    const seen = reviews.get(key);
    if (!seen || (r.last || 0) > (seen.last || 0)) reviews.set(key, r);
  }
  out.reviews = [...reviews.values()];

  // Weak points: keep the most recent mention of each.
  out.disputes = unionBy(local.disputes || [], remote.disputes || [], (d) => d.t).sort((a, b) => b.t - a.t).slice(0, 100);
  const weak = new Map();
  for (const w of [...(local.weak || []), ...(remote.weak || [])]) {
    if (!weak.has(w.text) || w.at > weak.get(w.text).at) weak.set(w.text, w);
  }
  out.weak = [...weak.values()].sort((a, b) => b.at - a.at).slice(0, 30);
  return out;
}
