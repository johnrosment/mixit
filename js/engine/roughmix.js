// Your own rough mix as the balance and tone reference for a stem mix. The
// unprocessed buses are fitted so that, frame by frame and in three bands,
// they add up to the rough mix's energy (non-negative least squares on the bus
// powers), after lining the two up in time. That gives each bus's loudness in
// your rough mix, which the processed buses are then set to. The rough mix's
// long-term spectrum is kept for a gentle tonal match on the mix bus.
//
// With two or more stems, each stem's own level is read first (see
// readStemLevels). That also sets the buses, and the energy fit stays as the
// check on whether the file belongs to these stems at all.

import { fft, nextPow2 } from './fft.js';
import { lr4Split3 } from './filters.js';
import { ltas } from './spectral.js';
import { integratedLufs, hopEnergies, integratedFromHops } from './loudness.js';

const ROUGH_MAX_ERR_DB = 4; // a rough mix further from the stems than this is the wrong file
/** Whether a rough mix belongs to these stems. Stems found in it settle that, however much it was processed. */
export const roughBelongs = (fit, stemsRead) => !!fit && (!!stemsRead || fit.errDb <= ROUGH_MAX_ERR_DB);

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
  return { ...bandEnergies(st, sr), k: hopEnergies(st, sr), spec: ltas(st, sr), lufs: integratedLufs(st, sr), sr, seconds: st[0].length / sr };
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
  const lag = read ? { lagHops: Math.round(read.offsetSec / HOP), r: null } : findLag(total, rough.total);
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
const OFFSET_SPAN = 2 ** 20;   // samples of the stems compared to line the two up (about 87 s)
const OFFSET_REACH = 2 ** 20;  // how far the rough mix is searched either way, as a finished song can start well before its stems
const MIN_OFFSET_PEAK = 50;    // below this they do not line up sample for sample
const OFFSET_TRIES = 16;       // best matches checked over the whole song
const OFFSET_APART = 0.02;     // seconds that keep two matches apart
const OFFSET_SLICE = 8;        // seconds of each piece of that check
const FIT_LOAD = 20000;        // stems² × seconds fitted frame by frame; more is thinned out
const WAVE_STRONG = 0.01;      // a band counts toward a stem's level within 20 dB of its strongest

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

/** Light copy of the rough mix, which may run past the stems as far as the search can reach. */
export const roughCopy = (chs, step, samples) => waveCopy(chs, step, Math.max(samples, Math.min(chs[0].length, samples + 2 * OFFSET_REACH * step)));

/** Mono with the lows thinned out, so a master's high-pass turning them round doesn't matter. */
function thinned(channelSets, length) {
  const o = new Float32Array(length);
  for (const chs of channelSets) for (const c of chs) { let last = 0; for (let i = 0; i < Math.min(length, c.length); i++) { o[i] += c[i] - last; last = c[i]; } }
  return o;
}

/** How well the two agree at this offset, on average over the whole song. Stretches with no stems don't count, ones with no rough mix count as nothing. */
function holdsAcross(stems, rough, lag, W, quiet) {
  let sum = 0, count = 0;
  for (let t = 0; t + W <= stems.length; t += W) {
    let xx = 0, yy = 0, xy = 0;
    for (let i = 0; i < W; i++) {
      const j = t + i + lag, x = stems[t + i], y = j >= 0 && j < rough.length ? rough[j] : 0;
      xx += x * x;
      yy += y * y;
      xy += x * y;
    }
    if (xx <= quiet) continue;
    count++;
    if (yy > 0) sum += Math.max(0, xy / Math.sqrt(xx * yy));
  }
  return count ? sum / count : 0;
}

/**
 * Offset of the rough mix against the stems in samples, from the part of the
 * stems around their middle. Only the timing counts here (each bin is weighed
 * the same), so the result is not pulled around by the low end's phase. A song
 * built from exact loops also matches itself a bar or more away, so the best
 * few matches are checked over the whole song: only the true one holds
 * throughout. `peak` says how far the match stands out: a different file has no
 * clear one.
 */
function waveOffset(stems, rough, rate) {
  const n = stems[0][0].length, span = Math.min(n, OFFSET_SPAN);
  const from = Math.floor((n - span) / 2);
  const at = Math.max(0, from - OFFSET_REACH), reach = Math.max(0, Math.min(rough[0].length, from + span + OFFSET_REACH) - at);
  const N = nextPow2(span + reach);
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (const s of stems) for (const c of s) for (let i = 0; i < span; i++) ar[i] += c[from + i] || 0;
  for (const c of rough) for (let i = 0; i < reach; i++) br[i] += c[at + i];
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
  let sum = 0, top = 0;
  for (let k = 0; k < N; k++) { const v = Math.abs(ar[k]); sum += v; if (v > top) top = v; }
  const mean = sum / N;
  if (!(mean > 0) || top < MIN_OFFSET_PEAK * mean) return { lag: 0, peak: mean > 0 ? top / mean : 0 };
  const peaks = [];
  for (let k = 0; k < N; k++) {
    const v = Math.abs(ar[k]);
    if (v >= MIN_OFFSET_PEAK * mean) peaks.push({ lag: (k < reach ? k : k - N) + at - from, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const apart = Math.round(OFFSET_APART * rate), tries = [];
  for (const p of peaks) {
    if (tries.every((q) => Math.abs(q.lag - p.lag) > apart)) tries.push(p);
    if (tries.length >= OFFSET_TRIES) break;
  }
  let pick = tries[0];
  if (tries.length > 1) {
    const a = thinned(stems, n), b = thinned([rough], rough[0].length), W = Math.min(n, Math.round(OFFSET_SLICE * rate));
    const quiet = (1e-4 * W * a.reduce((e, v) => e + v * v, 0)) / n;
    let most = -1;
    for (const p of tries) { const h = holdsAcross(a, b, p.lag, W, quiet); if (h > most) { most = h; pick = p; } }
  }
  return { lag: pick.lag, peak: pick.v / mean };
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
  // Energy a stem puts into a band = its own energy there × its level × the band's tone. Only bands near
  // the stem's strongest count: where it has next to nothing, its gain is free to grow and soak up
  // whatever else the song holds (a quiet hi-hat once read 30 dB too high from the lows).
  const dB = (v) => 10 * Math.log10(v + 1e-20);
  const counts = own.map((row) => { const most = Math.max(...row); return Array.from(row, (v) => v > 0 && v >= WAVE_STRONG * most); });
  const allPut = put.reduce((a, row, i) => a + row.reduce((p, v, b) => p + (counts[i][b] ? v : 0), 0), 0);
  const calm = (0.05 * allPut) / B + 1e-30; // a band with little in it stays near no change
  const level = new Float64Array(m).fill(1), tone = new Float64Array(B).fill(1);
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < m; i++) {
      let num = 0, den = 0;
      for (let b = 0; b < B; b++) if (counts[i][b]) { num += put[i][b]; den += own[i][b] * tone[b]; }
      level[i] = den > 0 ? num / den : 0;
    }
    for (let b = 0; b < B; b++) {
      let num = calm, den = calm;
      for (let i = 0; i < m; i++) if (counts[i][b]) { num += put[i][b]; den += own[i][b] * level[i]; }
      tone[b] = num / den;
    }
  }
  const db = Array.from(level, (v, i) => (put[i].some((p) => p > 0) ? dB(v) : null));
  return { db, toneDb: Array.from(tone, dB), share: total > 0 ? found / total : 0, offsetSec: lag / rate, lag, peak };
}

// --- Each stem's level, from how its energy moves over time ---
// The waveforms only count sound that lines up sample for sample. Stems rendered
// on their own from a finished song mostly do not, so read that way they come out
// far too low. Their energy still rises and falls with the song, band by band,
// whatever happened to the phase. The levels here are the ones that make the
// stems' summed energy move most like the song's, with one tone offset per band
// taken out so EQ on the master is not mistaken for balance.

const FRAME_SEC = 0.085, MAP_HOP_SEC = 0.1, MAP_FRAMES = 1200;
/** Third-octave centres of a stem map. */
export const MAP_BANDS = Array.from({ length: 27 }, (_, k) => 40 * Math.pow(2, k / 3));
const MAP_EDGE = Math.pow(2, 1 / 6);
const MB = MAP_BANDS.length;
export const mapHop = (samples, sr) => Math.max(MAP_HOP_SEC, samples / sr / MAP_FRAMES);

/** Energy of one stem per third octave and moment. Flat array: band + frame * bands. */
export function stemMap(chs, sr, hopSec = MAP_HOP_SEC) {
  const N = nextPow2(FRAME_SEC * sr), hop = Math.round(hopSec * sr);
  const frames = Math.max(1, Math.floor((chs[0].length - N) / hop) + 1);
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const edges = MAP_BANDS.map((f) => [Math.round((f / MAP_EDGE) * N / sr), Math.min(N / 2, Math.round((f * MAP_EDGE * N) / sr))]);
  const energy = new Float32Array(MB * frames), re = new Float64Array(N), im = new Float64Array(N);
  for (const c of chs) {
    for (let h = 0; h < frames; h++) {
      let any = 0;
      for (let j = 0; j < N; j++) { const v = (c[h * hop + j] || 0) * hann[j]; re[j] = v; im[j] = 0; any += v * v; }
      if (any < 1e-12) continue;
      fft(re, im);
      for (let b = 0; b < MB; b++) {
        let e = 0;
        for (let k = edges[b][0]; k < edges[b][1]; k++) e += re[k] * re[k] + im[k] * im[k];
        energy[b + h * MB] += e;
      }
    }
  }
  return { energy, frames };
}

const READ_LOW = 60, READ_HIGH = 5000; // Hz of the light copies that are read
const READ_MOVE = 60;   // dB a level may go either way: a stem left out of the song sinks this far
const READ_STEPS = [3, 1, 0.25];

function energyLevels(stems, rough, rate, lag) {
  const start = Math.max(0, -lag);
  const usable = Math.min(stems[0][0].length - start, rough[0].length - start - lag);
  const hopSec = mapHop(usable, rate);
  const cut = (chs, from) => chs.map((c) => c.subarray(from, from + usable));
  const maps = stems.map((s) => stemMap(cut(s, start), rate, hopSec));
  const song = stemMap(cut(rough, start + lag), rate, hopSec);
  const F = song.frames, m = stems.length;
  const top = Math.min(READ_HIGH, 0.42 * rate);
  const bands = MAP_BANDS.flatMap((f, b) => (f >= READ_LOW && f <= top ? [b] : []));
  const toDb = (v) => 10 * Math.log10(v);
  const songDb = new Float32Array(bands.length * F).fill(NaN), floors = new Float64Array(bands.length), kept = bands.map(() => 0);
  bands.forEach((b, x) => {
    let mean = 0;
    for (let h = 0; h < F; h++) mean += song.energy[b + h * MB];
    mean /= F;
    floors[x] = mean;
    if (mean <= 0) return;
    for (let h = 0; h < F; h++) {
      const e = song.energy[b + h * MB];
      if (e < 1e-5 * mean) continue;
      songDb[x * F + h] = toDb(e + 1e-3 * mean);
      kept[x]++;
    }
  });
  const live = maps.map((map) => map.energy.some((v) => v > 0));
  const sums = new Float64Array(bands.length * F);
  bands.forEach((b, x) => { for (let h = 0; h < F; h++) for (let i = 0; i < m; i++) if (live[i]) sums[x * F + h] += maps[i].energy[b + h * MB]; });
  // Spread of the difference over time, per band: its mean is that band's tone offset.
  const cost = (i, change) => {
    const E = i >= 0 ? maps[i].energy : null;
    let total = 0, count = 0;
    bands.forEach((b, x) => {
      if (!kept[x]) return;
      let mean = 0;
      for (let h = 0; h < F; h++) mean += sums[x * F + h] + (E ? change * E[b + h * MB] : 0);
      mean /= F;
      if (mean <= 0) return;
      const c = 1e-3 * mean;
      let a = 0, a2 = 0;
      for (let h = 0; h < F; h++) {
        const t = songDb[x * F + h];
        if (t !== t) continue;
        const d = toDb(sums[x * F + h] + (E ? change * E[b + h * MB] : 0) + c) - t;
        a += d;
        a2 += d * d;
      }
      total += a2 - (a * a) / kept[x];
      count += kept[x];
    });
    return count ? total / count : Infinity;
  };
  const db = new Float64Array(m), lin = new Float64Array(m).fill(1);
  let best = cost(-1, 0);
  for (const step of READ_STEPS) {
    for (let round = 0; round < 12; round++) {
      let moved = false;
      for (let i = 0; i < m; i++) {
        if (!live[i]) continue;
        for (const s of [step, -step]) {
          for (;;) {
            const next = db[i] + s;
            if (Math.abs(next) > READ_MOVE) break;
            const change = Math.pow(10, next / 10) - lin[i];
            const c = cost(i, change);
            if (c >= best - 1e-5) break;
            bands.forEach((b, x) => { for (let h = 0; h < F; h++) sums[x * F + h] += change * maps[i].energy[b + h * MB]; });
            lin[i] += change;
            db[i] = next;
            best = c;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }
  return { db: Array.from(db, (v, i) => (live[i] ? v : null)), leftover: Math.sqrt(best) };
}

const READ_EXACT = 0.9;  // the waveforms account for this much of it: they line up, so they are exact
const READ_FITS = 3.8;   // dB left unexplained by the energy fit. All of a song's stems leave up to
                         // 3.6; part of them leave 4.1 or more, as the song holds what is missing.
const READ_CLOSE = 1.5;  // dB between readings the energy can't tell apart, so nothing moves

/**
 * Each stem's level in your rough mix, from the light copies, by whichever
 * reading suits this file. A plain bounce of these stems lines up sample for
 * sample and the waveforms are exact. A finished song's stems do not line up, and
 * the energy is right. When the stems are only part of the song, the energy has
 * no way to account for the rest, and the waveforms ignore what lines up with no
 * stem. Returns null when the two do not line up in time at all.
 */
export function readStemLevels(stems, rough, rate) {
  const wave = fitStemLevels(stems, rough, rate);
  if (!wave) return null;
  if (wave.share >= READ_EXACT) return { ...wave, method: 'waveform' };
  const energy = energyLevels(stems, rough, rate, wave.lag);
  if (energy.leftover > READ_FITS) return { ...wave, method: 'waveform', partial: true };
  const found = energy.db.filter((v) => v != null);
  const close = Math.max(...found) - Math.min(...found) <= READ_CLOSE;
  return { ...wave, db: close ? energy.db.map((v) => (v == null ? null : 0)) : energy.db, share: null, method: 'energy', leftover: energy.leftover };
}

// --- Each stem's level, section by section ---
// A finished song rides its parts: a choir can sit low in one chorus and high in the last, and one level
// for the whole song is then wrong in both. Here each stem is read again in 8 s windows, at fine time and
// pitch resolution, but only in the cells where it plays nearly alone, so nothing else in the song can be
// taken for it. A stem owns a cell only if it would stand out there at an ordinary level: one read loud
// cannot claim cells by being read loud. A part moves only where it sits steadily off its own level.
// Over eight songs and plain bounces of them, no part sat 2 dB off for 20 s when it had not been
// ridden; rides of 3 to 5 dB set into a bounce for 30 s were found to within 0.1 dB.
const SECTION_WIN = 8;       // seconds per window
const SECTION_STEP = 4;      // seconds between windows
const SECTION_OWN = 6;       // dB a stem must stand out by to own a cell
const SECTION_CELLS = 80;    // cells a stem needs in a window to be read there
const SECTION_MIN = 2;       // dB a stem must sit off its own level to move
const SECTION_RUN = 4;       // windows in a row (20 s) it must stay off by that much
const SECTION_MAX = 12;      // dB either way at most
const SECTION_LOW = 100, SECTION_HIGH = 8000; // Hz read
const HIST_STEP = 0.5, HIST_LO = -40, HIST_N = 161;

const middleOf = (list) => { const s = [...list].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
const histMedian = (h) => {
  let total = 0;
  for (let k = 0; k < h.length; k++) total += h[k];
  if (!total) return null;
  for (let k = 0, c = 0; k < h.length; k++) { c += h[k]; if (c >= total / 2) return HIST_LO + k * HIST_STEP; }
  return null;
};

/**
 * How each stem's level in your rough mix changes along the song, from the light copies.
 * `lag`: rough-mix sample = stem sample + lag. `db`: each stem's whole-song level (null if left out).
 * Returns, per stem, null (it keeps one level) or the points of a gain curve in dB and the stretches it moves.
 */
export function sectionLevels(stems, rough, rate, lag, db) {
  const m = stems.length, n = stems[0][0].length;
  const N = nextPow2(0.09 * rate), H = N / 2;
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const k0 = Math.ceil((SECTION_LOW * N) / rate), k1 = Math.min(N / 2, Math.floor((Math.min(SECTION_HIGH, 0.45 * rate) * N) / rate));
  const bandOf = Int16Array.from({ length: k1 }, (_, k) => Math.max(0, Math.floor(3 * Math.log2(Math.max(SECTION_LOW, (k * rate) / N) / SECTION_LOW))));
  const NB = bandOf[k1 - 1] + 1;
  const frames = Math.floor((n - N) / H);
  const per = Math.max(1, Math.round((SECTION_STEP * rate) / H)), slots = Math.ceil(frames / per), span = Math.round(SECTION_WIN / SECTION_STEP);
  if (frames < 1 || slots < span + SECTION_RUN - 1) return { curves: stems.map(() => null) };
  const g = db.map((v) => (v == null ? 0 : Math.pow(10, v / 10)));
  const heard = g.filter((v) => v > 0).sort((a, b) => a - b);
  if (heard.length < 2) return { curves: stems.map(() => null) };
  const ordinary = heard[heard.length >> 1];
  const ownScale = g.map((v) => (v > 0 ? Math.min(1, ordinary / v) : 0));
  const lead = Math.pow(10, SECTION_OWN / 10);
  // Counts per stem, 4 s slot and third octave, of the song's level over the stems' in the cells the stem owns.
  const hist = Array.from({ length: m }, () => Array.from({ length: slots * NB }, () => new Uint16Array(HIST_N)));
  const re = new Float64Array(N), im = new Float64Array(N), R = new Float64Array(k1), T = new Float64Array(k1);
  const P = stems.map(() => new Float64Array(k1));
  const frameEnergy = new Float64Array(frames);
  let top = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < m; i++) if (g[i]) for (let c = 0; c < 2; c++) { const x = stems[i][c]; for (let j = 0; j < N; j += 4) e += g[i] * x[f * H + j] * x[f * H + j]; }
    frameEnergy[f] = e;
    if (e > top) top = e;
  }
  for (let f = 0; f < frames; f++) {
    if (frameEnergy[f] < 1e-5 * top) continue;
    const t = f * H, tr = t + lag;
    if (tr < 0 || tr + N > rough[0].length) continue;
    R.fill(0); T.fill(0);
    for (let c = 0; c < 2; c++) {
      for (let j = 0; j < N; j++) { re[j] = rough[c][tr + j] * hann[j]; im[j] = 0; }
      fft(re, im);
      for (let k = k0; k < k1; k++) R[k] += re[k] * re[k] + im[k] * im[k];
    }
    for (let i = 0; i < m; i++) {
      const p = P[i];
      p.fill(0);
      if (!g[i]) continue;
      for (let c = 0; c < 2; c++) {
        const x = stems[i][c];
        let any = 0;
        for (let j = 0; j < N; j++) { const v = x[t + j] * hann[j]; re[j] = v; im[j] = 0; any += v * v; }
        if (any < 1e-14) continue;
        fft(re, im);
        for (let k = k0; k < k1; k++) p[k] += g[i] * (re[k] * re[k] + im[k] * im[k]);
      }
      for (let k = k0; k < k1; k++) T[k] += p[k];
    }
    let most = 0;
    for (let k = k0; k < k1; k++) if (T[k] > most) most = T[k];
    const slot = Math.min(slots - 1, Math.floor(f / per));
    for (let k = k0; k < k1; k++) {
      if (T[k] < 1e-4 * most || R[k] <= 0) continue;
      for (let i = 0; i < m; i++) {
        const e = P[i][k];
        if (e <= 0 || e * ownScale[i] < lead * (T[k] - e)) continue;
        const bin = Math.max(0, Math.min(HIST_N - 1, Math.round((10 * Math.log10(R[k] / T[k]) - HIST_LO) / HIST_STEP)));
        const h = hist[i][slot * NB + bandOf[k]];
        if (h[bin] < 65535) h[bin]++;
        break;
      }
    }
  }
  // The song's tone, band by band, over every cell any stem owns: EQ on it is not taken for a level.
  const shift = Array.from({ length: NB }, (_, b) => {
    const h = new Float64Array(HIST_N);
    for (let i = 0; i < m; i++) for (let s = 0; s < slots; s++) { const x = hist[i][s * NB + b]; for (let k = 0; k < HIST_N; k++) h[k] += x[k]; }
    return Math.round((histMedian(h) ?? 0) / HIST_STEP);
  });
  const pool = (who, s0, s1) => {
    const h = new Float64Array(HIST_N);
    for (const i of who) for (let s = s0; s < s1; s++) for (let b = 0; b < NB; b++) {
      const x = hist[i][s * NB + b], sh = shift[b];
      for (let k = 0; k < HIST_N; k++) { const kk = k - sh; if (x[k] && kk >= 0 && kk < HIST_N) h[kk] += x[k]; }
    }
    return h;
  };
  const cells = (h) => h.reduce((a, v) => a + v, 0);
  const all = Array.from({ length: m }, (_, i) => i);
  const wins = slots - span + 1;
  // Each stem's level in each window: the middle of its cells there.
  const lvl = all.map((i) => Array.from({ length: wins }, (_, w) => { const h = pool([i], w, w + span); return cells(h) >= SECTION_CELLS ? histMedian(h) : null; }));
  // Split into a level for each stem, a level for each window (the whole song louder or quieter there,
  // which the mix's own rise and fall looks after) and what is left: how far a stem moves on its own.
  // Each stem has one say per window, so a part with many cells does not drag the window with it.
  const stemPart = new Array(m).fill(0), winPart = new Array(wins).fill(0);
  for (let it = 0; it < 4; it++) {
    for (const i of all) { const r = lvl[i].flatMap((x, w) => (x == null ? [] : [x - winPart[w]])); stemPart[i] = r.length ? middleOf(r) : 0; }
    const fit = Array.from({ length: wins }, (_, w) => { const r = all.flatMap((i) => (lvl[i][w] == null ? [] : [lvl[i][w] - stemPart[i]])); return r.length >= 2 ? middleOf(r) : null; });
    // A window with one stem alone takes the nearest window that has more.
    for (let w = 0; w < wins; w++) {
      if (fit[w] != null) { winPart[w] = fit[w]; continue; }
      let d = 1;
      while (d < wins && fit[w - d] == null && fit[w + d] == null) d++;
      winPart[w] = fit[w - d] ?? fit[w + d] ?? 0;
    }
  }
  const heardStems = all.filter((i) => lvl[i].some((x) => x != null));
  const typical = heardStems.length ? middleOf(heardStems.map((i) => stemPart[i])) : 0;
  const own = all.map((i) => stemPart[i] - typical);
  // Each stem against the window as the other stems have it: where few play, its own move would
  // otherwise count as the whole song moving.
  const off = all.map((i) => {
    const others = Array.from({ length: wins }, (_, w) => { const r = all.flatMap((j) => (j === i || lvl[j][w] == null ? [] : [lvl[j][w] - stemPart[j]])); return r.length >= 2 ? middleOf(r) : null; });
    return lvl[i].map((x, w) => {
      if (x == null) return null;
      let d = 0;
      while (d < wins && others[w - d] == null && others[w + d] == null) d++;
      return x - stemPart[i] - (others[w - d] ?? others[w + d] ?? winPart[w]);
    });
  });
  const centre = (w) => w * SECTION_STEP + SECTION_WIN / 2;
  const stretches = (v, from) => {
    // Middle of three neighbouring windows, so one odd window does not count.
    const sm = v.map((x, w) => { if (x == null) return null; const near = [v[w - 1], x, v[w + 1]].filter((y) => y != null).map((y) => y - from).sort((a, b) => a - b); return near[near.length >> 1]; });
    const runs = [];
    for (let w = 0; w < wins;) {
      const sign = sm[w] == null || Math.abs(sm[w]) < SECTION_MIN ? 0 : Math.sign(sm[w]);
      if (!sign) { w++; continue; }
      let e = w;
      while (e + 1 < wins && sm[e + 1] != null && Math.abs(sm[e + 1]) >= SECTION_MIN && Math.sign(sm[e + 1]) === sign) e++;
      if (e - w + 1 >= SECTION_RUN) runs.push([w, e]);
      w = e + 1;
    }
    return { sm, runs };
  };
  const curves = off.map((v, i) => {
    // A part that sits at two levels for about half the song each has its middle between them, and
    // neither looks far enough off. So once a stretch is found, the part's own level is read again from
    // the rest of the song, and the stretches from that.
    let from = 0, { sm, runs } = stretches(v, 0);
    for (let pass = 0; pass < 3 && runs.length; pass++) {
      const inRun = new Set(runs.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)));
      const rest = v.flatMap((x, w) => (x == null || inRun.has(w) ? [] : [x]));
      if (rest.length < SECTION_RUN) break;
      const next = middleOf(rest);
      if (Math.abs(next - from) < 0.25) break;
      from = next;
      ({ sm, runs } = stretches(v, from));
    }
    if (!runs.length) return null;
    const val = new Array(wins).fill(0);
    for (const [a, b] of runs) for (let w = a; w <= b; w++) val[w] = Math.max(-SECTION_MAX, Math.min(SECTION_MAX, sm[w]));
    // A point at every window that moves or borders one, so each stretch ramps in and out over a window.
    const knots = [];
    for (let w = 0; w < wins; w++) if (val[w] || val[w - 1] || val[w + 1]) knots.push({ t: centre(w), db: val[w] });
    const moves = runs.map(([a, b]) => {
      const list = sm.slice(a, b + 1);
      return { from: centre(a) - SECTION_STEP / 2, to: centre(b) + SECTION_STEP / 2, db: Math.max(-SECTION_MAX, Math.min(SECTION_MAX, list.reduce((p, x) => p + x, 0) / list.length)) };
    });
    // One level for the whole of a part that changes lands between its levels, so the rest of the song
    // moves too: to where the part sits outside the stretches that move.
    return { base: Math.max(-SECTION_MAX, Math.min(SECTION_MAX, own[i] + from)), knots, moves };
  });
  return { curves };
}

/** A gain curve from points in seconds and dB, straight lines between them and none outside. */
export function followCurve(chs, sr, knots) {
  for (let p = 0; p + 1 < knots.length; p++) {
    const a = knots[p], b = knots[p + 1];
    if (!a.db && !b.db) continue;
    const i0 = Math.max(0, Math.round(a.t * sr)), i1 = Math.min(chs[0].length, Math.round(b.t * sr));
    const len = Math.max(1, Math.round((b.t - a.t) * sr));
    for (let i = i0; i < i1; i++) {
      const d = a.db + ((b.db - a.db) * (i - Math.round(a.t * sr))) / len;
      const k = Math.pow(10, d / 20);
      for (const ch of chs) ch[i] *= k;
    }
  }
}
