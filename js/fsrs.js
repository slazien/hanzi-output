// FSRS-6 review scheduling (https://github.com/open-spaced-repetition), with
// its published default parameters. Each sentence in review has a memory
// "stability" (days until recall probability falls to 90%) and a "difficulty"
// (1-10). Ratings: 1 Forgot, 2 Hard, 3 Recalled, 4 Easy.

const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const DECAY = -W[20];
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;

export const RETENTION = 0.9; // aim to review when recall probability is about 90%
export const MAX_INTERVAL = 365; // days
const MIN_S = 0.001;

const clampD = (d) => Math.min(10, Math.max(1, d));
const initD = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);

// Probability of recalling an item `days` after its last review.
export function retrievability(days, s) {
  return Math.pow(1 + (FACTOR * Math.max(0, days)) / s, DECAY);
}

// Days until recall probability falls to the target.
export function intervalFor(s, retention = RETENTION) {
  const days = (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  return Math.min(MAX_INTERVAL, Math.max(1, Math.round(days)));
}

function nextDifficulty(d, g) {
  const moved = d + (-W[6] * (g - 3) * (10 - d)) / 9;
  return clampD(W[7] * initD(4) + (1 - W[7]) * moved);
}

// The memory state after a review. `memory` is null for a first review, or
// { s, d }; `days` is the time since the last review.
export function review(memory, g, days) {
  if (!memory) return { s: Math.max(MIN_S, W[g - 1]), d: initD(g) };
  const { s, d } = memory;
  let next;
  if (days < 1) {
    // Same-day repeat: a small adjustment that never lowers a successful item.
    next = s * Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(s, -W[19]);
    if (g >= 3) next = Math.max(s, next);
  } else {
    const r = retrievability(days, s);
    if (g === 1) {
      const forgot = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
      next = Math.min(forgot, s / Math.exp(W[17] * W[18]));
    } else {
      const bonus = (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1);
      next = s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * bonus);
    }
  }
  return { s: Math.max(MIN_S, next), d: nextDifficulty(d, g) };
}
