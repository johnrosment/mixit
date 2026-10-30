// Mastering chain. Every stage records what it did so the report can explain
// the result.

import { analyze } from './analyze.js';
import { integratedLufs, truePeak, measureLoudness } from './loudness.js';
import { compress, multiband, deess, limitWithEnvelope, peakEnvelope, attackSustain, bassDebloom, sectionDynamics, deBox, hfPeakReserve, dynamicShelf } from './dynamics.js';
import { saturate, tapeHiss, reverb, addInto, exciter, multibandWidth, toneEq, gain, copyChannels } from './effects.js';
import { ltas, referenceCurve, spectralProcess, bandCenters, bandLevels } from './spectral.js';
import { dcBlock, design, cascade } from './filters.js';
import {
  detectStereoDelay, repairStereoDelay, detectClipping, declip, detectClicks, repairClicks,
  detectHum, removeHum, denoise, bandBalance,
} from './repair.js';
import { learnProfile, profileSpectrum, profileWidthFactors } from './profile.js';
import { upsample2, downsample2, HALF_BAND } from './resample.js';
import { upmix, loudnessWeights, channelLevels } from './spatial.js';

export const MASTER_DEFAULTS = {
  targetLufs: -14, ceiling: -1, lookahead: 5, release: 80,
  hpf: 25, low: 0, mid: 0, high: 0, tilt: 0, air: 0, deMud: 0, deMudFreq: 300,
  refStrength: 0.7, resonance: 0.3, deess: 0.15,
  multiband: 0.35, xLow: 120, xHigh: 2500, glue: 0.28,
  saturation: 0, satMode: 'tape',
  widthLow: 1, widthMid: 1, widthHigh: 1, monoBass: 0, balanceRepair: true,
  // Repair (opt-in restoration)
  delayRepair: false, declip: false, clickRepair: 0, hum: 0, denoise: 0, bandBalance: false, bandwidthGuard: true,
  // Extra dynamics
  attack: 0, sustain: 0, bassDebloom: 0, sectionDyn: 0, sectionWindow: 10, deBox: 0, deBoxFreq: 0, hfReserve: 0, hiss: 0, verb: 0, harshCut: 0, harshFreq: 3000, nasalCut: 0, nasalFreq: 700, exciter: 0,
  // 1 = process at the source rate, 2 = run the chain at twice the rate
  oversample: 1,
  // Sound profile
  profileWidth: 0.5, profileLoudness: false,
  // Release cohesion trims (set per track for batches)
  tiltTrim: 0, widthTrim: 1,
};

export const PLATFORM_TARGETS = [
  { key: 'streaming', label: 'Streaming (Spotify, YouTube, Tidal)', lufs: -14, ceiling: -1 },
  { key: 'apple', label: 'Apple Music', lufs: -16, ceiling: -1 },
  { key: 'club', label: 'Club / DJ', lufs: -8, ceiling: -0.3 },
  { key: 'broadcast', label: 'Broadcast (EBU R128)', lufs: -23, ceiling: -1 },
];

export const VARIATION_OVERRIDES = {
  transparent: { multiband: 0.12, glue: 0.1, saturation: 0, resonance: 0.15 },
  warm: { tilt: -1, saturation: 3, satMode: 'tube', glue: 0.35, high: -0.5 },
  loud: { targetLufs: -9, multiband: 0.55, glue: 0.45, saturation: 2, satMode: 'clip' },
};

// Vinyl / cassette pre-master: summed low end, more sibilance control, a
// gentler loudness target and protected headroom.
function vinylOverrides(s) {
  return {
    monoBass: Math.max(s.monoBass || 0, 150), deess: Math.max(s.deess, 0.5), widthHigh: Math.min(s.widthHigh, 1), widthLow: Math.min(s.widthLow, 0.6),
    saturation: s.satMode === 'clip' ? 0 : s.saturation, targetLufs: Math.min(s.targetLufs, -13), ceiling: -3, release: Math.max(s.release, 150),
  };
}

const PLAYBACK_NORMALISATION = [
  { platform: 'Spotify (normal)', target: -14 },
  { platform: 'YouTube', target: -14 },
  { platform: 'Apple Music (Sound Check)', target: -16 },
  { platform: 'Amazon Music', target: -14 },
  { platform: 'Deezer', target: -15 },
];

function clampGain(db) {
  return Math.max(-30, Math.min(40, db));
}

/** Loudness targeting through the true-peak limiter, iterating the gain. */
export function finalize(chs, sr, { targetLufs, ceiling, lookahead = 5, release = 80, weights = null }, cache = {}) {
  const env = cache.env || (cache.env = peakEnvelope(chs, sr));
  const pre = cache.lufs ?? (cache.lufs = integratedLufs(chs, sr, weights));
  let gainDb = clampGain(targetLufs - pre);
  const out = chs.map((c) => new Float32Array(c.length));
  let lim = null, achieved = pre, iterations = 0;
  // Secant search: the loudness gained per dB of gain shrinks as the limiter works harder.
  const search = (ceil) => {
    let prevGain = null, prevAch = null;
    for (let it = 0; it < 8; it++) {
      iterations++;
      lim = limitWithEnvelope(chs, sr, env, { gainDb, ceilingDb: ceil, lookaheadMs: lookahead, releaseMs: release, out });
      achieved = integratedLufs(out, sr, weights);
      const err = targetLufs - achieved;
      if (Math.abs(err) < 0.05) break;
      let slope = lim.maxGr > 3 ? 0.77 : 1;
      if (prevGain != null && Math.abs(gainDb - prevGain) > 0.01) slope = Math.max(0.15, Math.min(1, (achieved - prevAch) / (gainDb - prevGain)));
      prevGain = gainDb; prevAch = achieved;
      gainDb = clampGain(gainDb + err / slope);
    }
  };
  search(ceiling - 0.05);
  let tp = truePeak(out, sr);
  // Very sharp transients can peak a little above the limiter's estimate; if so,
  // search again with the ceiling lowered by that overshoot instead of turning everything down.
  if (tp.dbtp > ceiling + 0.05) {
    search(ceiling - 0.05 - (tp.dbtp - ceiling));
    tp = truePeak(out, sr);
  }
  let safety = 0;
  if (tp.dbtp > ceiling) {
    safety = ceiling - tp.dbtp - 0.02;
    gain(out, safety);
  }
  return {
    chs: out,
    gainDb: gainDb + safety,
    achievedLufs: achieved + safety,
    truePeakDbtp: tp.dbtp + safety,
    safetyTrimDb: safety,
    iterations,
    limiter: lim,
  };
}

/** Everything before loudness targeting. Returns processed channels and stage reports. */
function processChain(input, sr, s, { profile, progress, inputAnalysis }) {
  const stages = [];
  const log = (stage, detail, data = {}) => stages.push({ stage, detail, ...data });
  let chs = copyChannels(input);
  const repairs = {};
  const scan = inputAnalysis.repair || {};

  // ---- Repair (before any gain or filtering, so clipped plateaus are still exact) ----
  if (s.delayRepair) {
    progress('Repair: stereo delay', 0.22);
    const d = scan.stereoDelay || detectStereoDelay(chs, sr);
    if (d.detected) {
      chs = repairStereoDelay(chs, d.lagSamples);
      log('Stereo delay repair', `${d.lagSamples > 0 ? 'Right' : 'Left'} channel arrived ${Math.abs(d.lagMs).toFixed(3)} ms late; both channels moved half way. Correlation ${d.corrAtZero.toFixed(2)} → ${d.corrAtLag.toFixed(2)}.`);
    } else log('Stereo delay repair', 'No qualified coherent delay between the channels; nothing changed.');
    repairs.stereoDelay = d;
  }
  if (s.declip) {
    progress('Repair: clipped peaks', 0.23);
    const det = detectClipping(chs, { sr });
    if (det.detected) {
      const r = declip(chs, sr, det);
      log('Clipped-peak repair', `Reconstructed ${r.runs} flat-topped peak${r.runs > 1 ? 's' : ''} (${r.samples} samples), up to ${r.maxOvershootDb.toFixed(1)} dB above the old clip level${r.skippedLongRuns ? `; ${r.skippedLongRuns} run(s) longer than 2.5 ms were left alone` : ''}.`);
      repairs.declip = r;
    } else log('Clipped-peak repair', 'No flat-topped peaks found; nothing changed.');
  }
  if (s.clickRepair > 0) {
    progress('Repair: clicks', 0.24);
    const det = detectClicks(chs, sr, { sensitivity: s.clickRepair });
    const r = repairClicks(chs, sr, det);
    log('Click repair', det.count
      ? `Reconstructed ${det.count} isolated click${det.count > 1 ? 's' : ''} (${r.samples} samples, ${det.perMinute.toFixed(1)}/min). Left alone: ${det.skippedOnsets} onset-like, ${det.skippedClusters} clustered, ${det.skippedLong} long events.`
      : 'No isolated clicks found; nothing changed.');
    repairs.clicks = { count: det.count, perMinute: det.perMinute, times: det.times, skippedOnsets: det.skippedOnsets, skippedClusters: det.skippedClusters };
  }
  if (s.hum > 0) {
    progress('Repair: hum', 0.25);
    const det = scan.hum || detectHum(chs, sr);
    const r = removeHum(chs, sr, det, { amount: s.hum });
    log('Hum removal', det.detected
      ? `${det.mains} Hz mains hum (measured ${det.f0.toFixed(2)} Hz): ${r.filters.length} narrow cuts, ${r.filters.map((f) => `${Math.round(f.freq)} Hz ${f.gainDb.toFixed(0)} dB`).join(', ')}.`
      : 'No steady 50/60 Hz harmonic series found; nothing changed.', { filters: r.filters });
    repairs.hum = { ...det, filters: r.filters };
  }
  if (s.denoise > 0) {
    progress('Repair: noise reduction', 0.26);
    const r = denoise(chs, sr, { amount: s.denoise, onProgress: (f) => progress('Repair: noise reduction', 0.26 + f * 0.03) });
    chs = r.chs;
    log('Noise reduction', r.report.applied
      ? `${r.report.reason} Floor ${r.report.floorDbfs.toFixed(0)} dBFS; average reduction ${r.report.avgReductionDb.toFixed(1)} dB across the spectrum, at most ${(6 + 12 * s.denoise).toFixed(0)} dB.`
      : `${r.report.reason} Nothing changed.`);
    repairs.denoise = r.report;
  }

  if (s.balanceRepair && Math.abs(inputAnalysis.stereo.balanceDb) > 0.5) {
    const corr = Math.min(3, Math.abs(inputAnalysis.stereo.balanceDb));
    const louder = inputAnalysis.stereo.balanceDb > 0 ? 0 : 1;
    gain([chs[louder]], -corr);
    log('Stereo balance', `${louder === 0 ? 'Left' : 'Right'} channel was ${Math.abs(inputAnalysis.stereo.balanceDb).toFixed(2)} dB louder; trimmed by ${corr.toFixed(2)} dB.`, { trimDb: corr });
  }
  if (s.bandBalance) {
    const bb = bandBalance(chs, sr);
    const moved = bb.bands.filter((b) => b.trimDb);
    log('Per-band balance', moved.length
      ? moved.map((b) => `${b.name}: ${b.side} ${Math.abs(b.diffDb).toFixed(1)} dB louder, trimmed ${b.trimDb.toFixed(1)} dB`).join('; ') + '.'
      : `Bands within 1 dB (${bb.bands.map((b) => `${b.name} ${b.diffDb.toFixed(1)}`).join(', ')} dB); nothing changed.`);
    repairs.bandBalance = bb;
  }

  const stageGain = clampGain(-20 - inputAnalysis.loudness.integrated);
  gain(chs, stageGain);
  dcBlock(chs, sr, 5);
  log('Gain staging', `Brought the input from ${inputAnalysis.loudness.integrated.toFixed(1)} LUFS to about -20 LUFS (${stageGain >= 0 ? '+' : ''}${stageGain.toFixed(1)} dB) and removed DC offset.`, { gainDb: stageGain });
  progress('Tone shaping', 0.3);

  const bw = inputAnalysis.spectrum.bandwidth;
  const guard = s.bandwidthGuard && bw?.limited;
  let air = s.air;
  if (guard && air > 0 && bw.bandwidthHz < 14000) {
    air = 0;
    log('Bandwidth guard', `Source content ends near ${(bw.bandwidthHz / 1000).toFixed(1)} kHz, so the 12 kHz air shelf was skipped.`);
  }
  const tilt = s.tilt + (s.tiltTrim || 0);
  // Cuts are narrow, boosts wide (the mid bell's width follows its sign).
  const extra = [];
  if (s.deMud > 0) extra.push({ type: 'peaking', freq: s.deMudFreq || 300, q: 1.4, gain: -3 * s.deMud });
  if (s.nasalCut > 0) extra.push({ type: 'peaking', freq: s.nasalFreq || 700, q: 3, gain: -s.nasalCut });
  if (s.harshCut > 0) extra.push({ type: 'peaking', freq: s.harshFreq || 3000, q: 3, gain: -s.harshCut });
  // Treble and air boosts are dynamic (below); cuts stay static.
  toneEq(chs, sr, { hpf: s.hpf, low: s.low, mid: s.mid, midQ: s.mid > 0 ? 0.7 : 1.4, high: Math.min(0, s.high), tilt, air: 0, extra });
  const shine = [];
  if (s.high > 0) shine.push(dynamicShelf(chs, sr, { freq: 7000, gainDb: s.high }));
  if (air > 0) shine.push(dynamicShelf(chs, sr, { freq: Math.min(12000, sr * 0.4), gainDb: air }));
  log('Tone EQ', [
    s.hpf ? `High-pass ${s.hpf} Hz` : 'No high-pass',
    s.low ? `low shelf ${fmt(s.low)} dB` : null,
    s.mid ? `mid ${fmt(s.mid)} dB (${s.mid > 0 ? 'wide boost' : 'narrower cut'})` : null,
    s.high < 0 ? `high shelf ${fmt(s.high)} dB` : null,
    tilt ? `tilt ${fmt(tilt)} dB${s.tiltTrim ? ` (incl. ${fmt(s.tiltTrim)} dB release cohesion)` : ''}` : null,
    s.deMud ? `low-mid cut ${fmt(-3 * s.deMud)} dB at ${s.deMudFreq} Hz` : null,
    s.nasalCut ? `narrow ${fmt(-s.nasalCut)} dB cut at ${s.nasalFreq} Hz (boxy, nasal)` : null,
    s.harshCut ? `narrow ${fmt(-s.harshCut)} dB cut at ${s.harshFreq} Hz (harsh)` : null,
  ].filter(Boolean).join(', ') + '.');
  for (const d of shine.filter(Boolean)) {
    log('Dynamic shine', `${fmt(d.gainDb)} dB shelf above ${d.freq >= 1000 ? `${(d.freq / 1000).toFixed(d.freq % 1000 ? 1 : 0)} kHz` : `${d.freq} Hz`}: ${fmt(d.minDb)} dB always, the rest backing off while cymbals, snares or sibilance are already loud (average ${fmt(d.avgDb)} dB).`, { curve: d.curve });
  }

  let refInfo = null;
  let staticCurve = null;
  let hfBoost = s.high > 0 || tilt > 0 || air > 0;
  if (profile) {
    progress('Matching the sound profile', 0.36);
    const srcSpec = ltas(chs, sr);
    const refSpec = profileSpectrum(profile, srcSpec.N, sr);
    // Kept within ±4 dB: a bigger difference is better fixed in the mix.
    const wide = referenceCurve(srcSpec, refSpec, { strength: s.refStrength, maxDb: 12 });
    staticCurve = referenceCurve(srcSpec, refSpec, { strength: s.refStrength, maxDb: 4 });
    const wantMax = Math.max(...Array.from(wide, Math.abs));
    const binHz = sr / srcSpec.N;
    if (guard) {
      const kb = Math.floor((bw.bandwidthHz * 0.95) / binHz);
      for (let k = kb; k < staticCurve.length; k++) if (staticCurve[k] > 0) staticCurve[k] = 0;
    }
    for (let k = Math.floor(8000 / binHz); k < staticCurve.length; k++) if (staticCurve[k] > 0.5) { hfBoost = true; break; }
    const centers = bandCenters(3, 31.5, 16000);
    const curvePts = centers.map((f) => ({ freq: Math.round(f), db: staticCurve[Math.min(staticCurve.length - 1, Math.round(f / binHz))] }));
    refInfo = {
      curve: curvePts,
      referenceLufs: 0,
      referenceBands: bandLevels(refSpec, bandCenters(6, 20, Math.min(20000, sr * 0.48)), 6),
      profile: { name: profile.name, count: profile.count, sources: profile.sources, lufs: profile.lufs, lra: profile.lra, plr: profile.plr, widthDb: profile.widthDb },
    };
    const biggest = [...curvePts].sort((a, b) => Math.abs(b.db) - Math.abs(a.db)).slice(0, 3);
    const label = profile.name ? `sound profile “${profile.name}”` : profile.count > 1 ? `the average of ${profile.count} references` : 'the reference';
    log('Reference match', `Tonal balance moved ${Math.round(s.refStrength * 100)}% toward ${label}. Largest moves: ${biggest.map((p) => `${fmt(p.db)} dB at ${p.freq} Hz`).join(', ')}.${wantMax > 4.5 ? ` Matching fully would take up to ${wantMax.toFixed(1)} dB; the master stops at 4 dB, as a bigger change sounds better made in the mix.` : ''}${guard ? ` Boosts above ${(bw.bandwidthHz / 1000).toFixed(1)} kHz were removed by the bandwidth guard.` : ''}`, { curve: curvePts });
  }

  let resonanceReport = null;
  if (staticCurve || s.resonance > 0) {
    progress('Resonance control', 0.42);
    const res = spectralProcess(chs, sr, { staticCurve, resonance: s.resonance, onProgress: (f) => progress('Resonance control', 0.42 + f * 0.12) });
    chs[0] = res.chs[0];
    chs[1] = res.chs[1];
    resonanceReport = res.report;
    if (s.resonance > 0) {
      log('Resonance control', resonanceReport.topFrequencies.length
        ? `Active in ${resonanceReport.activePct.toFixed(0)}% of frames. Most-treated regions: ${resonanceReport.topFrequencies.slice(0, 4).map((r) => `${r.freq} Hz`).join(', ')}.`
        : 'No narrow resonances exceeded the threshold.', { map: resonanceReport.map });
    }
  }

  if (guard && hfBoost && bw.bandwidthHz < sr * 0.42) {
    const fc = Math.min(sr * 0.45, bw.bandwidthHz * 1.1);
    const lp = [design('lowpass', fc, sr, 0.5412), design('lowpass', fc, sr, 1.3066)];
    for (const ch of chs) cascade(lp, ch, ch);
    log('Bandwidth guard', `High-frequency boosts were applied, so a 24 dB/oct low-pass at ${(fc / 1000).toFixed(1)} kHz keeps them from lifting noise above the source's ${(bw.bandwidthHz / 1000).toFixed(1)} kHz bandwidth.`);
  }

  let box = null;
  if (s.deBox > 0.01) {
    progress('Low-mid de-box', 0.55);
    // Auto: where the analysis found the most low-mid build-up (1/3-octave, against the spectral trend).
    const t = inputAnalysis.spectrum.tonal;
    const auto = !(s.deBoxFreq >= 150) && t.mudPeak.freq > 0 && t.mudPeak.db > 0;
    const freq = s.deBoxFreq >= 150 ? s.deBoxFreq : auto ? Math.round(t.mudPeak.freq) : 300;
    box = deBox(chs, sr, { amount: s.deBox, freq });
    log('Low-mid de-box', `Dynamic cut at ${freq} Hz${s.deBoxFreq >= 150 ? '' : auto ? ` (the low-mid peak, ${t.mudPeak.db.toFixed(1)} dB above the spectral trend)` : ' (default; no low-mid build-up measured)'}, only while that band rose above its usual share of the mix: avg ${box.avgGr.toFixed(2)} dB, max ${box.maxGr.toFixed(1)} dB, active ${box.activePct.toFixed(1)}% of the time.`);
  }

  progress('De-essing', 0.56);
  const de = deess(chs, sr, { amount: s.deess });
  if (s.deess > 0) log('De-esser', `Reduced sibilant moments in ${de.activePct.toFixed(1)}% of the track, up to ${de.maxGr.toFixed(1)} dB above ${4.5} kHz.`, de);

  progress('Attack and sustain', 0.59);
  const as = attackSustain(chs, sr, { attack: s.attack, sustain: s.sustain });
  if (as) log('Attack / sustain', `Attack ${fmt(s.attack * 100)}%, sustain ${fmt(s.sustain * 100)}%: up to +${as.maxBoostDb.toFixed(1)} dB / -${as.maxCutDb.toFixed(1)} dB of shaping.`);
  const db = bassDebloom(chs, sr, { amount: s.bassDebloom });
  if (db) log('Bass de-bloom', `Sustained ringing below ${db.freq} Hz shortened by up to ${db.maxGr.toFixed(1)} dB, active ${db.activePct.toFixed(1)}% of the time (only while the low end is above its typical level).`);

  // Reverb on the whole song, before the compressors so they hold it together.
  // Lows stay dry; the level is set against the song's own loudness.
  if (s.verb > 0.005) {
    progress('Reverb', 0.61);
    const decay = 0.9 + 1.1 * Math.min(1, s.verb);
    const wet = reverb(chs[0], chs[1], sr, { kind: 'plate', decay, predelayMs: 18, hp: 300, lp: 8000 });
    const relLu = -30 + 18 * Math.min(1, s.verb);
    const dry = integratedLufs(chs, sr), lw = integratedLufs(wet, sr);
    if (dry > -70 && lw > -100) addInto(chs, wet, Math.pow(10, (dry + relLu - lw) / 20));
    log('Reverb', `A ${decay.toFixed(1)} s plate blended in ${Math.abs(relLu).toFixed(0)} LU under the song, with everything below 300 Hz kept dry.`);
  }

  progress('Multiband dynamics', 0.62);
  let mb = null;
  if (s.multiband > 0.01) {
    const a = s.multiband;
    mb = multiband(chs, sr, {
      xLow: s.xLow, xHigh: s.xHigh,
      bands: [
        { ratio: 1.5 + 2.5 * a, attack: 25, release: 180, knee: 8, rmsMs: 10, thresholdPct: 0.75, thresholdOffset: -6 * a },
        { ratio: 1.4 + 2 * a, attack: 12, release: 140, knee: 8, rmsMs: 5, thresholdPct: 0.75, thresholdOffset: -6 * a },
        { ratio: 1.4 + 2 * a, attack: 4, release: 90, knee: 8, rmsMs: 3, thresholdPct: 0.75, thresholdOffset: -6 * a },
      ],
    });
    const names = ['Low', 'Mid', 'High'];
    log('Multiband compression', mb.bands.map((b, i) => `${names[i]}: avg ${b.avgGr.toFixed(1)} dB, max ${b.maxGr.toFixed(1)} dB at ${b.ratio.toFixed(1)}:1`).join('; ') + `. Crossovers ${s.xLow} Hz / ${s.xHigh} Hz.`, { bands: mb.bands.map(stripCurve) });
  }

  progress('Glue compression', 0.7);
  let glue = null;
  if (s.glue > 0.01) {
    glue = compress(chs, sr, { ratio: 1.3 + 1.2 * s.glue, attack: 30, release: 200, knee: 10, rmsMs: 15, thresholdPct: 0.7, thresholdOffset: -4 * s.glue });
    log('Glue compression', `Average ${glue.avgGr.toFixed(1)} dB, max ${glue.maxGr.toFixed(1)} dB at ${glue.ratio.toFixed(2)}:1 with slow attack to keep transients.`, stripCurve(glue));
  }

  const sd = sectionDynamics(chs, sr, { amount: s.sectionDyn, windowSec: s.sectionWindow });
  if (sd) log('Section-aware dynamics', `Short outliers more than ${sd.threshold.toFixed(1)} dB above their ${sd.windowSec} s section were turned down: avg ${sd.avgGr.toFixed(2)} dB, max ${sd.maxGr.toFixed(1)} dB, active ${sd.activePct.toFixed(0)}% of the time. Section-to-section contrast is kept.`);

  progress('Saturation', 0.74);
  if (s.saturation > 0) {
    saturate(chs, sr, { drive: s.saturation, mode: s.satMode });
    log('Saturation', `${s.satMode} saturation at ${s.saturation.toFixed(1)} dB drive, 2x oversampled.`);
  }
  if (s.exciter > 0.005) {
    progress('Exciter', 0.76);
    exciter(chs, sr, { amount: s.exciter });
    log('Exciter', `Fresh harmonics added above 3.5 kHz only (${Math.round(s.exciter * 100)}%), more in quiet passages and less in loud ones. The lows and mids are untouched.`);
  }

  progress('Stereo image', 0.78);
  let wf = [1, 1, 1];
  if (profile && s.profileWidth > 0) wf = profileWidthFactors(profile, inputAnalysis.stereo.sideToMidBands, s.profileWidth);
  const wt = s.widthTrim || 1;
  const want = [s.widthLow * wf[0] * wt, s.widthMid * wf[1] * wt, s.widthHigh * wf[2] * wt];
  const wd = multibandWidth(chs, sr, { low: want[0], mid: want[1], high: want[2], monoHz: s.monoBass });
  if (s.monoBass || wd.requested.some((w) => Math.abs(w - 1) > 0.005)) {
    const notes = [];
    if (wf.some((f) => f !== 1)) notes.push(`profile width x${wf.map((f) => f.toFixed(2)).join('/')}`);
    if (wt !== 1) notes.push(`release cohesion x${wt.toFixed(2)}`);
    log('Stereo image', `Width low/mid/high ${wd.applied.map((w) => w.toFixed(2)).join(' / ')}${notes.length ? ` (${notes.join(', ')})` : ''}${wd.applied.some((w, i) => w < wd.requested[i]) ? ' (limited by correlation protection)' : ''}${s.monoBass ? `; mono below ${s.monoBass} Hz` : ''}.`, wd);
  }

  if (s.hiss > 0.005) {
    progress('Tape hiss', 0.79);
    const h = tapeHiss(chs, sr, { amount: s.hiss });
    if (h) log('Tape hiss', `Shaped tape noise added ${Math.abs(h.relLu).toFixed(0)} LU under the music, so it shows mostly in quiet passages and fades.`);
  }

  // Last before the limiter: it needs to know where the limiter will start.
  let hfr = null;
  if (s.hfReserve > 0.01) {
    progress('High-frequency peak reserve', 0.8);
    const expectedGain = s.targetLufs - integratedLufs(chs, sr);
    const limitAt = Math.pow(10, (s.ceiling - expectedGain) / 20);
    hfr = hfPeakReserve(chs, sr, { amount: s.hfReserve, limitAt });
    log('High-frequency peak reserve', hfr.maxGr > 0.05
      ? `Above 5 kHz, peaks that would have reached the limiter were turned down by up to ${hfr.maxGr.toFixed(1)} dB (active ${hfr.activePct.toFixed(2)}% of the time). Samples the limiter must catch: ${hfr.overBeforePct.toFixed(2)}% → ${hfr.overAfterPct.toFixed(2)}%; highest peak over its threshold ${hfr.peakOverBeforeDb.toFixed(1)} → ${hfr.peakOverAfterDb.toFixed(1)} dB.`
      : 'The high band was not driving the limiter’s peaks; nothing changed.');
  }
  return {
    chs, stages, refInfo, resonanceReport, repairs,
    curves: { glue: glue?.curve, multiband: mb?.bands.map((b) => b.curve), shaper: as?.curve, debloom: db?.curve, section: sd?.curve, sectionStep: sd?.curveStepSec, deBox: box?.curve, hfReserve: hfr?.curve },
  };
}

function stripCurve(o) {
  const { curve, ...rest } = o;
  return rest;
}

function fmt(v) {
  return `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}`;
}

export function master(audio, settings, { references = [], profile = null, deliverables = {}, progress = () => {} } = {}) {
  const s = { ...MASTER_DEFAULTS, ...settings };
  const sr = audio.sr;
  const input = audio.channels.length > 1 ? audio.channels.slice(0, 2) : [audio.channels[0], audio.channels[0]];
  const t0 = performance.now();
  progress('Analysing the input', 0.02);
  const inputAnalysis = analyze({ sr, channels: input }, { repairScan: true, progress: (st, f) => progress(`Analysing: ${st}`, 0.02 + f * 0.2) });
  if (!profile && references.length) {
    progress('Learning the reference profile', 0.21);
    profile = learnProfile(references, { names: references.map((r) => r.name || '') });
  }
  if (profile && s.profileLoudness) s.targetLufs = Math.round(Math.max(-24, Math.min(-6, profile.lufs)) * 10) / 10;
  // Auto profile: start from the analysis suggestions. Loudness target, ceiling
  // and anything the user changed by hand (`locked`) are left alone.
  const autoApplied = {};
  if (s.auto) {
    const locked = new Set(settings.locked || []);
    for (const [k, v] of Object.entries(inputAnalysis.suggestions.settings)) {
      if (k === 'targetLufs' || k === 'ceiling' || locked.has(k)) continue;
      s[k] = v;
      autoApplied[k] = v;
    }
  }

  // Oversampled processing: the whole chain and the limiter run at twice the
  // rate, then a linear-phase half-band filter brings it back and a final
  // limiter pass at the source rate catches any overshoot from the conversion.
  const os = s.oversample === 2 && sr <= 48000 ? 2 : 1;
  const wsr = sr * os;
  let work = input, chainAnalysis = inputAnalysis;
  if (os === 2) {
    progress('Oversampling to 2x', 0.215);
    work = input.map(upsample2);
    const sd0 = inputAnalysis.repair?.stereoDelay;
    chainAnalysis = sd0 ? { ...inputAnalysis, repair: { ...inputAnalysis.repair, stereoDelay: { ...sd0, lagSamples: sd0.lagSamples * 2 } } } : inputAnalysis;
  }
  const finalizeOut = (chs, vs, cache = {}) => {
    const f = finalize(chs, wsr, vs, cache);
    if (os === 1) return f;
    const g = finalize(f.chs.map(downsample2), sr, vs);
    return { ...g, gainDb: f.gainDb + g.gainDb, iterations: f.iterations, convertGrDb: g.limiter.maxGr, limiter: { ...f.limiter, maxGr: Math.max(f.limiter.maxGr, g.limiter.maxGr) } };
  };

  const chain = processChain(work, wsr, s, { profile, progress, inputAnalysis: chainAnalysis });
  if (os === 2) chain.stages.unshift({ stage: 'Oversampled processing', detail: `Every stage below ran at ${(wsr / 1000).toFixed(1)} kHz (2x the source), so saturation, fast dynamics and the limiter create less aliasing. Converted with a ${HALF_BAND.taps}-tap linear-phase half-band filter (flat to ${(HALF_BAND.passband * sr / 1000).toFixed(1)} kHz, about 100 dB rejection above).` });
  progress('Loudness and true-peak limiting', 0.82);
  const finCache = {};
  const fin = finalizeOut(chain.chs, s, finCache);
  chain.stages.push({
    stage: 'Loudness + limiter',
    detail: `Gain ${fmt(fin.gainDb)} dB into a true-peak limiter (ceiling ${s.ceiling} dBTP, ${s.lookahead} ms look-ahead, ${s.release} ms release that adapts: quicker after short peaks, slower when limiting is held). Reached ${fin.achievedLufs.toFixed(2)} LUFS at ${fin.truePeakDbtp.toFixed(2)} dBTP in ${fin.iterations} pass(es). Limiter: avg ${fin.limiter.avgGr.toFixed(2)} dB, max ${fin.limiter.maxGr.toFixed(1)} dB, active ${fin.limiter.activePct.toFixed(1)}% of the time.${os === 2 ? ` After converting back to ${(sr / 1000).toFixed(1)} kHz, a final pass caught up to ${fin.convertGrDb.toFixed(2)} dB of conversion overshoot.` : ''}`,
  });
  const warnings = [];
  if (fin.limiter.maxGr > 8 || fin.limiter.avgGr > 2) warnings.push(`The limiter is working hard to reach ${s.targetLufs} LUFS (up to ${fin.limiter.maxGr.toFixed(1)} dB, ${fin.limiter.avgGr.toFixed(1)} dB on average; 1-3 dB is the comfortable range). Hits may sound flattened. A slightly lower loudness target will keep more punch and feeling.`);
  if (Math.abs(fin.achievedLufs - s.targetLufs) > 0.5) warnings.push(`Target ${s.targetLufs} LUFS could not be reached exactly (got ${fin.achievedLufs.toFixed(2)} LUFS).`);

  progress('Analysing the master', 0.88);
  const outputAnalysis = analyze({ sr, channels: fin.chs }, { progress: (st, f) => progress(`Analysing master: ${st}`, 0.88 + f * 0.08) });

  const extras = [];
  if (deliverables.platformPack) {
    for (const p of PLATFORM_TARGETS) {
      progress(`Delivery: ${p.label}`, 0.96);
      const f = finalizeOut(chain.chs, { ...s, targetLufs: p.lufs, ceiling: p.ceiling }, finCache);
      extras.push({ kind: 'platform', key: p.key, label: p.label, chs: f.chs, lufs: f.achievedLufs, dbtp: f.truePeakDbtp, maxGr: f.limiter.maxGr });
    }
  }
  if (deliverables.variations) {
    for (const [key, ov] of Object.entries(VARIATION_OVERRIDES)) {
      progress(`Variation: ${key}`, 0.97);
      const vs = { ...s, ...ov };
      const c = processChain(work, wsr, vs, { profile, progress: () => {}, inputAnalysis: chainAnalysis });
      const f = finalizeOut(c.chs, vs);
      extras.push({ kind: 'variation', key, label: key[0].toUpperCase() + key.slice(1), chs: f.chs, lufs: f.achievedLufs, dbtp: f.truePeakDbtp, maxGr: f.limiter.maxGr });
    }
  }
  if (deliverables.mono) {
    progress('Delivery: mono master', 0.975);
    const L = chain.chs[0], R = chain.chs[1];
    const m = new Float32Array(L.length);
    for (let i = 0; i < m.length; i++) m[i] = 0.5 * (L[i] + R[i]);
    // Loudness is matched as dual-mono, i.e. as heard on two speakers.
    const f = finalizeOut([m, m], s);
    extras.push({ kind: 'mono', key: 'mono', label: 'Mono / radio', chs: [f.chs[0]], lufs: f.achievedLufs, dbtp: f.truePeakDbtp, maxGr: f.limiter.maxGr });
  }
  if (deliverables.vinyl) {
    progress('Delivery: vinyl pre-master', 0.98);
    const vs = { ...s, ...vinylOverrides(s) };
    const c = processChain(work, wsr, vs, { profile, progress: () => {}, inputAnalysis: chainAnalysis });
    // Vinyl wants its transients: pick the loudness that needs at most about 1 dB of limiting.
    vs.targetLufs = Math.min(vs.targetLufs, integratedLufs(c.chs, wsr) + (vs.ceiling + 1 - truePeak(c.chs, wsr).dbtp));
    const f = finalizeOut(c.chs, vs);
    extras.push({ kind: 'vinyl', key: 'vinyl', label: 'Vinyl / cassette pre-master', chs: f.chs, lufs: f.achievedLufs, dbtp: f.truePeakDbtp, maxGr: f.limiter.maxGr });
  }
  if (deliverables.spatial) {
    // Upmixed from the processed (pre-limiter) chain at the source rate, then
    // limited and loudness-matched on its own with BS.1770 channel weights.
    const sp = deliverables.spatial;
    progress(`Delivery: ${sp.layout} spatial upmix`, 0.985);
    const base = os === 2 ? chain.chs.map(downsample2) : chain.chs;
    const up = upmix(base, sr, { layout: sp.layout, centre: sp.centre, surround: sp.surround, lfeDb: sp.lfeDb });
    const weights = loudnessWeights(sp.layout);
    const f = finalize(up.chs, sr, { ...s, targetLufs: sp.targetLufs ?? -18, ceiling: sp.ceiling ?? -1, weights });
    extras.push({
      kind: 'spatial', key: `spatial_${sp.layout.replace(/\./g, '')}`, label: `Spatial ${sp.layout}`, layout: sp.layout, chs: f.chs, lufs: f.achievedLufs, dbtp: f.truePeakDbtp, maxGr: f.limiter.maxGr,
      ambiencePct: up.ambiencePct, centrePct: up.centrePct, levels: channelLevels(f.chs, sp.layout), settings: sp,
    });
  }
  // Level-match the variations for fair comparison (reported, not applied).
  const playback = PLAYBACK_NORMALISATION.map((p) => ({ ...p, gainDb: Math.min(0, p.target - fin.achievedLufs) }));

  return {
    channels: fin.chs,
    extras,
    report: {
      settings: s,
      autoApplied,
      input: inputAnalysis,
      output: outputAnalysis,
      stages: chain.stages,
      warnings,
      reference: chain.refInfo,
      profile,
      repairs: chain.repairs,
      resonance: chain.resonanceReport,
      curves: { ...chain.curves, limiter: fin.limiter.curve, stepSec: fin.limiter.curveStepSec },
      playbackNormalisation: playback,
      timing: { seconds: (performance.now() - t0) / 1000 },
    },
  };
}

export { measureLoudness };
