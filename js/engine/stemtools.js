// Measurements that steer per-stem and per-bus EQ: how high a high-pass can
// go before it takes anything useful away, and narrow peaks (boxy, nasal,
// harsh) that stand out of a sound's own spectral trend.

import { ltas, bandCenters, bandLevels } from './spectral.js';

/**
 * Highest high-pass frequency that removes almost nothing (the energy below it
 * is under 0.3% of the stem's energy above 20 Hz), between `min` and `max`.
 * The search mirrors raising a high-pass until the sound starts to thin.
 */
export function lowCutFreq(chs, sr, { min = 30, max = 120 } = {}) {
  const spec = ltas(chs, sr);
  if (!spec.frames) return min;
  const binHz = sr / spec.N;
  let total = 0;
  for (let k = Math.ceil(20 / binHz); k < spec.power.length; k++) total += spec.power[k];
  if (total <= 0) return min;
  let acc = 0, f = min;
  for (let k = Math.ceil(20 / binHz); k < spec.power.length; k++) {
    acc += spec.power[k];
    if (acc / total > 0.003) { f = k * binHz; break; }
  }
  // Stay a little under the point where content starts.
  return Math.round(Math.max(min, Math.min(max, f * 0.75)));
}

/**
 * Peaks that stand out of the sound's own trend within each range. Returns
 * narrow cuts ({ freq, gainDb, q, range }) for peaks more than `minDb` above
 * the trend, sized at most `maxCut` dB.
 */
export function resonantCuts(chs, sr, ranges, { minDb = 3, maxCut = 3, q = 3, trendBands = 12 } = {}) {
  const spec = ltas(chs, sr);
  if (!spec.frames) return [];
  const centers = bandCenters(12, 60, Math.min(16000, sr * 0.45));
  const lv = bandLevels(spec, centers, 12);
  // Trend: average over `trendBands` twelfth-octave bands either side (an
  // octave by default; narrower windows only flag narrow peaks, not broad humps
  // such as a voice's formants).
  const trend = lv.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - trendBands); j <= Math.min(lv.length - 1, i + trendBands); j++) { s += lv[j]; c++; }
    return s / c;
  });
  const cuts = [];
  for (const [lo, hi, name] of ranges) {
    let best = -1, bestRes = -Infinity;
    centers.forEach((f, i) => { if (f >= lo && f <= hi && lv[i] - trend[i] > bestRes) { bestRes = lv[i] - trend[i]; best = i; } });
    if (best >= 0 && bestRes > minDb) {
      cuts.push({ freq: Math.round(centers[best]), gainDb: -Math.min(maxCut, (bestRes - minDb / 2) * 0.8), q, range: name, prominenceDb: bestRes });
    }
  }
  return cuts;
}
