// Your own rough mix as the balance and tone reference for a stem mix. The
// unprocessed buses are fitted so that, frame by frame and in three bands,
// they add up to the rough mix's energy (non-negative least squares on the bus
// powers), after lining the two up in time. That gives each bus's loudness in
// your rough mix, which the processed buses are then set to. The rough mix's
// long-term spectrum is kept for a gentle tonal match on the mix bus.
//
// With two or more stems, each stem's own level is read from the waveforms
// first (see fitStemLevels). That also sets the buses, and the energy fit stays
// as the check on whether the file belongs to these stems at all.

import { fft, nextPow2 } from './fft.js';
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

// Gaussian elimination on rows of [...coefficients, right-hand side].
function gauss(M) {
  const k = M.length;
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
}

// Non-negative least squares on a small normal-equation system (Lawson-Hanson).
function nnls(A, b) {
  const m = b.length;
  const x = new Float64Array(m);
  const passive = new Set();
  const solve = (idx) => gauss(idx.map((i) => [...idx.map((j) => A[i][j]), b[i]]));
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
 * in time. Returns null when nothing usable was found. `read` is the result of
 * the stem fit: when there is one, it decides the levels and the start point.
 */
export function fitBalance(buses, rough, read = null) {
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
  const peak = rows.reduce((m, x) => Math.max(m, x.r), 0);
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
  const power = (k, i) => (read ? Math.pow(10, read.busDb[k] / 10) : x[i]);
  const lufs = Object.fromEntries(keys.map((k, i) => [k, power(k, i) > 0 ? integratedFromHops({ energy: buses[k].k.energy.map((e) => e * power(k, i)), hop: buses[k].k.hop }) : -Infinity]));
  return { gainsDb, lufs, toneDb, errDb, lagSec: read ? read.offsetSec : lag.lagSec, lagR: lag.r, rows: use.length };
}

// --- Each stem's level, read from the waveforms ---
// Stems bounced from one session are still inside your rough mix, sample for
// sample, so their levels can be read directly. Parts of the song you did not
// add, and its reverb, line up with no stem and are ignored. Levels are read
// band by band and ignoring phase, as a master's EQ and high-pass turn the low
// end far enough round to cancel out a plain comparison.

const WAVE_RATE = 12000;       // rate of the light copies used for the fit
const WAVE_BYTES = 4e8;        // the most memory those copies may take
const WAVE_FRAME = 2048;
const WAVE_EDGES = [40, 100, 200, 400, 800, 1600, 3200, 5500];
const OFFSET_SPAN = 2 ** 20;   // samples compared to line the two up (about 87 s)
const MIN_OFFSET_PEAK = 50;    // below this they do not line up sample for sample
const FIT_LOAD = 20000;        // stems² × seconds fitted frame by frame; more is thinned out

/** How far to thin the light copies, so a big session stays within memory. */
export const waveStep = (sr, samples, stems) => Math.max(1, Math.round(sr / WAVE_RATE), Math.ceil((8 * samples * stems) / WAVE_BYTES));

/** Light stereo copy by plain averaging. Stems and rough mix get the same treatment, so the sum still holds. */
export function waveCopy(chs, step, samples) {
  const st = chs.length > 1 ? chs.slice(0, 2) : [chs[0], chs[0]];
  return st.map((x) => {
    const o = new Float32Array(Math.floor(samples / step));
    const end = Math.min(o.length, Math.floor(x.length / step));
    for (let i = 0; i < end; i++) {
      let s = 0;
      for (let j = 0; j < step; j++) s += x[i * step + j];
      o[i] = s / step;
    }
    return o;
  });
}

/**
 * Offset of the rough mix against the stems in samples, from the part of the
 * song around its middle. Only the timing counts here (each bin is weighed the
 * same), so the result is not pulled around by the low end's phase. `peak` says
 * how far the best match stands out: a different file has no clear one.
 */
function waveOffset(stems, rough, rate, maxSec = 4) {
  const n = rough[0].length, span = Math.min(n, OFFSET_SPAN);
  const from = Math.floor((n - span) / 2);
  const N = nextPow2(2 * span);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (const s of stems) for (const c of s) for (let i = 0; i < span; i++) ar[i] += c[from + i] || 0;
  for (const c of rough) for (let i = 0; i < span; i++) br[i] += c[from + i];
  fft(ar, ai);
  fft(br, bi);
  const lo = Math.floor((150 * N) / rate);
  for (let k = 0; k < N; k++) {
    const re = ar[k] * br[k] + ai[k] * bi[k], im = ar[k] * bi[k] - ai[k] * br[k];
    const m = Math.hypot(re, im) + 1e-30, use = Math.min(k, N - k) >= lo;
    ar[k] = use ? re / m : 0;
    ai[k] = use ? im / m : 0;
  }
  fft(ar, ai, true);
  const L = Math.round(maxSec * rate);
  let best = 0, lag = 0, sum = 0, count = 0;
  for (let k = 0; k < N; k++) {
    const at = k < N / 2 ? k : k - N;
    if (Math.abs(at) > L) continue;
    const v = Math.abs(ar[k]);
    sum += v;
    count++;
    if (v > best) { best = v; lag = at; }
  }
  return { lag, peak: count && sum > 0 ? best / (sum / count) : 0 };
}

/**
 * Each stem's level in your rough mix, from the light copies. Per band and
 * channel, the complex gains that best rebuild the rough mix; their sizes are
 * then split into one level per stem and one tone offset per band, so EQ on the
 * master is not taken for a change of balance. Returns null when the two do not
 * line up. `db` holds one level per stem, null for a silent one; `share` is how
 * much of the rough mix's sound the stems account for.
 */
export function fitStemLevels(stems, rough, rate) {
  const m = stems.length;
  const { lag, peak } = waveOffset(stems, rough, rate);
  if (peak < MIN_OFFSET_PEAK) return null;
  const F = WAVE_FRAME;
  const hann = Float64Array.from({ length: F }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / F));
  const bin = (f) => Math.round((f * F) / rate);
  const bands = WAVE_EDGES.slice(0, -1).map((f, b) => [bin(f), Math.min(F / 2, bin(WAVE_EDGES[b + 1]))]).filter(([a, z]) => z > a);
  const B = bands.length;
  const zero = () => ({ Gr: Array.from({ length: m }, () => new Float64Array(m)), Gi: Array.from({ length: m }, () => new Float64Array(m)), rr: new Float64Array(m), ri: new Float64Array(m), energy: 0 });
  const acc = [0, 1].map(() => Array.from({ length: B }, zero));
  const Sr = stems.map(() => new Float64Array(F)), Si = stems.map(() => new Float64Array(F));
  const Rr = new Float64Array(F), Ri = new Float64Array(F);
  const start = Math.max(0, -lag), usable = Math.min(stems[0][0].length, rough[0].length - lag) - start;
  const hop = F * Math.max(1, Math.ceil((m * m * (usable / rate)) / FIT_LOAD));
  for (let t = start; t + F <= start + usable; t += hop) {
    for (let c = 0; c < 2; c++) {
      for (let j = 0; j < F; j++) { Rr[j] = rough[c][t + lag + j] * hann[j]; Ri[j] = 0; }
      fft(Rr, Ri);
      const live = [];
      for (let s = 0; s < m; s++) {
        const x = stems[s][c];
        let energy = 0;
        for (let j = 0; j < F; j++) { const v = x[t + j] * hann[j]; Sr[s][j] = v; Si[s][j] = 0; energy += v * v; }
        if (energy > 1e-14) { fft(Sr[s], Si[s]); live.push(s); }
      }
      bands.forEach(([k0, k1], b) => {
        const A = acc[c][b];
        for (let k = k0; k < k1; k++) A.energy += Rr[k] * Rr[k] + Ri[k] * Ri[k];
        live.forEach((i, li) => {
          const ar = Sr[i], ai = Si[i];
          let rr = 0, ri = 0;
          for (let k = k0; k < k1; k++) { rr += ar[k] * Rr[k] + ai[k] * Ri[k]; ri += ar[k] * Ri[k] - ai[k] * Rr[k]; }
          A.rr[i] += rr;
          A.ri[i] += ri;
          for (let lj = li; lj < live.length; lj++) {
            const j = live[lj], br = Sr[j], bi = Si[j];
            let gr = 0, gi = 0;
            for (let k = k0; k < k1; k++) { gr += ar[k] * br[k] + ai[k] * bi[k]; gi += ar[k] * bi[k] - ai[k] * br[k]; }
            A.Gr[i][j] += gr;
            A.Gi[i][j] += gi;
            if (i !== j) { A.Gr[j][i] += gr; A.Gi[j][i] -= gi; }
          }
        });
      });
    }
  }
  // Energy each stem puts into each band of the rough mix, and its own energy there.
  const put = stems.map(() => new Float64Array(B)), own = stems.map(() => new Float64Array(B));
  let found = 0, total = 0;
  for (const perBand of acc) {
    perBand.forEach((A, b) => {
      // Real form of the complex system; a little loading keeps silent or identical stems solvable.
      const M = [];
      for (let i = 0; i < m; i++) {
        const load = 1e-6 * A.Gr[i][i] + 1e-12;
        M.push([...A.Gr[i].map((v, j) => v + (i === j ? load : 0)), ...A.Gi[i].map((v) => -v), A.rr[i]]);
      }
      for (let i = 0; i < m; i++) {
        const load = 1e-6 * A.Gr[i][i] + 1e-12;
        M.push([...A.Gi[i], ...A.Gr[i].map((v, j) => v + (i === j ? load : 0)), A.ri[i]]);
      }
      const g = gauss(M) || new Array(2 * m).fill(0);
      total += A.energy;
      for (let i = 0; i < m; i++) {
        const re = g[i], im = g[m + i];
        put[i][b] += (re * re + im * im) * A.Gr[i][i];
        own[i][b] += A.Gr[i][i];
        found += Math.max(0, re * A.rr[i] + im * A.ri[i]);
      }
    });
  }
  // log(power gain) = stem level + tone of the band, weighted by the energy behind each reading.
  const dB = (v) => 10 * Math.log10(v + 1e-20);
  const seen = put.map((row, i) => Array.from(row, (v, b) => (own[i][b] > 0 ? dB(v / own[i][b]) : 0)));
  const allPut = put.reduce((a, row) => a + row.reduce((p, v) => p + v, 0), 0);
  const level = new Float64Array(m), tone = new Float64Array(B);
  for (let it = 0; it < 30; it++) {
    for (let i = 0; i < m; i++) {
      let num = 0, den = 0;
      for (let b = 0; b < B; b++) { num += put[i][b] * (seen[i][b] - tone[b]); den += put[i][b]; }
      level[i] = den > 0 ? num / den : 0;
    }
    for (let b = 0; b < B; b++) {
      let num = 0, den = (0.05 * allPut) / B + 1e-30;
      for (let i = 0; i < m; i++) { num += put[i][b] * (seen[i][b] - level[i]); den += put[i][b]; }
      tone[b] = num / den;
    }
  }
  const db = Array.from(level, (v, i) => (put[i].some((p) => p > 0) ? v : null));
  return { db, toneDb: Array.from(tone), share: total > 0 ? found / total : 0, offsetSec: lag / rate, peak };
}
