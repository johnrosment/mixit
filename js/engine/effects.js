// Tone and space processors: oversampled saturation, tape hiss, M/S width
// (including per-band width and mono bass), panning, a Schroeder-Moorer style
// reverb, and a filtered feedback delay.

import { design, biquad, lr4, cascade, lr4Split3, zeroPhaseLowpass } from './filters.js';
import { integratedLufs, hopEnergies } from './loudness.js';

// ---- 2x oversampling with a windowed-sinc half-band filter ----
const HB_TAPS = 31;
const HB = (() => {
  const h = new Float64Array(HB_TAPS);
  const c = (HB_TAPS - 1) / 2;
  for (let i = 0; i < HB_TAPS; i++) {
    const k = i - c;
    const sinc = k === 0 ? 1 : Math.sin((Math.PI * k) / 2) / ((Math.PI * k) / 2);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (HB_TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (HB_TAPS - 1));
    h[i] = 0.5 * sinc * w;
  }
  // Normalise odd-offset taps so interpolation has unity DC gain.
  let odd = 0;
  for (let i = 0; i < HB_TAPS; i++) if ((i - c) % 2 !== 0) odd += h[i];
  for (let i = 0; i < HB_TAPS; i++) if ((i - c) % 2 !== 0) h[i] *= 0.5 / odd;
  h[c] = 0.5;
  return h;
})();
const HB_C = (HB_TAPS - 1) / 2;

function upsample2(x) {
  const n = x.length;
  const y = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    y[2 * i] = x[i];
    // y[2i+1] = sum over odd offsets k of 2*h[k] * x[(2i+1-k)/2]
    let acc = 0;
    for (let t = 0; t < HB_TAPS; t++) {
      const k = t - HB_C;
      if ((k & 1) === 0) continue;
      const idx = (2 * i + 1 - k) >> 1;
      if (idx >= 0 && idx < n) acc += 2 * HB[t] * x[idx];
    }
    y[2 * i + 1] = acc;
  }
  return y;
}

function downsample2(z, out) {
  const n = out.length;
  const m = z.length;
  for (let i = 0; i < n; i++) {
    let acc = 0.5 * z[2 * i];
    for (let t = 0; t < HB_TAPS; t++) {
      const k = t - HB_C;
      if ((k & 1) === 0) continue;
      const idx = 2 * i - k;
      if (idx >= 0 && idx < m) acc += HB[t] * z[idx];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Oversampled saturation. drive in dB (0..18). Modes: 'tape' (symmetric tanh),
 * 'tube' (asymmetric, adds even harmonics), 'clip' (soft clipper, mostly
 * transparent until peaks). Small-signal gain is unity.
 */
export function saturate(chs, sr, { drive = 0, mode = 'tape', mix = 1 } = {}) {
  if (drive <= 0.01 || mix <= 0) return { drive: 0 };
  const g = Math.pow(10, drive / 20);
  const bias = mode === 'tube' ? 0.18 : 0;
  const tb = Math.tanh(bias);
  const dcb = 1 - Math.tanh(bias) ** 2; // derivative of tanh at bias, normalises small-signal gain
  for (const ch of chs) {
    const up = upsample2(ch);
    for (let i = 0; i < up.length; i++) {
      const x = up[i] * g;
      let y;
      if (mode === 'clip') {
        const a = Math.abs(x);
        y = a < 0.7 ? x : Math.sign(x) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3));
      } else {
        y = (Math.tanh(x + bias) - tb) / dcb;
      }
      up[i] = y / g;
    }
    const wet = downsample2(up, new Float32Array(ch.length));
    if (bias) biquad(design('highpass', 8, sr), wet, wet);
    for (let i = 0; i < ch.length; i++) ch[i] = ch[i] * (1 - mix) + wet[i] * mix;
  }
  return { drive, mode, mix };
}

/**
 * Tape-style hiss: independent noise per channel, shaped like tape noise
 * (thin lows, strongest around 3-10 kHz) with a slow wobble, added at a level
 * set against the program's loudness: -66 LU (amount near 0) to -38 LU (1).
 * The noise is seeded, so the same settings always give the same file.
 */
export function tapeHiss(chs, sr, { amount = 0, seed = 0x9e3779b9 } = {}) {
  if (amount <= 0.005) return null;
  const n = chs[0].length;
  const program = integratedLufs(chs, sr);
  if (program < -70) return null;
  let st = seed >>> 0;
  const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >>> 17; st ^= st << 5; st >>>= 0; return st / 4294967296 - 0.5; };
  const shape = [design('highpass', 400, sr, 0.6), design('peaking', 6000, sr, 0.7, 4), design('lowpass', Math.min(15000, sr * 0.45), sr, 0.7)];
  const noise = chs.map(() => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = rnd();
    cascade(shape, x, x);
    return x;
  });
  // ±0.7 dB wobble at a quarter-hertz, offset between the channels.
  const w = (2 * Math.PI * 0.23) / sr;
  noise.forEach((x, c) => { for (let i = 0; i < n; i++) x[i] *= 1 + 0.08 * Math.sin(w * i + c * 1.7); });
  const relLu = -66 + 28 * Math.min(1, amount);
  const g = Math.pow(10, (program + relLu - integratedLufs(noise, sr)) / 20);
  chs.forEach((ch, c) => { const x = noise[c]; for (let i = 0; i < n; i++) ch[i] += x[i] * g; });
  return { relLu, programLufs: program };
}

/**
 * Upper-band harmonic exciter. Only the band above `freq` is driven (2x
 * oversampled, mostly even harmonics), and only the new harmonics above `freq`
 * are added back, so the low end and mids are untouched. With `dynamic`, quiet
 * passages get more and loud, full ones less.
 */
export function exciter(chs, sr, { amount = 0, freq = 3500, dynamic = true } = {}) {
  if (amount <= 0.005) return null;
  const n = chs[0].length;
  const bands = chs.map((ch) => { const lp = zeroPhaseLowpass(ch, freq, sr); const h = new Float32Array(n); for (let i = 0; i < n; i++) h[i] = ch[i] - lp[i]; return h; });
  // Drive so the band's loud moments reach the bend of the curve.
  const sorted = Float32Array.from(bands[0].filter((_, i) => i % 7 === 0), Math.abs).sort();
  const ref = sorted[Math.floor(sorted.length * 0.995)] || 1e-6;
  const drive = 1.6 / ref;
  const bias = 0.25, tb = Math.tanh(bias), slope = 1 - tb * tb;
  const products = bands.map((h) => {
    const up = upsample2(h);
    for (let i = 0; i < up.length; i++) { const x = up[i] * drive; up[i] = ((Math.tanh(x + bias) - tb) / slope - x) / drive; }
    const p = downsample2(up, new Float32Array(n));
    const lp = zeroPhaseLowpass(p, freq, sr);
    for (let i = 0; i < n; i++) p[i] -= lp[i];
    return p;
  });
  // Level over time (400 ms): more on quiet passages, less on loud ones.
  const w = new Float32Array(n).fill(1);
  if (dynamic) {
    const { energy, hop } = hopEnergies(chs, sr, 0.1);
    const db = Array.from(energy, (e) => 10 * Math.log10(e / hop + 1e-12));
    const med = [...db].sort((a, b) => a - b)[Math.floor(db.length * 0.6)];
    for (let i = 0; i < n; i++) {
      const j = Math.min(db.length - 1, (i / hop) | 0);
      w[i] = Math.max(0.5, Math.min(1.4, 1 - (db[j] - med) / 12));
    }
    // Smooth the weight so it never steps.
    const a = Math.exp(-1 / (0.2 * sr));
    let m = w[0];
    for (let i = 0; i < n; i++) { m = a * m + (1 - a) * w[i]; w[i] = m; }
  }
  const g = 1.2 * amount;
  chs.forEach((ch, c) => { const p = products[c]; for (let i = 0; i < n; i++) ch[i] += p[i] * g * w[i]; });
  return { amount, freq };
}

/**
 * Subtle chorus: two slowly modulated delay taps (15-25 ms) mixed in at a low
 * level, with the left and right taps moving in opposite phase for a little
 * movement around the centre.
 */
export function chorus(chs, sr, { mix = 0.06, rateHz = 0.6, delayMs = 18, depthMs = 3 } = {}) {
  if (mix <= 0.001) return null;
  const n = chs[0].length;
  const base = (delayMs * sr) / 1000, depth = (depthMs * sr) / 1000;
  const w = (2 * Math.PI * rateHz) / sr;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (chs[0][i] + chs[chs.length - 1][i]);
  chs.forEach((ch, c) => {
    const ph = c === 0 ? 0 : Math.PI;
    for (let i = n - 1; i >= 0; i--) {
      const d = base + depth * Math.sin(w * i + ph);
      const pos = i - d;
      const k = Math.floor(pos);
      if (k < 0) continue;
      const t = pos - k;
      ch[i] += mix * (mono[k] * (1 - t) + mono[Math.min(n - 1, k + 1)] * t);
    }
  });
  return { mix };
}

export function gain(chs, db) {
  if (!db) return chs;
  const g = Math.pow(10, db / 20);
  for (const ch of chs) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return chs;
}

/** Simple M/S width with optional high-passed side (mono bass below monoHz). */
export function width(chs, { amount = 1, monoHz = 0, sr }) {
  const [L, R] = chs;
  const n = L.length;
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = 0.5 * (L[i] - R[i]);
  if (monoHz > 0) cascade(lr4('highpass', monoHz, sr), S, S);
  for (let i = 0; i < n; i++) {
    const M = 0.5 * (L[i] + R[i]);
    const s = S[i] * amount;
    L[i] = M + s;
    R[i] = M - s;
  }
  return chs;
}

/**
 * Per-band stereo width with correlation protection: if a widened band would
 * fall below the correlation floor, its side gain is pulled back.
 */
export function multibandWidth(chs, sr, { low = 1, mid = 1, high = 1, monoHz = 0, xLow = 200, xHigh = 4000, corrFloor = 0.15 }) {
  if (low === 1 && mid === 1 && high === 1 && !monoHz) return { requested: [1, 1, 1], applied: [1, 1, 1], monoHz: 0 };
  const [L, R] = chs;
  const n = L.length;
  const M = new Float32Array(n);
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) { M[i] = 0.5 * (L[i] + R[i]); S[i] = 0.5 * (L[i] - R[i]); }
  if (monoHz > 0) cascade(lr4('highpass', monoHz, sr), S, S);
  const [sl, sm, sh] = lr4Split3(S, xLow, xHigh, sr);
  const [ml, mm, mh] = lr4Split3(M, xLow, xHigh, sr);
  const req = [low, mid, high];
  const applied = [];
  const sides = [sl, sm, sh];
  const mids = [ml, mm, mh];
  for (let b = 0; b < 3; b++) {
    let em = 0, es = 0;
    for (let i = 0; i < n; i++) { em += mids[b][i] * mids[b][i]; es += sides[b][i] * sides[b][i]; }
    // correlation of L/R for this band with side gain w: (em - w^2 es) / (em + w^2 es)
    let w = req[b];
    if (w > 1 && em > 0) {
      const maxW = Math.sqrt(Math.max(0, (em * (1 - corrFloor)) / ((1 + corrFloor) * Math.max(es, 1e-12))));
      if (w > maxW) w = Math.max(1, maxW);
    }
    applied.push(w);
  }
  // The mid split is all-passed; reconstruct M and S from their bands so both
  // carry identical phase shift.
  for (let i = 0; i < n; i++) {
    const m = ml[i] + mm[i] + mh[i];
    const s = sl[i] * applied[0] + sm[i] * applied[1] + sh[i] * applied[2];
    L[i] = m + s;
    R[i] = m - s;
  }
  return { requested: req, applied, monoHz };
}

export function isMonoSource([L, R]) {
  let diff = 0, peak = 0;
  for (let i = 0; i < L.length; i += 7) {
    const d = Math.abs(L[i] - R[i]);
    if (d > diff) diff = d;
    const a = Math.abs(L[i]);
    if (a > peak) peak = a;
  }
  return peak === 0 || diff <= peak * 1e-4;
}

/** Pan: constant-power for mono sources, balance for stereo sources. */
export function pan(chs, p) {
  if (!p) return chs;
  const [L, R] = chs;
  const n = L.length;
  if (isMonoSource(chs)) {
    const ang = ((p + 1) * Math.PI) / 4;
    const gl = Math.cos(ang) * Math.SQRT2, gr = Math.sin(ang) * Math.SQRT2;
    for (let i = 0; i < n; i++) { const x = L[i]; L[i] = x * gl; R[i] = x * gr; }
  } else if (p > 0) {
    const g = 1 - p;
    for (let i = 0; i < n; i++) L[i] *= g;
  } else {
    const g = 1 + p;
    for (let i = 0; i < n; i++) R[i] *= g;
  }
  return chs;
}

// ---- Reverb (parallel lowpass-feedback combs into series allpasses) ----
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES = [556, 441, 341, 225];
const SPREAD = 23;
export const REVERB_KINDS = {
  room: { size: 0.75, damp: 0.45, diffusion: 0.5 },
  plate: { size: 0.9, damp: 0.15, diffusion: 0.62 },
  hall: { size: 1.2, damp: 0.3, diffusion: 0.55 },
};

export function reverb(inL, inR, sr, { kind = 'room', decay = 1.2, predelayMs = 20, hp = 150, lp = 10000, stereo = 1 } = {}) {
  const k = REVERB_KINDS[kind] || REVERB_KINDS.room;
  const n = inL.length;
  const pre = Math.round((predelayMs / 1000) * sr);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i - pre;
    mono[i] = j >= 0 ? 0.5 * (inL[j] + inR[j]) : 0;
  }
  cascade([design('highpass', hp, sr), design('lowpass', lp, sr)], mono, mono);
  const scale = (sr / 44100) * k.size;
  const outs = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const off = c * SPREAD;
    const combs = COMBS.map((d) => {
      const len = Math.max(1, Math.round((d + off) * scale));
      return { buf: new Float32Array(len), idx: 0, fb: Math.pow(10, (-3 * len) / (Math.max(0.1, decay) * sr)), store: 0 };
    });
    const aps = ALLPASSES.map((d) => ({ buf: new Float32Array(Math.max(1, Math.round((d + off) * (sr / 44100)))), idx: 0 }));
    const out = outs[c];
    const damp = k.damp, damp1 = 1 - k.damp, diff = k.diffusion;
    for (let i = 0; i < n; i++) {
      const x = mono[i] * 0.015;
      let acc = 0;
      for (let m = 0; m < combs.length; m++) {
        const cb = combs[m];
        const y = cb.buf[cb.idx];
        cb.store = y * damp1 + cb.store * damp;
        if (cb.store < 1e-25 && cb.store > -1e-25) cb.store = 0;
        cb.buf[cb.idx] = x + cb.store * cb.fb;
        if (++cb.idx >= cb.buf.length) cb.idx = 0;
        acc += y;
      }
      for (let m = 0; m < aps.length; m++) {
        const ap = aps[m];
        const b = ap.buf[ap.idx];
        const y = -acc + b;
        ap.buf[ap.idx] = acc + b * diff;
        if (++ap.idx >= ap.buf.length) ap.idx = 0;
        acc = y;
      }
      if (acc < 1e-25 && acc > -1e-25) acc = 0;
      out[i] = acc;
    }
  }
  const [L, R] = outs;
  const w1 = (1 + stereo) / 2, w2 = (1 - stereo) / 2;
  for (let i = 0; i < n; i++) {
    const l = L[i], r = R[i];
    L[i] = l * w1 + r * w2;
    R[i] = r * w1 + l * w2;
  }
  return outs;
}

/** Feedback delay with band-limited repeats; ping-pong alternates sides. */
export function delay(inL, inR, sr, { timeMs = 280, feedback = 0.25, pingpong = true, hp = 200, lp = 9000 } = {}) {
  const n = inL.length;
  const D = Math.max(1, Math.round((timeMs / 1000) * sr));
  const bufL = new Float32Array(D), bufR = new Float32Array(D);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const lpA = Math.exp((-2 * Math.PI * lp) / sr);
  const hpA = Math.exp((-2 * Math.PI * hp) / sr);
  let lpL = 0, lpR = 0, hpLs = 0, hpRs = 0;
  const fb = Math.min(0.95, Math.max(0, feedback));
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const dL = bufL[idx], dR = bufR[idx];
    lpL = (1 - lpA) * dL + lpA * lpL;
    lpR = (1 - lpA) * dR + lpA * lpR;
    hpLs = (1 - hpA) * lpL + hpA * hpLs;
    hpRs = (1 - hpA) * lpR + hpA * hpRs;
    if (lpL < 1e-25 && lpL > -1e-25) lpL = 0;
    if (lpR < 1e-25 && lpR > -1e-25) lpR = 0;
    if (hpLs < 1e-25 && hpLs > -1e-25) hpLs = 0;
    if (hpRs < 1e-25 && hpRs > -1e-25) hpRs = 0;
    const fL = lpL - hpLs, fR = lpR - hpRs;
    if (pingpong) {
      bufL[idx] = 0.5 * (inL[i] + inR[i]) + fR * fb;
      bufR[idx] = fL * fb;
    } else {
      bufL[idx] = inL[i] + fL * fb;
      bufR[idx] = inR[i] + fR * fb;
    }
    outL[i] = fL;
    outR[i] = fR;
    if (++idx >= D) idx = 0;
  }
  return [outL, outR];
}

/** Three-band tone control used by stems, buses and the mastering chain. */
export function toneEq(chs, sr, { hpf = 0, low = 0, lowFreq = 120, mid = 0, midFreq = 1500, midQ = 0.8, high = 0, highFreq = 7000, tilt = 0, air = 0, extra = [] }) {
  const cs = [];
  if (hpf > 0) cs.push(design('highpass', hpf, sr, Math.SQRT1_2), design('highpass', hpf, sr, 0.54));
  if (low) cs.push(design('lowshelf', lowFreq, sr, 0.7, low));
  if (mid) cs.push(design('peaking', midFreq, sr, midQ, mid));
  if (high) cs.push(design('highshelf', highFreq, sr, 0.7, high));
  if (tilt) cs.push(design('lowshelf', 300, sr, 0.5, -tilt / 2), design('highshelf', 3000, sr, 0.5, tilt / 2));
  if (air) cs.push(design('highshelf', Math.min(12000, sr * 0.4), sr, 0.7, air));
  for (const e of extra) cs.push(design(e.type, e.freq, sr, e.q ?? 1, e.gain ?? 0));
  for (const ch of chs) cascade(cs, ch, ch);
  return chs;
}

export function copyChannels(chs) {
  return chs.map((c) => new Float32Array(c));
}

export function addInto(dst, src, g = 1) {
  for (let c = 0; c < dst.length; c++) {
    const d = dst[c], s = src[c];
    const n = Math.min(d.length, s.length);
    for (let i = 0; i < n; i++) d[i] += s[i] * g;
  }
}
