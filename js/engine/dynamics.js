// Dynamics processors: compressor (stereo-linked, soft knee, program-relative
// threshold), multiband compressor, de-esser, transient shaper, and an offline
// look-ahead true-peak limiter.

import { lr4Split2, lr4Split3, design, cascade, biquad, zeroPhaseLowpass } from './filters.js';
import { truePeakEnvelope, hopEnergies } from './loudness.js';

const LN10_20 = Math.LN10 / 20;
const DB_FLOOR = -120;

export function percentileDb(values, p, floor = -70) {
  // Histogram percentile over values above `floor` (0.25 dB bins from -120..+24).
  const bins = new Uint32Array(576);
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v <= floor) continue;
    const b = Math.min(575, Math.max(0, Math.floor((v + 120) * 4)));
    bins[b]++;
    count++;
  }
  if (!count) return floor;
  const target = p * count;
  let acc = 0;
  for (let b = 0; b < bins.length; b++) {
    acc += bins[b];
    if (acc >= target) return b / 4 - 120;
  }
  return 24;
}

// Per-sample detector level in dB (max over channels; optional RMS smoothing).
export function detectorDb(chs, sr, rmsMs = 0) {
  const n = chs[0].length;
  const out = new Float32Array(n);
  if (rmsMs > 0) {
    const a = Math.exp(-1 / (rmsMs * 1e-3 * sr));
    let s = 0;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (const ch of chs) { const v = ch[i] * ch[i]; if (v > m) m = v; }
      s = a * s + (1 - a) * m;
      if (s < 1e-30) s = 0;
      out[i] = s > 1e-12 ? 10 * Math.log10(s) : DB_FLOOR;
    }
  } else {
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (const ch of chs) { const v = Math.abs(ch[i]); if (v > m) m = v; }
      out[i] = m > 1e-6 ? 20 * Math.log10(m) : DB_FLOOR;
    }
  }
  return out;
}

function gainComputer(x, T, R, W) {
  const d = x - T;
  if (2 * d < -W) return 0;
  if (W > 0 && 2 * Math.abs(d) <= W) {
    const t = d + W / 2;
    return (1 / R - 1) * (t * t) / (2 * W);
  }
  return d * (1 / R - 1);
}

function decimateMin(arr, step) {
  const out = new Float32Array(Math.ceil(arr.length / step));
  for (let i = 0, j = 0; i < arr.length; i += step, j++) {
    let m = 0;
    const end = Math.min(arr.length, i + step);
    for (let k = i; k < end; k++) if (arr[k] < m) m = arr[k];
    out[j] = m;
  }
  return out;
}

/**
 * Stereo-linked feed-forward compressor, in place.
 * Threshold is absolute (`threshold`) or program-relative: a percentile of the
 * detector level (`thresholdPct`) plus `thresholdOffset`.
 */
export function compress(chs, sr, opts = {}) {
  const {
    ratio = 2, knee = 6, attack = 10, release = 120, makeup = 'auto', mix = 1,
    rmsMs = 0, sidechain = null, threshold = null, thresholdPct = 0.8, thresholdOffset = 0,
    maxGr = 30, curveStepSec = 0.05,
  } = opts;
  const n = chs[0].length;
  const det = detectorDb(sidechain || chs, sr, rmsMs);
  const T = threshold ?? percentileDb(det, thresholdPct) + thresholdOffset;
  const aA = Math.exp(-1 / (Math.max(0.05, attack) * 1e-3 * sr));
  const aR = Math.exp(-1 / (Math.max(1, release) * 1e-3 * sr));
  const gr = new Float32Array(n);
  let gs = 0, maxRed = 0, sumRed = 0, active = 0, considered = 0;
  for (let i = 0; i < n; i++) {
    let gc = gainComputer(det[i], T, ratio, knee);
    if (gc < -maxGr) gc = -maxGr;
    gs = gc < gs ? aA * gs + (1 - aA) * gc : aR * gs + (1 - aR) * gc;
    gr[i] = gs;
    if (det[i] > T - 30) {
      considered++;
      sumRed += gs;
      if (gs < -0.5) active++;
    }
    if (gs < maxRed) maxRed = gs;
  }
  const avgRed = considered ? sumRed / considered : 0;
  const mk = makeup === 'auto' ? -avgRed * 0.85 : makeup;
  const nch = chs.length;
  for (let i = 0; i < n; i++) {
    const g = 1 - mix + mix * Math.exp((gr[i] + mk) * LN10_20);
    for (let c = 0; c < nch; c++) chs[c][i] *= g;
  }
  return {
    threshold: T,
    ratio,
    makeup: mk,
    maxGr: -maxRed,
    avgGr: -avgRed,
    activePct: considered ? (100 * active) / considered : 0,
    curve: decimateMin(gr, Math.max(1, Math.round(sr * curveStepSec))),
    curveStepSec,
  };
}

/**
 * Three-band compressor. `bands` holds per-band options for compress().
 * Each band's threshold is program-relative to that band's own level.
 */
export function multiband(chs, sr, { xLow = 120, xHigh = 2500, bands }) {
  const split = chs.map((ch) => lr4Split3(ch, xLow, xHigh, sr));
  const stats = [];
  for (let b = 0; b < 3; b++) {
    const bandChs = split.map((s) => s[b]);
    stats.push(compress(bandChs, sr, bands[b]));
  }
  chs.forEach((ch, c) => {
    const [lo, mi, hi] = split[c];
    for (let i = 0; i < ch.length; i++) ch[i] = lo[i] + mi[i] + hi[i];
  });
  return { xLow, xHigh, bands: stats };
}

/**
 * Split-band de-esser. Measures how far the sibilance band (5-10 kHz) rises
 * relative to the full-band level, and only attenuates the band above `split`
 * when that ratio exceeds its own program-relative threshold.
 */
export function deess(chs, sr, { amount = 0.5, split = 4500, maxCut = 10 } = {}) {
  if (amount <= 0) return { activePct: 0, maxGr: 0 };
  const n = chs[0].length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const ch of chs) s += ch[i]; mono[i] = s / chs.length; }
  const sib = cascade([design('highpass', 5000, sr, 0.7), design('lowpass', Math.min(10000, sr * 0.45), sr, 0.7)], mono, new Float32Array(n));
  const envFast = (x, att, rel) => {
    const aA = Math.exp(-1 / (att * 1e-3 * sr)), aR = Math.exp(-1 / (rel * 1e-3 * sr));
    const out = new Float32Array(n);
    let e = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i] * x[i];
      e = v > e ? aA * e + (1 - aA) * v : aR * e + (1 - aR) * v;
      if (e < 1e-30) e = 0;
      out[i] = e > 1e-12 ? 10 * Math.log10(e) : DB_FLOOR;
    }
    return out;
  };
  const sibDb = envFast(sib, 1, 50);
  const fullDb = envFast(mono, 5, 80);
  const ratio = new Float32Array(n);
  for (let i = 0; i < n; i++) ratio[i] = fullDb[i] > -60 ? sibDb[i] - fullDb[i] : DB_FLOOR;
  const thr = percentileDb(ratio, 1 - 0.18 * amount, -90);
  const cut = maxCut * amount;
  const gain = new Float32Array(n);
  const aA = Math.exp(-1 / (1 * 1e-3 * sr)), aR = Math.exp(-1 / (60 * 1e-3 * sr));
  let g = 0, active = 0, maxRed = 0;
  for (let i = 0; i < n; i++) {
    const over = ratio[i] - thr;
    const target = over > 0 ? -Math.min(cut, over * 1.5) : 0;
    g = target < g ? aA * g + (1 - aA) * target : aR * g + (1 - aR) * target;
    gain[i] = Math.exp(g * LN10_20);
    if (g < -1) active++;
    if (g < maxRed) maxRed = g;
  }
  for (const ch of chs) {
    const [lo, hi] = lr4Split2(ch, split, sr);
    for (let i = 0; i < n; i++) ch[i] = lo[i] + hi[i] * gain[i];
  }
  return { threshold: thr, activePct: (100 * active) / n, maxGr: -maxRed };
}

/** Transient shaper. amount in [-1, 1]: positive adds attack, negative softens. */
export function transientShape(chs, sr, amount = 0) {
  if (Math.abs(amount) < 0.01) return { amount: 0 };
  const n = chs[0].length;
  const env = (att, rel) => {
    const aA = Math.exp(-1 / (att * 1e-3 * sr)), aR = Math.exp(-1 / (rel * 1e-3 * sr));
    const out = new Float32Array(n);
    let e = 0;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (const ch of chs) { const v = Math.abs(ch[i]); if (v > m) m = v; }
      e = m > e ? aA * e + (1 - aA) * m : aR * e + (1 - aR) * m;
      if (e < 1e-30) e = 0;
      out[i] = e;
    }
    return out;
  };
  const fast = env(0.5, 40);
  const slow = env(25, 200);
  const sm = Math.exp(-1 / (2e-3 * sr));
  let g = 0, maxBoost = 0;
  for (let i = 0; i < n; i++) {
    const t = fast[i] > 1e-6 && slow[i] > 1e-6 ? 20 * Math.log10(fast[i] / slow[i]) : 0;
    const target = Math.max(-8, Math.min(8, amount * Math.max(0, t) * 0.9));
    g = sm * g + (1 - sm) * target;
    if (Math.abs(g) > Math.abs(maxBoost)) maxBoost = g;
    const lin = Math.exp(g * LN10_20);
    for (const ch of chs) ch[i] *= lin;
  }
  return { amount, maxChangeDb: maxBoost };
}

/**
 * Offline look-ahead limiter. Uses a precomputed true-peak envelope (`peakEnv`,
 * measured before `gainDb` is applied) so gain iterations do not recompute it.
 * The forward min over the look-ahead window followed by a box average of the
 * same length guarantees the applied gain never exceeds the required gain.
 */
export function limitWithEnvelope(chs, sr, peakEnv, { gainDb = 0, ceilingDb = -1, lookaheadMs = 5, releaseMs = 80, out = null, curveStepSec = 0.05 }) {
  const n = chs[0].length;
  const L = Math.max(1, Math.round(lookaheadMs * 1e-3 * sr));
  const g = Math.pow(10, gainDb / 20);
  const c = Math.pow(10, ceilingDb / 20);
  // Sliding minimum of required gain over windows starting at k.
  const h = new Float32Array(n);
  const dq = new Int32Array(n + L);
  const req = (i) => {
    if (i >= n) return 1;
    const p = peakEnv[i] * g;
    return p > c ? c / p : 1;
  };
  let head = 0, tail = 0;
  for (let i = 0; i < n + L - 1; i++) {
    const r = req(i);
    while (tail > head && req(dq[tail - 1]) >= r) tail--;
    dq[tail++] = i;
    if (dq[head] <= i - L) head++;
    const k = i - L + 1;
    if (k >= 0 && k < n) h[k] = req(dq[head]);
  }
  // Release: recover toward unity, never above the required gain.
  const rel = 1 - Math.exp(-1 / (Math.max(1, releaseMs) * 1e-3 * sr));
  let prev = 1;
  for (let k = 0; k < n; k++) {
    const up = prev + (1 - prev) * rel;
    prev = h[k] < up ? h[k] : up;
    h[k] = prev;
  }
  // Box average over the look-ahead length (smooth attack ramp).
  const gr = new Float32Array(n);
  let acc = 0;
  let maxRed = 0, sumRed = 0, active = 0;
  const outs = out || chs;
  for (let i = 0; i < n; i++) {
    acc += h[i];
    if (i >= L) acc -= h[i - L];
    const count = i + 1 < L ? i + 1 : L;
    const a = i + 1 < L ? Math.min(acc / count, h[i]) : acc / L;
    const lin = a * g;
    for (let c2 = 0; c2 < chs.length; c2++) outs[c2][i] = chs[c2][i] * lin;
    const red = 20 * Math.log10(a);
    gr[i] = red;
    sumRed += red;
    if (red < -0.5) active++;
    if (red < maxRed) maxRed = red;
  }
  return {
    out: outs,
    maxGr: -maxRed,
    avgGr: -sumRed / n,
    activePct: (100 * active) / n,
    curve: decimateMin(gr, Math.max(1, Math.round(sr * curveStepSec))),
    curveStepSec,
  };
}

export function peakEnvelope(chs, sr) {
  return truePeakEnvelope(chs, sr, 8).env;
}

// Keeps the largest-magnitude value (either sign) per step, for signed gain curves.
function decimateExtreme(arr, step) {
  const out = new Float32Array(Math.ceil(arr.length / step));
  for (let i = 0, j = 0; i < arr.length; i += step, j++) {
    let m = 0;
    const end = Math.min(arr.length, i + step);
    for (let k = i; k < end; k++) if (Math.abs(arr[k]) > Math.abs(m)) m = arr[k];
    out[j] = m;
  }
  return out;
}

/**
 * Attack / sustain shaper with separate budgets. `attack` and `sustain` are in
 * [-1, 1] (positive emphasises, negative softens). Onsets are where a
 * fast-attack follower runs ahead of a slow-attack one; sustain is where a
 * slow-release follower stays above a fast-release one.
 */
export function attackSustain(chs, sr, { attack = 0, sustain = 0, maxDb = 9, curveStepSec = 0.05 } = {}) {
  if (Math.abs(attack) < 0.01 && Math.abs(sustain) < 0.01) return null;
  const n = chs[0].length;
  const coef = (ms) => Math.exp(-1 / (ms * 1e-3 * sr));
  const aFast = coef(0.3), aSlow = coef(20), rMid = coef(80), rFast = coef(30), rSlow = coef(300);
  const sm = coef(1);
  const gr = new Float32Array(n);
  let fA = 0, sA = 0, fR = 0, sR = 0, g = 0, up = 0, down = 0;
  const nch = chs.length;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let c = 0; c < nch; c++) { const v = Math.abs(chs[c][i]); if (v > x) x = v; }
    fA = x > fA ? aFast * fA + (1 - aFast) * x : rMid * fA + (1 - rMid) * x;
    sA = x > sA ? aSlow * sA + (1 - aSlow) * x : rMid * sA + (1 - rMid) * x;
    fR = x > fR ? aFast * fR + (1 - aFast) * x : rFast * fR + (1 - rFast) * x;
    sR = x > sR ? aFast * sR + (1 - aFast) * x : rSlow * sR + (1 - rSlow) * x;
    if (fA < 1e-30) fA = 0;
    if (sA < 1e-30) sA = 0;
    if (fR < 1e-30) fR = 0;
    if (sR < 1e-30) sR = 0;
    const tr = fA > 1e-5 && sA > 1e-5 ? Math.max(0, 20 * Math.log10(fA / sA)) : 0;
    const su = fR > 1e-5 && sR > 1e-5 ? Math.min(18, Math.max(0, 20 * Math.log10(sR / fR))) : 0;
    let target = attack * tr * 0.8 + sustain * su * 0.4;
    if (target > maxDb) target = maxDb; else if (target < -maxDb) target = -maxDb;
    g = sm * g + (1 - sm) * target;
    gr[i] = g;
    if (g > up) up = g;
    if (g < down) down = g;
    const lin = Math.exp(g * LN10_20);
    for (let c = 0; c < nch; c++) chs[c][i] *= lin;
  }
  return { attack, sustain, maxBoostDb: up, maxCutDb: -down, curve: decimateExtreme(gr, Math.max(1, Math.round(sr * curveStepSec))), curveStepSec };
}

/**
 * Bass de-bloom: shortens sustained low-frequency ringing below `freq`, but
 * only while the low band is louder than its own typical level, so ordinary
 * bass notes and kick transients are left alone.
 */
export function bassDebloom(chs, sr, { amount = 0.5, freq = 150, maxCut = 8, curveStepSec = 0.05 } = {}) {
  if (amount <= 0.01) return null;
  const n = chs[0].length;
  const split = chs.map((ch) => lr4Split2(ch, freq, sr));
  const lows = split.map((s) => s[0]);
  const coef = (ms) => Math.exp(-1 / (ms * 1e-3 * sr));
  const aRms = coef(10);
  // Pass 1: typical low-band level (decimated RMS envelope).
  const dec = 32;
  const lv = new Float32Array(Math.ceil(n / dec));
  let e = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const l of lows) { const v = l[i] * l[i]; if (v > m) m = v; }
    e = aRms * e + (1 - aRms) * m;
    if (e < 1e-30) e = 0;
    if (i % dec === 0) lv[i / dec] = e > 1e-12 ? 10 * Math.log10(e) : -120;
  }
  const ref = percentileDb(lv, 0.6);
  // Pass 2: sustain detector gated by level above the reference.
  const aFast = coef(0.5), rFast = coef(30), rSlow = coef(300), sm = coef(5);
  const gr = new Float32Array(n);
  let fR = 0, sR = 0, g = 0, maxRed = 0, active = 0;
  e = 0;
  for (let i = 0; i < n; i++) {
    let x = 0, m = 0;
    for (const l of lows) { const a = Math.abs(l[i]); if (a > x) x = a; if (a * a > m) m = a * a; }
    e = aRms * e + (1 - aRms) * m;
    if (e < 1e-30) e = 0;
    fR = x > fR ? aFast * fR + (1 - aFast) * x : rFast * fR + (1 - rFast) * x;
    sR = x > sR ? aFast * sR + (1 - aFast) * x : rSlow * sR + (1 - rSlow) * x;
    if (fR < 1e-30) fR = 0;
    if (sR < 1e-30) sR = 0;
    const su = fR > 1e-5 && sR > 1e-5 ? Math.max(0, 20 * Math.log10(sR / fR)) : 0;
    const level = e > 1e-12 ? 10 * Math.log10(e) : -120;
    const excess = Math.min(1, Math.max(0, (level - ref) / 6));
    const target = -Math.min(maxCut, su * 0.5 * amount) * excess;
    g = sm * g + (1 - sm) * target;
    gr[i] = g;
    if (g < maxRed) maxRed = g;
    if (g < -0.5) active++;
    const lin = Math.exp(g * LN10_20);
    for (const l of lows) l[i] *= lin;
  }
  chs.forEach((ch, c) => { const [lo, hi] = split[c]; for (let i = 0; i < n; i++) ch[i] = lo[i] + hi[i]; });
  return { amount, freq, maxGr: -maxRed, activePct: (100 * active) / n, curve: decimateMin(gr, Math.max(1, Math.round(sr * curveStepSec))), curveStepSec };
}

/**
 * Section-aware dynamics: compares momentary loudness (400 ms) with the
 * surrounding section's loudness (a centred window of `windowSec`) and turns
 * down only short outliers. Verses stay quieter than drops because each is
 * measured against its own section, not the whole track.
 */
export function sectionDynamics(chs, sr, { amount = 0.5, windowSec = 10, maxCut = 6 } = {}) {
  if (amount <= 0.01) return null;
  const { energy, hop, hopSec } = hopEnergies(chs, sr);
  const H = energy.length;
  const toLufs = (ms) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -120);
  const mom = new Float64Array(H);
  for (let h = 0; h < H; h++) {
    let s = 0, c = 0;
    for (let j = h - 1; j <= h + 2; j++) if (j >= 0 && j < H) { s += energy[j]; c++; }
    mom[h] = toLufs(s / (c * hop));
  }
  // Gated, centred section level.
  const W = Math.max(4, Math.round(windowSec / hopSec));
  const pe = new Float64Array(H + 1), pc = new Float64Array(H + 1);
  for (let h = 0; h < H; h++) {
    const act = mom[h] > -70;
    pe[h + 1] = pe[h] + (act ? energy[h] : 0);
    pc[h + 1] = pc[h] + (act ? 1 : 0);
  }
  const threshold = 4 - 2 * amount;
  const ratio = 1 + 3 * amount;
  const target = new Float64Array(H);
  for (let h = 0; h < H; h++) {
    const a = Math.max(0, h - (W >> 1)), b = Math.min(H, h + (W >> 1) + 1);
    const cnt = pc[b] - pc[a];
    if (!cnt || mom[h] <= -70) continue;
    const sec = toLufs((pe[b] - pe[a]) / (cnt * hop));
    const over = mom[h] - sec - threshold;
    if (over > 0) target[h] = -Math.min(maxCut, over * (1 - 1 / ratio));
  }
  // Two-sided smoothing: anticipate (0.3 s) and recover (0.8 s).
  const ra = Math.exp(-hopSec / 0.3), rr = Math.exp(-hopSec / 0.8);
  const gf = new Float64Array(H), gb = new Float64Array(H);
  for (let h = 0; h < H; h++) gf[h] = Math.min(target[h], h ? gf[h - 1] * rr : 0);
  for (let h = H - 1; h >= 0; h--) gb[h] = Math.min(target[h], h < H - 1 ? gb[h + 1] * ra : 0);
  const curve = new Float32Array(H);
  let maxRed = 0, sum = 0, active = 0, considered = 0;
  for (let h = 0; h < H; h++) {
    const g = Math.min(gf[h], gb[h]);
    curve[h] = g;
    if (g < maxRed) maxRed = g;
    if (mom[h] > -70) { considered++; sum += g; if (g < -0.5) active++; }
  }
  // Apply, interpolating between hop centres.
  const n = chs[0].length;
  for (let i = 0; i < n; i++) {
    const pos = i / hop - 0.5;
    const h0 = Math.max(0, Math.min(H - 1, Math.floor(pos)));
    const h1 = Math.min(H - 1, h0 + 1);
    const t = Math.max(0, Math.min(1, pos - h0));
    const g = curve[h0] * (1 - t) + curve[h1] * t;
    if (g === 0) continue;
    const lin = Math.exp(g * LN10_20);
    for (const ch of chs) ch[i] *= lin;
  }
  return { amount, windowSec, threshold, maxGr: -maxRed, avgGr: considered ? -sum / considered : 0, activePct: considered ? (100 * active) / considered : 0, curve, curveStepSec: hopSec };
}

/**
 * Dynamic low-mid "de-box": the band around `freq` is turned down only while
 * it rises above its usual share of the full-band level (a dynamic bell, so a
 * thin passage is not thinned further). Unity when inactive: out = x - k*band.
 */
export function deBox(chs, sr, { amount = 0.5, freq = 300, q = 1.4, maxCut = 6, curveStepSec = 0.05 } = {}) {
  if (amount <= 0.01) return null;
  const n = chs[0].length;
  const bp = design('bandpass', freq, sr, q);
  const bands = chs.map((ch) => biquad(bp, ch, new Float32Array(n)));
  const coef = (ms) => Math.exp(-1 / (ms * 1e-3 * sr));
  const aE = coef(20);
  // Relative band level (band minus full band, dB), decimated for the threshold.
  const dec = 32;
  const rel = new Float32Array(n);
  const relDec = new Float32Array(Math.ceil(n / dec));
  let eb = 0, ef = 0;
  for (let i = 0; i < n; i++) {
    let b = 0, f = 0;
    for (let c = 0; c < chs.length; c++) { b += bands[c][i] * bands[c][i]; f += chs[c][i] * chs[c][i]; }
    eb = aE * eb + (1 - aE) * b;
    ef = aE * ef + (1 - aE) * f;
    if (eb < 1e-30) eb = 0;
    if (ef < 1e-30) ef = 0;
    const r = ef > 1e-9 && eb > 1e-14 ? 10 * Math.log10(eb / ef) : -120;
    rel[i] = r;
    if (i % dec === 0) relDec[i / dec] = r;
  }
  // Reference share: the band's level in the leaner 40% of the track.
  const typical = percentileDb(relDec, 0.4, -60);
  const cut = maxCut * amount;
  const ratio = 0.5 + 0.5 * amount;
  const aA = coef(15), aR = coef(140);
  const gr = new Float32Array(n);
  let g = 0, maxRed = 0, active = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const over = rel[i] - typical - 1;
    const target = over > 0 && rel[i] > -60 ? -Math.min(cut, over * ratio) : 0;
    g = target < g ? aA * g + (1 - aA) * target : aR * g + (1 - aR) * target;
    gr[i] = g;
    sum += g;
    if (g < maxRed) maxRed = g;
    if (g < -0.5) active++;
    const k = 1 - Math.exp(g * LN10_20);
    if (k > 1e-6) for (let c = 0; c < chs.length; c++) chs[c][i] -= k * bands[c][i];
  }
  return { amount, freq, typicalDb: typical, maxGr: -maxRed, avgGr: -sum / n, activePct: (100 * active) / n, curve: decimateMin(gr, Math.max(1, Math.round(sr * curveStepSec))), curveStepSec };
}

/**
 * High-frequency peak reserve. Where the final limiter will have to act
 * (samples above `limitAt`, the ceiling minus the expected make-up gain) and
 * the band above `freq` pushes the peak in the same direction, only that band
 * is turned down for the peak. Cymbals, snare cracks and sibilance then stop
 * ducking the whole mix in the limiter. Zero-phase split, so the result is
 * bit-identical to the input wherever the stage is idle.
 */
export function hfPeakReserve(chs, sr, { amount = 0.5, freq = 5000, limitAt, maxCut = 9, lookMs = 1, releaseMs = 40, curveStepSec = 0.05 } = {}) {
  if (amount <= 0.01 || !(limitAt > 0)) return null;
  const n = chs[0].length;
  const his = chs.map((ch) => { const lo = zeroPhaseLowpass(ch, freq, sr); for (let i = 0; i < n; i++) lo[i] = ch[i] - lo[i]; return lo; });
  const gMin = Math.pow(10, -maxCut / 20);
  const req = new Float32Array(n).fill(1);
  let overBefore = 0, peakBefore = 0;
  for (let i = 0; i < n; i++) {
    let r = 1, over = false;
    for (let c = 0; c < chs.length; c++) {
      const x = chs[c][i], a = x < 0 ? -x : x;
      if (a > peakBefore) peakBefore = a;
      if (a <= limitAt) continue;
      over = true;
      const h = his[c][i];
      // The high band only helps when it points the same way as the peak and is a real part of it.
      if (h * x <= 0 || Math.abs(h) < 0.25 * a) continue;
      const ideal = Math.max(gMin, 1 - (a - limitAt) / Math.abs(h));
      const g = 1 - amount * (1 - ideal);
      if (g < r) r = g;
    }
    if (over) overBefore++;
    req[i] = r;
  }
  // Forward minimum over the look-ahead, release toward unity, then a box
  // average of the same length (the ramp is complete when the peak arrives).
  const L = Math.max(1, Math.round(lookMs * 1e-3 * sr));
  const h = new Float32Array(n);
  const dq = new Int32Array(n + L);
  let head = 0, tail = 0;
  const at = (i) => (i < n ? req[i] : 1);
  for (let i = 0; i < n + L - 1; i++) {
    const r = at(i);
    while (tail > head && at(dq[tail - 1]) >= r) tail--;
    dq[tail++] = i;
    if (dq[head] <= i - L) head++;
    const k = i - L + 1;
    if (k >= 0 && k < n) h[k] = at(dq[head]);
  }
  const rel = 1 - Math.exp(-1 / (releaseMs * 1e-3 * sr));
  let prev = 1;
  for (let k = 0; k < n; k++) { const up = prev + (1 - prev) * rel; prev = h[k] < up ? h[k] : up; h[k] = prev; }
  const gr = new Float32Array(n);
  let acc = 0, maxRed = 0, active = 0, overAfter = 0, peakAfter = 0;
  for (let i = 0; i < n; i++) {
    acc += h[i];
    if (i >= L) acc -= h[i - L];
    const g = i + 1 < L ? Math.min(acc / (i + 1), h[i]) : acc / L;
    const db = g < 1 ? 20 * Math.log10(g) : 0;
    gr[i] = db;
    if (db < maxRed) maxRed = db;
    if (db < -0.5) active++;
    let over = false;
    for (let c = 0; c < chs.length; c++) {
      if (g < 1) chs[c][i] -= (1 - g) * his[c][i];
      const a = Math.abs(chs[c][i]);
      if (a > peakAfter) peakAfter = a;
      if (a > limitAt) over = true;
    }
    if (over) overAfter++;
  }
  return {
    amount, freq, maxGr: -maxRed, activePct: (100 * active) / n,
    overBeforePct: (100 * overBefore) / n, overAfterPct: (100 * overAfter) / n,
    peakOverBeforeDb: 20 * Math.log10(peakBefore / limitAt), peakOverAfterDb: 20 * Math.log10(peakAfter / limitAt),
    curve: decimateMin(gr, Math.max(1, Math.round(sr * curveStepSec))), curveStepSec,
  };
}
