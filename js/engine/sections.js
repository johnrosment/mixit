// Song sections for mix automation: a self-similarity novelty curve over
// loudness and timbre (four band levels) finds boundaries; each section is
// labelled from its loudness relative to the song (the labels are guesses).
// Per-section moves become smooth per-bus gain curves.

import { hopEnergies } from './loudness.js';
import { lr4Split3 } from './filters.js';

const BLOCK = 0.5; // seconds per feature block

const toDb = (e) => (e > 1e-12 ? 10 * Math.log10(e) : -120);

function features(chs, sr) {
  const n = chs[0].length;
  const B = Math.max(1, Math.round(BLOCK * sr));
  const nb = Math.ceil(n / B);
  const bands = [new Float64Array(nb), new Float64Array(nb), new Float64Array(nb), new Float64Array(nb)];
  for (const ch of chs) {
    const [lo, mid, hi] = lr4Split3(ch, 150, 5000, sr);
    // Split the mid band once more at 1 kHz with a simple complementary one-pole pair.
    const a = Math.exp((-2 * Math.PI * 1000) / sr);
    let s = 0;
    for (let i = 0; i < n; i++) {
      s = a * s + (1 - a) * mid[i];
      const b = (i / B) | 0;
      bands[0][b] += lo[i] * lo[i];
      bands[1][b] += s * s;
      bands[2][b] += (mid[i] - s) * (mid[i] - s);
      bands[3][b] += hi[i] * hi[i];
    }
  }
  const { energy, hop } = hopEnergies(chs, sr);
  const per = Math.round(BLOCK / 0.1);
  const loud = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let e = 0, c = 0;
    for (let h = b * per; h < Math.min(energy.length, (b + 1) * per); h++) { e += energy[h]; c++; }
    loud[b] = c ? -0.691 + toDb(e / (c * hop)) : -120;
  }
  // Feature: loudness, then each band relative to the block total (timbre).
  return Array.from({ length: nb }, (_, b) => {
    const tot = bands.reduce((p, x) => p + x[b], 0);
    return [Math.max(-60, loud[b]), ...bands.map((x) => Math.max(-40, toDb(x[b]) - toDb(tot)))];
  });
}

/**
 * Sections with boundaries at novelty peaks (checkerboard kernel over a
 * self-similarity matrix, ~4 s each side), at least `minSec` apart.
 */
export function detectSections(chs, sr, { minSec = 8, minNovelty = 1.5 } = {}) {
  const f = features(chs, sr);
  const nb = f.length;
  const dur = (nb * BLOCK);
  const whole = [{ start: 0, end: chs[0].length / sr, label: 'Whole song', rel: 0, lufs: 0 }];
  if (dur < 2 * minSec) return whole;
  // Fixed scales (3 dB = one unit), so a steady song does not get its small
  // fluctuations stretched into fake sections.
  const D = f[0].length;
  const z = f.map((v) => v.map((x) => x / 3));
  const dist = (i, j) => { let s = 0; for (let d = 0; d < D; d++) s += (z[i][d] - z[j][d]) ** 2; return Math.sqrt(s); };
  const K = 8;
  const nov = new Float64Array(nb);
  for (let c = K; c < nb - K; c++) {
    let cross = 0, within = 0, wc = 0, ww = 0;
    for (let a = -K; a < K; a++) {
      for (let b = -K; b < K; b++) {
        if (a === b) continue;
        const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (K / 2) ** 2));
        const d = dist(c + a, c + b);
        if ((a < 0) !== (b < 0)) { cross += g * d; wc += g; } else { within += g * d; ww += g; }
      }
    }
    nov[c] = cross / wc - within / ww;
  }
  const vals = Array.from(nov).filter((v, i) => i >= K && i < nb - K);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const minGap = Math.round(minSec / BLOCK);
  const cand = [];
  for (let c = K; c < nb - K; c++) if (nov[c] > Math.max(minNovelty, mean + 0.3 * std) && nov[c] >= nov[c - 1] && nov[c] >= nov[c + 1]) cand.push(c);
  cand.sort((a, b) => nov[b] - nov[a]);
  const chosen = [];
  for (const c of cand) if (c >= minGap && nb - c >= minGap && chosen.every((x) => Math.abs(x - c) >= minGap)) chosen.push(c);
  chosen.sort((a, b) => a - b);
  const edges = [0, ...chosen, nb];
  // Section loudness (energy average of block loudness above -60).
  const secs = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    let e = 0, c = 0;
    for (let b = edges[i]; b < edges[i + 1]; b++) if (f[b][0] > -60) { e += Math.pow(10, f[b][0] / 10); c++; }
    secs.push({ start: edges[i] * BLOCK, end: Math.min(edges[i + 1] * BLOCK, chs[0].length / sr), lufs: c ? 10 * Math.log10(e / c) : -60 });
  }
  if (secs.length < 2) return whole;
  // Labels from loudness against the loudest section (6 s or longer).
  const top = Math.max(...secs.filter((s) => s.end - s.start >= 6).map((s) => s.lufs));
  const songE = secs.reduce((a, s) => a + Math.pow(10, s.lufs / 10) * (s.end - s.start), 0) / secs.reduce((a, s) => a + (s.end - s.start), 0);
  const song = 10 * Math.log10(songE);
  secs.forEach((s, i) => {
    s.rel = s.lufs - song;
    const d = s.lufs - top;
    const edge = i === 0 ? 'Intro' : i === secs.length - 1 ? 'Outro' : null;
    s.label = d >= -2.5 ? 'Hook / drop' : edge && d < -3 ? edge : d <= -10 ? 'Break' : 'Verse';
    s.novelty = i > 0 ? nov[edges[i]] : 0;
  });
  return secs;
}

// Automatic moves per label, scaled by the amount (dB per bus, music width
// factor, vocal send factor, and low/high shelves in dB on the music and FX:
// verses carry a little less low and high end, choruses are full range).
const AUTO = {
  'Hook / drop': { vocals: 0.5, drums: 0.75, bass: 0.25, music: 1, fx: 0.5, width: 0.15, send: 0.2, lows: 0, highs: 0 },
  Verse: { vocals: 0, drums: 0, bass: 0, music: -0.75, fx: -0.5, width: -0.1, send: -0.3, lows: -1, highs: -1 },
  Break: { vocals: 0, drums: -0.5, bass: 0, music: 0.5, fx: 0.5, width: 0.1, send: 0.2, lows: -1.5, highs: 0 },
  Intro: { vocals: 0, drums: 0, bass: 0, music: 0, fx: 0, width: 0, send: 0, lows: 0, highs: 0 },
  Outro: { vocals: 0, drums: 0, bass: 0, music: 0, fx: 0, width: 0, send: 0, lows: 0, highs: 0 },
  'Whole song': { vocals: 0, drums: 0, bass: 0, music: 0, fx: 0, width: 0, send: 0, lows: 0, highs: 0 },
};

/**
 * Moves per section: automatic ones (by label, times `amount`) are made
 * zero-mean over the song, so they only add contrast between sections and do
 * not change the overall balance; edits in `offsets` (dB per bus) are added as given.
 */
export function sectionMoves(sections, amount) {
  const keys = ['vocals', 'drums', 'bass', 'music', 'fx', 'width', 'send', 'lows', 'highs'];
  const total = sections.reduce((p, s) => p + (s.end - s.start), 0) || 1;
  const mean = Object.fromEntries(keys.map((k) => [k, sections.reduce((p, s) => p + (AUTO[s.label] || AUTO.Verse)[k] * (s.end - s.start), 0) / total]));
  return sections.map((s) => {
    const a = AUTO[s.label] || AUTO.Verse;
    const o = s.offsets || {};
    const auto = (k) => (a[k] - mean[k]) * amount;
    const db = (k) => auto(k) + (o[k] || 0);
    return { ...s, gains: { vocals: db('vocals'), drums: db('drums'), bass: db('bass'), music: db('music'), fx: db('fx') }, width: Math.max(0.5, 1 + auto('width')), send: Math.max(0, 1 + auto('send')), lows: auto('lows'), highs: auto('highs') };
  });
}

/**
 * Per-sample curve from per-section values with raised-cosine ramps of
 * `rampSec` centred a little before each boundary (moves land on the downbeat).
 */
export function sectionCurve(moves, pick, n, sr, { rampSec = 0.6, leadSec = 0.15 } = {}) {
  const out = new Float32Array(n);
  const R = Math.max(1, Math.round(rampSec * sr));
  let cur = pick(moves[0]);
  let idx = 0;
  const edges = moves.slice(1).map((m) => Math.round((m.start - leadSec) * sr));
  for (let i = 0; i < n; i++) {
    while (idx < edges.length && i >= edges[idx] + R / 2) { cur = pick(moves[idx + 1]); idx++; }
    if (idx < edges.length && i >= edges[idx] - R / 2) {
      const t = (i - (edges[idx] - R / 2)) / R;
      const w = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
      out[i] = cur * (1 - w) + pick(moves[idx + 1]) * w;
    } else out[i] = cur;
  }
  return out;
}
