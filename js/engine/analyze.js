// Full technical analysis of a stereo signal plus rule-based processing
// suggestions (each with a plain-language reason).

import { measureLoudness, truePeak, integratedLufs, lin2db } from './loudness.js';
import { ltas, bandCenters, bandLevels, rhythm } from './spectral.js';
import { design, cascade } from './filters.js';
import { percentileDb } from './dynamics.js';
import { detectHum, detectClicks, detectClipping, detectStereoDelay, detectBandwidth, noiseProfile } from './repair.js';

const BAND_RANGES = [
  ['sub', 20, 60], ['bass', 60, 200], ['lowMid', 200, 500], ['mid', 500, 2000],
  ['upperMid', 2000, 4000], ['presence', 4000, 8000], ['air', 8000, 20000],
];

function corr(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 1;
}

function filtered(x, coeffs) {
  return cascade(coeffs, x, new Float32Array(x.length));
}

/**
 * `repairScan` adds the restoration detectors (hum, clicks, clipped runs,
 * inter-channel delay, noise floor); they cost a few extra passes, so the
 * mastering chain only runs them on its input.
 */
export function analyze(audio, { progress = () => {}, repairScan = false } = {}) {
  const { sr } = audio;
  const chs = audio.channels.length > 1 ? audio.channels.slice(0, 2) : [audio.channels[0], audio.channels[0]];
  const [L, R] = chs;
  const n = L.length;
  progress('Measuring loudness', 0.05);
  const loud = measureLoudness(chs, sr);
  progress('Measuring true peak', 0.25);
  const tp = truePeak(chs, sr);

  // Sample-level statistics.
  const peaks = [], rmsCh = [], dc = [];
  let clipped = 0, clipEvents = 0;
  for (const ch of chs) {
    let pk = 0, ss = 0, sum = 0, run = 0;
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      ss += v * v;
      sum += v;
      if (a >= 0.9999) { run++; if (run === 3) { clipEvents++; clipped += 3; } else if (run > 3) clipped++; } else run = 0;
    }
    peaks.push(pk);
    rmsCh.push(Math.sqrt(ss / n));
    dc.push(sum / n);
  }
  const samplePeak = Math.max(...peaks);
  const rms = Math.sqrt((rmsCh[0] ** 2 + rmsCh[1] ** 2) / 2);
  const hop = Math.round(sr * 0.1);
  let silentHops = 0, hops = 0;
  for (let i = 0; i < n; i += hop) {
    let ss = 0;
    const end = Math.min(n, i + hop);
    for (let j = i; j < end; j++) ss += (L[j] * L[j] + R[j] * R[j]) * 0.5;
    if (ss / (end - i) < 1e-6) silentHops++;
    hops++;
  }

  progress('Measuring stereo image', 0.4);
  const lowC = [design('lowpass', 150, sr), design('lowpass', 150, sr)];
  const highC = [design('highpass', 4000, sr), design('highpass', 4000, sr)];
  let mm = 0, ss2 = 0;
  for (let i = 0; i < n; i++) { const m = L[i] + R[i], s = L[i] - R[i]; mm += m * m; ss2 += s * s; }
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = 0.5 * (L[i] + R[i]);
  const monoLufs = integratedLufs([mono, mono], sr);
  const corrTimeline = [];
  const cw = Math.round(sr * 0.5);
  for (let i = 0; i + cw <= n; i += cw) corrTimeline.push(corr(L.subarray(i, i + cw), R.subarray(i, i + cw)));
  const stereo = {
    correlation: corr(L, R),
    lowCorrelation: corr(filtered(L, lowC), filtered(R, lowC)),
    highCorrelation: corr(filtered(L, highC), filtered(R, highC)),
    sideToMidDb: mm > 0 ? 10 * Math.log10(Math.max(ss2, 1e-20) / mm) : -120,
    balanceDb: lin2db(rmsCh[0]) - lin2db(rmsCh[1]),
    monoLossLu: loud.integrated - monoLufs,
    correlationTimeline: corrTimeline,
    correlationStepSec: 0.5,
  };

  progress('Measuring spectrum', 0.55);
  const spec = ltas(chs, sr, { stereo: true });
  const binHz = sr / spec.N;
  const share = {};
  let total = 0;
  const bandPow = BAND_RANGES.map(([, lo, hi]) => {
    let s = 0;
    for (let k = Math.ceil(lo / binHz); k <= Math.min(spec.power.length - 1, Math.floor(hi / binHz)); k++) s += spec.power[k];
    total += s;
    return s;
  });
  BAND_RANGES.forEach(([key], i) => { share[key] = total > 0 ? (100 * bandPow[i]) / total : 0; });
  let num = 0, den = 0;
  for (let k = 1; k < spec.power.length; k++) {
    const f = k * binHz;
    if (f < 20 || f > 20000) continue;
    num += f * spec.power[k];
    den += spec.power[k];
  }
  let cum = 0, rolloff = 0;
  for (let k = 1; k < spec.power.length; k++) {
    cum += spec.power[k];
    if (cum >= 0.85 * den) { rolloff = k * binHz; break; }
  }
  const centers6 = bandCenters(6, 20, Math.min(20000, sr * 0.48));
  const levels6 = bandLevels(spec, centers6, 6);
  const centers3 = bandCenters(3, 63, Math.min(10000, sr * 0.45));
  const levels3 = bandLevels(spec, centers3, 3);
  // Linear fit of band level against octave position. Bands more than 45 dB
  // below the loudest band are treated as noise floor and left out, so quiet or
  // band-limited sources do not read as bright.
  const xs = centers3.map((f) => Math.log2(f / 1000));
  const topLevel = Math.max(...levels3);
  const fitIdx = levels3.map((v, i) => (v > topLevel - 45 ? i : -1)).filter((i) => i >= 0);
  const xm = fitIdx.reduce((a, i) => a + xs[i], 0) / fitIdx.length;
  const ym = fitIdx.reduce((a, i) => a + levels3[i], 0) / fitIdx.length;
  let sxy = 0, sxx = 0;
  for (const i of fitIdx) { sxy += (xs[i] - xm) * (levels3[i] - ym); sxx += (xs[i] - xm) ** 2; }
  const slope = sxx ? sxy / sxx : 0;
  const usableTopHz = centers3[fitIdx[fitIdx.length - 1]] || 0;
  const residual = levels3.map((y, i) => y - (ym + slope * (xs[i] - xm)));
  const resIn = (lo, hi) => {
    const v = residual.filter((_, i) => centers3[i] >= lo && centers3[i] <= hi);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const peakResidual = (lo, hi) => {
    let best = { freq: 0, db: -99 };
    centers3.forEach((f, i) => { if (f >= lo && f <= hi && residual[i] > best.db) best = { freq: f, db: residual[i] }; });
    return best;
  };
  const tonal = {
    slopeDbPerOct: slope,
    usableTopHz,
    mudDb: resIn(180, 500),
    mudPeak: peakResidual(180, 500),
    boxDb: resIn(500, 1000),
    harshDb: resIn(2000, 5000),
    harshPeak: peakResidual(2000, 6000),
    airDb: resIn(8000, 10000),
  };

  // Per-band mono compatibility: mid power against the per-channel average.
  const centersMono = bandCenters(3, 31.5, Math.min(16000, sr * 0.45));
  const midLv = bandLevels({ power: spec.mid, N: spec.N, sr }, centersMono, 3);
  const avgLv = bandLevels(spec, centersMono, 3).map((v) => v - 10 * Math.log10(2));
  stereo.monoLossBands = { centers: centersMono, lossDb: midLv.map((v, i) => Math.max(-40, Math.min(0.5, v - avgLv[i]))) };
  const msBand = (lo, hi) => {
    let m = 0, sd = 0;
    for (let k = Math.max(1, Math.ceil(lo / binHz)); k <= Math.min(spec.power.length - 1, Math.floor(hi / binHz)); k++) { m += spec.mid[k]; sd += spec.side[k]; }
    return m > 0 ? 10 * Math.log10(Math.max(sd, 1e-20) / m) : -120;
  };
  stereo.sideToMidBands = [msBand(20, 200), msBand(200, 4000), msBand(4000, 20000)];
  const bandwidth = detectBandwidth(spec);

  progress('Measuring sibilance', 0.7);
  const sib = filtered(mono, [design('highpass', 5000, sr, 0.7), design('lowpass', Math.min(9000, sr * 0.45), sr, 0.7)]);
  const step = Math.round(sr * 0.01);
  const ratios = [];
  for (let i = 0; i + step <= n; i += step) {
    let a = 0, b = 0;
    for (let j = i; j < i + step; j++) { a += sib[j] * sib[j]; b += mono[j] * mono[j]; }
    if (b / step > 1e-6) ratios.push(10 * Math.log10((a + 1e-20) / b));
  }
  const ratioArr = Float32Array.from(ratios);
  const sibilance = {
    indexDb: ratios.length ? percentileDb(ratioArr, 0.97, -200) - percentileDb(ratioArr, 0.5, -200) : 0,
    shareDb: ratios.length ? percentileDb(ratioArr, 0.5, -200) : -120,
  };

  progress('Estimating tempo', 0.8);
  const { spectrogram, ...rh } = rhythm(chs, sr, { spectrogram: true });

  let repair = null;
  if (repairScan) {
    progress('Scanning for hum', 0.84);
    const hum = detectHum(chs, sr);
    progress('Scanning for clicks', 0.86);
    const { events, ...clicks } = detectClicks(chs, sr);
    const { perChannel, ...clipping } = detectClipping(chs, { sr });
    progress('Scanning stereo delay and noise floor', 0.9);
    const delay = detectStereoDelay(chs, sr);
    const noise = noiseProfile(chs, sr);
    // Bands narrower than one FFT bin carry no measurement and are dropped.
    const keep = noise.floorDb.map((v, i) => (v > -199 ? i : -1)).filter((i) => i >= 0);
    repair = {
      hum, clicks, clipping, stereoDelay: delay,
      noise: { qualified: noise.qualified, reason: noise.reason, floorDbfs: noise.floorDbfs, separationDb: noise.separationDb, quietSec: noise.quietSec, centers: keep.map((i) => noise.centers[i]), floorDb: keep.map((i) => noise.floorDb[i]) },
    };
  }

  const result = {
    durationSec: n / sr,
    sampleRate: sr,
    sourceChannels: audio.channels.length,
    loudness: {
      integrated: loud.integrated,
      lra: loud.lra,
      momentaryMax: loud.momentaryMax,
      shortTermMax: loud.shortTermMax,
      momentary: loud.momentary,
      shortTerm: loud.shortTerm,
      hopSec: loud.hopSec,
    },
    peak: {
      truePeakDbtp: tp.dbtp,
      truePeakPerChannel: tp.perChannelDbtp,
      samplePeakDbfs: lin2db(samplePeak),
      samplePeakPerChannel: peaks.map(lin2db),
      headroomDb: -tp.dbtp,
    },
    level: {
      rmsDbfs: lin2db(rms),
      rmsPerChannel: rmsCh.map(lin2db),
      crestDb: lin2db(samplePeak) - lin2db(rms),
      plrDb: tp.dbtp - loud.integrated,
      dcOffsetPct: dc.map((d) => d * 100),
      clippedSamples: clipped,
      clipEvents,
      silencePct: hops ? (100 * silentHops) / hops : 0,
    },
    stereo,
    spectrum: {
      centroidHz: den ? num / den : 0,
      rolloff85Hz: rolloff,
      bandSharePct: share,
      bands: { centers: centers6, levels: levels6 },
      tonal,
      bandwidth,
    },
    spectrogram,
    sibilance,
    rhythm: rh,
    repair,
  };
  progress('Building suggestions', 0.95);
  result.suggestions = suggest(result);
  return result;
}

/** Rule-based starting point for the mastering chain, with reasons. */
export function suggest(m) {
  const s = {};
  const why = [];
  const I = m.loudness.integrated;
  const crest = m.level.crestDb;
  const t = m.spectrum.tonal;
  if (I < -30) why.push(`Input is very quiet (${I.toFixed(1)} LUFS). It is gain-staged before processing so the dynamics stages see a normal level.`);
  if (m.level.clipEvents > 0) why.push(`${m.level.clipEvents} clipping event(s) detected in the source. Processing cannot restore clipped peaks; re-export without clipping if possible.`);
  const finished = I > -11 && crest < 11;
  if (finished) {
    s.multiband = 0.12; s.glue = 0.1; s.saturation = 0; s.resonance = 0.15;
    s.targetLufs = Math.round(Math.min(-8, Math.max(-14, I)) * 2) / 2;
    why.push(`Source already looks mastered (${I.toFixed(1)} LUFS, ${crest.toFixed(1)} dB crest). Processing is kept light and the target stays close to the current level.`);
  } else {
    s.targetLufs = -14;
    if (crest > 18) { s.multiband = 0.5; s.glue = 0.35; why.push(`High crest factor (${crest.toFixed(1)} dB): more multiband and glue compression to control peaks before limiting.`); }
    else if (crest < 12) { s.multiband = 0.2; s.glue = 0.15; why.push(`Moderate crest factor (${crest.toFixed(1)} dB): dynamics kept gentle.`); }
    else { s.multiband = 0.35; s.glue = 0.28; }
  }
  if (m.loudness.lra > 12) why.push(`Wide loudness range (${m.loudness.lra.toFixed(1)} LU). Quiet passages will stay quiet relative to loud ones unless you raise multiband compression.`);
  const targetSlope = -4.5;
  let tilt = Math.max(-3, Math.min(3, (targetSlope - t.slopeDbPerOct) * 1.2));
  // Never darken material whose energy already sits low in the spectrum.
  if (tilt < 0 && (m.spectrum.centroidHz < 1200 || t.usableTopHz < 5000)) {
    tilt = 0;
    why.push(`Dark, band-limited source (centroid ${Math.round(m.spectrum.centroidHz)} Hz): its tonal character is preserved and no darkening tilt is applied.`);
  }
  if (Math.abs(tilt) >= 0.5) {
    s.tilt = Math.round(tilt * 2) / 2;
    why.push(`Spectral slope is ${t.slopeDbPerOct.toFixed(1)} dB/octave (reference ${targetSlope}). Tilt set to ${s.tilt > 0 ? '+' : ''}${s.tilt} dB to ${s.tilt > 0 ? 'brighten' : 'darken'} gently.`);
  } else s.tilt = 0;
  if (t.mudDb > 1.2) {
    s.deMud = Math.min(1, t.mudDb / 4);
    s.deMudFreq = Math.round(t.mudPeak.freq);
    why.push(`Low-mid build-up of ${t.mudDb.toFixed(1)} dB above the spectral trend, peaking near ${s.deMudFreq} Hz: a broad cut is applied there.`);
  } else s.deMud = 0;
  if (t.harshDb > 1.5) { s.resonance = Math.min(0.8, 0.3 + t.harshDb / 8); why.push(`Upper mids are ${t.harshDb.toFixed(1)} dB above trend: resonance control raised.`); }
  else if (s.resonance == null) s.resonance = 0.3;
  if (m.sibilance.indexDb > 16) { s.deess = Math.min(0.8, (m.sibilance.indexDb - 12) / 12); why.push(`Sibilance bursts reach ${m.sibilance.indexDb.toFixed(1)} dB above the typical 5-9 kHz level: de-esser enabled.`); }
  else s.deess = 0.15;
  if (m.stereo.lowCorrelation < 0.6) { s.monoBass = 120; why.push(`Low-end correlation is ${m.stereo.lowCorrelation.toFixed(2)}: bass below 120 Hz is folded to mono for translation.`); }
  else s.monoBass = 0;
  if (Math.abs(m.stereo.balanceDb) > 0.5) { s.balanceRepair = true; why.push(`Channels differ by ${m.stereo.balanceDb.toFixed(1)} dB: the louder side is trimmed toward centre (max 3 dB).`); }
  if (m.stereo.correlation < 0.2) why.push(`Overall correlation is low (${m.stereo.correlation.toFixed(2)}); check the mix in mono (${m.stereo.monoLossLu.toFixed(1)} LU lost when folded).`);
  const bw = m.spectrum.bandwidth;
  if (t.airDb < -3 && t.slopeDbPerOct < -6 && !(bw && bw.limited && bw.bandwidthHz < 13000)) { s.air = 1.5; why.push('Very little energy above 8 kHz: a small air shelf is added.'); }
  if (bw && bw.limited) why.push(`Content ends near ${(bw.bandwidthHz / 1000).toFixed(1)} kHz${bw.brickwall ? ' with a steep cut-off (typical of lossy encoding)' : ''}. The bandwidth guard keeps boosts from lifting noise above it.`);
  // Restoration is opt-in: detections are reported, never switched on automatically.
  const rp = m.repair;
  if (rp) {
    if (rp.hum.detected) why.push(`Mains hum at ${rp.hum.f0.toFixed(2)} Hz with ${rp.hum.harmonics.length} steady harmonics (up to ${Math.max(...rp.hum.harmonics.map((h) => h.prominenceDb)).toFixed(0)} dB above the surrounding spectrum). Turn on Hum removal under Repair; audition bass notes afterwards.`);
    if (rp.clicks.count > 0) why.push(`${rp.clicks.count} isolated click${rp.clicks.count > 1 ? 's' : ''} found (${rp.clicks.perMinute.toFixed(1)} per minute). Click repair under Repair can reconstruct them.`);
    if (rp.clipping.runs > 0) why.push(`${rp.clipping.runs} flat-topped (clipped) peak${rp.clipping.runs > 1 ? 's' : ''}, ${rp.clipping.samples} samples in total. Clipped-peak repair can reconstruct short ones.`);
    if (rp.stereoDelay.detected) why.push(`The channels are offset by ${Math.abs(rp.stereoDelay.lagMs).toFixed(3)} ms (correlation ${rp.stereoDelay.corrAtZero.toFixed(2)} as is, ${rp.stereoDelay.corrAtLag.toFixed(2)} when aligned). Stereo delay repair can align them; intentional stereo delays would be affected.`);
    if (rp.noise.qualified && rp.noise.floorDbfs > -75) why.push(`Steady noise floor around ${rp.noise.floorDbfs.toFixed(0)} dBFS during quiet passages. Noise reduction can lower it; audition quiet detail and reverb tails.`);
  }
  return { settings: s, reasons: why };
}
