// Vocal pitch correction: YIN pitch tracking (on a decimated copy, with
// FFT-based correlation), key detection from the sung pitch classes, note
// targeting with hysteresis and a retune speed, and TD-PSOLA pitch shifting
// (pitch-synchronous grains, so formants and timing are kept).

import { fft, nextPow2 } from './fft.js';
import { design, cascade } from './filters.js';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
// Krumhansl-Kessler key profiles.
const KK = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};

const toMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const noteName = (m) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

function monoOf(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const ch of chs) s += ch[i]; m[i] = s / chs.length; }
  return m;
}

/**
 * YIN pitch track. Returns per-frame f0 (Hz, 0 when unvoiced), aperiodicity,
 * frame level (dB) and the frame centre of frame t at sample t*hop + offset.
 */
export function trackPitch(chs, sr, { fMin = 70, fMax = 1000, hopSec = 0.005, threshold = 0.12 } = {}) {
  const x = monoOf(chs);
  const d = Math.max(1, Math.floor(sr / 12000));
  const fs = sr / d;
  // Anti-alias (4th-order Butterworth) and decimate.
  const lp = cascade([design('lowpass', 0.4 * fs, sr, 0.5412), design('lowpass', 0.4 * fs, sr, 1.3066)], x, new Float32Array(x.length));
  const y = new Float32Array(Math.floor(x.length / d));
  for (let i = 0; i < y.length; i++) y[i] = lp[i * d];
  const W = Math.round(0.04 * fs);
  const tMax = Math.ceil(fs / fMin), tMin = Math.max(2, Math.floor(fs / fMax));
  const Nf = nextPow2(W + tMax + 1);
  const hop = Math.max(1, Math.round(hopSec * fs));
  const frames = Math.max(0, Math.floor((y.length - W - tMax) / hop) + 1);
  const cs = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) cs[i + 1] = cs[i] + y[i] * y[i];
  const level = new Float32Array(frames);
  for (let t = 0; t < frames; t++) { const e = cs[t * hop + W] - cs[t * hop]; level[t] = e > 0 ? 10 * Math.log10(e / W) : -120; }
  const sorted = Float32Array.from(level).sort();
  const loud = sorted.length ? sorted[Math.floor(0.95 * (sorted.length - 1))] : -120;
  const gate = Math.max(-60, loud - 35);
  const f0 = new Float32Array(frames), aper = new Float32Array(frames).fill(1);
  const re = new Float64Array(Nf), im = new Float64Array(Nf);
  const cm = new Float64Array(tMax + 2);
  for (let t = 0; t < frames; t++) {
    if (level[t] < gate) continue;
    const s0 = t * hop;
    for (let i = 0; i < Nf; i++) { re[i] = i < W ? y[s0 + i] : 0; im[i] = i < W + tMax ? y[s0 + i] : 0; }
    fft(re, im, false);
    // r(tau) = sum a[j] b[j+tau]: unpack A, B; product conj(A)*B; inverse.
    for (let k = 0; k <= Nf / 2; k++) {
      const k2 = (Nf - k) % Nf;
      const ar = 0.5 * (re[k] + re[k2]), ai = 0.5 * (im[k] - im[k2]);
      const br = 0.5 * (im[k] + im[k2]), bi = -0.5 * (re[k] - re[k2]);
      const pr = ar * br + ai * bi, pi = ar * bi - ai * br;
      re[k] = pr; im[k] = pi;
      if (k2 !== k) { re[k2] = pr; im[k2] = -pi; }
    }
    fft(re, im, true);
    const e0 = cs[s0 + W] - cs[s0];
    let run = 0, best = -1, bestV = Infinity;
    cm[0] = 1;
    for (let tau = 1; tau <= tMax; tau++) {
      const et = cs[s0 + tau + W] - cs[s0 + tau];
      const dv = Math.max(0, e0 + et - 2 * re[tau]);
      run += dv;
      cm[tau] = run > 0 ? (dv * tau) / run : 1;
    }
    // First dip under the threshold (then its local minimum), else the global minimum.
    for (let tau = tMin; tau <= tMax; tau++) {
      if (cm[tau] < threshold) {
        while (tau + 1 <= tMax && cm[tau + 1] < cm[tau]) tau++;
        best = tau; bestV = cm[tau];
        break;
      }
      if (cm[tau] < bestV) { bestV = cm[tau]; best = tau; }
    }
    if (best < 0 || bestV > 0.3) continue;
    let tau = best;
    if (best > tMin && best < tMax) {
      const a = cm[best - 1], b = cm[best], c = cm[best + 1];
      const den = a - 2 * b + c;
      if (den > 0) tau = best + (0.5 * (a - c)) / den;
    }
    f0[t] = fs / tau;
    aper[t] = bestV;
  }
  cleanTrack(f0, Math.round(0.03 / hopSec));
  return { f0, aper, level, gate, hopSamples: hop * d, offset: (W / 2) * d, hopSec: (hop * d) / sr, frames };
}

// Median-based octave-error fix and removal of voiced runs shorter than `minRun`.
function cleanTrack(f0, minRun) {
  const n = f0.length;
  const fixed = Float32Array.from(f0);
  for (let t = 0; t < n; t++) {
    if (!f0[t]) continue;
    const win = [];
    for (let j = t - 3; j <= t + 3; j++) if (j >= 0 && j < n && f0[j]) win.push(f0[j]);
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    const r = Math.log2(f0[t] / med);
    if (Math.abs(Math.abs(r) - 1) < 0.1) fixed[t] = f0[t] * Math.pow(2, -Math.round(r));
  }
  f0.set(fixed);
  for (let t = 0; t < n;) {
    if (!f0[t]) { t++; continue; }
    let e = t;
    while (e < n && f0[e]) e++;
    if (e - t < minRun) for (let j = t; j < e; j++) f0[j] = 0;
    t = e;
  }
}

/** Key from the sung pitch classes (level-weighted), Krumhansl-Kessler correlation. */
export function detectKey(track) {
  const hist = new Float64Array(12);
  for (let t = 0; t < track.frames; t++) {
    if (!track.f0[t]) continue;
    const m = toMidi(track.f0[t]);
    const w = Math.pow(10, (track.level[t] - track.gate) / 40);
    hist[((Math.round(m) % 12) + 12) % 12] += w;
  }
  const corr = (a, b) => {
    const ma = a.reduce((p, c) => p + c, 0) / 12, mb = b.reduce((p, c) => p + c, 0) / 12;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < 12; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  };
  let best = { root: 0, scale: 'major', r: -2 };
  for (const scale of ['major', 'minor']) {
    for (let root = 0; root < 12; root++) {
      const prof = KK[scale].map((_, i) => KK[scale][(i - root + 12) % 12]);
      const r = corr(hist, prof);
      if (r > best.r) best = { root, scale, r };
    }
  }
  return { ...best, name: `${NOTE_NAMES[best.root]} ${best.scale}`, histogram: Array.from(hist) };
}

function nearestInScale(m, root, scale) {
  const pcs = SCALES[scale];
  let best = Math.round(m), bd = Infinity;
  for (let k = Math.floor(m) - 2; k <= Math.ceil(m) + 2; k++) {
    if (!pcs.includes(((k - root) % 12 + 12) % 12)) continue;
    const dd = Math.abs(k - m);
    if (dd < bd) { bd = dd; best = k; }
  }
  return best;
}

// Zero-phase one-pole smoothing (forward then backward) over a frame series.
function smooth2(arr, a) {
  const y = Float64Array.from(arr);
  for (let i = 1; i < y.length; i++) y[i] = a * y[i - 1] + (1 - a) * y[i];
  for (let i = y.length - 2; i >= 0; i--) y[i] = a * y[i + 1] + (1 - a) * y[i];
  return y;
}

/**
 * Correction curve in semitones per frame. `speedMs` is the retune speed: 0
 * snaps to the note (vibrato flattened); longer values only correct the
 * slower average of the pitch, so vibrato and scoops pass through.
 */
export function correctionCurve(track, { root, scale, strength = 1, speedMs = 40, maxShift = 1.5 } = {}) {
  const { f0, frames, hopSec } = track;
  const midi = new Float64Array(frames), target = new Float64Array(frames), delta = new Float64Array(frames);
  const runs = [];
  for (let t = 0; t < frames;) {
    if (!f0[t]) { t++; continue; }
    let e = t;
    while (e < frames && f0[e]) e++;
    runs.push([t, e]);
    t = e;
  }
  let notes = 0, lastTarget = null, lastEnd = -Infinity;
  const aRef = speedMs > 0 ? Math.exp(-hopSec / (speedMs / 1000)) : 0;
  const aNote = Math.exp(-hopSec / 0.06);
  const joinGap = Math.round(0.25 / hopSec);
  for (const [s, e] of runs) {
    const m = [];
    for (let t = s; t < e; t++) { midi[t] = toMidi(f0[t]); m.push(midi[t]); }
    const ref = aRef ? smooth2(m, aRef) : m;
    const decide = smooth2(m, aNote);
    const cands = decide.map((d) => nearestInScale(d, root, scale));
    // A new note must hold for 90 ms: fast releases read sharp in YIN for a few frames.
    const hold = Math.max(1, Math.round(0.09 / hopSec));
    const holds = (j, c) => { for (let q = j; q < j + hold; q++) if (q >= cands.length || cands[q] !== c) return false; return true; };
    // Typical level of this run: decaying tails (resonances, breaths) more than 12 dB under it never pick a new note.
    const lv = Array.from(track.level.subarray(s, e)).sort((a, b) => a - b);
    const floor = lv[lv.length >> 1] - 12;
    let cur = null;
    for (let j = 0; j < m.length; j++) {
      const cand = cands[j];
      // Hysteresis, and the new note must hold (see above).
      if (cur == null || (cand !== cur && track.level[s + j] > floor && Math.abs(decide[j] - cand) + 0.15 < Math.abs(decide[j] - cur) && holds(j, cand))) {
        // A short dropout inside a held note is not a new note.
        if (!(cur == null && cand === lastTarget && s - lastEnd <= joinGap)) notes++;
        cur = cand;
      }
      target[s + j] = cur;
      const dd = cur - ref[j];
      delta[s + j] = Math.abs(dd) > maxShift ? 0 : dd * strength;
    }
    lastTarget = cur;
    lastEnd = e;
    // Smooth note-to-note steps and fade in/out over 20 ms at the run edges.
    const sm = smooth2(delta.subarray(s, e), Math.exp(-hopSec / Math.max(0.008, 0.25 * speedMs / 1000)));
    const fade = Math.max(1, Math.round(0.02 / hopSec));
    for (let j = 0; j < sm.length; j++) delta[s + j] = sm[j] * Math.min(1, (j + 0.5) / fade, (sm.length - j - 0.5) / fade);
  }
  return { midi, target, delta, runs, notes };
}

/**
 * TD-PSOLA: analysis marks one per period on the voiced runs; each synthesis
 * mark takes the nearest analysis grain (asymmetric Hann over the
 * neighbouring periods). With a ratio of 1 the grains rebuild the input
 * exactly, so the edges of each run splice seamlessly into the original.
 */
export function psola(chs, sr, track, delta) {
  const n = chs[0].length;
  const x = monoOf(chs);
  const lp = cascade([design('lowpass', 900, sr, 0.7)], x, new Float32Array(n));
  const { hopSamples, offset, frames } = track;
  const frameAt = (i) => Math.max(0, Math.min(frames - 1, (i - offset) / hopSamples));
  const valAt = (arr, i) => { const p = frameAt(i), a = Math.floor(p), b = Math.min(frames - 1, a + 1), f = p - a; return arr[a] * (1 - f) + arr[b] * f; };
  const out = chs.map((c) => new Float32Array(c));
  let shifted = 0;
  for (const [s, e] of delta.runs) {
    let any = false;
    for (let t = s; t < e; t++) if (Math.abs(delta.delta[t]) > 0.005) { any = true; break; }
    if (!any) continue;
    const S = Math.round(s * hopSamples + offset), E = Math.min(n - 1, Math.round((e - 1) * hopSamples + offset));
    const period = (i) => { const p = frameAt(i), t = Math.round(p); return sr / (track.f0[Math.max(s, Math.min(e - 1, t))] || track.f0[s]); };
    // Analysis marks on positive peaks of the low-passed signal.
    const marks = [];
    let T0 = period(S), m = S, best = -Infinity;
    for (let i = S; i < Math.min(E, S + T0); i++) if (lp[i] > best) { best = lp[i]; m = i; }
    marks.push(m);
    for (;;) {
      const T = period(m);
      const guess = Math.round(m + T);
      if (guess + T >= E) break;
      const r = Math.max(1, Math.round(0.15 * T));
      let pk = guess; best = -Infinity;
      for (let i = guess - r; i <= guess + r; i++) if (lp[i] > best) { best = lp[i]; pk = i; }
      marks.push(pk);
      m = pk;
    }
    if (marks.length < 4) continue;
    const M = marks.length, A = marks[0], B = marks[M - 1];
    const acc = chs.map(() => new Float64Array(B - A + 1));
    const ws = new Float64Array(B - A + 1);
    let ts = A, k = 0;
    while (ts <= B) {
      while (k + 1 < M && Math.abs(marks[k + 1] - ts) <= Math.abs(marks[k] - ts)) k++;
      const beta = Math.pow(2, valAt(delta.delta, ts) / 12);
      const Pl = k > 0 ? marks[k] - marks[k - 1] : marks[1] - marks[0];
      const Pr = k < M - 1 ? marks[k + 1] - marks[k] : Pl;
      const base = Math.floor(ts), frac = ts - base;
      for (let j = -Pl; j < Pr; j++) {
        const u = j - frac;
        if (u <= -Pl || u >= Pr) continue;
        const o = base + j;
        if (o < A || o > B) continue;
        const w = 0.5 * (1 + Math.cos((Math.PI * u) / (u < 0 ? Pl : Pr)));
        const src = marks[k] + j;
        if (src - 1 < 0 || src >= n) continue;
        ws[o - A] += w;
        for (let c = 0; c < chs.length; c++) acc[c][o - A] += w * ((1 - frac) * chs[c][src] + frac * chs[c][src - 1]);
      }
      ts += Pr / beta;
    }
    for (let i = 0; i < ws.length; i++) {
      if (ws[i] < 0.05) continue;
      for (let c = 0; c < chs.length; c++) out[c][A + i] = acc[c][i] / ws[i];
    }
    shifted += B - A;
  }
  return { chs: out, shiftedPct: (100 * shifted) / n };
}

function deviationCents(track, root, scale) {
  let sum = 0, cnt = 0;
  for (let t = 0; t < track.frames; t++) {
    if (!track.f0[t]) continue;
    const m = toMidi(track.f0[t]);
    sum += Math.abs(m - nearestInScale(m, root, scale)) * 100;
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/**
 * Full correction for one stem. `key` is { root, scale } or null to detect it.
 * Returns the corrected channels and a report with before/after pitch curves.
 */
export function tuneVocal(chs, sr, { key = null, strength = 1, speedMs = 40, curveStepSec = 0.02 } = {}) {
  const track = trackPitch(chs, sr);
  const voiced = track.f0.reduce((a, f) => a + (f ? 1 : 0), 0);
  const active = track.level.reduce((a, l) => a + (l >= track.gate ? 1 : 0), 0);
  const detected = detectKey(track);
  const k = key || { root: detected.root, scale: detected.scale };
  const skip = (reason) => ({ chs, report: { applied: false, reason, key: k, keyName: `${NOTE_NAMES[k.root]} ${k.scale}`, detected: { name: detected.name, r: detected.r } } });
  if (voiced < 20) return skip('too little pitched singing was found');
  // A full mix, chords or a heavily layered stack is not one voice; leave it alone.
  if (voiced < 0.35 * active) return skip(`only ${Math.round((100 * voiced) / active)}% of the audible part has a single clear pitch (not a solo voice)`);
  const curve = correctionCurve(track, { root: k.root, scale: k.scale, strength, speedMs });
  const ps = psola(chs, sr, track, curve);
  const after = trackPitch(ps.chs, sr);
  const beforeCents = deviationCents(track, k.root, k.scale), afterCents = deviationCents(after, k.root, k.scale);
  if (afterCents > beforeCents - 0.5) return skip(`measured pitch did not move closer to ${NOTE_NAMES[k.root]} ${k.scale} (${beforeCents.toFixed(0)} → ${afterCents.toFixed(0)} cents), so the original was kept`);
  const step = Math.max(1, Math.round(curveStepSec / track.hopSec));
  const dec = (arr, len) => { const o = new Float32Array(Math.ceil(len / step)); for (let t = 0, j = 0; t < len; t += step, j++) o[j] = arr[t] || -1; return o; };
  const afterMidi = new Float64Array(after.frames);
  for (let t = 0; t < after.frames; t++) afterMidi[t] = after.f0[t] ? toMidi(after.f0[t]) : 0;
  let maxShift = 0;
  for (const v of curve.delta) if (Math.abs(v) > maxShift) maxShift = Math.abs(v);
  return {
    chs: ps.chs,
    report: {
      applied: true, key: k, keyName: `${NOTE_NAMES[k.root]} ${k.scale}`, detected: { name: detected.name, r: detected.r },
      strength, speedMs, voicedPct: (100 * voiced) / track.frames, notes: curve.notes, maxShiftCents: maxShift * 100, shiftedPct: ps.shiftedPct,
      beforeCents, afterCents,
      curve: { stepSec: step * track.hopSec, before: dec(curve.midi, track.frames), target: dec(curve.target, track.frames), after: dec(afterMidi, after.frames) },
    },
  };
}
