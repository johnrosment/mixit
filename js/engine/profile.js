// Sound profiles: the averaged tonal balance, per-band stereo width and
// loudness of one or more reference masters, stored compactly on a
// 1/12-octave grid so a profile can be saved and reused without the audio.

import { ltas } from './spectral.js';
import { measureLoudness, truePeak } from './loudness.js';

export const PROFILE_GRID = (() => {
  const g = [];
  for (let k = Math.ceil(12 * Math.log2(20 / 1000)); ; k++) {
    const f = 1000 * Math.pow(2, k / 12);
    if (f > 20000) break;
    g.push(Math.round(f * 100) / 100);
  }
  return g;
})();

const WIDTH_BANDS = [[20, 200], [200, 4000], [4000, 20000]];

function stereoPair(audio) {
  return audio.channels.length > 1 ? audio.channels.slice(0, 2) : [audio.channels[0], audio.channels[0]];
}

/**
 * Power spectral density per Hz (independent of frame size and sample rate:
 * bin power is divided by the window energy N/2 and the sample rate), in dB
 * relative to the track's integrated loudness, sampled on the profile grid.
 */
function measure(audio) {
  const { sr } = audio;
  const chs = stereoPair(audio);
  const spec = ltas(chs, sr, { stereo: true });
  const loud = measureLoudness(chs, sr, { series: false });
  const tp = truePeak(chs, sr);
  const { N } = spec;
  const binHz = sr / N;
  const norm = 2 / (N * sr);
  const edge = Math.pow(2, 1 / 24);
  const densityDb = PROFILE_GRID.map((f) => {
    if (f > sr * 0.48) return null;
    const lo = Math.max(1, Math.ceil(f / edge / binHz)), hi = Math.min(spec.power.length - 1, Math.floor((f * edge) / binHz));
    let s = 0, c = 0;
    if (hi >= lo) for (let k = lo; k <= hi; k++) { s += spec.power[k]; c++; }
    else { s = spec.power[Math.max(1, Math.round(f / binHz))]; c = 1; }
    return s > 0 ? 10 * Math.log10((s / c) * norm) - loud.integrated : null;
  });
  const widthDb = WIDTH_BANDS.map(([a, b]) => {
    let m = 0, sd = 0;
    for (let k = Math.max(1, Math.ceil(a / binHz)); k <= Math.min(spec.power.length - 1, Math.floor(b / binHz)); k++) { m += spec.mid[k]; sd += spec.side[k]; }
    return m > 0 ? 10 * Math.log10(Math.max(sd, 1e-20) / m) : -120;
  });
  return { densityDb, lufs: loud.integrated, lra: loud.lra, plr: tp.dbtp - loud.integrated, widthDb, durationSec: chs[0].length / sr };
}

/** Learn a profile from 1-8 reference tracks ({ sr, channels }). */
export function learnProfile(audios, { name = '', names = [] } = {}) {
  if (!audios.length) throw new Error('A sound profile needs at least one reference track.');
  const ms = audios.map(measure);
  const densityDb = PROFILE_GRID.map((_, i) => {
    const v = ms.map((m) => m.densityDb[i]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  // Fill grid points above the lowest Nyquist with the last measured value.
  let last = densityDb.find((v) => v != null) ?? -100;
  for (let i = 0; i < densityDb.length; i++) { if (densityDb[i] == null) densityDb[i] = last; else last = densityDb[i]; }
  const spread = PROFILE_GRID.map((_, i) => {
    const v = ms.map((m) => m.densityDb[i]).filter((x) => x != null);
    if (v.length < 2) return 0;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  });
  const mean = (get) => ms.reduce((a, m) => a + get(m), 0) / ms.length;
  return {
    version: 1,
    name,
    sources: names,
    count: ms.length,
    created: new Date().toISOString(),
    grid: PROFILE_GRID,
    densityDb: densityDb.map((v) => Math.round(v * 100) / 100),
    spreadDb: spread.map((v) => Math.round(v * 100) / 100),
    lufs: mean((m) => m.lufs),
    lra: mean((m) => m.lra),
    plr: mean((m) => m.plr),
    widthDb: [0, 1, 2].map((b) => mean((m) => m.widthDb[b])),
  };
}

/** Per-bin power spectrum (as ltas() returns it) for a track at 0 LUFS with this profile's balance. */
export function profileSpectrum(profile, N, sr) {
  const half = N / 2 + 1;
  const binHz = sr / N;
  const power = new Float64Array(half);
  const g = profile.grid, d = profile.densityDb;
  const lg = g.map((f) => Math.log2(f));
  const scale = (N * sr) / 2;
  let j = 0;
  for (let k = 0; k < half; k++) {
    const f = Math.max(g[0], Math.min(g[g.length - 1], Math.max(1, k) * binHz));
    const x = Math.log2(f);
    while (j < g.length - 2 && lg[j + 1] < x) j++;
    const t = Math.max(0, Math.min(1, (x - lg[j]) / (lg[j + 1] - lg[j])));
    power[k] = Math.pow(10, (d[j] * (1 - t) + d[j + 1] * t) / 10) * scale;
  }
  return { power, N, sr, frames: 1 };
}

/** Side-gain multipliers per band (low/mid/high) that move a source's width toward the profile. */
export function profileWidthFactors(profile, sourceWidthDb, amount = 0.5) {
  return [0, 1, 2].map((b) => {
    const src = sourceWidthDb?.[b];
    if (src == null || src < -40 || amount <= 0) return 1;
    const f = Math.pow(10, ((profile.widthDb[b] - src) / 20) * amount);
    return Math.max(0.7, Math.min(1.4, f));
  });
}
