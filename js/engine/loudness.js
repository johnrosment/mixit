// ITU-R BS.1770-4 / EBU R128 loudness: K-weighting, gated integrated loudness,
// momentary/short-term series, loudness range, and oversampled true peak.

import { biquad } from './filters.js';

const LUFS_FLOOR = -120;

// K-weighting coefficients for any sample rate (bilinear-transform form that
// reproduces the published 48 kHz coefficients exactly).
export function kCoeffs(sr) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

const toLufs = (meanSquare) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : LUFS_FLOOR);

// Summed (over channels) K-weighted energy per 100 ms hop. `weights` are the
// BS.1770 per-channel gains for multichannel audio (0 skips a channel, e.g. LFE).
export function hopEnergies(chs, sr, hopSec = 0.1, weights = null) {
  const hop = Math.max(1, Math.round(sr * hopSec));
  const n = chs[0].length;
  const hops = Math.ceil(n / hop);
  const energy = new Float64Array(hops);
  const [s1, s2] = kCoeffs(sr);
  const tmp = new Float32Array(n);
  chs.forEach((ch, c) => {
    const w = weights ? weights[c] : 1;
    if (!w) return;
    biquad(s1, ch, tmp);
    biquad(s2, tmp, tmp);
    for (let h = 0, i = 0; h < hops; h++) {
      const end = Math.min(n, i + hop);
      let acc = 0;
      for (; i < end; i++) acc += tmp[i] * tmp[i];
      energy[h] += acc * w;
    }
  });
  return { energy, hop, hopSec };
}

function windowSeries(energy, hop, width) {
  const out = new Float32Array(energy.length);
  let acc = 0;
  for (let i = 0; i < energy.length; i++) {
    acc += energy[i];
    if (i >= width) acc -= energy[i - width];
    const count = Math.min(i + 1, width);
    out[i] = toLufs(acc / (count * hop));
  }
  return out;
}

export function integratedFromHops({ energy, hop }) {
  const blocks = [];
  if (energy.length < 4) {
    let acc = 0;
    for (const e of energy) acc += e;
    return toLufs(acc / Math.max(1, energy.length * hop));
  }
  for (let j = 3; j < energy.length; j++) {
    blocks.push((energy[j] + energy[j - 1] + energy[j - 2] + energy[j - 3]) / (4 * hop));
  }
  const absGated = blocks.filter((z) => toLufs(z) > -70);
  if (!absGated.length) return LUFS_FLOOR;
  const mean1 = absGated.reduce((a, b) => a + b, 0) / absGated.length;
  const rel = toLufs(mean1) - 10;
  const relGated = absGated.filter((z) => toLufs(z) > rel);
  if (!relGated.length) return LUFS_FLOOR;
  return toLufs(relGated.reduce((a, b) => a + b, 0) / relGated.length);
}

export function loudnessRangeFromHops({ energy, hop }) {
  if (energy.length < 30) return 0;
  const st = [];
  let acc = 0;
  for (let i = 0; i < energy.length; i++) {
    acc += energy[i];
    if (i >= 30) acc -= energy[i - 30];
    if (i >= 29) st.push(acc / (30 * hop));
  }
  const absGated = st.filter((z) => toLufs(z) > -70);
  if (absGated.length < 2) return 0;
  const mean = absGated.reduce((a, b) => a + b, 0) / absGated.length;
  const rel = toLufs(mean) - 20;
  const vals = absGated.map(toLufs).filter((l) => l > rel).sort((a, b) => a - b);
  if (vals.length < 2) return 0;
  const pick = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return pick(0.95) - pick(0.1);
}

export function measureLoudness(chs, sr, { series = true, weights = null } = {}) {
  const hops = hopEnergies(chs, sr, 0.1, weights);
  const integrated = integratedFromHops(hops);
  const lra = loudnessRangeFromHops(hops);
  const result = { integrated, lra, hopSec: hops.hopSec };
  if (series) {
    result.momentary = windowSeries(hops.energy, hops.hop, 4);
    result.shortTerm = windowSeries(hops.energy, hops.hop, 30);
    let mMax = LUFS_FLOOR, sMax = LUFS_FLOOR;
    for (let i = 3; i < result.momentary.length; i++) mMax = Math.max(mMax, result.momentary[i]);
    for (let i = 29; i < result.shortTerm.length; i++) sMax = Math.max(sMax, result.shortTerm[i]);
    if (result.shortTerm.length < 30) sMax = result.shortTerm.length ? result.shortTerm[result.shortTerm.length - 1] : LUFS_FLOOR;
    result.momentaryMax = mMax;
    result.shortTermMax = sMax;
  }
  return result;
}

export function integratedLufs(chs, sr, weights = null) {
  return integratedFromHops(hopEnergies(chs, sr, 0.1, weights));
}

// ---- True peak (polyphase windowed-sinc interpolation) ----

const tpFilters = new Map();

function oversampleFactor(sr) {
  if (sr >= 176400) return 1;
  if (sr >= 88200) return 2;
  return 4;
}

function tpFilter(factor, taps) {
  const key = `${factor}:${taps}`;
  let f = tpFilters.get(key);
  if (f) return f;
  const N = factor * taps;
  const h = new Float64Array(N);
  const centre = (N - 1) / 2;
  for (let i = 0; i < N; i++) {
    const t = (i - centre) / factor;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const x = (2 * Math.PI * i) / (N - 1);
    const w = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
    h[i] = sinc * w;
  }
  const phases = [];
  for (let p = 0; p < factor; p++) {
    const ph = new Float64Array(taps);
    let sum = 0;
    for (let k = 0; k < taps; k++) { ph[k] = h[p + factor * k]; sum += ph[k]; }
    for (let k = 0; k < taps; k++) ph[k] /= sum;
    phases.push(ph);
  }
  f = { phases, taps, factor };
  tpFilters.set(key, f);
  return f;
}

// Per-sample peak envelope (max over channels of |x| and interpolated values
// around each sample). Used by the limiter and by true-peak metering.
export function truePeakEnvelope(chs, sr, taps = 8) {
  const n = chs[0].length;
  const env = new Float32Array(n);
  const factor = oversampleFactor(sr);
  const perChannel = [];
  if (factor === 1) {
    for (const ch of chs) {
      let m = 0;
      for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > env[i]) env[i] = a; if (a > m) m = a; }
      perChannel.push(m);
    }
    return { env, perChannel };
  }
  const { phases } = tpFilter(factor, taps);
  const D = taps >> 1;
  // Zero-padded copy so the inner loop needs no bounds checks.
  const pad = new Float32Array(n + 2 * taps);
  for (const ch of chs) {
    pad.set(ch, taps);
    let chMax = 0;
    // Count of non-zero samples inside the interpolation window, so exact
    // silence (common in sparse stems) can be skipped.
    let nonZero = 0;
    for (let k = 0; k < taps; k++) if (pad[taps + D - k] !== 0) nonZero++;
    for (let i = 0; i < n; i++) {
      const base = i + taps + D;
      if (i > 0) {
        if (pad[base] !== 0) nonZero++;
        if (pad[base - taps] !== 0) nonZero--;
      }
      if (nonZero === 0) continue;
      const s0 = ch[i];
      let m = s0 < 0 ? -s0 : s0;
      for (let p = 0; p < factor; p++) {
        const ph = phases[p];
        let acc = 0;
        for (let k = 0; k < taps; k++) acc += ph[k] * pad[base - k];
        const a = acc < 0 ? -acc : acc;
        if (a > m) m = a;
      }
      if (m > env[i]) env[i] = m;
      if (m > chMax) chMax = m;
    }
    perChannel.push(chMax);
  }
  return { env, perChannel };
}

/**
 * True-peak meter. An interpolated value can exceed the largest sample in its
 * window by at most the filter's absolute tap sum, so only windows containing
 * a sample within that factor of the channel's sample peak are interpolated.
 */
export function truePeak(chs, sr) {
  const factor = oversampleFactor(sr);
  const taps = 24;
  const perChannel = [];
  if (factor === 1) {
    for (const ch of chs) { let m = 0; for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > m) m = a; } perChannel.push(m); }
  } else {
    const { phases } = tpFilter(factor, taps);
    let gainBound = 0;
    for (const ph of phases) gainBound = Math.max(gainBound, ph.reduce((a, h) => a + Math.abs(h), 0));
    const D = taps >> 1;
    for (const ch of chs) {
      const n = ch.length;
      let sp = 0;
      for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > sp) sp = a; }
      const hot = sp / gainBound;
      let best = sp;
      let hotCount = 0;
      // window for sample i covers indices i+D-taps+1 .. i+D
      for (let k = 0; k <= D && k < n; k++) if (Math.abs(ch[k]) >= hot) hotCount++;
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          const add = i + D, rem = i + D - taps;
          if (add < n && Math.abs(ch[add]) >= hot) hotCount++;
          if (rem >= 0 && Math.abs(ch[rem]) >= hot) hotCount--;
        }
        if (hotCount === 0) continue;
        for (let p = 0; p < factor; p++) {
          const ph = phases[p];
          let acc = 0;
          for (let k = 0; k < taps; k++) {
            const idx = i + D - k;
            if (idx >= 0 && idx < n) acc += ph[k] * ch[idx];
          }
          const a = acc < 0 ? -acc : acc;
          if (a > best) best = a;
        }
      }
      perChannel.push(best);
    }
  }
  const max = Math.max(...perChannel);
  return {
    dbtp: lin2db(max),
    perChannelDbtp: perChannel.map(lin2db),
  };
}

export function lin2db(x) {
  return x > 0 ? 20 * Math.log10(x) : LUFS_FLOOR;
}

export function db2lin(db) {
  return Math.pow(10, db / 20);
}
