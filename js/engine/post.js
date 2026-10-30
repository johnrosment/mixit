// Video, ad and podcast mixing: delivery loudness standards, a dialogue
// leveller, ducking keyed to speech (music swells back up in the gaps), and a
// delivery check (loudness and peak against the standard, dead air, how even
// the dialogue is).

import { hopEnergies } from './loudness.js';
import { lr4Split3 } from './filters.js';

// Common delivery targets. Specs differ by broadcaster and platform, so the
// report always says to check the one you deliver to.
export const DELIVERY = {
  web: { label: 'Online video', lufs: -14, ceiling: -1, tolerance: 1 },
  podcast: { label: 'Podcast', lufs: -16, ceiling: -1, tolerance: 1 },
  'tv-eu': { label: 'TV, Europe (EBU R128)', lufs: -23, ceiling: -1, tolerance: 0.5 },
  'tv-us': { label: 'TV, US (ATSC A/85)', lufs: -24, ceiling: -2, tolerance: 2 },
};

const db = (e) => (e > 1e-12 ? -0.691 + 10 * Math.log10(e) : -120);
const pctl = (arr, p) => { const v = [...arr].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : -120; };

/** Loudness per hop over a sliding window (K-weighted), with the hop size in samples. */
function windowLoudness(chs, sr, hopSec, windowHops) {
  const { energy, hop } = hopEnergies(chs, sr, hopSec);
  const out = new Float32Array(energy.length);
  let acc = 0;
  for (let j = 0; j < energy.length; j++) {
    acc += energy[j];
    if (j >= windowHops) acc -= energy[j - windowHops];
    out[j] = db(acc / (Math.min(j + 1, windowHops) * hop));
  }
  return { loud: out, hop };
}

/** Per-sample gain (dB per hop, linearly interpolated) applied to every channel, optionally to one band only. */
function applyHopGain(chs, sr, gDb, hop, band = null) {
  const n = chs[0].length;
  const lin = (i) => {
    const x = i / hop - 0.5, j = Math.max(0, Math.min(gDb.length - 1, Math.floor(x))), k = Math.min(gDb.length - 1, j + 1), t = Math.max(0, Math.min(1, x - j));
    return Math.pow(10, (gDb[j] * (1 - t) + gDb[k] * t) / 20);
  };
  for (const ch of chs) {
    if (!band) { for (let i = 0; i < n; i++) ch[i] *= lin(i); continue; }
    const [lo, mid, hi] = lr4Split3(ch, band[0], band[1], sr);
    for (let i = 0; i < n; i++) ch[i] = lo[i] + mid[i] * lin(i) + hi[i];
  }
}

/**
 * Dialogue leveller: brings each phrase toward the voice's typical level
 * (400 ms loudness against the median of the speech), by up to `maxDb`, and
 * leaves pauses alone so breaths and room noise are not pulled up.
 */
export function levelSpeech(chs, sr, { amount = 0.6, maxDb = 9 } = {}) {
  if (amount <= 0.01) return null;
  const { loud, hop } = windowLoudness(chs, sr, 0.05, 8);
  const top = pctl(loud, 0.95);
  const active = Array.from(loud, (v) => v > top - 25);
  const speech = Array.from(loud).filter((_, j) => active[j]);
  if (speech.length < 20) return null;
  const target = pctl(speech, 0.5);
  const g = new Float32Array(loud.length);
  let cur = 0;
  const a = Math.exp(-1 / (0.15 / 0.05)); // 150 ms smoothing at 50 ms hops
  for (let j = 0; j < loud.length; j++) {
    const want = active[j] ? Math.max(-maxDb, Math.min(maxDb, (target - loud[j]) * amount)) : cur * 0.97;
    cur = a * cur + (1 - a) * want;
    g[j] = cur;
  }
  applyHopGain(chs, sr, g, hop);
  const after = windowLoudness(chs, sr, 0.05, 8).loud;
  const act = Array.from(after).filter((_, j) => active[j]);
  return {
    spreadBeforeDb: pctl(speech, 0.9) - pctl(speech, 0.1),
    spreadAfterDb: pctl(act, 0.9) - pctl(act, 0.1),
    maxBoostDb: Math.max(0, ...g), maxCutDb: -Math.min(0, ...g),
  };
}

/**
 * Turns `target` down while `key` (the dialogue) speaks: full depth during
 * speech, held through short gaps between words, and released slowly so the
 * music swells back up in longer pauses. `band` limits the dip to one range.
 */
export function duckUnderSpeech(target, key, sr, { amountDb = 6, attackMs = 60, releaseMs = 700, holdMs = 300, band = null } = {}) {
  if (amountDb <= 0.05) return null;
  const { loud, hop } = windowLoudness(key, sr, 0.01, 30);
  const top = pctl(loud, 0.95);
  const holdHops = Math.round(holdMs / 10);
  const g = new Float32Array(loud.length);
  const aA = Math.exp(-1 / (attackMs / 10)), aR = Math.exp(-1 / (releaseMs / 10));
  let held = 0, cur = 0, sum = 0, active = 0;
  for (let j = 0; j < loud.length; j++) {
    if (loud[j] > top - 20) held = holdHops; else if (held > 0) held--;
    const want = held > 0 ? -amountDb : 0;
    cur = want < cur ? aA * cur + (1 - aA) * want : aR * cur + (1 - aR) * want;
    g[j] = cur;
    sum += cur;
    if (cur < -1) active++;
  }
  applyHopGain(target, sr, g, hop, band);
  return { amountDb, avgDb: -sum / g.length, activePct: (100 * active) / g.length };
}

/**
 * Delivery check: loudness and true peak against the standard, dead air
 * (2 s or more of silence inside the programme), and how even the dialogue is
 * (spread of its 400 ms loudness while speaking).
 */
export function deliveryCheck(out, dialogue, sr, { standard, achievedLufs, truePeakDbtp }) {
  const spec = DELIVERY[standard] || null;
  const { loud, hop } = windowLoudness(out, sr, 0.1, 4);
  const secs = hop / sr;
  const dead = [];
  let start = -1;
  const lastHop = loud.length - Math.round(0.5 / secs);
  for (let j = Math.round(0.5 / secs); j <= lastHop; j++) {
    const quiet = j < lastHop && loud[j] < -60;
    if (quiet && start < 0) start = j;
    if (!quiet && start >= 0) { if ((j - start) * secs >= 2) dead.push({ start: start * secs, end: j * secs }); start = -1; }
  }
  let voice = null;
  if (dialogue) {
    const d = windowLoudness(dialogue, sr, 0.1, 4).loud;
    const top = pctl(d, 0.95);
    const act = Array.from(d).filter((v) => v > top - 20);
    if (act.length > 10) voice = { spreadDb: pctl(act, 0.9) - pctl(act, 0.1) };
  }
  return {
    standard, label: spec?.label || 'Custom', targetLufs: spec?.lufs ?? null, ceiling: spec?.ceiling ?? null, tolerance: spec?.tolerance ?? null,
    achievedLufs, truePeakDbtp,
    loudnessOk: spec ? Math.abs(achievedLufs - spec.lufs) <= spec.tolerance : null,
    peakOk: spec ? truePeakDbtp <= spec.ceiling + 0.05 : null,
    deadAir: dead,
    voice,
  };
}
