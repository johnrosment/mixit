// Stem mixing session. Stems are processed one at a time (to keep memory flat)
// and summed into category buses; bus-level processing, ducking, the vocal
// rider, effects returns and the mix bus run in finish().

import { integratedLufs, hopEnergies, truePeak, lin2db } from './loudness.js';
import { compress, deess, transientShape, detectorDb, percentileDb } from './dynamics.js';
import { toneEq, width, pan, gain, reverb, delay, addInto, saturate, chorus } from './effects.js';
import { design, cascade, lr4Split2, lr4Split3, zeroPhaseLowpass } from './filters.js';
import { analyze } from './analyze.js';
import { ltas, bandCenters, bandLevels, referenceCurve, spectralProcess, rhythm } from './spectral.js';
import { finalize } from './master.js';
import { bedFromBuses, loudnessWeights, channelLevels } from './spatial.js';
import { tuneVocal, SCALES } from './pitch.js';
import { detectSections, sectionMoves, sectionCurve } from './sections.js';
import { roughFeatures, stemFeatures, addFeatures, fitBalance } from './roughmix.js';
import { lowCutFreq, resonantCuts } from './stemtools.js';
import { levelSpeech, duckUnderSpeech, deliveryCheck, fadeEdits, mouthDeclick, FRAME_RATES } from './post.js';
import { denoise, detectClicks, repairClicks } from './repair.js';

export const BUS_KEYS = ['vocals', 'drums', 'bass', 'music', 'fx', 'ambience'];

// Loudness each bus is balanced to before the mix bus (relative balance only;
// the output stage sets the final level).
const BUS_TARGETS = { vocals: -18, drums: -20, bass: -21, music: -19.5, fx: -27, ambience: -30 };
// Video, ad and podcast: dialogue leads, music and effects sit under it, ambience is a quiet bed.
const POST_TARGETS = { vocals: -20, drums: -27, bass: -27, music: -25, fx: -26, ambience: -32 };
const VOICE_LUFS = -24; // each voice is brought to this before the bus, so speakers match
const SUPPORT_OFFSET = -6; // doubles/backing relative to lead vocal
// Video, ad and podcast stems that get click removal and edit fades.
const EDIT_KINDS = { vocals: 'dialogue', fx: 'effects', ambience: 'ambience' };

const TONES = {
  neutral: [],
  bright: [{ type: 'highshelf', freq: 6000, q: 0.7, gain: 2 }, { type: 'lowshelf', freq: 150, q: 0.7, gain: -0.5 }],
  dark: [{ type: 'highshelf', freq: 6000, q: 0.7, gain: -2.5 }, { type: 'lowshelf', freq: 200, q: 0.7, gain: 0.8 }],
  warm: [{ type: 'peaking', freq: 250, q: 0.8, gain: 1.2 }, { type: 'highshelf', freq: 9000, q: 0.7, gain: -1.2 }],
};

const stereoBuf = (n) => [new Float32Array(n), new Float32Array(n)];

// Compression by instrument: vocals level gently (medium attack, fast
// release); percussion takes high ratios with quick times; kick, snare and
// toms keep their attack; bass sits at 3-6:1; keys and pads stay light.
function compSettings(st) {
  const c = st.comp, punch = st.compMode === 'punch';
  const base = { knee: 6, thresholdPct: 0.75, thresholdOffset: -8 * c };
  if (st.category === 'vocals') return { ...base, ratio: 1.6 + 1.6 * c + (st.role === 'lead' ? 0 : 0.6), attack: punch ? 20 : 12, release: 70, rmsMs: 5 };
  if (st.category === 'drums') {
    if (st.drumRole === 'perc') return { ...base, ratio: 3 + 5 * c, attack: punch ? 8 : 3, release: 30, knee: 4, rmsMs: 0, thresholdPct: 0.8 };
    if (st.drumRole === 'cymbals') return { ...base, ratio: 1.5 + 1.5 * c, attack: 5, release: 80, rmsMs: 2 };
    if (st.drumRole === 'kick' || st.drumRole === 'snare' || st.drumRole === 'toms') return { ...base, ratio: 1.5 + 2.5 * c, attack: punch ? 18 : 10, release: 80, rmsMs: 0, thresholdPct: 0.8, thresholdOffset: -6 * c };
    return { ...base, ratio: 1.5 + 3.5 * c, attack: punch ? 18 : 6, release: 90, rmsMs: 0 };
  }
  if (st.category === 'bass') return { ...base, ratio: 2.5 + 3.5 * c, attack: punch ? 15 : 8, release: 90, rmsMs: 5 };
  if (st.category === 'music') return { ...base, ratio: 1.3 + 1.4 * c, attack: punch ? 25 : 15, release: 150, knee: 8, rmsMs: 10, thresholdOffset: -6 * c };
  return { ...base, ratio: 1.5 + 3.5 * c, attack: punch ? 18 : 4, release: punch ? 140 : 110, rmsMs: punch ? 0 : 5 };
}

// Highest the automatic high-pass may go, by instrument (kick, bass and full
// drum kits keep their lows).
function hpfCap(st) {
  if (st.category === 'bass') return 0;
  if (st.category === 'drums') return st.drumRole === 'cymbals' ? 250 : st.drumRole === 'snare' || st.drumRole === 'toms' || st.drumRole === 'perc' ? 100 : 0;
  if (st.category === 'vocals') return st.role === 'lead' ? 120 : 180;
  return st.category === 'fx' ? 150 : 120;
}

const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function fmt(v, d = 1) {
  return `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}`;
}

function envDb(chs, sr, attackMs, releaseMs) {
  const n = chs[0].length;
  const aA = Math.exp(-1 / (attackMs * 1e-3 * sr)), aR = Math.exp(-1 / (releaseMs * 1e-3 * sr));
  const out = new Float32Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const ch of chs) { const v = ch[i] * ch[i]; if (v > m) m = v; }
    e = m > e ? aA * e + (1 - aA) * m : aR * e + (1 - aR) * m;
    if (e < 1e-30) e = 0;
    out[i] = e > 1e-12 ? 10 * Math.log10(e) : -120;
  }
  return out;
}

function smoothGain(targetDb, sr, attackMs, releaseMs) {
  const n = targetDb.length;
  const aA = Math.exp(-1 / (attackMs * 1e-3 * sr)), aR = Math.exp(-1 / (releaseMs * 1e-3 * sr));
  const out = new Float32Array(n);
  let g = 0;
  for (let i = 0; i < n; i++) {
    const t = targetDb[i];
    g = t < g ? aA * g + (1 - aA) * t : aR * g + (1 - aR) * t;
    out[i] = g;
  }
  return out;
}

function stats(arr) {
  let min = 0, sum = 0, active = 0;
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v < min) min = v; sum += v; if (v < -0.5) active++; }
  return { maxGr: -min, avgGr: -sum / arr.length, activePct: (100 * active) / arr.length };
}

export class MixSession {
  constructor(settings, sr, length) {
    this.s = settings;
    this.sr = sr;
    this.n = length;
    this.buses = { vocalLead: stereoBuf(length), vocalSupport: stereoBuf(length), drums: stereoBuf(length), bass: stereoBuf(length), music: stereoBuf(length), fx: stereoBuf(length) };
    this.used = {};
    this.rawSum = stereoBuf(length);
    this.stemReports = [];
    this.anySolo = settings.stems.some((st) => st.solo && !st.mute);
    this.edits = { clicks: 0, fades: 0, hard: 0, blips: 0 };
    // Pitch-correction key: fixed, chromatic, or detected from the first tuned vocal and reused.
    const k = settings.tuneKey || 'auto';
    this.tuneKey = k === 'auto' ? null : k === 'chromatic' ? { root: 0, scale: 'chromatic' } : { root: Number(k.split(':')[0]), scale: k.split(':')[1] };
  }

  /** Your own bounce of the song: the reference for bus balance and tone. */
  setRoughMix(audio) {
    this.rough = roughFeatures(audio.channels, this.sr);
    this.roughBus = {};
    return { lufs: this.rough.lufs, seconds: this.rough.seconds };
  }

  addStem(index, audio) {
    const st = this.s.stems[index];
    const sr = this.sr, n = this.n;
    const src = audio.channels.length > 1 ? audio.channels.slice(0, 2) : [audio.channels[0], audio.channels[0]];
    const chs = [new Float32Array(n), new Float32Array(n)];
    for (let c = 0; c < 2; c++) chs[c].set(src[c].subarray(0, Math.min(n, src[c].length)));
    const inputLufs = integratedLufs(chs, sr);
    const inputPeak = truePeak(chs, sr).dbtp;
    const audible = !st.mute && (!this.anySolo || st.solo);
    const row = { index, name: st.name, category: st.category, role: st.role, audible, inputLufs, inputPeakDbtp: inputPeak, steps: [] };

    if (audible) addInto(this.rawSum, chs, 1);
    if (st.polarity) for (const ch of chs) for (let i = 0; i < n; i++) ch[i] = -ch[i];
    const post = this.s.mode === 'post';
    // Edit clean-up first, before anything reacts to the clicks: ticks and pops
    // rebuilt from the sound around them (crackles that repeat, and hits, are
    // left alone), mouth clicks in dialogue dipped in the upper band, then a
    // fade on every place a sound starts or stops.
    const kind = post && audible ? EDIT_KINDS[st.category] : null;
    const declick = this.s.declick ?? 0.5;
    if (kind && declick > 0.01) {
      const det = detectClicks(chs, sr, { sensitivity: 0.5 * declick });
      if (det.count) repairClicks(chs, sr, det);
      const mouth = kind === 'dialogue' ? mouthDeclick(chs, sr, { sensitivity: declick }).count : 0;
      const count = det.count + mouth;
      if (count) row.steps.push(`${count} click${count === 1 ? '' : 's'} removed${mouth ? ` (${mouth} mouth click${mouth === 1 ? '' : 's'})` : ''}`);
      this.edits.clicks += count;
    }
    const frames = Number(this.s.editFades ?? 1);
    if (kind && frames > 0) {
      const f = fadeEdits(chs, sr, { frames, fps: FRAME_RATES[this.s.frameRate] || FRAME_RATES['29.97'], kind });
      if (f.fades) row.steps.push(`Fades on ${f.fades / 2} sound${f.fades === 2 ? '' : 's'} (${f.fadeMs.toFixed(0)} ms${f.hard ? `; ${f.hard} hard cut${f.hard === 1 ? '' : 's'} smoothed` : ''})`);
      if (f.blips) row.steps.push(`${f.blips} stray click${f.blips === 1 ? '' : 's'} in the silence removed`);
      this.edits.fades += f.fades; this.edits.hard += f.hard; this.edits.blips += f.blips;
    }
    if (post && st.category === 'vocals' && audible && (this.s.dialogueDenoise || 0) > 0.01) {
      const r = denoise(chs, sr, { amount: this.s.dialogueDenoise });
      if (r.report.applied) { chs[0].set(r.chs[0]); chs[1].set(r.chs[1]); row.steps.push(`Background noise lowered (average ${r.report.avgReductionDb.toFixed(1)} dB)`); } else row.steps.push(`Noise reduction skipped: ${r.report.reason}`);
    }
    if (!post && st.category === 'vocals' && (st.tune || 0) > 0.01 && audible) {
      const t = tuneVocal(chs, sr, { key: this.tuneKey, strength: st.tune, speedMs: st.tuneSpeed ?? 40 });
      const r = t.report;
      if (r.applied) {
        chs[0].set(t.chs[0]);
        chs[1].set(t.chs[1]);
        if (!this.tuneKey && SCALES[r.key.scale]) { this.tuneKey = r.key; r.keySource = 'detected from this stem'; } else r.keySource = r.keySource || (this.s.tuneKey === 'auto' ? 'detected from an earlier vocal stem' : 'set by you');
        row.steps.push(`Pitch correction in ${r.keyName} (${Math.round(st.tune * 100)}%, retune ${r.speedMs ? `${r.speedMs} ms` : 'hard'}): ${r.beforeCents.toFixed(0)} → ${r.afterCents.toFixed(0)} cents from the nearest scale note`);
      } else row.steps.push(`Pitch correction skipped: ${r.reason}`);
      row.tune = r;
    }
    gain(chs, st.gain || 0);
    // Unprocessed levels per bus for matching your rough mix (after your stem gain).
    if (this.rough && audible) { const k = st.category in BUS_TARGETS ? st.category : 'music'; this.roughBus[k] = addFeatures(this.roughBus[k], stemFeatures(chs, sr)); }
    // High-pass everything but kick and bass: raised to just under where the
    // stem's useful low end starts (at most the cap for its type).
    let hpf = st.hpf || 0;
    const cap = hpfCap(st);
    if (st.hpfAuto !== false && audible && cap > hpf) {
      const probe = chs.map((ch) => ch.subarray(0, Math.min(n, sr * 120)));
      const auto = lowCutFreq(probe, sr, { min: hpf, max: cap });
      if (auto > hpf + 2) { row.steps.push(`High-pass raised ${hpf} → ${auto} Hz (nothing useful below)`); hpf = auto; }
    }
    row.hpf = hpf;
    toneEq(chs, sr, { hpf, low: st.eqLow, lowFreq: 120, mid: st.eqMid, midFreq: 1500, high: st.eqHigh, highFreq: 7000 });
    row.steps.push(`HPF ${hpf} Hz, EQ ${fmt(st.eqLow || 0)}/${fmt(st.eqMid || 0)}/${fmt(st.eqHigh || 0)} dB`);
    if (st.deess && st.category === 'vocals') {
      const d = deess(chs, sr, { amount: 0.55 });
      row.deess = d;
      row.steps.push(`De-ess active ${d.activePct.toFixed(1)}%, max ${d.maxGr.toFixed(1)} dB`);
    }
    // Harsh, metallic cymbals: a de-esser tuned higher.
    if (st.category === 'drums' && st.drumRole === 'cymbals' && audible) {
      const d = deess(chs, sr, { amount: 0.35, split: 6000 });
      row.steps.push(`Cymbal harshness tamed: active ${d.activePct.toFixed(1)}%, max ${d.maxGr.toFixed(1)} dB above 6 kHz`);
    }
    if (st.category === 'vocals' && audible) {
      // Narrow cuts where the voice sounds boxy (400-800 Hz) or nasal (2-4 kHz).
      const cuts = resonantCuts(chs, sr, [[400, 800, 'boxy'], [2000, 4000, 'nasal']], { minDb: 4, maxCut: 2.5, q: 4, trendBands: 4 });
      if (cuts.length) {
        toneEq(chs, sr, { extra: cuts.map((c) => ({ type: 'peaking', freq: c.freq, q: c.q, gain: c.gainDb })) });
        row.steps.push(`Narrow ${cuts.map((c) => `${fmt(c.gainDb)} dB at ${c.freq} Hz (${c.range})`).join(', ')}`);
      }
      // Dialogue: phrases brought toward the voice's typical level before compression.
      if (post && (this.s.dialogueLeveler ?? 0.6) > 0.01) {
        const lv = levelSpeech(chs, sr, { amount: this.s.dialogueLeveler ?? 0.6 });
        if (lv) row.steps.push(`Voice evened out: phrase-to-phrase spread ${lv.spreadBeforeDb.toFixed(1)} → ${lv.spreadAfterDb.toFixed(1)} dB (up to +${lv.maxBoostDb.toFixed(1)} / -${lv.maxCutDb.toFixed(1)} dB)`);
      }
      // Soft limiter catches the highest peaks first, so the compressor can stay gentle.
      if (st.comp > 0.01) {
        const l = compress(chs, sr, { ratio: 10, attack: 1, release: 60, knee: 8, rmsMs: 0, thresholdPct: 0.985, thresholdOffset: 0, makeup: 0, maxGr: 6 });
        row.steps.push(`Peak limiter on the loudest notes: max ${l.maxGr.toFixed(1)} dB`);
      }
    }
    if (st.comp > 0.01) {
      const c = compress(chs, sr, compSettings(st));
      row.comp = { ...c, curve: undefined };
      row.steps.push(`Compression ${c.ratio.toFixed(1)}:1 (${st.compMode === 'punch' ? 'punch' : 'smooth'}${st.drumRole ? `, ${st.drumRole}` : ''}), avg ${c.avgGr.toFixed(1)} dB, max ${c.maxGr.toFixed(1)} dB`);
    }
    if (!post && st.category === 'vocals' && audible) {
      // Light tape saturation on top for character.
      saturate(chs, sr, { drive: 3, mode: 'tape', mix: 0.3 });
      row.steps.push('Light tape saturation (30% blend)');
    }
    if ((st.width ?? 1) !== 1 || st.monoBass) {
      width(chs, { amount: st.width ?? 1, monoHz: st.monoBass ? 120 : 0, sr });
      row.steps.push(`Width ${(st.width ?? 1).toFixed(2)}${st.monoBass ? ', mono < 120 Hz' : ''}`);
    }
    if (st.pan) { pan(chs, st.pan); row.steps.push(`Pan ${st.pan > 0 ? 'R' : 'L'}${Math.round(Math.abs(st.pan) * 100)}`); }
    // Every voice at the same loudness, so speakers and takes match.
    if (post && st.category === 'vocals' && audible && this.s.matchVoices !== false) {
      const l = integratedLufs(chs, sr);
      if (l > -70) { gain(chs, VOICE_LUFS - l); row.steps.push(`Voice matched to ${VOICE_LUFS} LUFS (${fmt(VOICE_LUFS - l)} dB)`); }
    }
    row.processedLufs = integratedLufs(chs, sr);
    if (audible) {
      let bus = st.category;
      if (bus === 'vocals') bus = st.role === 'lead' ? 'vocalLead' : 'vocalSupport';
      if (bus === 'ambience' && !this.buses.ambience) this.buses.ambience = stereoBuf(n);
      if (!this.buses[bus]) bus = 'music';
      addInto(this.buses[bus], chs, 1);
      this.used[bus] = true;
      row.bus = bus;
    }
    this.stemReports.push(row);
    return row;
  }

  finish(progress = () => {}) {
    const s = this.s, sr = this.sr, n = this.n;
    const B = this.buses;
    const log = [];
    const busReports = {};
    const balance = s.autoBalance !== false;
    const post = s.mode === 'post';

    // --- Vocal lead / support balance ---
    progress('Balancing vocals', 0.05);
    const leadLufs = this.used.vocalLead ? integratedLufs(B.vocalLead, sr) : null;
    const supportLufs = this.used.vocalSupport ? integratedLufs(B.vocalSupport, sr) : null;
    // (With your rough mix, its own lead/backing balance is kept instead.)
    if (balance && !this.rough && leadLufs != null && supportLufs != null && supportLufs > -70) {
      const g = leadLufs + SUPPORT_OFFSET - supportLufs;
      gain(B.vocalSupport, g);
      log.push(`Doubles/backing balanced ${fmt(SUPPORT_OFFSET)} LU under the lead (${fmt(g)} dB).`);
    }
    // A touch of chorus on the lead vocal (8% or less) for movement around the centre.
    if (!post && this.used.vocalLead && (s.vocalChorus ?? 0.06) > 0.001) {
      chorus(B.vocalLead, sr, { mix: s.vocalChorus ?? 0.06 });
      log.push(`Lead vocal: ${Math.round((s.vocalChorus ?? 0.06) * 100)}% chorus for a little movement around the centre.`);
    }
    // Backing vocals get extra reverb; their send is taken here and follows the vocal bus level later.
    const supportVerb = this.used.vocalSupport ? B.vocalSupport.map((ch) => Float32Array.from(ch, (v) => v * 0.5)) : null;
    const vocals = B.vocalLead;
    addInto(vocals, B.vocalSupport, 1);
    const buses = { vocals, drums: B.drums, bass: B.bass, music: B.music, fx: B.fx, ambience: B.ambience };
    const used = { vocals: this.used.vocalLead || this.used.vocalSupport, drums: this.used.drums, bass: this.used.bass, music: this.used.music, fx: this.used.fx, ambience: this.used.ambience };
    B.vocalSupport = null;

    // --- Source-aware balance, or the balance of your rough mix ---
    progress('Balancing buses', 0.12);
    const keys = BUS_KEYS.filter((k) => used[k]);
    const before = Object.fromEntries(keys.map((k) => [k, integratedLufs(buses[k], sr)]));
    const targets = post ? POST_TARGETS : BUS_TARGETS;
    const even = (k) => Math.max(-40, Math.min(40, targets[k] - before[k]));
    let rough = null;
    if (balance && this.rough) {
      progress('Matching your rough mix', 0.1);
      const fit = fitBalance(Object.fromEntries(keys.filter((k) => this.roughBus[k]).map((k) => [k, this.roughBus[k]])), this.rough);
      if (fit && fit.errDb <= 4) {
        // Each processed bus goes to its loudness in the rough mix, then all are
        // shifted together so the sum lands where the even balance would. A bus
        // you left out of the rough mix stays 24 dB under its even level.
        const target = (k) => (Number.isFinite(fit.lufs[k]) ? fit.lufs[k] - before[k] : -Infinity);
        const tot = (f) => 10 * Math.log10(keys.reduce((a, k) => a + Math.pow(10, f(k) / 10), 0));
        const shift = tot((k) => targets[k]) - tot((k) => before[k] + Math.max(target(k), even(k) - 24));
        rough = { ...fit, gains: Object.fromEntries(keys.map((k) => [k, Math.max(-40, Math.min(40, Math.max(target(k) + shift, even(k) - 24)))])) };
        log.push(`Balance from your rough mix (lined up${Math.abs(fit.lagSec) >= 0.02 ? ` with a ${fit.lagSec.toFixed(2)} s offset` : ''}, fits within ${fit.errDb.toFixed(1)} dB): ${keys.map((k) => `${k} ${fmt(rough.gains[k])} dB`).join(', ')}.`);
      } else {
        rough = { ...(fit || {}), rejected: true };
        log.push(`Your rough mix did not line up with these stems${fit ? ` (level error ${fit.errDb.toFixed(1)} dB)` : ''}, so the standard balance was used. Check that it is a bounce of the same song from the same start point.`);
      }
    }
    const amount = s.balanceAmount ?? 1;
    for (const key of keys) {
      const userGain = (s.buses[key]?.gain || 0) + (key === 'vocals' ? s.vocalLevel || 0 : 0);
      const auto = !balance || before[key] <= -70 ? 0 : rough && !rough.rejected ? rough.gains[key] : amount * even(key);
      gain(buses[key], auto + userGain);
      busReports[key] = { inputLufs: before[key], autoGainDb: auto, userGainDb: userGain };
    }
    if (balance && !(rough && !rough.rejected)) log.push(`Source-aware balance${amount < 0.99 ? ` (${Math.round(amount * 100)}% of the way to an even balance)` : ''}: ${keys.map((k) => `${k} ${fmt(busReports[k].autoGainDb)} dB`).join(', ')}.`);

    // --- Tempo: echo time and compressor release follow the song ---
    let tempo = 0;
    const beatSrc = used.drums ? buses.drums : used.music ? buses.music : used.bass ? buses.bass : null;
    if (beatSrc && !post) {
      const rh = rhythm(beatSrc, sr);
      if (rh.bpm >= 60 && rh.bpm <= 200 && rh.confidence > 0.15) tempo = rh.bpm;
    }
    const eighthMs = tempo ? 30000 / tempo : 0;
    const glueRelease = eighthMs ? Math.max(80, Math.min(300, eighthMs)) : 0;
    if (tempo) log.push(`Tempo about ${tempo} BPM: compressor releases follow an eighth note (${Math.round(glueRelease)} ms)${s.delay?.enabled && s.delaySync !== false ? ' and the echo locks to the beat' : ''}.`);
    // Loudness-neutral character stages, so the balance set above holds.
    const keepLevel = (b, fn) => { const before = integratedLufs(b, sr); const r = fn(); const after = integratedLufs(b, sr); if (before > -70 && after > -70) gain(b, before - after); return r; };

    // --- Bus processing ---
    progress('Processing buses', 0.2);
    for (const key of BUS_KEYS) {
      if (!used[key]) continue;
      const b = buses[key];
      const cfg = s.buses[key] || {};
      const rep = busReports[key];
      if (key === 'vocals') {
        const p = s.vocalPresence ?? 0.5;
        toneEq(b, sr, { extra: [
          { type: 'peaking', freq: 3200, q: 0.9, gain: (p - 0.5) * 6 },
          { type: 'highshelf', freq: 10000, q: 0.7, gain: (p - 0.5) * 3 },
          { type: 'peaking', freq: 300, q: 1, gain: -(p - 0.5) * 2 },
        ] });
        rep.presence = `Presence ${fmt((p - 0.5) * 6)} dB at 3.2 kHz, air ${fmt((p - 0.5) * 3)} dB`;
      }
      if (key === 'drums' && Math.abs((s.transientEnergy ?? 0.5) - 0.5) > 0.01) {
        rep.transient = transientShape(b, sr, ((s.transientEnergy ?? 0.5) - 0.5) * 2);
      }
      if (key === 'drums') {
        // Parallel compression: a hard-squashed copy blended under the drums for weight,
        // then a little tape saturation (under 30%) as glue.
        const par = s.drumParallel ?? 0.3, drive = s.drumDrive ?? 0.35;
        keepLevel(b, () => {
          if (par > 0.01) {
            const c = compress(b, sr, { ratio: 8, attack: 0.1, release: glueRelease ? Math.min(120, glueRelease) : 80, knee: 4, rmsMs: 0, thresholdPct: 0.6, thresholdOffset: -6, mix: par, maxGr: 18, makeup: 6 });
            rep.parallel = `Parallel compression ${Math.round(par * 100)}% (8:1 copy, avg ${c.avgGr.toFixed(1)} dB)`;
          }
          if (drive > 0.01) { saturate(b, sr, { drive: 6 * drive, mode: 'tape', mix: 0.25 }); rep.drive = `Tape saturation ${(6 * drive).toFixed(1)} dB, 25% blend`; }
        });
      }
      if (key === 'bass') {
        const t = s.bassTightness ?? 0.5;
        toneEq(b, sr, { hpf: 25 + t * 20, extra: [{ type: 'peaking', freq: 250, q: 1, gain: -t * 2 }] });
        const c = compress(b, sr, { ratio: 2 + 3 * t, attack: 10, release: 90, knee: 6, rmsMs: 8, thresholdPct: 0.7, thresholdOffset: -6 * t });
        rep.tightness = `HPF ${(25 + t * 20).toFixed(0)} Hz, 250 Hz ${fmt(-t * 2)} dB, compression avg ${c.avgGr.toFixed(1)} dB`;
        const grit = s.bassGrit ?? 0.3;
        if (grit > 0.01) {
          // Harmonics of the bass's own notes, kept above 300 Hz, so it is heard on small speakers.
          keepLevel(b, () => {
            for (const ch of b) {
              const lo = zeroPhaseLowpass(ch, 250, sr);
              let pk = 0;
              for (let i = 0; i < n; i++) { const a = Math.abs(lo[i]); if (a > pk) pk = a; }
              const drive = pk > 0 ? 2.5 / pk : 1;
              const p = new Float32Array(n);
              for (let i = 0; i < n; i++) p[i] = (Math.tanh(lo[i] * drive) / drive - lo[i]);
              const pl = zeroPhaseLowpass(p, 300, sr);
              for (let i = 0; i < n; i++) ch[i] += (p[i] - pl[i]) * 1.5 * grit;
            }
          });
          rep.grit = `Bass harmonics ${Math.round(grit * 100)}% (above 300 Hz)`;
        }
      }
      if (key === 'music') {
        const w = s.stereoWidth ?? 0.5;
        width(b, { amount: 0.6 + 0.8 * w, sr, monoHz: 0 });
        rep.width = 0.6 + 0.8 * w;
        if (s.musicCleanup !== false) {
          // Muddy (150-500 Hz) or boxy (500 Hz-1 kHz) build-up in the instruments is cut where it stands out.
          const cuts = resonantCuts(b, sr, [[150, 500, 'muddy'], [500, 1000, 'boxy']], { minDb: 3, maxCut: 3, q: 1.4 });
          if (cuts.length) {
            toneEq(b, sr, { extra: cuts.map((c) => ({ type: 'peaking', freq: c.freq, q: c.q, gain: c.gainDb })) });
            rep.cleanup = cuts.map((c) => `${fmt(c.gainDb)} dB at ${c.freq} Hz (${c.range})`).join(', ');
          }
        }
      }
      if (TONES[cfg.tone] && TONES[cfg.tone].length) toneEq(b, sr, { extra: TONES[cfg.tone] });
      if ((cfg.width ?? 1) !== 1) width(b, { amount: cfg.width, sr, monoHz: 0 });
      if ((cfg.glue || 0) > 0.01) {
        const c = compress(b, sr, { ratio: 1.5 + 2.5 * cfg.glue, attack: 20, release: glueRelease || 150, knee: 8, rmsMs: 10, thresholdPct: 0.7, thresholdOffset: -6 * cfg.glue, adaptive: true });
        rep.glue = { ratio: c.ratio, avgGr: c.avgGr, maxGr: c.maxGr };
      }
    }

    // --- Vocal rider (section-aware balance) ---
    progress('Riding the vocal', 0.4);
    const instrumental = stereoBuf(n);
    for (const key of ['drums', 'bass', 'music', 'fx']) if (used[key]) addInto(instrumental, buses[key], 1);
    let rider = null;
    if (!post && used.vocals && (s.riderStrength || 0) > 0.01 && (used.music || used.drums || used.bass)) {
      rider = this.vocalRider(buses.vocals, instrumental, s.riderStrength, s.riderWindow || 1.5);
      log.push(`Vocal rider: kept the vocal-to-music ratio near ${rider.targetDiff.toFixed(1)} LU, moving the vocal between ${fmt(rider.minDb)} and ${fmt(rider.maxDb)} dB across sections.`);
    }

    // --- Ducking ---
    progress('Ducking', 0.5);
    let duck = null, bassDuck = null;
    let postDucks = null;
    if (post && used.vocals) {
      // Music, effects and ambience step back while someone speaks and come back up in the gaps;
      // the music also clears the 1-4 kHz range the words live in.
      postDucks = {};
      if (used.music) {
        postDucks.music = duckUnderSpeech(buses.music, buses.vocals, sr, { amountDb: s.musicDuck ?? 6, attackMs: 80, releaseMs: 700 });
        postDucks.carve = duckUnderSpeech(buses.music, buses.vocals, sr, { amountDb: s.musicCarve ?? 3, attackMs: 40, releaseMs: 400, band: [1000, 4000] });
      }
      if (used.fx) postDucks.fx = duckUnderSpeech(buses.fx, buses.vocals, sr, { amountDb: s.sfxDuck ?? 2, attackMs: 20, releaseMs: 300, holdMs: 150 });
      if (used.ambience) postDucks.ambience = duckUnderSpeech(buses.ambience, buses.vocals, sr, { amountDb: s.ambDuck ?? 3, attackMs: 150, releaseMs: 1200, holdMs: 500 });
      const parts = [postDucks.music ? `music ${fmt(-postDucks.music.amountDb)} dB (plus ${fmt(-postDucks.carve.amountDb)} dB at 1-4 kHz)` : null, postDucks.fx ? `effects ${fmt(-postDucks.fx.amountDb)} dB` : null, postDucks.ambience ? `ambience ${fmt(-postDucks.ambience.amountDb)} dB` : null].filter(Boolean);
      if (parts.length) log.push(`Under the dialogue: ${parts.join(', ')}, coming back up in pauses.`);
    }
    if (!post && used.vocals && used.music && (s.duckAmount || 0) > 0) {
      duck = this.duckUnderVocals(buses.music, buses.vocals, s.duckAmount, s.duckRelease || 180);
      log.push(`Music ducks up to ${s.duckAmount} dB in the vocal range (250 Hz-5 kHz) while the vocal is active; average ${duck.avgGr.toFixed(2)} dB.`);
    }
    if (!post && used.vocals && used.drums && (s.duckAmount || 0) > 0) {
      // Kick harmonics and snare snap (2-5 kHz) step back a little while the vocal sings.
      const dd = this.duckUnderVocals(buses.drums, buses.vocals, Math.min(2, 0.4 * s.duckAmount), s.duckRelease || 180, { lo: 2000, hi: 5000, hiShare: 0 });
      log.push(`Drums dip up to ${Math.min(2, 0.4 * s.duckAmount).toFixed(1)} dB between 2 and 5 kHz under the vocal, so snare snap and kick click do not mask it (average ${dd.avgGr.toFixed(2)} dB).`);
    }
    if (used.drums && used.bass && (s.bassDuck || 0) > 0) {
      bassDuck = this.duckBassUnderKick(buses.bass, buses.drums, s.bassDuck);
      log.push(`Bass ducks up to ${s.bassDuck} dB on kick hits; active ${bassDuck.activePct.toFixed(0)}% of the time.`);
    }

    // --- Section automation (after the rider, so it does not undo the moves) ---
    let sections = null, sendCurve = null;
    const edited = Array.isArray(s.sections) && s.sections.length ? s.sections : null;
    if ((s.sectionAuto || 0) > 0.01 || edited) {
      progress('Section automation', 0.55);
      // Detected on the balanced, processed buses (what the mix will sound like), not the raw stem levels.
      let found = edited;
      if (!found) {
        const pre = stereoBuf(n);
        for (const key of BUS_KEYS) if (used[key]) addInto(pre, buses[key], 1);
        found = detectSections(pre, sr);
      }
      const moves = sectionMoves(found, s.sectionAuto || 0);
      const step = Math.round(sr * 0.1);
      const dec = (c) => { const o = new Float32Array(Math.ceil(n / step)); for (let i = 0, j = 0; i < n; i += step, j++) o[j] = c[i]; return o; };
      const curves = {};
      for (const key of BUS_KEYS) {
        if (!used[key] || moves.every((m) => Math.abs(m.gains[key] ?? 0) < 0.01)) continue;
        const c = sectionCurve(moves, (m) => m.gains[key] ?? 0, n, sr);
        for (const ch of buses[key]) for (let i = 0; i < n; i++) if (c[i]) ch[i] *= Math.pow(10, c[i] / 20);
        curves[key] = dec(c);
      }
      if (used.music && moves.some((m) => Math.abs(m.width - 1) > 0.005)) {
        const w = sectionCurve(moves, (m) => m.width, n, sr);
        const [L, R] = buses.music;
        for (let i = 0; i < n; i++) { const mid = 0.5 * (L[i] + R[i]), side = 0.5 * (L[i] - R[i]) * w[i]; L[i] = mid + side; R[i] = mid - side; }
      }
      if (used.vocals && moves.some((m) => Math.abs(m.send - 1) > 0.005)) sendCurve = sectionCurve(moves, (m) => m.send, n, sr);
      // Thinner verses, full-range choruses: low and high shelves on the music and FX follow the sections.
      if (moves.some((m) => Math.abs(m.lows ?? 0) > 0.05 || Math.abs(m.highs ?? 0) > 0.05)) {
        const lowC = sectionCurve(moves, (m) => m.lows ?? 0, n, sr), highC = sectionCurve(moves, (m) => m.highs ?? 0, n, sr);
        const lowS = [design('lowshelf', 150, sr, 0.7, -3)], highS = [design('highshelf', 6000, sr, 0.7, -3)];
        for (const key of ['music', 'fx']) {
          if (!used[key]) continue;
          for (const ch of buses[key]) {
            const lo = cascade(lowS, ch, new Float32Array(n)), hi = cascade(highS, ch, new Float32Array(n));
            for (let i = 0; i < n; i++) ch[i] += (lo[i] - ch[i]) * (lowC[i] / -3) + (hi[i] - ch[i]) * (highC[i] / -3);
          }
        }
      }
      sections = {
        detected: !edited, amount: s.sectionAuto || 0, curves, stepSec: 0.1,
        list: moves.map((m) => ({ start: m.start, end: m.end, label: m.label, rel: m.rel, lufs: m.lufs, offsets: m.offsets || {}, gains: m.gains, width: m.width, send: m.send, lows: m.lows, highs: m.highs })),
      };
      log.push(`Section automation: ${moves.length} section${moves.length > 1 ? 's' : ''} ${edited ? '(your edited boundaries)' : 'found'} (${moves.map((m) => m.label).join(', ')}). ${moves.filter((m) => Object.values(m.gains).some((g) => Math.abs(g) >= 0.05)).map((m) => `${fmtTime(m.start)} ${m.label}: ${Object.entries(m.gains).filter(([k, g]) => used[k] && Math.abs(g) >= 0.05).map(([k, g]) => `${k} ${fmt(g)}`).join(', ')} dB`).join('; ') || 'No level moves.'}`);
    }

    // --- Effects returns ---
    progress('Reverb and delay', 0.6);
    // The echo locks to the song (a quarter note, or an eighth if a quarter is too long or short).
    let delayMs = s.delay?.time ?? 300;
    if (s.delay?.enabled && s.delaySync !== false && tempo) {
      const q = 60000 / tempo;
      delayMs = [q, q / 2, q * 2].find((t) => t >= 220 && t <= 650) || delayMs;
    }
    const vocalBusGain = used.vocals ? Math.pow(10, ((busReports.vocals?.autoGainDb || 0) + (busReports.vocals?.userGainDb || 0)) / 20) : 1;
    // With alternate mixes, vocal and instrument returns are kept apart.
    const split = !!s.alternates;
    const revVoc = stereoBuf(n), revOther = split ? stereoBuf(n) : revVoc;
    const dlyVoc = stereoBuf(n), dlyOther = split ? stereoBuf(n) : dlyVoc;
    let anyRev = false, anyDly = false;
    for (const key of BUS_KEYS) {
      if (!used[key]) continue;
      const cfg = s.buses[key] || {};
      if (key === 'vocals') {
        if (s.reverb?.enabled && cfg.sendReverb > 0) {
          // Drier verses, wetter hooks; band-limited to 200 Hz-5 kHz so the reverb sits under the sibilance.
          const send = buses.vocals.map((ch) => new Float32Array(ch));
          if (sendCurve) for (const c of send) for (let i = 0; i < n; i++) c[i] *= sendCurve[i];
          if (supportVerb) addInto(send, supportVerb, vocalBusGain);
          toneEq(send, sr, { hpf: 200, extra: [{ type: 'lowpass', freq: 5000, q: 0.7 }, { type: 'lowpass', freq: 5000, q: 0.7 }] });
          addInto(revVoc, send, cfg.sendReverb);
          anyRev = true;
        }
        if (s.delay?.enabled && cfg.sendDelay > 0) {
          // Hard syllables are de-essed out of the echo send.
          const send = buses.vocals.map((ch) => new Float32Array(ch));
          deess(send, sr, { amount: 0.9 });
          toneEq(send, sr, { hpf: 200, extra: [{ type: 'lowpass', freq: 6000, q: 0.7 }] });
          addInto(dlyVoc, send, cfg.sendDelay);
          anyDly = true;
        }
      } else {
        if (s.reverb?.enabled && cfg.sendReverb > 0) { addInto(revOther, buses[key], cfg.sendReverb); anyRev = true; }
        if (s.delay?.enabled && cfg.sendDelay > 0) { addInto(dlyOther, buses[key], cfg.sendDelay); anyDly = true; }
      }
    }
    // Returns roll off lows and highs (the depth lives in the mids).
    const revGain = Math.pow(10, (s.reverb?.level ?? -12) / 20) * 6;
    const dlyGain = Math.pow(10, (s.delay?.level ?? -16) / 20);
    const runRev = (src) => gain(reverb(src[0], src[1], sr, { kind: s.reverb.kind, decay: s.reverb.decay, predelayMs: s.reverb.predelay, hp: 200, lp: 9000 }), 20 * Math.log10(revGain));
    const runDly = (src) => gain(delay(src[0], src[1], sr, { timeMs: delayMs, feedback: s.delay.feedback, pingpong: s.delay.pingpong, hp: 200, lp: 7000 }), 20 * Math.log10(dlyGain));
    const ret = { voc: [], other: [] };
    if (anyRev) {
      ret.voc.push(runRev(revVoc));
      if (split) ret.other.push(runRev(revOther));
      log.push(`Reverb (${s.reverb.kind}, ${s.reverb.decay}s, ${s.reverb.predelay} ms pre-delay) returned at ${s.reverb.level} dB, rolled off below 200 Hz and above 9 kHz; the vocal's send is limited to 200 Hz-5 kHz${supportVerb ? ' and backing vocals get extra' : ''}.`);
    }
    if (anyDly) {
      ret.voc.push(runDly(dlyVoc));
      if (split) ret.other.push(runDly(dlyOther));
      log.push(`Echo ${Math.round(delayMs)} ms${delayMs !== s.delay.time ? ' (locked to the tempo)' : ''}, feedback ${Math.round(s.delay.feedback * 100)}%${s.delay.pingpong ? ', ping-pong' : ''}, returned at ${s.delay.level} dB; the vocal's echo send is de-essed.`);
    }
    const returns = [...ret.voc, ...ret.other];
    // Sum of buses (each with a gain in dB, -Infinity to leave out) and returns.
    const sumMix = (g = {}, vocRet = 0, otherRet = 0) => {
      const m = stereoBuf(n);
      for (const key of BUS_KEYS) if (used[key] && g[key] !== -Infinity) addInto(m, buses[key], Math.pow(10, (g[key] || 0) / 20));
      if (vocRet !== -Infinity) for (const r of ret.voc) addInto(m, r, Math.pow(10, vocRet / 20));
      if (otherRet !== -Infinity) for (const r of ret.other) addInto(m, r, Math.pow(10, otherRet / 20));
      return m;
    };
    const mix = sumMix();

    // --- Spatial bed (from the processed buses and returns, before the stereo mix bus) ---
    let spatial = null;
    if (s.spatial) {
      progress(`Spatial ${s.spatial.layout} bed`, 0.66);
      const bedBuses = Object.fromEntries(BUS_KEYS.filter((k) => used[k] && k !== 'ambience').map((k) => [k, buses[k]]));
      if (used.ambience) { const fx = stereoBuf(n); if (bedBuses.fx) addInto(fx, bedBuses.fx, 1); addInto(fx, buses.ambience, 1); bedBuses.fx = fx; }
      const bed = bedFromBuses(bedBuses, returns, sr, { layout: s.spatial.layout, vocalCentre: s.spatial.centre ?? 0.6, lfeDb: s.spatial.lfeDb ?? -12 });
      const f = finalize(bed.chs, sr, { targetLufs: s.spatial.targetLufs ?? -18, ceiling: s.spatial.ceiling ?? -1, weights: loudnessWeights(s.spatial.layout) });
      spatial = { layout: s.spatial.layout, chs: f.chs, lufs: f.achievedLufs, dbtp: f.truePeakDbtp, maxGr: f.limiter.maxGr, levels: channelLevels(f.chs, s.spatial.layout) };
      log.push(`Spatial ${s.spatial.layout} bed: lead vocal and bass mids partly in the centre, music, FX and effect returns opened into the surrounds${s.spatial.layout === '7.1.4' ? ' and heights' : ''}, kick and bass lows in the LFE. ${f.achievedLufs.toFixed(1)} LUFS at ${f.truePeakDbtp.toFixed(2)} dBTP (BS.1770 channel weights; the stereo mix-bus glue is not applied to the bed).`);
    }

    // --- Mix bus (kept light: the mix should already work before it) ---
    progress('Mix bus', 0.7);
    const lows = s.mixLow || 0, highs = s.mixHigh || 0, tape = s.mixTape || 0;
    let roughCurve = null;
    const busChain = (m, quiet = false) => {
      if (lows || highs || tape > 0.01) {
        toneEq(m, sr, { low: lows, lowFreq: 120, high: highs - 1.5 * tape, highFreq: 8000 });
        if (tape > 0.01) saturate(m, sr, { drive: 5 * tape, mode: 'tape' });
        if (!quiet) log.push(`Mix-bus tone: lows ${fmt(lows)} dB at 120 Hz, highs ${fmt(highs - 1.5 * tape)} dB above 8 kHz${tape > 0.01 ? `, tape saturation ${(5 * tape).toFixed(1)} dB drive` : ''}.`);
      }
      let glue = null;
      if ((s.mixGlue || 0) > 0.01) {
        glue = compress(m, sr, { ratio: 1.4 + 1.6 * s.mixGlue, attack: 30, release: glueRelease ? Math.max(120, glueRelease) : 220, knee: 10, rmsMs: 15, thresholdPct: 0.7, thresholdOffset: -5 * s.mixGlue, adaptive: true });
        if (!quiet) log.push(`Mix-bus glue ${glue.ratio.toFixed(2)}:1, average ${glue.avgGr.toFixed(1)} dB.`);
      }
      if (roughCurve) { const res = spectralProcess(m, sr, { staticCurve: roughCurve }); m[0] = res.chs[0]; m[1] = res.chs[1]; }
      return glue;
    };
    const mixGlue = busChain(mix);

    // --- Tone of your rough mix (static EQ toward its long-term spectrum) ---
    let roughTone = null;
    if (this.rough && (s.roughTone || 0) > 0.01) {
      progress('Matching your rough mix tone', 0.74);
      const spec = ltas(mix, sr);
      roughCurve = referenceCurve(spec, this.rough.spec, { strength: s.roughTone, maxDb: 4, fraction: 2 });
      const res = spectralProcess(mix, sr, { staticCurve: roughCurve });
      mix[0] = res.chs[0];
      mix[1] = res.chs[1];
      const binHz = sr / spec.N;
      const pts = bandCenters(3, 31.5, 16000).map((f) => ({ freq: Math.round(f), db: roughCurve[Math.min(roughCurve.length - 1, Math.round(f / binHz))] }));
      roughTone = { strength: s.roughTone, curve: pts };
      const big = [...pts].sort((a, b) => Math.abs(b.db) - Math.abs(a.db)).slice(0, 3);
      log.push(`Tone moved ${Math.round(s.roughTone * 100)}% toward your rough mix (at most 4 dB). Largest moves: ${big.map((p) => `${fmt(p.db)} dB at ${p.freq} Hz`).join(', ')}.`);
    }

    // --- Output stage ---
    progress('Output level', 0.78);
    let outGain = 0, out = mix, limiter = null;
    if (s.outputMode === 'loudness') {
      const f = finalize(mix, sr, { targetLufs: s.targetLufs ?? -14, ceiling: s.ceiling ?? -1 });
      out = f.chs; outGain = f.gainDb; limiter = { maxGr: f.limiter.maxGr, avgGr: f.limiter.avgGr, curve: f.limiter.curve, stepSec: f.limiter.curveStepSec };
      log.push(`Output: ${f.achievedLufs.toFixed(2)} LUFS at ${f.truePeakDbtp.toFixed(2)} dBTP through the true-peak limiter (max ${f.limiter.maxGr.toFixed(1)} dB).`);
    } else {
      const tp = truePeak(mix, sr).dbtp;
      outGain = (s.headroom ?? -6) - tp;
      gain(mix, outGain);
      log.push(`Output: normalised so true peak sits at ${s.headroom ?? -6} dBTP, leaving headroom for mastering (${fmt(outGain)} dB).`);
    }

    // --- Alternate mixes: same buses and effects, different balances ---
    let alternates = null;
    if (split) {
      const versions = [
        { key: 'vocal_up_1db', label: 'Vocal up 1 dB', g: { vocals: 1 }, vr: 1 },
        { key: 'vocal_up_2db', label: 'Vocal up 2 dB', g: { vocals: 2 }, vr: 2 },
        { key: 'bass_up_1db', label: 'Bass up 1 dB', g: { bass: 1 } },
        { key: 'instrumental', label: 'Instrumental', g: { vocals: -Infinity }, vr: -Infinity, need: 'vocals' },
        { key: 'a_cappella', label: 'A cappella', g: { drums: -Infinity, bass: -Infinity, music: -Infinity, fx: -Infinity }, or: -Infinity, need: 'vocals' },
        { key: 'clean_bus', label: 'No mix-bus processing', clean: true },
      ].filter((v) => !v.need || used[v.need]).filter((v) => v.key !== 'bass_up_1db' || used.bass);
      alternates = [];
      versions.forEach((v, i) => {
        progress(`Alternate mix: ${v.label}`, 0.8 + (0.04 * i) / versions.length);
        const m = sumMix(v.g, v.vr ?? 0, v.or ?? 0);
        if (!v.clean) busChain(m, true);
        let chs = m, lufs, dbtp;
        if (s.outputMode === 'loudness') {
          const f = finalize(m, sr, { targetLufs: s.targetLufs ?? -14, ceiling: s.ceiling ?? -1 });
          chs = f.chs; lufs = f.achievedLufs; dbtp = f.truePeakDbtp;
        } else {
          gain(m, outGain);
          lufs = integratedLufs(m, sr); dbtp = truePeak(m, sr).dbtp;
        }
        alternates.push({ key: v.key, label: v.label, chs, lufs, dbtp });
      });
      log.push(`Alternate mixes: ${alternates.map((a) => a.label.toLowerCase()).join(', ')}.`);
    }

    // Unprocessed sum for the A/B comparison, peak-matched to the same ceiling.
    const rawTp = truePeak(this.rawSum, sr).dbtp;
    const rawGain = Math.min(0, (s.headroom ?? -6) - rawTp);
    gain(this.rawSum, rawGain);
    const rawSumLufs = integratedLufs(this.rawSum, sr);
    const rawSumTruePeak = rawTp + rawGain;

    progress('Analysing the mix', 0.85);
    const analysis = analyze({ sr, channels: out }, { progress: (st, f) => progress(`Analysing: ${st}`, 0.85 + f * 0.08) });
    const delivery = post ? deliveryCheck(out, used.vocals ? buses.vocals : null, sr, { standard: s.delivery, achievedLufs: analysis.loudness.integrated, truePeakDbtp: analysis.peak.truePeakDbtp }) : null;
    if (delivery) delivery.edits = { ...this.edits, frames: Number(s.editFades ?? 1), frameRate: s.frameRate || '29.97', declick: s.declick ?? 0.5 };

    // Per-bus spectra (after processing, before the output stage) for the masking view.
    progress('Bus spectra', 0.94);
    const centers = bandCenters(6, 20, Math.min(20000, sr * 0.48));
    const busSpectra = {};
    const og = Math.pow(10, outGain / 20);
    for (const key of BUS_KEYS) {
      if (!used[key]) continue;
      const spec = ltas(buses[key], sr);
      busSpectra[key] = bandLevels(spec, centers, 6).map((v) => v + 20 * Math.log10(og));
      busReports[key].outputLufs = integratedLufs(buses[key], sr) + outGain;
    }
    let pocket = null;
    if (busSpectra.vocals) {
      const others = ['music', 'drums', 'bass'].filter((k) => busSpectra[k]);
      if (others.length) {
        const idx = centers.map((f, i) => (f >= 1000 && f <= 4000 ? i : -1)).filter((i) => i >= 0);
        const pw = (arr) => 10 * Math.log10(idx.reduce((a, i) => a + Math.pow(10, arr[i] / 10), 0) / idx.length);
        const vocalPw = pw(busSpectra.vocals);
        const otherPw = 10 * Math.log10(others.reduce((a, k) => a + Math.pow(10, pw(busSpectra[k]) / 10), 0));
        pocket = { vocalDb: vocalPw, othersDb: otherPw, marginDb: vocalPw - otherPw };
        log.push(`Vocal pocket (1-4 kHz): vocal sits ${fmt(pocket.marginDb)} dB ${pocket.marginDb >= 0 ? 'above' : 'below'} the rest of the mix.`);
      }
    }

    // Bus stems share one gain so they keep the mix's balance; it is lowered
    // when needed so none of them peaks above -1 dBFS (a loud mix is limited, its stems are not).
    let busStems = null, busStemTrimDb = 0;
    if (s.renderBusStems) {
      let peak = 0;
      for (const k of BUS_KEYS) if (used[k]) for (const ch of buses[k]) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
      const limit = Math.pow(10, -1 / 20);
      const g = peak * og > limit ? limit / peak : og;
      busStemTrimDb = 20 * Math.log10(g / og);
      busStems = Object.fromEntries(BUS_KEYS.filter((k) => used[k]).map((k) => [k, buses[k].map((ch) => { const c = new Float32Array(ch); for (let i = 0; i < c.length; i++) c[i] *= g; return c; })]));
      if (busStemTrimDb < -0.05) log.push(`Bus stems were saved ${Math.abs(busStemTrimDb).toFixed(1)} dB under the mix's level so none of them clips; their balance is unchanged.`);
    }

    return {
      channels: out,
      rawSum: this.rawSum,
      busStems,
      spatial,
      alternates,
      report: {
        settings: s,
        sampleRate: sr,
        rawSumLufs,
        rawSumTruePeak,
        stems: this.stemReports,
        buses: busReports,
        log,
        rider: rider ? { targetDiff: rider.targetDiff, minDb: rider.minDb, maxDb: rider.maxDb, curve: rider.curve, stepSec: rider.stepSec } : null,
        ducking: duck ? { ...duck, curve: duck.curve } : null,
        bassDuck,
        mixGlue: mixGlue ? { ratio: mixGlue.ratio, avgGr: mixGlue.avgGr, maxGr: mixGlue.maxGr } : null,
        limiter,
        output: analysis,
        busSpectra: { centers, levels: busSpectra },
        pocket,
        delivery,
        postDucks,
        sections,
        tempo,
        alternates: alternates ? alternates.map(({ chs, ...a }) => a) : null,
        rough: this.rough ? { lufs: this.rough.lufs, seconds: this.rough.seconds, fit: rough ? { errDb: rough.errDb, lagSec: rough.lagSec, rejected: !!rough.rejected, gains: rough.gains || null } : null, tone: roughTone } : null,
        spatial: spatial ? { layout: spatial.layout, lufs: spatial.lufs, dbtp: spatial.dbtp, maxGr: spatial.maxGr, levels: spatial.levels } : null,
      },
    };
  }

  vocalRider(vocals, inst, strength, windowSec) {
    const sr = this.sr, n = this.n;
    const hv = hopEnergies(vocals, sr), hi = hopEnergies(inst, sr);
    const H = hv.energy.length;
    const lv = new Float32Array(H), li = new Float32Array(H);
    for (let j = 0; j < H; j++) {
      let ev = 0, ei = 0;
      for (let k = Math.max(0, j - 3); k <= j; k++) { ev += hv.energy[k]; ei += hi.energy[k]; }
      const cnt = Math.min(4, j + 1) * hv.hop;
      lv[j] = ev > 0 ? -0.691 + 10 * Math.log10(ev / cnt) : -120;
      li[j] = ei > 0 ? -0.691 + 10 * Math.log10(ei / cnt) : -120;
    }
    const vocI = integratedLufs(vocals, sr);
    const active = [];
    for (let j = 0; j < H; j++) if (lv[j] > vocI - 15 && li[j] > -70) active.push(lv[j] - li[j]);
    if (!active.length) return { targetDiff: 0, minDb: 0, maxDb: 0, curve: new Float32Array(0), stepSec: 0.1 };
    active.sort((a, b) => a - b);
    const target = active[Math.floor(active.length / 2)];
    const maxMove = 4 * strength;
    const want = new Float32Array(H);
    let last = 0;
    for (let j = 0; j < H; j++) {
      if (lv[j] > vocI - 15 && li[j] > -70) last = Math.max(-maxMove, Math.min(maxMove, (target - (lv[j] - li[j])) * 0.7));
      want[j] = last;
    }
    // Moving-average smoothing over the section window.
    const w = Math.max(1, Math.round(windowSec / 0.1));
    const sm = new Float32Array(H);
    let acc = 0;
    for (let j = 0; j < H; j++) {
      acc += want[j];
      if (j >= w) acc -= want[j - w];
      sm[j] = acc / Math.min(j + 1, w);
    }
    let minDb = 0, maxDb = 0;
    const hop = hv.hop;
    for (let i = 0; i < n; i++) {
      const pos = i / hop - 0.5;
      const j0 = Math.max(0, Math.min(H - 1, Math.floor(pos)));
      const j1 = Math.min(H - 1, j0 + 1);
      const t = Math.max(0, Math.min(1, pos - j0));
      const db = sm[j0] * (1 - t) + sm[j1] * t;
      const g = Math.pow(10, db / 20);
      vocals[0][i] *= g;
      vocals[1][i] *= g;
    }
    for (let j = 0; j < H; j++) { if (sm[j] < minDb) minDb = sm[j]; if (sm[j] > maxDb) maxDb = sm[j]; }
    return { targetDiff: target, minDb, maxDb, curve: sm, stepSec: 0.1 };
  }

  duckUnderVocals(music, vocals, amountDb, releaseMs, { lo = 250, hi = 5000, hiShare = 0.5 } = {}) {
    const sr = this.sr, n = this.n;
    const env = envDb(vocals, sr, 10, 80);
    const vocI = integratedLufs(vocals, sr);
    const target = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, Math.min(1, (env[i] - (vocI - 18)) / 12));
      target[i] = -amountDb * a;
    }
    const g = smoothGain(target, sr, 12, releaseMs);
    for (let c = 0; c < 2; c++) {
      const [l, mid, h] = lr4Split3(music[c], lo, hi, sr);
      const ch = music[c];
      for (let i = 0; i < n; i++) {
        const lin = Math.pow(10, g[i] / 20);
        ch[i] = l[i] + mid[i] * lin + h[i] * (hiShare ? Math.pow(lin, hiShare) : 1);
      }
    }
    const st = stats(g);
    const step = Math.round(sr * 0.05);
    const curve = new Float32Array(Math.ceil(n / step));
    for (let i = 0, j = 0; i < n; i += step, j++) curve[j] = g[i];
    return { ...st, curve, stepSec: 0.05 };
  }

  duckBassUnderKick(bass, drums, amountDb) {
    const sr = this.sr, n = this.n;
    const lp = [design('lowpass', 120, sr), design('lowpass', 120, sr)];
    const kick = [cascade(lp, drums[0], new Float32Array(n)), cascade(lp, drums[1], new Float32Array(n))];
    const env = envDb(kick, sr, 1, 60);
    const p90 = percentileDb(env, 0.9);
    const target = new Float32Array(n);
    for (let i = 0; i < n; i++) target[i] = -amountDb * Math.max(0, Math.min(1, (env[i] - (p90 - 12)) / 12));
    const g = smoothGain(target, sr, 2, 90);
    // Only the bass's low band (where the kick lives) ducks fully; its upper notes barely move.
    for (const ch of bass) {
      const [low, high] = lr4Split2(ch, 150, sr);
      for (let i = 0; i < n; i++) { const lin = Math.pow(10, g[i] / 20); ch[i] = low[i] * lin + high[i] * Math.pow(lin, 0.25); }
    }
    return stats(g);
  }
}

export { lin2db, detectorDb };
