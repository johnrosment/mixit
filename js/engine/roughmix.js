// Your own rough mix as the balance and tone reference for a stem mix. The
// unprocessed buses are fitted so that, frame by frame and in three bands,
// they add up to the rough mix's energy (non-negative least squares on the bus
// powers), after lining the two up in time. That gives each bus's loudness in
// your rough mix, which the processed buses are then set to. The rough mix's
// long-term spectrum is kept for a gentle tonal match on the mix bus.

import { lr4Split3 } from './filters.js';
import { ltas } from './spectral.js';
import { integratedLufs, hopEnergies, integratedFromHops } from './loudness.js';

const HOP = 0.01;   // seconds per envelope hop
const FRAME = 40;   // hops per fitting frame (0.4 s)
const SPLITS = [200, 2500];

/** Energy per 10 ms hop in three bands (L+R), plus the broadband sum. */
function bandEnergies(chs, sr) {
  const n = chs[0].length;
  const h = Math.max(1, Math.round(HOP * sr));
  const H = Math.ceil(n / h);
  const bands = [new Float64Array(H), new Float64Array(H), new Float64Array(H)];
  for (const ch of chs) {
    const split = lr4Split3(ch, SPLITS[0], SPLITS[1], sr);
    split.forEach((x, b) => { const e = bands[b]; for (let i = 0; i < n; i++) e[(i / h) | 0] += x[i] * x[i]; });
  }
  const total = new Float64Array(H);
  for (let j = 0; j < H; j++) total[j] = bands[0][j] + bands[1][j] + bands[2][j];
  return { bands, total, hops: H };
}

/**
 * Unprocessed level features of one stem (10 ms band energies and 100 ms
 * K-weighted energies). Added up per bus; within a bus the stems are treated
 * as uncorrelated, and the fit and the loudness use the same sums, so the
 * error largely cancels.
 */
export function stemFeatures(chs, sr) {
  return { ...bandEnergies(chs, sr), k: hopEnergies(chs, sr) };
}

export function addFeatures(acc, f) {
  if (!acc) return { bands: f.bands.map((b) => Float64Array.from(b)), total: Float64Array.from(f.total), hops: f.hops, k: { ...f.k, energy: Float64Array.from(f.k.energy) } };
  acc.bands.forEach((b, i) => { for (let j = 0; j < b.length; j++) b[j] += f.bands[i][j]; });
  for (let j = 0; j < acc.total.length; j++) acc.total[j] += f.total[j];
  for (let j = 0; j < acc.k.energy.length; j++) acc.k.energy[j] += f.k.energy[j];
  return acc;
}

export function roughFeatures(chs, sr) {
  const st = chs.length > 1 ? chs.slice(0, 2) : [chs[0], chs[0]];
  return { ...bandEnergies(st, sr), spec: ltas(st, sr), lufs: integratedLufs(st, sr), sr, seconds: st[0].length / sr };
}

/**
 * Offset of `b` against `a` in hops (positive: b starts later), from the
 * normalised correlation of their log envelopes within ±maxSec.
 */
export function findLag(a, b, maxSec = 4) {
  const toDb = (x) => Float64Array.from(x, (v) => 10 * Math.log10(v + 1e-10));
  const da = toDb(a), db = toDb(b);
  const mean = (x) => x.reduce((p, c) => p + c, 0) / x.length;
  const ma = mean(da), mb = mean(db);
  for (let i = 0; i < da.length; i++) da[i] -= ma;
  for (let i = 0; i < db.length; i++) db[i] -= mb;
  const L = Math.round(maxSec / HOP);
  let best = 0, bestR = -Infinity;
  for (let lag = -L; lag <= L; lag++) {
    let s = 0, ea = 0, eb = 0;
    for (let i = Math.max(0, -lag); i < da.length && i + lag < db.length; i++) {
      const x = da[i], y = db[i + lag];
      s += x * y; ea += x * x; eb += y * y;
    }
    const r = ea && eb ? s / Math.sqrt(ea * eb) : 0;
    if (r > bestR) { bestR = r; best = lag; }
  }
  return { lagHops: best, lagSec: best * HOP, r: bestR };
}

// Non-negative least squares on a small normal-equation system (Lawson-Hanson).
function nnls(A, b) {
  const m = b.length;
  const x = new Float64Array(m);
  const passive = new Set();
  const solve = (idx) => {
    // Gaussian elimination on the passive sub-system.
    const k = idx.length;
    const M = idx.map((i) => [...idx.map((j) => A[i][j]), b[i]]);
    for (let c = 0; c < k; c++) {
      let p = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-300) return null;
      for (let r = 0; r < k; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
      }
    }
    return M.map((row, r) => row[k] / row[r]);
  };
  for (let iter = 0; iter < 30; iter++) {
    const w = b.map((bi, i) => bi - A[i].reduce((s, a, j) => s + a * x[j], 0));
    let jMax = -1, wMax = 1e-12 * Math.max(...b.map(Math.abs));
    for (let j = 0; j < m; j++) if (!passive.has(j) && w[j] > wMax) { wMax = w[j]; jMax = j; }
    if (jMax < 0) break;
    passive.add(jMax);
    for (let inner = 0; inner < 30; inner++) {
      const idx = [...passive];
      const z = solve(idx);
      if (!z) { passive.delete(jMax); break; }
      if (z.every((v) => v > 0)) { idx.forEach((i, k) => { x[i] = z[k]; }); break; }
      let alpha = 1;
      idx.forEach((i, k) => { if (z[k] <= 0) alpha = Math.min(alpha, x[i] / (x[i] - z[k])); });
      idx.forEach((i, k) => { x[i] += alpha * (z[k] - x[i]); if (x[i] <= 1e-15) { x[i] = 0; passive.delete(i); } });
    }
  }
  return x;
}

/**
 * Each bus's loudness in your rough mix. `buses` maps key → summed
 * stemFeatures of the unprocessed stems; their total lines up the rough mix
 * in time. Returns null when nothing usable was found.
 */
export function fitBalance(buses, rough) {
  const keys = Object.keys(buses);
  if (!keys.length) return null;
  const feats = keys.map((k) => buses[k]);
  const total = new Float64Array(feats[0].hops);
  for (const f of feats) for (let j = 0; j < total.length; j++) total[j] += f.total[j];
  const lag = findLag(total, rough.total);
  const H = feats[0].hops;
  // Frame energies (0.4 s), with the rough mix shifted by the measured lag.
  const rows = [];
  for (let f = 0; f * FRAME < H; f++) {
    for (let b = 0; b < 3; b++) {
      let r = 0;
      const e = new Float64Array(keys.length);
      for (let j = f * FRAME; j < Math.min(H, (f + 1) * FRAME); j++) {
        const jr = j + lag.lagHops;
        if (jr < 0 || jr >= rough.hops) continue;
        r += rough.bands[b][jr];
        feats.forEach((ft, k) => { e[k] += ft.bands[b][j]; });
      }
      rows.push({ r, e, b });
    }
  }
  const peak = Math.max(...rows.map((x) => x.r));
  const use = rows.filter((x) => x.r > peak * 1e-5 && x.e.some((v) => v > 0));
  if (use.length < 12) return null;
  // Model: rough = tone[band] × Σ gain[bus] × bus energy. The per-band tone
  // factor soaks up EQ on your rough mix's master bus (and the chain's own
  // tonal changes), so they are not mistaken for level differences. The mid
  // band is the fixed reference. Solved by alternating least squares, with the
  // error relative to each row so quiet passages and the highs count as much as loud lows.
  const m = keys.length;
  const tone = [1, 1, 1];
  let x = new Float64Array(m);
  for (let it = 0; it < 12; it++) {
    const A = Array.from({ length: m }, () => new Float64Array(m));
    const y = new Float64Array(m);
    for (const { r, e, b } of use) {
      const w = (tone[b] * tone[b]) / (r * r);
      for (let i = 0; i < m; i++) {
        y[i] += (w / tone[b]) * e[i] * r;
        for (let j = 0; j < m; j++) A[i][j] += w * e[i] * e[j];
      }
    }
    x = nnls(A.map((row) => Array.from(row)), Array.from(y));
    for (const b of [0, 2]) {
      let num = 0, den = 0;
      for (const row of use) {
        if (row.b !== b) continue;
        const q = row.e.reduce((s, v, i) => s + v * x[i], 0) / row.r;
        num += q; den += q * q;
      }
      if (den > 0) tone[b] = Math.max(0.1, Math.min(10, num / den));
    }
  }
  // Fit quality: median absolute level error over the rows, in dB.
  const errs = use.map(({ r, e, b }) => {
    const p = tone[b] * e.reduce((s, v, i) => s + v * x[i], 0);
    return Math.abs(10 * Math.log10((p + 1e-20) / r));
  }).sort((a, b) => a - b);
  const errDb = errs[Math.floor(errs.length / 2)];
  const gainsDb = Object.fromEntries(keys.map((k, i) => [k, x[i] > 0 ? 10 * Math.log10(x[i]) : -Infinity]));
  const toneDb = tone.map((t) => 10 * Math.log10(t));
  const lufs = Object.fromEntries(keys.map((k, i) => [k, x[i] > 0 ? integratedFromHops({ energy: buses[k].k.energy.map((e) => e * x[i]), hop: buses[k].k.hop }) : -Infinity]));
  return { gainsDb, lufs, toneDb, errDb, lagSec: lag.lagSec, lagR: lag.r, rows: use.length };
}
