// Restoration tools, all opt-in: coherent inter-channel delay, flat-top
// (clipped) peak reconstruction, sparse click repair, harmonic hum
// attenuation, stationary noise reduction, per-band L/R balance and source
// bandwidth detection. Every detector reports what it found, so nothing is
// changed without a measured reason.

import { design, cascade, lr4Split3 } from './filters.js';
import { stft } from './spectral.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- Autoregressive modelling ----

/** Burg AR coefficients a[0..p] (a[0] = 1), so that x[t] ≈ -Σ a[i]·x[t-i]. */
export function burg(x, p) {
  const n = x.length;
  const a = new Float64Array(p + 1);
  a[0] = 1;
  if (n <= p + 1) return a;
  const f = Float64Array.from(x);
  const b = Float64Array.from(x);
  let D = 0;
  for (let j = 0; j < n; j++) D += 2 * f[j] * f[j];
  D -= f[0] * f[0] + b[n - 1] * b[n - 1];
  for (let k = 0; k < p; k++) {
    if (D <= 1e-20) break;
    let mu = 0;
    for (let m = 0; m <= n - k - 2; m++) mu += f[m + k + 1] * b[m];
    mu *= -2 / D;
    for (let m = 0; m <= (k + 1) >> 1; m++) {
      const t1 = a[m] + mu * a[k + 1 - m];
      const t2 = a[k + 1 - m] + mu * a[m];
      a[m] = t1;
      a[k + 1 - m] = t2;
    }
    for (let m = 0; m <= n - k - 2; m++) {
      const t1 = f[m + k + 1] + mu * b[m];
      const t2 = b[m] + mu * f[m + k + 1];
      f[m + k + 1] = t1;
      b[m] = t2;
    }
    D = (1 - mu * mu) * D - f[k + 1] * f[k + 1] - b[n - k - 2] * b[n - k - 2];
  }
  return a;
}

/** Levinson-Durbin recursion on autocorrelation r[0..p]; same sign convention as burg(). */
function levinson(r, p, a, tmp) {
  a.fill(0);
  a[0] = 1;
  let err = r[0];
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 1e-20) break;
  }
  return a;
}

function predict(context, a, len) {
  const p = a.length - 1;
  const buf = new Float64Array(p + len);
  for (let i = 0; i < p; i++) buf[i] = context[context.length - p + i];
  for (let t = p; t < p + len; t++) {
    let acc = 0;
    for (let i = 1; i <= p; i++) acc -= a[i] * buf[t - i];
    buf[t] = acc;
  }
  return buf.subarray(p);
}

/**
 * Replace x[g0..g1) by a cross-fade of a forward AR prediction (from the left
 * context) and a backward one (from the time-reversed right context).
 */
export function arInterpolate(x, g0, g1, { order = 24, context = 384 } = {}) {
  const len = g1 - g0;
  if (len <= 0) return;
  const n = x.length;
  const left = x.subarray(Math.max(0, g0 - context), g0);
  const right = Float64Array.from(x.subarray(g1, Math.min(n, g1 + context))).reverse();
  const pl = Math.min(order, left.length >> 2);
  const pr = Math.min(order, right.length >> 2);
  const fwd = pl >= 2 ? predict(left, burg(left, pl), len) : null;
  const bwd = pr >= 2 ? predict(right, burg(right, pr), len) : null;
  let lim = 1e-9;
  for (let i = 0; i < left.length; i++) lim = Math.max(lim, Math.abs(left[i]));
  for (let i = 0; i < right.length; i++) lim = Math.max(lim, Math.abs(right[i]));
  lim *= 2;
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / len);
    const f = fwd ? fwd[i] : bwd ? bwd[len - 1 - i] : 0;
    const b = bwd ? bwd[len - 1 - i] : f;
    x[g0 + i] = clamp((1 - w) * f + w * b, -lim, lim);
  }
}

// ---- Coherent inter-channel delay ----

/**
 * Cross-correlation of band-passed L and R over ±maxMs on the loudest
 * segments. A delay qualifies only when the correlation at the best lag is
 * high and clearly above the correlation at zero lag.
 */
export function detectStereoDelay(chs, sr, { maxMs = 1.5 } = {}) {
  const [L, R] = chs;
  const n = L.length;
  const none = { detected: false, lagSamples: 0, lagMs: 0, corrAtZero: 1, corrAtLag: 1 };
  if (n < sr) return none;
  const bp = [design('highpass', 150, sr, 0.7), design('lowpass', Math.min(5000, sr * 0.45), sr, 0.7)];
  const seg = Math.round(sr * 0.25);
  const segs = [];
  for (let s = 0; s + seg <= n; s += seg) {
    let e = 0;
    for (let i = s; i < s + seg; i += 4) e += L[i] * L[i] + R[i] * R[i];
    segs.push([s, e]);
  }
  segs.sort((a, b) => b[1] - a[1]);
  const pick = segs.slice(0, 40).filter((s) => s[1] > 0);
  if (!pick.length) return none;
  const maxLag = Math.max(1, Math.round(maxMs * 1e-3 * sr));
  const nl = 2 * maxLag + 1;
  const acc = new Float64Array(nl);
  let eL = 0, eR = 0;
  for (const [s] of pick) {
    const a = s - maxLag, b = s + seg + maxLag;
    if (a < 0 || b > n) continue;
    const l = cascade(bp, L.slice(a, b));
    const r = cascade(bp, R.slice(a, b));
    for (let i = maxLag; i < maxLag + seg; i++) { eL += l[i] * l[i]; eR += r[i] * r[i]; }
    for (let j = 0; j < nl; j++) {
      const lag = j - maxLag;
      let sum = 0;
      for (let i = maxLag; i < maxLag + seg; i++) sum += l[i] * r[i + lag];
      acc[j] += sum;
    }
  }
  if (eL <= 0 || eR <= 0) return none;
  const norm = 1 / Math.sqrt(eL * eR);
  let best = maxLag;
  for (let j = 0; j < nl; j++) if (acc[j] > acc[best]) best = j;
  let frac = 0;
  if (best > 0 && best < nl - 1) {
    const y0 = acc[best - 1], y1 = acc[best], y2 = acc[best + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) frac = clamp((0.5 * (y0 - y2)) / d, -0.5, 0.5);
  }
  const lag = best - maxLag + frac;
  const corrAtLag = acc[best] * norm;
  const corrAtZero = acc[maxLag] * norm;
  const detected = Math.abs(lag) >= 0.75 && corrAtLag > 0.6 && corrAtLag - corrAtZero > 0.12;
  return { detected, lagSamples: lag, lagMs: (lag / sr) * 1000, corrAtZero, corrAtLag };
}

function shift(x, d) {
  // y[i] = x[i + d] with cubic (Catmull-Rom) interpolation for fractional d.
  const n = x.length;
  const y = new Float32Array(n);
  const ip = Math.floor(d), t = d - ip;
  const at = (i) => (i >= 0 && i < n ? x[i] : 0);
  for (let i = 0; i < n; i++) {
    const j = i + ip;
    const p0 = at(j - 1), p1 = at(j), p2 = at(j + 1), p3 = at(j + 2);
    y[i] = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}

/** Positive lag means R arrives late. Each channel moves half way, keeping the centre timing. */
export function repairStereoDelay(chs, lagSamples) {
  return [shift(chs[0], -lagSamples / 2), shift(chs[1], lagSamples / 2)];
}

// ---- Flat-top (clipped) peaks ----

/** Runs of >= minRun samples sitting on a channel's positive or negative extreme. */
export function detectClipping(chs, { minRun = 3, maxRunMs = 2.5, sr = 48000 } = {}) {
  const maxRun = Math.round(maxRunMs * 1e-3 * sr);
  const perChannel = chs.map((ch) => {
    let pos = 0, neg = 0;
    for (let i = 0; i < ch.length; i++) { const v = ch[i]; if (v > pos) pos = v; else if (v < neg) neg = v; }
    const runs = [];
    let skipped = 0;
    for (const [level, sign] of [[pos, 1], [-neg, -1]]) {
      if (level < 0.1) continue;
      const thr = level * (1 - 1e-5);
      let run = 0, start = 0;
      for (let i = 0; i <= ch.length; i++) {
        const v = i < ch.length ? sign * ch[i] : -Infinity;
        if (v >= thr) { if (!run) start = i; run++; continue; }
        if (run >= minRun) {
          if (run <= maxRun && start > 2 && i < ch.length - 2) runs.push({ start, end: i, sign, level });
          else skipped++;
        }
        run = 0;
      }
    }
    runs.sort((a, b) => a.start - b.start);
    return { runs, skipped, samples: runs.reduce((a, r) => a + r.end - r.start, 0) };
  });
  return {
    detected: perChannel.some((c) => c.runs.length > 0),
    runs: perChannel.reduce((a, c) => a + c.runs.length, 0),
    samples: perChannel.reduce((a, c) => a + c.samples, 0),
    skippedLongRuns: perChannel.reduce((a, c) => a + c.skipped, 0),
    perChannel,
  };
}

/**
 * Reconstruct clipped runs by AR interpolation from both sides. The result is
 * held at or above the clip level (with the clip's sign) and at most 6 dB
 * above it.
 */
export function declip(chs, sr, detection = detectClipping(chs, { sr })) {
  let maxOver = 0;
  chs.forEach((ch, c) => {
    for (const r of detection.perChannel[c].runs) {
      const { start, end, sign, level } = r;
      const a0 = Math.max(0, start - 300);
      const ar = Float32Array.from(ch.subarray(a0, Math.min(ch.length, end + 300)));
      arInterpolate(ar, start - a0, end - a0, { order: 20, context: 256 });
      for (let i = start; i < end; i++) {
        const v = clamp(sign * ar[i - a0], level, level * 2);
        if (v / level > maxOver) maxOver = v / level;
        ch[i] = sign * v;
      }
    }
  });
  return { runs: detection.runs, samples: detection.samples, skippedLongRuns: detection.skippedLongRuns, maxOvershootDb: maxOver > 0 ? 20 * Math.log10(maxOver) : 0 };
}

// ---- Sparse clicks ----

/**
 * Click detection on the residual of a block-wise AR model. A sample is an
 * outlier when its residual exceeds k times the local residual level and an
 * absolute floor tied to the programme level (so quantisation steps in
 * near-silence are ignored). Events must be short, isolated (fewer than three
 * within 50 ms), sparse within their block, and have similar energy before and
 * after (so drum onsets are left alone). Events are merged across channels so
 * both sides are repaired together.
 */
export function detectClicks(chs, sr, { sensitivity = 0.5, maxGapMs = 2 } = {}) {
  const order = 20;
  const B = 4096;
  const k = 12 - 5 * clamp(sensitivity, 0, 1);
  const maxGap = Math.max(4, Math.round(maxGapMs * 1e-3 * sr));
  const ctx = Math.round(sr * 0.006);
  const guard = Math.round(sr * 0.0015);
  const win = new Float64Array(B);
  for (let i = 0; i < B; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / B);
  const seg = new Float64Array(B);
  const r = new Float64Array(order + 1);
  const a = new Float64Array(order + 1), tmp = new Float64Array(order + 1);
  const W = Math.round(sr * 0.005);
  const absRes = new Float32Array(B + 2 * W);
  const prefix = new Float64Array(B + 2 * W + 1);
  const raw = [];
  let onsetLike = 0, tooLong = 0, clustered = 0;
  // Programme RMS over non-silent samples sets an absolute residual floor 45 dB below it.
  let ss = 0, cntNz = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i += 2) { const v = ch[i]; if (v !== 0) { ss += v * v; cntNz++; } }
  const absFloor = Math.max(1e-4, 0.0056 * Math.sqrt(cntNz ? ss / cntNz : 0));
  for (const ch of chs) {
    const n = ch.length;
    for (let start = 0; start + order * 4 < n; start += B) {
      const m = Math.min(B, n - start);
      for (let i = 0; i < m; i++) seg[i] = ch[start + i] * win[i];
      for (let lag = 0; lag <= order; lag++) {
        let s = 0;
        for (let i = 0; i + lag < m; i++) s += seg[i] * seg[i + lag];
        r[lag] = s;
      }
      if (r[0] < 1e-10 * m) continue;
      r[0] *= 1.0001;
      levinson(r, order, a, tmp);
      // Residual over the block plus W samples either side (for local scale).
      const e0 = Math.max(order, start - W), e1 = Math.min(n, start + m + W);
      const len = e1 - e0;
      prefix[0] = 0;
      for (let i = 0; i < len; i++) {
        const t = e0 + i;
        let e = ch[t];
        for (let j = 1; j <= order; j++) e += a[j] * ch[t - j];
        const v = e < 0 ? -e : e;
        absRes[i] = v;
        prefix[i + 1] = prefix[i] + v;
      }
      const sorted = absRes.slice(Math.max(0, start - e0), Math.max(0, start - e0) + m).sort();
      const sigma = sorted[sorted.length >> 1] * 1.4826;
      if (!(sigma > 0)) continue;
      // Threshold against the local mean |residual| (centre excluded), so a
      // decaying burst is not mistaken for impulses.
      const flagged = [];
      for (let t = Math.max(start, e0); t < start + m; t++) {
        const i = t - e0;
        const lo = Math.max(0, i - W), hi = Math.min(len, i + W + 1);
        const clo = Math.max(lo, i - 3), chi = Math.min(hi, i + 4);
        const cnt = hi - lo - (chi - clo);
        const local = cnt > 0 ? (prefix[hi] - prefix[lo] - (prefix[chi] - prefix[clo])) / cnt : 0;
        if (absRes[i] > absFloor && absRes[i] > k * Math.max(1.25 * local, 0.6 * sigma)) flagged.push(t);
      }
      if (!flagged.length || flagged.length > m * 0.004) continue;
      let ev = null;
      for (const t of flagged) {
        if (ev && t - ev[1] <= order) ev[1] = t;
        else { if (ev) raw.push([Math.max(0, ev[0] - 1), Math.min(n, ev[1] + 2)]); ev = [t, t]; }
      }
      if (ev) raw.push([Math.max(0, ev[0] - 1), Math.min(n, ev[1] + 2)]);
    }
  }
  // Merge across channels.
  raw.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const e of raw) {
    const last = merged[merged.length - 1];
    if (last && e[0] <= last[1] + 2) last[1] = Math.max(last[1], e[1]);
    else merged.push([e[0], e[1]]);
  }
  const events = [];
  const n = chs[0].length;
  const near = Math.round(sr * 0.05);
  for (let e = 0; e < merged.length; e++) {
    const [g0, g1] = merged[e];
    if (g1 - g0 > maxGap) { tooLong++; continue; }
    let neighbours = 0;
    for (let j = e - 1; j >= 0 && merged[j][0] > g0 - near; j--) neighbours++;
    for (let j = e + 1; j < merged.length && merged[j][0] < g0 + near; j++) neighbours++;
    if (neighbours >= 2) { clustered++; continue; }
    // Energy before vs after (skipping a guard band around the event).
    let before = 0, after = 0;
    for (const ch of chs) {
      for (let i = Math.max(0, g0 - guard - ctx); i < g0 - guard; i++) before += ch[i] * ch[i];
      for (let i = g1 + guard; i < Math.min(n, g1 + guard + ctx); i++) after += ch[i] * ch[i];
    }
    if (after > 4 * before + 1e-12) { onsetLike++; continue; }
    events.push([g0, g1]);
  }
  const minutes = n / sr / 60;
  return {
    detected: events.length > 0,
    events,
    count: events.length,
    perMinute: minutes > 0 ? events.length / minutes : 0,
    skippedOnsets: onsetLike,
    skippedLong: tooLong,
    skippedClusters: clustered,
    times: events.slice(0, 200).map(([s]) => s / sr),
  };
}

export function repairClicks(chs, sr, detection) {
  for (const [g0, g1] of detection.events) for (const ch of chs) arInterpolate(ch, g0, g1, { order: 24, context: 384 });
  return { repaired: detection.events.length, samples: detection.events.reduce((a, [s, e]) => a + e - s, 0) };
}

// ---- Mains hum ----

function decimateLow(chs, sr) {
  const D = Math.max(1, Math.floor(sr / 4000));
  // 8th-order Butterworth anti-alias filter.
  const lp = [0.5098, 0.6013, 0.9, 2.5629].map((q) => design('lowpass', 1250, sr, q));
  const out = chs.map((ch) => {
    const f = cascade(lp, ch, new Float32Array(ch.length));
    const y = new Float32Array(Math.floor(ch.length / D));
    for (let i = 0; i < y.length; i++) y[i] = f[i * D];
    return y;
  });
  return { chs: out, sr: sr / D };
}

function lowSpectrum(chs, sr, N) {
  const acc = new Float64Array(N / 2 + 1);
  let frames = 0;
  stft(chs, sr, { N, overlap: 2, onFrame: (re, im, power) => { for (let k = 0; k < acc.length; k++) acc[k] += power[k]; frames++; } });
  if (frames) for (let k = 0; k < acc.length; k++) acc[k] /= frames;
  return acc;
}

function scoreHum(power, binHz, f0) {
  const harmonics = [];
  for (let h = 1; h * f0 <= 1200; h++) {
    const fh = h * f0;
    const tol = 0.6 + 0.002 * fh;
    const k0 = Math.max(1, Math.floor((fh - tol) / binHz)), k1 = Math.min(power.length - 2, Math.ceil((fh + tol) / binHz));
    let kb = k0;
    for (let k = k0; k <= k1; k++) if (power[k] > power[kb]) kb = k;
    const nb = [];
    for (let k = Math.floor((fh - 15) / binHz); k <= Math.ceil((fh + 15) / binHz); k++) {
      if (k < 1 || k >= power.length) continue;
      if (Math.abs(k * binHz - fh) < 3) continue;
      nb.push(power[k]);
    }
    if (!nb.length || power[kb] <= 0) continue;
    nb.sort((x, y) => x - y);
    const floor = nb[nb.length >> 1];
    const prom = floor > 0 ? 10 * Math.log10(power[kb] / floor) : 0;
    // Parabolic refinement of the peak position.
    const lg = (v) => Math.log(Math.max(v, 1e-30));
    const y0 = lg(power[kb - 1]), y1 = lg(power[kb]), y2 = lg(power[kb + 1]);
    const d = y0 - 2 * y1 + y2;
    const off = d < 0 ? clamp((0.5 * (y0 - y2)) / d, -0.5, 0.5) : 0;
    harmonics.push({ n: h, freq: (kb + off) * binHz, prominenceDb: prom });
  }
  const strong = harmonics.filter((x) => x.prominenceDb >= 10);
  return { harmonics, strong, score: strong.length, total: strong.reduce((a, x) => a + x.prominenceDb, 0) };
}

/** Looks for stationary 50 or 60 Hz harmonic series in both halves of the track. */
export function detectHum(chs, sr) {
  const none = { detected: false, f0: 0, harmonics: [] };
  if (chs[0].length < sr * 4) return none;
  const low = decimateLow(chs, sr);
  const N = 8192;
  const binHz = low.sr / N;
  const half = Math.floor(low.chs[0].length / 2);
  const full = lowSpectrum(low.chs, low.sr, N);
  const a = lowSpectrum(low.chs.map((c) => c.subarray(0, half)), low.sr, N);
  const b = lowSpectrum(low.chs.map((c) => c.subarray(half)), low.sr, N);
  let best = null;
  for (const mains of [50, 60]) {
    const s = scoreHum(full, binHz, mains);
    const sa = scoreHum(a, binHz, mains), sb = scoreHum(b, binHz, mains);
    // A harmonic counts only if it is prominent in both halves (stationary).
    const steady = s.strong.filter((x) => [sa, sb].every((h) => h.harmonics.some((y) => y.n === x.n && y.prominenceDb >= 8)));
    if (steady.length < 3) continue;
    // Refine f0 from the low harmonics, then keep only exact multiples
    // (musical notes near a harmonic are rarely at an exact multiple).
    const lowH = steady.filter((x) => x.n <= 6);
    const ref = lowH.length ? lowH : steady;
    const w = ref.reduce((acc, x) => acc + x.prominenceDb, 0);
    const f0 = ref.reduce((acc, x) => acc + (x.freq / x.n) * x.prominenceDb, 0) / w;
    const exact = steady.filter((x) => Math.abs(x.freq - x.n * f0) <= 0.25 + 0.0003 * x.n * f0);
    if (exact.length < 3) continue;
    const total = exact.reduce((acc, x) => acc + x.prominenceDb, 0);
    if (!best || exact.length > best.h.length || (exact.length === best.h.length && total > best.total)) best = { mains, f0, h: exact, total };
  }
  if (!best) return none;
  return { detected: true, mains: best.mains, f0: best.f0, harmonics: best.h.map((x) => ({ n: x.n, freq: x.n * best.f0, prominenceDb: x.prominenceDb })) };
}

/** Narrow peaking cuts at each qualified harmonic, sized by its measured prominence. */
export function removeHum(chs, sr, detection, { amount = 1 } = {}) {
  if (!detection.detected) return { filters: [] };
  const filters = detection.harmonics.map((h) => {
    const bw = 1.5 + 0.003 * h.freq;
    const cut = -clamp((h.prominenceDb - 3) * amount, 0, 30);
    return { freq: h.freq, q: h.freq / bw, gainDb: cut };
  }).filter((f) => f.gainDb < -0.5 && f.freq < sr * 0.45);
  const coeffs = filters.map((f) => design('peaking', f.freq, sr, f.q, f.gainDb));
  for (const ch of chs) cascade(coeffs, ch, ch);
  return { filters };
}

// ---- Stationary noise ----

function noiseBands(N, sr) {
  const half = N / 2 + 1;
  const binHz = sr / N;
  const band = new Int16Array(half).fill(-1);
  const centers = [];
  for (let b = 0; ; b++) {
    const fc = 40 * Math.pow(2, (b + 0.5) / 6);
    if (fc > sr * 0.48) break;
    centers.push(fc);
  }
  for (let k = 1; k < half; k++) {
    const f = k * binHz;
    if (f < 40) continue;
    band[k] = Math.min(centers.length - 1, Math.floor(6 * Math.log2(f / 40)));
  }
  const width = new Uint16Array(centers.length);
  for (let k = 0; k < half; k++) if (band[k] >= 0) width[band[k]]++;
  return { band, centers, width };
}

/**
 * Noise profile from the quietest passages: the 5% quietest non-silent frames
 * (and any within 3 dB of them) are averaged per band. The profile qualifies
 * only when those frames sit at least 20 dB below the median frame and cover
 * half a second or more; otherwise there is no clear noise-only passage and
 * noise reduction leaves the audio alone.
 */
export function noiseProfile(chs, sr, { N = sr > 96000 ? 8192 : sr > 48000 ? 4096 : 2048 } = {}) {
  const { band, centers, width } = noiseBands(N, sr);
  const nb = centers.length;
  const totals = [];
  stft(chs, sr, { N, overlap: 2, onFrame: (re, im, power) => { let t = 0; for (let k = 1; k < power.length; k++) t += power[k]; totals.push(t); } });
  const live = Float64Array.from(totals.filter((t) => t > 1e-24)).sort();
  const hopSec = N / 2 / sr;
  const base = { N, centers, floorDb: centers.map(() => -200), floorDbfs: -200, separationDb: 0, quietSec: 0, qualified: false };
  if (live.length < 40) return { ...base, reason: 'The track is too short to measure a noise floor.' };
  const q = live[Math.floor(live.length * 0.05)];
  const med = live[live.length >> 1];
  const acc = new Float64Array(nb);
  let count = 0, qsum = 0;
  stft(chs, sr, {
    N, overlap: 2,
    onFrame: (re, im, power, f) => {
      const t = totals[f];
      if (!(t > 1e-24 && t <= 2 * q)) return;
      for (let k = 1; k < power.length; k++) { const b = band[k]; if (b >= 0) acc[b] += power[k]; }
      count++;
      qsum += t;
    },
  });
  const floorDb = centers.map((_, b) => (acc[b] > 0 ? 10 * Math.log10(acc[b] / (count * width[b])) : -200));
  const separationDb = 10 * Math.log10(med / q);
  const quietSec = count * hopSec;
  const floorDbfs = count ? 10 * Math.log10((2 * qsum) / count / (N * N)) : -200;
  const qualified = separationDb >= 20 && quietSec >= 0.5;
  const reason = qualified
    ? `Noise profile from ${quietSec.toFixed(1)} s of the quietest passages, ${separationDb.toFixed(0)} dB below the typical level.`
    : separationDb < 20
      ? `No clear noise-only passage: the quietest moments are only ${separationDb.toFixed(0)} dB below the typical level (20 dB needed).`
      : `Only ${quietSec.toFixed(1)} s of noise-only material (0.5 s needed).`;
  return { N, centers, floorDb, floorDbfs, separationDb, quietSec, qualified, reason };
}

/**
 * Spectral-subtraction style noise reduction with linked stereo gains,
 * gain floors, slow gain closing and cross-bin smoothing (to avoid "musical
 * noise"). Bands where music is not clearly separated from the floor are
 * protected.
 */
export function denoise(chs, sr, { amount = 0.5, profile = null, onProgress } = {}) {
  const prof = profile || noiseProfile(chs, sr);
  if (!prof.qualified) return { chs, report: { applied: false, reason: prof.reason, floorDbfs: prof.floorDbfs, separationDb: prof.separationDb } };
  const N = prof.N;
  const half = N / 2 + 1;
  const { band, centers } = noiseBands(N, sr);
  const noise = new Float64Array(half);
  const weight = new Float64Array(half);
  for (let k = 1; k < half; k++) {
    const b = band[k];
    if (b < 0 || prof.floorDb[b] <= -199) continue;
    noise[k] = Math.pow(10, prof.floorDb[b] / 10);
    weight[k] = 1;
  }
  const alpha = 1 + 2 * amount;
  const gmin = Math.pow(10, -(6 + 12 * amount) / 20);
  const hopSec = N / 4 / sr;
  // Per-bin power is smoothed over a few frames (fast rise, slower fall)
  // before the gain is computed, which keeps random noise peaks from opening
  // the gain.
  const bUp = Math.exp(-hopSec / 0.004), bDown = Math.exp(-hopSec / 0.035);
  const psm = new Float64Array(half);
  const prev = new Float64Array(half).fill(1);
  const g = new Float64Array(half);
  let sumRed = 0, count = 0;
  const out = stft(chs, sr, {
    N, overlap: 4, synthesize: true, onProgress,
    onFrame: (re, im, power) => {
      for (let k = 0; k < half; k++) {
        const p = power[k];
        psm[k] = p > psm[k] ? bUp * psm[k] + (1 - bUp) * p : bDown * psm[k] + (1 - bDown) * p;
        let gk = 1;
        if (weight[k] > 0 && psm[k] > 0) gk = Math.max(gmin, 1 - (alpha * noise[k]) / psm[k]);
        gk = 0.4 * prev[k] + 0.6 * gk;
        prev[k] = gk;
        g[k] = gk;
      }
      for (let k = 1; k < half - 1; k++) {
        const s = 0.25 * (g[k - 1] + 2 * g[k] + g[k + 1]);
        const gk = 1 - weight[k] * (1 - s);
        if (gk < 0.9999) {
          re[k] *= gk; im[k] *= gk;
          if (k < N / 2) { re[N - k] *= gk; im[N - k] *= gk; }
          sumRed += -20 * Math.log10(gk);
        }
        count++;
      }
    },
  });
  return {
    chs: out,
    report: {
      applied: true,
      amount,
      reason: prof.reason,
      floorDbfs: prof.floorDbfs,
      separationDb: prof.separationDb,
      avgReductionDb: count ? sumRed / count : 0,
      bands: centers.map((f, i) => ({ freq: Math.round(f), floorDb: prof.floorDb[i] })),
    },
  };
}

// ---- Per-band L/R balance ----

/** Conservative per-band balance: half the measured difference, at most maxDb, only above minDb. */
export function bandBalance(chs, sr, { maxDb = 1.5, minDb = 1, xLow = 200, xHigh = 4000 } = {}) {
  const [L, R] = chs;
  const sl = lr4Split3(L, xLow, xHigh, sr), sr3 = lr4Split3(R, xLow, xHigh, sr);
  const bands = [];
  for (let b = 0; b < 3; b++) {
    let el = 0, er = 0;
    for (let i = 0; i < L.length; i++) { el += sl[b][i] * sl[b][i]; er += sr3[b][i] * sr3[b][i]; }
    const diff = el > 0 && er > 0 ? 10 * Math.log10(el / er) : 0;
    const trim = Math.abs(diff) > minDb ? Math.min(maxDb, Math.abs(diff) / 2) : 0;
    const g = Math.pow(10, -trim / 20);
    if (trim) { const t = diff > 0 ? sl[b] : sr3[b]; for (let i = 0; i < t.length; i++) t[i] *= g; }
    bands.push({ name: ['low', 'mid', 'high'][b], diffDb: diff, trimDb: trim, side: trim ? (diff > 0 ? 'left' : 'right') : null });
  }
  for (let i = 0; i < L.length; i++) { L[i] = sl[0][i] + sl[1][i] + sl[2][i]; R[i] = sr3[0][i] + sr3[1][i] + sr3[2][i]; }
  return { bands };
}

// ---- Source bandwidth ----

/** Highest frequency still within 55 dB of the 1-4 kHz level, and whether it ends in a steep wall. */
export function detectBandwidth(spec) {
  const { power, N, sr } = spec;
  const binHz = sr / N;
  const half = power.length;
  const db = new Float64Array(half);
  const w = 4;
  for (let k = 0; k < half; k++) {
    let s = 0, c = 0;
    for (let j = Math.max(1, k - w); j <= Math.min(half - 1, k + w); j++) { s += power[j]; c++; }
    db[k] = s > 0 ? 10 * Math.log10(s / c) : -300;
  }
  let ref = 0, rc = 0;
  for (let k = Math.ceil(1000 / binHz); k <= Math.floor(4000 / binHz) && k < half; k++) { ref += power[k]; rc++; }
  const nyq = sr / 2;
  if (!rc || ref <= 0) return { bandwidthHz: nyq, limited: false, brickwall: false, dropDb: 0 };
  const refDb = 10 * Math.log10(ref / rc);
  let top = Math.floor((0.98 * nyq) / binHz);
  while (top > 1 && db[top] < refDb - 55) top--;
  const bandwidthHz = Math.min(nyq, top * binHz);
  const at = (f) => db[clamp(Math.round(f / binHz), 1, half - 1)];
  const dropDb = bandwidthHz < 0.95 * nyq ? at(bandwidthHz * 0.92) - at(Math.min(0.98 * nyq, bandwidthHz * 1.08)) : 0;
  return { bandwidthHz, limited: bandwidthHz < Math.min(19500, 0.9 * nyq), brickwall: dropDb > 25, dropDb };
}
