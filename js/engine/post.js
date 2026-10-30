// Video, ad and podcast mixing: delivery loudness standards, a dialogue
// leveller, ducking keyed to speech (music swells back up in the gaps), and a
// delivery check (loudness and peak against the standard, dead air, how even
// the dialogue is).

import { hopEnergies } from './loudness.js';
import { lr4Split3, zeroPhaseLowpass } from './filters.js';

// Common delivery targets. Specs differ by broadcaster and platform, so the
// report always says to check the one you deliver to.
export const DELIVERY = {
  web: { label: 'Online video', lufs: -14, ceiling: -1, tolerance: 1 },
  podcast: { label: 'Podcast', lufs: -16, ceiling: -1, tolerance: 1 },
  'tv-eu': { label: 'TV, Europe (EBU R128)', lufs: -23, ceiling: -1, tolerance: 0.5 },
  'tv-us': { label: 'TV, US (ATSC A/85)', lufs: -24, ceiling: -2, tolerance: 2 },
};

// Frame rates for edit fades: film, PAL, NTSC and web video.
export const FRAME_RATES = { '23.976': 24000 / 1001, 24: 24, 25: 25, '29.97': 30000 / 1001, 30: 30 };

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

/**
 * Loudness of the speech around each hop: a centred window (450 ms by default)
 * that counts only hops where someone is speaking (within `gateDb` of the loud
 * moments), so a window reaching into a pause does not read low. `active`
 * marks the speech hops.
 */
function phraseLoudness(chs, sr, { hopSec = 0.05, windowHops = 9, gateDb = 25 } = {}) {
  const { energy, hop } = hopEnergies(chs, sr, hopSec);
  const H = energy.length;
  const level = Float32Array.from(energy, (e) => db(e / hop));
  const top = pctl(level, 0.95);
  // A silent stem has no speech (rather than every hop counting as speech).
  const active = Uint8Array.from(level, (v) => (top > -70 && v > top - gateDb ? 1 : 0));
  const pe = new Float64Array(H + 1), pc = new Uint32Array(H + 1);
  for (let j = 0; j < H; j++) { pe[j + 1] = pe[j] + (active[j] ? energy[j] : 0); pc[j + 1] = pc[j] + active[j]; }
  const half = windowHops >> 1;
  const loud = new Float32Array(H).fill(-120);
  for (let j = 0; j < H; j++) {
    const a = Math.max(0, j - half), b = Math.min(H, j + half + 1);
    if (pc[b] > pc[a]) loud[j] = db((pe[b] - pe[a]) / ((pc[b] - pc[a]) * hop));
  }
  return { loud, active, hop };
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
 * (centred phrase loudness against the median of the speech), by up to
 * `maxDb`. The whole file is known, so each move is in place when its phrase
 * starts: a pause takes the gain of the phrase before it for its first half
 * and of the next phrase for its second half, and the gain is smoothed both
 * ways. Breaths and room noise in pauses are never pulled up on their own.
 */
export function levelSpeech(chs, sr, { amount = 0.6, maxDb = 9 } = {}) {
  if (amount <= 0.01) return null;
  const hopSec = 0.05;
  const { loud, active, hop } = phraseLoudness(chs, sr, { hopSec });
  const speech = loud.filter((_, j) => active[j]);
  if (speech.length < 20) return null;
  const target = pctl(speech, 0.5);
  const H = loud.length;
  const g = new Float32Array(H);
  for (let j = 0; j < H; j++) if (active[j]) g[j] = Math.max(-maxDb, Math.min(maxDb, (target - loud[j]) * amount));
  for (let j = 0; j < H; j++) {
    if (active[j]) continue;
    let k = j;
    while (k < H && !active[k]) k++;
    const prev = j > 0 ? g[j - 1] : k < H ? g[k] : 0, next = k < H ? g[k] : prev;
    for (let i = j; i < k; i++) g[i] = i < (j + k) / 2 ? prev : next;
    j = k;
  }
  const a = Math.exp(-hopSec / 0.15); // 150 ms each way
  for (let j = 1; j < H; j++) g[j] = a * g[j - 1] + (1 - a) * g[j];
  for (let j = H - 2; j >= 0; j--) g[j] = a * g[j + 1] + (1 - a) * g[j];
  applyHopGain(chs, sr, g, hop);
  const after = phraseLoudness(chs, sr, { hopSec }).loud;
  const act = after.filter((_, j) => active[j]);
  let up = 0, down = 0;
  for (const v of g) { if (v > up) up = v; else if (v < down) down = v; }
  return { spreadBeforeDb: pctl(speech, 0.9) - pctl(speech, 0.1), spreadAfterDb: pctl(act, 0.9) - pctl(act, 0.1), maxBoostDb: up, maxCutDb: -down };
}

/**
 * Mouth clicks and ticks in dialogue: bursts under 3 ms in the band above
 * 2.5 kHz that stand well above everything else within 15 ms either side
 * (so the regular pulses of a voice are not taken for clicks). A burst that
 * starts a sound (much more energy just after than just before, as in "t" or
 * "k") is left alone. Only the upper band is dipped, down to the level around
 * the click, so the voice underneath is untouched.
 */
export function mouthDeclick(chs, sr, { sensitivity = 0.5 } = {}) {
  const n = chs[0].length;
  const mono = new Float32Array(n);
  for (const ch of chs) for (let i = 0; i < n; i++) mono[i] += ch[i] / chs.length;
  const low = zeroPhaseLowpass(mono, 2500, sr);
  const hop = Math.max(1, Math.round(sr * 0.00025));
  const H = Math.floor(n / hop);
  const env = new Float32Array(H);
  for (let j = 0; j < H; j++) {
    let p = 0;
    for (let i = j * hop; i < (j + 1) * hop; i++) { const v = Math.abs(mono[i] - low[i]); if (v > p) p = v; }
    env[j] = p;
  }
  const ratio = Math.pow(10, (14 - 8 * Math.max(0, Math.min(1, sensitivity))) / 20); // 14 dB above at 0, 6 dB at 1
  const W = Math.round((0.015 * sr) / hop), X = Math.round((0.0015 * sr) / hop), maxLen = Math.round((0.003 * sr) / hop);
  const pre = new Float64Array(H + 1);
  for (let j = 0; j < H; j++) pre[j + 1] = pre[j] + env[j];
  const ms = (t) => Math.round(t * 0.001 * sr);
  const energy = (a, b) => { let s = 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++) s += mono[i] * mono[i]; return s; };
  const events = [];
  for (let j = 0; j < H; j++) {
    const lo = Math.max(0, j - W), hi = Math.min(H, j + W + 1);
    if (env[j] < 3e-4 || env[j] < (3 * (pre[hi] - pre[lo])) / (hi - lo)) continue; // quick gate: under -70 dBFS or under 3x the local average
    // Reference: the loudest moment of the band within 15 ms, the click itself
    // left out, so a voice's own pulses (every 4-12 ms) never stand out.
    let ref = 0;
    for (let k = lo; k < hi; k++) if ((k < j - X || k > j + maxLen + X) && env[k] > ref) ref = env[k];
    if (env[j] < ratio * ref) continue;
    let b = j, peak = env[j];
    while (b + 1 < H && env[b + 1] > ratio * ref) { b++; if (env[b] > peak) peak = env[b]; }
    if (b - j + 1 <= maxLen) {
      const s0 = j * hop, s1 = (b + 1) * hop;
      if (energy(s1 + ms(2), s1 + ms(20)) <= 4 * energy(s0 - ms(20), s0 - ms(2)) + 1e-9) events.push({ s0, s1, g: Math.max(0.05, ref / peak) });
    }
    j = b;
  }
  // Repair: subtract part of the upper band over the click, with 0.5 ms ramps.
  const r = ms(0.5), pad = ms(10);
  for (const { s0, s1, g } of events) {
    const a = Math.max(0, s0 - r), b = Math.min(n, s1 + r);
    const p0 = Math.max(0, a - pad), p1 = Math.min(n, b + pad);
    for (const ch of chs) {
      const seg = ch.slice(p0, p1);
      const segLow = zeroPhaseLowpass(seg, 2500, sr);
      for (let i = a; i < b; i++) {
        const t = i < s0 ? (i - a) / Math.max(1, s0 - a) : i >= s1 ? (b - i) / Math.max(1, b - s1) : 1;
        const w = 1 - (1 - g) * (0.5 - 0.5 * Math.cos(Math.PI * t));
        ch[i] -= (1 - w) * (seg[i - p0] - segLow[i - p0]);
      }
    }
  }
  return { count: events.length, times: events.slice(0, 200).map((e) => e.s0 / sr) };
}

/**
 * Fades on every edit: wherever a sound starts out of digital silence or stops
 * into it, including the very start and end of the file. `frames` is the fade
 * length in video frames at `fps`. Tails always get the full fade. A head gets
 * the full fade only when its first frame is quiet (room tone or a breath
 * before the word); a head that starts right on a word or a hit gets a 2-4 ms
 * fade that stops the click and keeps the attack. Ambience always fades fully.
 * In dialogue, a lone blip under 3 ms surrounded by silence is a click and is
 * removed; in effects, sounds under 10 ms are left alone (a tick on purpose).
 */
export function fadeEdits(chs, sr, { frames = 1, fps = FRAME_RATES['29.97'], kind = 'dialogue' } = {}) {
  const n = chs[0].length;
  const L = Math.max(1, Math.round((frames / fps) * sr));
  const shortHead = Math.min(L, Math.round((kind === 'effects' ? 0.002 : 0.004) * sr));
  const thr = 1e-4; // -80 dBFS: anything quieter counts as silence
  const gap = Math.round(0.01 * sr); // at least 10 ms of it between two sounds
  const loudAt = (i) => { for (const ch of chs) if (ch[i] > thr || ch[i] < -thr) return true; return false; };
  const regions = [];
  let start = -1, last = -1;
  for (let i = 0; i < n; i++) {
    if (loudAt(i)) { if (start < 0) start = i; last = i; } else if (start >= 0 && i - last >= gap) { regions.push([start, last + 1]); start = -1; }
  }
  if (start >= 0) regions.push([start, last + 1]);
  const peak = (a, b) => { let p = 0; for (const ch of chs) for (let i = a; i < b; i++) { const v = ch[i] < 0 ? -ch[i] : ch[i]; if (v > p) p = v; } return p; };
  const hardEdge = (i) => chs.some((ch) => Math.abs(ch[i]) > 1e-3); // would click (above -60 dBFS)
  const ramp = (a, len, up) => {
    for (let i = 0; i < len; i++) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / len);
      for (const ch of chs) ch[a + i] *= up ? g : 1 - g;
    }
  };
  let fades = 0, hard = 0, blips = 0;
  for (const [s, e] of regions) {
    const len = e - s;
    if (kind === 'dialogue' && len < 0.003 * sr && s >= gap && n - e >= gap) { for (const ch of chs) ch.fill(0, s, e); blips++; continue; }
    if (kind === 'effects' && len < 0.01 * sr) continue;
    const half = Math.max(1, len >> 1);
    let head = Math.min(L, half);
    if (kind !== 'ambience' && peak(s, s + head) > 0.03 * peak(s, e)) head = Math.min(head, shortHead);
    const tail = Math.min(L, half);
    if (hardEdge(s)) hard++;
    if (hardEdge(e - 1)) hard++;
    ramp(s, head, true);
    ramp(e - tail, tail, false);
    fades += 2;
  }
  return { regions: regions.length, fades, hard, blips, fadeMs: (1000 * L) / sr };
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
  if (top < -70) return null; // the dialogue is silent: nothing to duck under
  const holdHops = Math.round(holdMs / 10);
  const g = new Float32Array(loud.length);
  const aA = Math.exp(-1 / (attackMs / 10)), aR = Math.exp(-1 / (releaseMs / 10));
  let held = 0, cur = 0;
  for (let j = 0; j < loud.length; j++) {
    if (loud[j] > top - 20) held = holdHops; else if (held > 0) held--;
    const want = held > 0 ? -amountDb : 0;
    cur = want < cur ? aA * cur + (1 - aA) * want : aR * cur + (1 - aR) * want;
    g[j] = cur;
  }
  // The whole file is known: lead the voice by twice the attack, so the dip
  // is mostly in place by the first word.
  const lead = Math.min(g.length, Math.round((2 * attackMs) / 10));
  if (lead) { const last = g[g.length - 1]; g.copyWithin(0, lead); g.fill(last, g.length - lead); }
  let sum = 0, active = 0;
  for (const v of g) { sum += v; if (v < -1) active++; }
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
    const p = phraseLoudness(dialogue, sr, { gateDb: 20 });
    const act = p.loud.filter((_, j) => p.active[j]);
    if (act.length > 20) voice = { spreadDb: pctl(act, 0.9) - pctl(act, 0.1) };
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
