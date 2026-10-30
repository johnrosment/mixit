// STFT-domain tools. Stereo frames are packed into one complex FFT (L as real,
// R as imaginary); real, bin-symmetric gains can then be applied to the packed
// spectrum directly. Provides long-term average spectrum (LTAS), fractional-
// octave band levels, reference tonal matching and a dynamic resonance
// suppressor.

import { fft } from './fft.js';

export function frameSizeFor(sr) {
  if (sr > 96000) return 16384;
  if (sr > 48000) return 8192;
  return 4096;
}

function sqrtHann(N) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  return w;
}

/**
 * Run an STFT over a stereo signal. `onFrame(re, im, power, frameIndex)` may
 * modify re/im (packed spectrum) when `synthesize` is true. `power[k]` is the
 * per-bin power summed over both channels for bins 0..N/2.
 */
export function stft(chs, sr, { N = frameSizeFor(sr), overlap = 4, synthesize = false, onFrame, onProgress }) {
  const [L, R] = chs.length > 1 ? chs : [chs[0], chs[0]];
  const n = L.length;
  const hop = N / overlap;
  const win = sqrtHann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const power = new Float64Array(N / 2 + 1);
  const outL = synthesize ? new Float32Array(n + 2 * N) : null;
  const outR = synthesize ? new Float32Array(n + 2 * N) : null;
  const total = n + N;
  const frames = Math.ceil(total / hop);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - N; // signal index of frame start (padded by N)
    for (let i = 0; i < N; i++) {
      const j = start + i;
      const inside = j >= 0 && j < n;
      re[i] = inside ? L[j] * win[i] : 0;
      im[i] = inside ? R[j] * win[i] : 0;
    }
    fft(re, im, false);
    for (let k = 0; k <= N / 2; k++) {
      const k2 = (N - k) % N;
      power[k] = 0.5 * (re[k] * re[k] + im[k] * im[k] + re[k2] * re[k2] + im[k2] * im[k2]);
    }
    onFrame(re, im, power, f);
    if (synthesize) {
      fft(re, im, true);
      const base = f * hop; // index into padded output (output index = signal index + N)
      for (let i = 0; i < N; i++) {
        outL[base + i] += re[i] * win[i] * 0.5 * (4 / overlap);
        outR[base + i] += im[i] * win[i] * 0.5 * (4 / overlap);
      }
    }
    if (onProgress && f % 256 === 0) onProgress(f / frames);
  }
  if (!synthesize) return null;
  return [outL.subarray(N, N + n).slice(), outR.subarray(N, N + n).slice()];
}

/**
 * Long-term average spectrum, skipping near-silent frames. `power` is summed
 * over both channels. With `stereo`, mid ((L+R)/2) and side ((L-R)/2) power
 * per bin are accumulated too (unpacked from the shared complex FFT).
 */
export function ltas(chs, sr, { N = frameSizeFor(sr), gateDb = -65, stereo = false } = {}) {
  const half = N / 2 + 1;
  const acc = new Float64Array(half);
  const mid = stereo ? new Float64Array(half) : null;
  const side = stereo ? new Float64Array(half) : null;
  let used = 0;
  const gate = Math.pow(10, gateDb / 10) * N * N * 0.25;
  stft(chs, sr, {
    N, overlap: 2,
    onFrame: (re, im, power) => {
      let tot = 0;
      for (let k = 1; k < power.length; k++) tot += power[k];
      if (tot / power.length < gate / power.length) return;
      for (let k = 0; k < power.length; k++) acc[k] += power[k];
      if (stereo) {
        for (let k = 0; k < half; k++) {
          const k2 = (N - k) % N;
          const r1 = re[k], i1 = im[k], r2 = re[k2], i2 = im[k2];
          const mr = (r1 + r2 + i1 + i2) * 0.25, mi = (i1 - i2 - r1 + r2) * 0.25;
          const sr2 = (r1 + r2 - i1 - i2) * 0.25, si = (i1 - i2 + r1 - r2) * 0.25;
          mid[k] += mr * mr + mi * mi;
          side[k] += sr2 * sr2 + si * si;
        }
      }
      used++;
    },
  });
  if (used) {
    for (let k = 0; k < acc.length; k++) acc[k] /= used;
    if (stereo) for (let k = 0; k < half; k++) { mid[k] /= used; side[k] /= used; }
  }
  return { power: acc, mid, side, N, sr, frames: used };
}

export function bandCenters(fraction = 6, fMin = 20, fMax = 20000) {
  const out = [];
  for (let k = Math.ceil(fraction * Math.log2(fMin / 1000)); ; k++) {
    const f = 1000 * Math.pow(2, k / fraction);
    if (f > fMax) break;
    out.push(f);
  }
  return out;
}

/** Fractional-octave band levels in dB from a per-bin power spectrum. */
export function bandLevels(spec, centers, fraction = 6) {
  const { power, N, sr } = spec;
  const binHz = sr / N;
  const edge = Math.pow(2, 1 / (2 * fraction));
  return centers.map((fc) => {
    const lo = Math.max(1, Math.ceil(fc / edge / binHz));
    const hi = Math.min(power.length - 1, Math.floor((fc * edge) / binHz));
    let s = 0;
    if (hi >= lo) for (let k = lo; k <= hi; k++) s += power[k];
    else s = power[Math.min(power.length - 1, Math.max(1, Math.round(fc / binHz)))] * (fc * (edge - 1 / edge)) / binHz;
    return s > 0 ? 10 * Math.log10(s) : -120;
  });
}

// Smooth a per-bin dB curve with a constant fractional-octave window.
function smoothOctave(db, binHz, fraction) {
  const n = db.length;
  const prefix = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) prefix[k + 1] = prefix[k] + db[k];
  const r = Math.pow(2, 1 / (2 * fraction));
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const lo = Math.max(1, Math.floor(k / r));
    const hi = Math.min(n - 1, Math.max(lo, Math.ceil(k * r)));
    out[k] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  out[0] = out[1] ?? 0;
  return out;
}

/**
 * Static matching curve (dB per bin) that moves the source's tonal balance toward
 * the reference. Overall level difference is removed (tonal match only).
 */
export function referenceCurve(srcSpec, refSpec, { strength = 0.7, maxDb = 8, fraction = 3 } = {}) {
  const { N, sr } = srcSpec;
  const binHz = sr / N;
  const half = srcSpec.power.length;
  const toDb = (p) => Array.from(p, (v) => (v > 1e-20 ? 10 * Math.log10(v) : -200));
  // Resample the reference spectrum to the source bin grid if frame sizes differ.
  const refDbRaw = toDb(refSpec.power);
  const refBinHz = refSpec.sr / refSpec.N;
  const refDb = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const pos = (k * binHz) / refBinHz;
    const i0 = Math.min(refDbRaw.length - 1, Math.floor(pos));
    const i1 = Math.min(refDbRaw.length - 1, i0 + 1);
    const t = pos - i0;
    refDb[k] = refDbRaw[i0] * (1 - t) + refDbRaw[i1] * t;
  }
  const s = smoothOctave(Float64Array.from(toDb(srcSpec.power)), binHz, fraction);
  const r = smoothOctave(refDb, binHz, fraction);
  const diff = new Float64Array(half);
  let wsum = 0, dsum = 0;
  for (let k = 1; k < half; k++) {
    diff[k] = r[k] - s[k];
    const f = k * binHz;
    if (f >= 100 && f <= 8000) { dsum += diff[k]; wsum++; }
  }
  const offset = wsum ? dsum / wsum : 0;
  const curve = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const f = k * binHz;
    let d = (diff[k] - offset) * strength;
    d = Math.max(-maxDb, Math.min(maxDb, d));
    // Fade the correction out below 30 Hz and above 16 kHz.
    let fade = 1;
    if (f < 30) fade = Math.max(0, f / 30);
    if (f > 16000) fade = Math.max(0, 1 - (f - 16000) / 4000);
    curve[k] = d * fade;
  }
  return smoothOctave(curve, binHz, fraction * 2);
}

/**
 * Apply an optional static curve (dB per bin) and an optional dynamic resonance
 * suppressor in one STFT pass. Returns the processed channels and a report of
 * where the suppressor acted most.
 */
export function spectralProcess(chs, sr, { staticCurve = null, resonance = 0, fLow = 150, fHigh = 12000, onProgress } = {}) {
  const N = frameSizeFor(sr);
  const half = N / 2 + 1;
  const binHz = sr / N;
  const hopSec = N / 4 / sr;
  const staticGain = staticCurve ? Float64Array.from(staticCurve, (d) => Math.pow(10, d / 20)) : null;
  const red = new Float64Array(half);
  const dbBuf = new Float64Array(half);
  const prefix = new Float64Array(half + 1);
  const relCoef = Math.exp(-hopSec / 0.12);
  const thr = 5;
  const maxCut = 3 + 9 * resonance;
  const kLo = Math.max(2, Math.floor(fLow / binHz));
  const kHi = Math.min(half - 2, Math.ceil(fHigh / binHz));
  const r6 = Math.pow(2, 1 / 6);
  const centers = bandCenters(6, 100, 16000);
  const mapAcc = new Float64Array(centers.length);
  let activeFrames = 0, frames = 0, sumRed = 0;
  const g = new Float64Array(half);

  const out = stft(chs, sr, {
    N, overlap: 4, synthesize: true, onProgress,
    onFrame: (re, im, power) => {
      frames++;
      for (let k = 0; k < half; k++) g[k] = staticGain ? staticGain[k] : 1;
      if (resonance > 0) {
        let tot = 0;
        for (let k = 0; k < half; k++) {
          const p = power[k];
          dbBuf[k] = p > 1e-20 ? 10 * Math.log10(p) : -200;
          tot += p;
          prefix[k + 1] = prefix[k] + dbBuf[k];
        }
        const frameActive = tot / half > 1e-11 * N * N;
        let anyRed = false;
        for (let k = 0; k < half; k++) {
          let target = 0;
          if (frameActive && k >= kLo && k <= kHi) {
            const lo = Math.max(1, Math.floor(k / r6));
            const hi = Math.min(half - 1, Math.ceil(k * r6));
            const avg = (prefix[hi + 1] - prefix[lo] - dbBuf[k]) / Math.max(1, hi - lo);
            const excess = dbBuf[k] - avg - thr;
            if (excess > 0) target = Math.min(maxCut, excess * 0.8 * resonance);
          }
          red[k] = target > red[k] ? target : red[k] * relCoef;
        }
        // Smooth across neighbouring bins to avoid isolated notches.
        for (let k = 1; k < half - 1; k++) {
          const r = (red[k - 1] + 2 * red[k] + red[k + 1]) * 0.25;
          if (r > 0.05) {
            g[k] *= Math.pow(10, -r / 20);
            anyRed = true;
            sumRed += r;
            const band = Math.round(6 * Math.log2((k * binHz) / centers[0]));
            if (band >= 0 && band < centers.length) mapAcc[band] += r;
          }
        }
        if (anyRed) activeFrames++;
      }
      if (staticGain || resonance > 0) {
        for (let k = 0; k < half; k++) {
          const gk = g[k];
          if (gk === 1) continue;
          re[k] *= gk; im[k] *= gk;
          if (k > 0 && k < N / 2) { re[N - k] *= gk; im[N - k] *= gk; }
        }
      }
    },
  });
  const ranked = centers
    .map((f, i) => ({ freq: Math.round(f), weight: mapAcc[i] / Math.max(1, frames) }))
    .sort((a, b) => b.weight - a.weight);
  return {
    chs: out,
    report: {
      resonanceAmount: resonance,
      activePct: frames ? (100 * activeFrames) / frames : 0,
      avgCutDb: frames ? sumRed / frames / Math.max(1, kHi - kLo) : 0,
      topFrequencies: ranked.filter((r) => r.weight > 0.01).slice(0, 6),
      map: centers.map((f, i) => ({ freq: Math.round(f), weight: mapAcc[i] / Math.max(1, frames) })),
    },
  };
}

/**
 * Onset strength (spectral flux) per hop plus an autocorrelation tempo
 * estimate. With `spectrogram`, also returns a compact log-frequency
 * spectrogram (Uint8 levels over a 96 dB range) from the same STFT pass.
 */
export function rhythm(chs, sr, { spectrogram = false, cols = 720, rows = 100 } = {}) {
  const N = 2048;
  const hop = N / 2;
  const prev = new Float64Array(N / 2 + 1);
  const flux = [];
  const frames = Math.ceil((chs[0].length + N) / hop);
  let sg = null;
  if (spectrogram) {
    const fMin = 30, fMax = Math.min(20000, sr * 0.48), binHz = sr / N;
    const ncols = Math.max(1, Math.min(cols, frames));
    const lo = new Int32Array(rows), hi = new Int32Array(rows);
    for (let r = 0; r < rows; r++) {
      const a = fMin * Math.pow(fMax / fMin, r / rows), b = fMin * Math.pow(fMax / fMin, (r + 1) / rows);
      lo[r] = Math.max(1, Math.round(a / binHz));
      hi[r] = Math.max(lo[r], Math.round(b / binHz) - 1);
    }
    sg = { fMin, fMax, ncols, per: frames / ncols, lo, hi, acc: new Float64Array(rows), cnt: 0, col: 0, db: new Float32Array(ncols * rows).fill(-200) };
  }
  const flush = () => {
    if (!sg.cnt) return;
    for (let r = 0; r < rows; r++) {
      const v = sg.acc[r] / sg.cnt;
      sg.db[sg.col * rows + r] = v > 1e-20 ? 10 * Math.log10(v) : -200;
    }
    sg.acc.fill(0);
    sg.cnt = 0;
  };
  stft(chs, sr, {
    N, overlap: 2,
    onFrame: (re, im, power, f) => {
      let s = 0;
      for (let k = 1; k < power.length; k++) {
        const m = Math.log1p(Math.sqrt(power[k]));
        const d = m - prev[k];
        if (d > 0) s += d;
        prev[k] = m;
      }
      flux.push(s);
      if (sg) {
        const col = Math.min(sg.ncols - 1, Math.floor(f / sg.per));
        if (col !== sg.col) { flush(); sg.col = col; }
        for (let r = 0; r < rows; r++) {
          let a = 0;
          for (let k = sg.lo[r]; k <= sg.hi[r]; k++) a += power[k];
          sg.acc[r] += a / (sg.hi[r] - sg.lo[r] + 1);
        }
        sg.cnt++;
      }
    },
  });
  let spec = null;
  if (sg) {
    flush();
    let maxDb = -200;
    for (let i = 0; i < sg.db.length; i++) if (sg.db[i] > maxDb) maxDb = sg.db[i];
    const range = 96;
    const data = new Uint8Array(sg.db.length);
    for (let i = 0; i < data.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(((sg.db[i] - (maxDb - range)) / range) * 255)));
    spec = { cols: sg.ncols, rows, fMin: sg.fMin, fMax: sg.fMax, stepSec: (sg.per * hop) / sr, rangeDb: range, data };
  }
  const withSpec = (o) => (spec ? { ...o, spectrogram: spec } : o);
  const fps = sr / hop;
  const n = flux.length;
  if (n < fps * 4) return withSpec({ bpm: 0, confidence: 0, onsetsPerSec: 0 });
  // Normalise and half-wave rectify against a moving mean.
  const win = Math.round(fps * 0.5);
  const nov = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += flux[i];
    if (i >= win) acc -= flux[i - win];
    const mean = acc / Math.min(i + 1, win);
    nov[i] = Math.max(0, flux[i] - mean);
  }
  // Onset count by peak picking.
  let onsets = 0;
  const thr = nov.reduce((a, b) => a + b, 0) / n * 1.5;
  for (let i = 1; i < n - 1; i++) if (nov[i] > thr && nov[i] >= nov[i - 1] && nov[i] > nov[i + 1]) onsets++;
  // Autocorrelation over 60-190 BPM with a mild preference around 110 BPM.
  let best = 0, bestLag = 0, sum = 0, cnt = 0;
  const lagMin = Math.floor((60 / 190) * fps), lagMax = Math.ceil((60 / 60) * fps);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    for (let i = lag; i < n; i++) r += nov[i] * nov[i - lag];
    const bpm = (60 * fps) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2));
    const score = r * w;
    sum += score; cnt++;
    if (score > best) { best = score; bestLag = lag; }
  }
  const mean = cnt ? sum / cnt : 0;
  return withSpec({
    bpm: bestLag ? Math.round(((60 * fps) / bestLag) * 10) / 10 : 0,
    confidence: mean > 0 ? Math.min(1, (best / mean - 1) / 3) : 0,
    onsetsPerSec: onsets / (n / fps),
  });
}
