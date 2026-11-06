// Stem mixing session. Stems are processed one at a time (to keep memory flat)
// and summed into category buses; bus-level processing, ducking, the vocal
// rider, effects returns and the mix bus run in finish().

import { integratedLufs, integratedFromHops, loudnessRangeFromHops, hopEnergies, truePeak, lin2db } from './loudness.js';
import { compress, deess, transientShape, detectorDb, percentileDb, shapeMoves, applyShape, limitWithEnvelope, peakEnvelope } from './dynamics.js';
import { toneEq, width, pan, gain, reverb, delay, addInto, saturate, chorus } from './effects.js';
import { design, cascade, lr4Split2, lr4Split3, zeroPhaseLowpass } from './filters.js';
import { analyze } from './analyze.js';
import { ltas, bandCenters, bandLevels, referenceCurve, spectralProcess, rhythm } from './spectral.js';
import { finalize } from './master.js';
import { bedFromBuses, loudnessWeights, channelLevels } from './spatial.js';
import { tuneVocal, SCALES } from './pitch.js';
import { detectSections, sectionMoves, sectionCurve } from './sections.js';
import { roughFeatures, stemFeatures, addFeatures, fitBalance, roughBelongs, waveStep, waveCopy, roughCopy, readStemLevels, sectionLevels, followCurve } from './roughmix.js';
import { lowCutFreq, resonantCuts, buildUpCuts } from './stemtools.js';
import { levelSpeech, duckUnderSpeech, deliveryCheck, fadeEdits, mouthDeclick, rotatePhase, shareMics, dialogueLoudness, FRAME_RATES, DELIVERY } from './post.js';
import { denoise, detectClicks, repairClicks, detectHumInPauses, removeHum } from './repair.js';

export const BUS_KEYS = ['vocals', 'drums', 'bass', 'music', 'fx', 'ambience'];

// Loudness each bus is balanced to before the mix bus (relative balance only;
// the output stage sets the final level).
const BUS_TARGETS = { vocals: -18, drums: -20, bass: -21, music: -19.5, fx: -27, ambience: -30 };
// Video, ad and podcast: dialogue leads, music and effects sit under it, ambience is a quiet bed.
const POST_TARGETS = { vocals: -20, drums: -27, bass: -27, music: -25, fx: -26, ambience: -32 };
const VOICE_LUFS = -24; // each voice is brought to this before the bus, so speakers match
const SUPPORT_OFFSET = -6; // doubles/backing relative to lead vocal
const ROUGH_MAX_DB = 4; // the most its tone can move the finished mix
const DRUM_HITS = { lookaheadMs: 2, releaseMs: 40 }; // quick, so only the tip of a hit is touched
const KEEP_TONE = 0.7; // how much of the tone the processing added Auto mix takes back
const KEEP_TONE_DB = 3; // the most that can be, before the strength
const ROUGH_LEFT_OUT_DB = -24; // a stem barely found in it stays this far under the loudest
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

// A part's level over a few seconds: K-weighted energy per 0.1 s, averaged over 3 s.
const SLOW_HOP = 0.1, SLOW_SPAN = 3, SLOW_MAX = 12;
function slowLevel(chs, sr) {
  const { energy, hop } = hopEnergies(chs, sr, SLOW_HOP);
  const H = energy.length, half = Math.round(SLOW_SPAN / SLOW_HOP / 2), sum = new Float64Array(H + 1);
  for (let h = 0; h < H; h++) sum[h + 1] = sum[h] + energy[h];
  return { hop, level: Float64Array.from({ length: H }, (_, h) => { const a = Math.max(0, h - half), b = Math.min(H, h + half + 1); return (sum[b] - sum[a]) / (b - a); }) };
}
/** Brings a part back to the slow level it had, straight lines between hops. Returns the largest move in dB. */
function keepSlowLevel(chs, sr, before) {
  const after = slowLevel(chs, sr), H = before.level.length, hop = before.hop;
  let top = 0;
  for (const v of before.level) if (v > top) top = v;
  if (top <= 0) return 0;
  const floor = 1e-6 * top;
  let most = 0;
  const k = Float64Array.from({ length: H }, (_, h) => {
    const db = Math.max(-SLOW_MAX, Math.min(SLOW_MAX, 10 * Math.log10((before.level[h] + floor) / (after.level[h] + floor))));
    if (before.level[h] > 1e-3 * top) most = Math.max(most, Math.abs(db));
    return Math.pow(10, db / 20);
  });
  const n = chs[0].length;
  for (let h = 0; h < H; h++) {
    const a = h * hop + hop / 2, ka = k[h], kb = k[Math.min(H - 1, h + 1)];
    const i0 = h === 0 ? 0 : Math.round(a), i1 = h === H - 1 ? n : Math.round(a + hop);
    for (let i = i0; i < Math.min(n, i1); i++) {
      const g = i < a ? ka : ka + ((kb - ka) * (i - a)) / hop;
      for (const ch of chs) ch[i] *= g;
    }
  }
  return most;
}

// --- Section balance (Auto mix): how far each group has moved against the others, section by section ---
// Compressors, glue and dips can each move a group a little in one section and not another, and
// together that can lift a choir over the music where it carries the song. Measured in 8 s windows
// every 4 s as each group's own change, less the change the groups share there, with its change over
// the whole song taken out.
const BAL_WIN = 80, BAL_STEP = 40; // hops of 0.1 s
const BAL_TOL = 2;                 // dB a group may move against the others in a section
const BAL_BACK = 1;                // dB it is brought back to when it moves further
const BAL_HEARD = 0.01;            // share of the mix's energy (-20 dB) below which a group is not judged
const middleOf = (list) => { const s = [...list].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
function sectionDrift(came, now) {
  const keys = Object.keys(came);
  const H = Math.min(...keys.map((k) => Math.min(came[k].length, now[k].length)));
  const wins = Math.max(0, Math.floor((H - BAL_WIN) / BAL_STEP) + 1);
  const sums = (e) => Array.from({ length: wins }, (_, w) => { let s = 0; for (let j = w * BAL_STEP; j < w * BAL_STEP + BAL_WIN; j++) s += e[j]; return s; });
  const c = keys.map((k) => sums(came[k])), o = keys.map((k) => sums(now[k]));
  const allC = c[0].map((_, w) => c.reduce((p, x) => p + x[w], 0)), allO = o[0].map((_, w) => o.reduce((p, x) => p + x[w], 0));
  const topAll = Math.max(...allC);
  // Each group's own change, only where it can be heard: under BAL_HEARD of the mix it is a tail or a
  // breath, and judging it there would pull its real entrances toward its quietest moments.
  const own = keys.map((k, a) => {
    const topK = Math.max(...c[a]);
    return c[a].map((ck, w) => (ck < 1e-3 * topK || allC[w] < 1e-3 * topAll || o[a][w] <= 0 || allO[w] <= 0 || (ck < BAL_HEARD * allC[w] && o[a][w] < BAL_HEARD * allO[w]) ? null : 10 * Math.log10(o[a][w] / ck)));
  });
  // The change the groups share in a window is not a change of balance. The middle one is taken, not
  // the whole mix's, so a group that carries a section cannot pass its own move on to the rest.
  const shared = c[0].map((_, w) => { const v = own.map((x) => x[w]).filter((x) => x != null); return v.length ? middleOf(v) : null; });
  const drift = {};
  keys.forEach((k, a) => {
    const d = own[a].map((x, w) => (x == null ? null : x - shared[w]));
    const live = d.filter((x) => x != null);
    if (live.length < 2) return;
    const mid = middleOf(live);
    drift[k] = d.map((x) => (x == null ? null : x - mid));
  });
  let worst = null;
  for (const [k, d] of Object.entries(drift)) d.forEach((x, w) => { if (x != null && (!worst || Math.abs(x) > Math.abs(worst.db))) worst = { key: k, db: x, at: (w * BAL_STEP + BAL_WIN / 2) * 0.1 }; });
  return { drift, worst };
}

const movingAverage = (v, w) => { const s = new Float64Array(v.length + 1); for (let j = 0; j < v.length; j++) s[j + 1] = s[j] + v[j]; const h = w >> 1; return Float64Array.from(v, (_, j) => { const a = Math.max(0, j - h), b = Math.min(v.length, j + h + 1); return (s[b] - s[a]) / (b - a); }); };
/** A gain in dB per hop, straight lines between hop centres. */
function hopGains(chs, db, hop) {
  const H = db.length, n = chs[0].length, k = Float64Array.from(db, (d) => Math.pow(10, d / 20));
  for (let h = 0; h < H; h++) {
    const a = h * hop + hop / 2, ka = k[h], kb = k[Math.min(H - 1, h + 1)];
    const i0 = h === 0 ? 0 : Math.round(a), i1 = h === H - 1 ? n : Math.round(a + hop);
    if (ka === 1 && kb === 1) continue;
    for (let i = i0; i < Math.min(n, i1); i++) { const g = i < a ? ka : ka + ((kb - ka) * (i - a)) / hop; for (const ch of chs) ch[i] *= g; }
  }
}

// The bus a stem counts toward when matching your rough mix.
const roughBusOf = (st) => (st.category in BUS_TARGETS ? st.category : 'music');

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
    // Two or more voices are held back until all are in, so their mics can share the level.
    const voiceCount = settings.stems.filter((st) => st.category === 'vocals' && !st.mute && (!this.anySolo || st.solo)).length;
    this.heldVoices = settings.mode === 'post' && settings.shareMics !== false && voiceCount > 1 ? [] : null;
    // Pitch-correction key: fixed, chromatic, or detected from the first tuned vocal and reused.
    const k = settings.tuneKey || 'auto';
    this.tuneKey = k === 'auto' ? null : k === 'chromatic' ? { root: 0, scale: 'chromatic' } : { root: Number(k.split(':')[0]), scale: k.split(':')[1] };
  }

  /** Your own bounce of the song: the reference for bus balance and tone. */
  setRoughMix(audio) {
    this.rough = roughFeatures(audio.channels, this.sr);
    this.roughBus = {};
    // Two or more stems: each one's level is read from it before the render.
    const heard = this.s.stems.flatMap((st, i) => (!st.mute && (!this.anySolo || st.solo) ? [i] : []));
    const readStems = this.s.autoBalance !== false && heard.length > 1 ? heard : [];
    if (readStems.length) {
      this.waveStep = waveStep(this.sr, this.n, readStems.length);
      this.roughWave = roughCopy(audio.channels, this.waveStep, this.n);
      this.stemWaves = {};
      this.stemsToRead = readStems;
    }
    return { lufs: this.rough.lufs, seconds: this.rough.seconds, readStems };
  }

  /** One stem as it comes, before any processing, for reading its level from your rough mix. */
  readRoughStem(index, audio) {
    this.stemWaves[index] = waveCopy(audio.channels, this.waveStep, this.n);
  }

  /** Each stem's level from your rough mix, once all are read. Every level then stays relative within its bus. */
  fitRoughStems() {
    const read = this.stemsToRead;
    const fit = readStemLevels(read.map((i) => this.stemWaves[i]), this.roughWave, this.sr / this.waveStep);
    this.stemsUnread = !fit;
    const found = fit ? fit.db.filter((v) => v != null) : [];
    if (fit && !found.length) this.stemsUnread = true;
    if (!fit || !found.length) { this.stemWaves = this.roughWave = null; return { read: false }; }
    const top = Math.max(...found);
    const whole = read.map((i, j) => (fit.db[j] == null ? null : Math.max(fit.db[j], top + ROUGH_LEFT_OUT_DB)));
    // A voice that gets matched to the others afterwards does not keep this level, so it is not listed.
    const matched = (st) => this.s.mode === 'post' && st.category === 'vocals' && this.s.matchVoices !== false;
    // Where a part's level changes along the song in it, the stem follows those changes too.
    // (Not when the stems are only part of the song: what is missing would be taken for them.)
    const along = fit.partial ? null : sectionLevels(read.map((i) => this.stemWaves[i]), this.roughWave, this.sr / this.waveStep, fit.lag, whole);
    this.stemWaves = this.roughWave = null;
    this.stemCurves = {};
    read.forEach((i, j) => { const c = along?.curves[j]; if (c && whole[j] != null && !matched(this.s.stems[i])) this.stemCurves[i] = c; });
    const levels = read.map((i, j) => ({ i, db: whole[j] == null ? null : whole[j] + (this.stemCurves[i]?.base || 0) }));
    const busDb = {};
    for (const { i, db } of levels) {
      if (db == null) continue;
      const k = roughBusOf(this.s.stems[i]);
      busDb[k] = Math.max(busDb[k] ?? -Infinity, db);
    }
    this.stemGains = {};
    for (const { i, db } of levels) if (db != null) this.stemGains[i] = db - busDb[roughBusOf(this.s.stems[i])];
    // Shown against the middle stem, so one that stands out doesn't make all the others look turned down.
    const middle = [...found].sort((a, b) => a - b)[Math.floor(found.length / 2)];
    const stems = levels.filter(({ i, db }) => db != null && !matched(this.s.stems[i])).map(({ i, db }) => ({ name: this.s.stems[i].name, db: db - middle, ...(this.stemCurves[i] ? { moves: this.stemCurves[i].moves } : {}) }));
    this.stemFit = { busDb, offsetSec: fit.offsetSec, share: fit.share, method: fit.method, partial: !!fit.partial, stems };
    return { read: true, stems, share: fit.share, method: fit.method };
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
    // Mains hum in a voice, found in its pauses. Before the fades: these narrow
    // cuts ring for a moment after a sound stops, and the fades clean that up.
    if (kind === 'dialogue' && this.s.dialogueHum !== false) {
      const h = detectHumInPauses(chs, sr);
      if (h.detected) {
        const r = removeHum(chs, sr, h);
        if (r.filters.length) row.steps.push(`${h.mains} Hz hum removed (${r.filters.length} narrow cut${r.filters.length === 1 ? '' : 's'})`);
      }
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
    const fromRough = this.stemGains?.[index] || 0;
    gain(chs, (st.gain || 0) + fromRough);
    if (fromRough) row.steps.push(`Level from your rough mix: ${fmt(fromRough)} dB`);
    // Where the part's level changes along the song in your rough mix, the stem follows. The moves go on
    // at the end of its chain, like a fader ridden after the compressor, which would otherwise even them
    // out; everything measured here as the stem comes in already has them.
    const along = audible ? this.stemCurves?.[index] : null;
    const asSet = along ? chs.map((c) => new Float32Array(c)) : chs;
    if (along) {
      followCurve(asSet, sr, along.knots);
      row.steps.push(`Follows your rough mix along the song: ${along.moves.map((v) => `${fmt(v.db)} dB from ${fmtTime(v.from)} to ${fmtTime(v.to)}`).join(', ')}`);
    }
    // Unprocessed levels per bus for matching your rough mix (after your stem gain).
    if (this.rough && audible) { const k = roughBusOf(st); this.roughBus[k] = addFeatures(this.roughBus[k], stemFeatures(asSet, sr)); }
    // Auto mix keeps each bus at the level it comes in at, plan's moves included.
    if (this.s.autoHold && audible) {
      const k = roughBusOf(st), h = hopEnergies(asSet, sr);
      this.holdBus ||= {};
      if (this.holdBus[k]) h.energy.forEach((e, j) => { this.holdBus[k].energy[j] += e; });
      else this.holdBus[k] = { energy: Float64Array.from(h.energy), hop: h.hop };
      if (k === 'drums') addInto(this.heldDrums ||= stereoBuf(n), asSet, 1);
      // (With the plan's cuts in, so holding the tone does not take them back out.)
      this.heldSum ||= stereoBuf(n);
      const cuts = st.autoCuts?.length && asSet === chs ? chs.map((c) => new Float32Array(c)) : asSet;
      if (st.autoCuts?.length) toneEq(cuts, sr, { extra: st.autoCuts });
      addInto(this.heldSum, cuts, 1);
    }
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
    toneEq(chs, sr, { hpf, low: st.eqLow, lowFreq: 120, mid: st.eqMid, midFreq: 1500, high: st.eqHigh, highFreq: 7000, extra: st.autoCuts });
    row.steps.push(`HPF ${hpf} Hz, EQ ${fmt(st.eqLow || 0)}/${fmt(st.eqMid || 0)}/${fmt(st.eqHigh || 0)} dB`);
    for (const c of st.autoCuts || []) row.steps.push(`Auto mix cut ${fmt(c.gain)} dB at ${c.freq} Hz`);
    if (st.deess && st.category === 'vocals') {
      const d = deess(chs, sr, { amount: 0.55 });
      row.deess = d;
      row.steps.push(`De-ess active ${d.activePct.toFixed(1)}%, max ${d.maxGr.toFixed(1)} dB`);
    }
    // Harsh, metallic cymbals: a de-esser tuned higher.
    if (st.category === 'drums' && st.drumRole === 'cymbals' && audible && !this.s.flat) {
      const d = deess(chs, sr, { amount: 0.35, split: 6000 });
      row.steps.push(`Cymbal harshness tamed: active ${d.activePct.toFixed(1)}%, max ${d.maxGr.toFixed(1)} dB above 6 kHz`);
    }
    // Each part keeps how loud it is from one section to the next: its compressor still evens out notes
    // and words, but measured over a few seconds the part comes out as loud as it went in. (Set from the
    // whole stem, a compressor works harder on the loud sections, and the quiet ones climb.) Not for
    // dialogue, where evening out phrases is the point.
    let slowIn = null;
    const holdSlow = () => { if (!slowIn && !post && audible && st.comp > 0.01) slowIn = slowLevel(chs, sr); };
    if (st.category === 'vocals' && audible) {
      // Narrow cuts where the voice sounds boxy (400-800 Hz) or nasal (2-4 kHz).
      const cuts = this.s.flat ? [] : resonantCuts(chs, sr, [[400, 800, 'boxy'], [2000, 4000, 'nasal']], { minDb: 4, maxCut: 2.5, q: 4, trendBands: 4 });
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
        holdSlow();
        const l = compress(chs, sr, { ratio: 10, attack: 1, release: 60, knee: 8, rmsMs: 0, thresholdPct: 0.985, thresholdOffset: 0, makeup: 0, maxGr: 6 });
        row.steps.push(`Peak limiter on the loudest notes: max ${l.maxGr.toFixed(1)} dB`);
      }
    }
    if (st.comp > 0.01) {
      // A music stem keeps its level: a sparse part would otherwise lose more
      // than a steady pad and slip back in your balance.
      holdSlow();
      const keepLufs = !slowIn && st.category === 'music' ? integratedLufs(chs, sr) : -Infinity;
      const c = compress(chs, sr, compSettings(st));
      if (keepLufs > -70) gain(chs, keepLufs - integratedLufs(chs, sr));
      row.comp = { ...c, curve: undefined };
      row.steps.push(`Compression ${c.ratio.toFixed(1)}:1 (${st.compMode === 'punch' ? 'punch' : 'smooth'}${st.drumRole ? `, ${st.drumRole}` : ''}), avg ${c.avgGr.toFixed(1)} dB, max ${c.maxGr.toFixed(1)} dB`);
    }
    if (!post && st.category === 'vocals' && audible && !this.s.flat) {
      // Light tape saturation on top for character.
      saturate(chs, sr, { drive: 3, mode: 'tape', mix: 0.3 });
      row.steps.push('Light tape saturation (30% blend)');
    }
    if (slowIn) {
      const moved = keepSlowLevel(chs, sr, slowIn);
      if (moved > 0.5) row.steps.push(`Section levels kept through the compressor (up to ${moved.toFixed(1)} dB back)`);
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
    if (along) followCurve(chs, sr, along.knots);
    row.processedLufs = integratedLufs(chs, sr);
    if (audible) {
      let bus = st.category;
      if (bus === 'vocals') bus = st.role === 'lead' ? 'vocalLead' : 'vocalSupport';
      if (bus === 'ambience' && !this.buses.ambience) this.buses.ambience = stereoBuf(n);
      if (!this.buses[bus]) bus = 'music';
      if (this.heldVoices && st.category === 'vocals') this.heldVoices.push(chs);
      else addInto(this.buses[bus], chs, 1);
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

    // --- Several microphones: the one being spoken into stays up, the rest step back ---
    if (this.heldVoices?.length) {
      const shared = shareMics(this.heldVoices, sr);
      for (const v of this.heldVoices) addInto(B.vocalLead, v, 1);
      this.heldVoices = null;
      if (shared) log.push(`${shared.mics} voices share the level: the mic being spoken into stays up and the others step back, so bleed and room noise do not pile up.`);
    }
    // Lower dialogue peaks at the same loudness, so the limiter has less to do.
    if (post && this.used.vocalLead && s.phaseRotate !== false && !s.flat) {
      const r = rotatePhase(B.vocalLead, sr);
      if (r) log.push(`Dialogue peaks lowered ${r.dropDb.toFixed(1)} dB by rotating their phase; loudness and tone are unchanged.`);
    }

    // --- Does your rough mix belong to these stems? A wrong file steers nothing. ---
    const roughFit = this.rough ? fitBalance(Object.fromEntries(BUS_KEYS.filter((k) => this.roughBus[k]).map((k) => [k, this.roughBus[k]])), this.rough, this.stemFit) : null;
    const roughOk = roughBelongs(roughFit, this.stemFit);

    // --- Vocal lead / support balance ---
    progress('Balancing vocals', 0.05);
    const leadLufs = this.used.vocalLead ? integratedLufs(B.vocalLead, sr) : null;
    const supportLufs = this.used.vocalSupport ? integratedLufs(B.vocalSupport, sr) : null;
    // (With your rough mix, its own lead/backing balance is kept instead.)
    if (balance && !roughOk && !s.autoHold && leadLufs != null && supportLufs != null && supportLufs > -70) {
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
    // The lead voice alone (mid only) keys the vocal rider and the music's dip, so backing parts and
    // choirs that carry a section on their own are neither lifted to the lead's level nor ducked under.
    let leadKey = null;
    if (!post && this.used.vocalLead && this.used.vocalSupport) {
      const [l, r] = B.vocalLead, m = new Float32Array(n);
      for (let i = 0; i < n; i++) m[i] = 0.5 * (l[i] + r[i]);
      leadKey = [m, m];
    }
    const vocals = B.vocalLead;
    addInto(vocals, B.vocalSupport, 1);
    const buses = { vocals, drums: B.drums, bass: B.bass, music: B.music, fx: B.fx, ambience: B.ambience };
    const used = { vocals: this.used.vocalLead || this.used.vocalSupport, drums: this.used.drums, bass: this.used.bass, music: this.used.music, fx: this.used.fx, ambience: this.used.ambience };
    B.vocalSupport = null;
    // With no drums or vocals there is nothing to make room for, and on held
    // sounds glue only rides the quiet and loud sections. Both step aside
    // (glue only if you left it alone).
    const noRoomNeeded = !used.vocals && !used.drums;
    const skipGlue = noRoomNeeded && !s.glueTouched;
    if (noRoomNeeded && (skipGlue || (used.music && s.musicCleanup !== false))) log.push(`No drums or vocals: ${[used.music && s.musicCleanup !== false ? 'instrument clean-up' : '', skipGlue ? 'glue' : ''].filter(Boolean).join(' and ')} left out, as there is nothing to make room for.`);

    // --- Source-aware balance, or the balance of your rough mix ---
    progress('Balancing buses', 0.12);
    const keys = BUS_KEYS.filter((k) => used[k]);
    const before = Object.fromEntries(keys.map((k) => [k, integratedLufs(buses[k], sr)]));
    const targets = post ? POST_TARGETS : BUS_TARGETS;
    const even = (k) => Math.max(-40, Math.min(40, targets[k] - before[k]));
    const tot = (f) => 10 * Math.log10(keys.reduce((a, k) => a + Math.pow(10, f(k) / 10), 0));
    let rough = null;
    if (this.rough && !roughOk) {
      rough = { ...(roughFit || {}), rejected: true };
      log.push(`Your rough mix did not line up with these stems${roughFit ? ` (level error ${roughFit.errDb.toFixed(1)} dB)` : ''}, so it was not used. Check that it is a bounce of the same song.`);
    } else if (balance && this.rough) {
      progress('Matching your rough mix', 0.1);
      const fit = roughFit;
      // Each processed bus goes to its loudness in the rough mix, then all are
      // shifted together so the sum lands where the even balance would. A bus
      // you left out of the rough mix stays 24 dB under its even level.
      const target = (k) => (Number.isFinite(fit.lufs[k]) ? fit.lufs[k] - before[k] : -Infinity);
      const shift = tot((k) => targets[k]) - tot((k) => before[k] + Math.max(target(k), even(k) - 24));
      rough = { ...fit, gains: Object.fromEntries(keys.map((k) => [k, Math.max(-40, Math.min(40, Math.max(target(k) + shift, even(k) - 24)))])) };
      log.push(`Balance from your rough mix (lined up${Math.abs(fit.lagSec) >= 0.02 ? ` with a ${fit.lagSec.toFixed(2)} s offset` : ''}, fits within ${fit.errDb.toFixed(1)} dB): ${keys.map((k) => `${k} ${fmt(rough.gains[k])} dB`).join(', ')}.`);
      if (this.stemFit) log.push(`Each stem's level read from it: ${this.stemFit.stems.map((x) => `${x.name} ${fmt(x.db)} dB`).join(', ')}.${this.stemFit.method === 'energy' ? ' Read from how each stem rises and falls with it.' : ` The stems line up with ${Math.round(this.stemFit.share * 100)}% of its sound.`}`);
      else if (this.stemsUnread) log.push('Your rough mix does not match these stems sample for sample, so each bus follows it as a whole and the stems within a bus keep their own balance.');
    }
    // Auto mix has already judged the balance from the stems played together, so
    // each bus goes back to the level it came in at, with the plan's moves, and
    // its own compression cannot pull it out of place.
    const roughSet = !!rough && !rough.rejected;
    let held = null;
    if (balance && s.autoHold && !roughSet && this.holdBus) {
      const want = (k) => (this.holdBus[k] ? integratedFromHops(this.holdBus[k]) - before[k] : 0);
      const shift = tot((k) => targets[k]) - tot((k) => before[k] + want(k));
      held = Object.fromEntries(keys.map((k) => [k, Math.max(-40, Math.min(40, want(k) + shift))]));
      log.push(`Each group stays at the level it came in at, plus Auto mix’s moves: ${keys.map((k) => `${k} ${fmt(held[k])} dB`).join(', ')}.`);
    }
    const amount = s.balanceAmount ?? 1;
    const setLufs = {};
    for (const key of keys) {
      const userGain = (s.buses[key]?.gain || 0) + (key === 'vocals' ? s.vocalLevel || 0 : 0);
      const auto = !balance || before[key] <= -70 ? 0 : roughSet ? rough.gains[key] : held ? held[key] : amount * even(key);
      gain(buses[key], auto + userGain);
      setLufs[key] = before[key] + auto + userGain;
      busReports[key] = { inputLufs: before[key], autoGainDb: auto, userGainDb: userGain };
    }
    if (balance && !roughSet && !held) log.push(`Source-aware balance${amount < 0.99 ? ` (${Math.round(amount * 100)}% of the way to an even balance)` : ''}: ${keys.map((k) => `${k} ${fmt(busReports[k].autoGainDb)} dB`).join(', ')}.`);

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
        if (!s.flat || t > 0.01) {
          toneEq(b, sr, { hpf: 25 + t * 20, extra: [{ type: 'peaking', freq: 250, q: 1, gain: -t * 2 }] });
          const slow = post ? null : slowLevel(b, sr); // (notes even out, sections keep their level)
          const c = compress(b, sr, { ratio: 2 + 3 * t, attack: 10, release: 90, knee: 6, rmsMs: 8, thresholdPct: 0.7, thresholdOffset: -6 * t });
          if (slow) keepSlowLevel(b, sr, slow);
          rep.tightness = `HPF ${(25 + t * 20).toFixed(0)} Hz, 250 Hz ${fmt(-t * 2)} dB, compression avg ${c.avgGr.toFixed(1)} dB`;
        }
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
        if (s.musicCleanup !== false && !noRoomNeeded) {
          // Muddy (150-500 Hz) or boxy (500 Hz-1 kHz) build-up in the instruments is cut gently where it stands out.
          const cuts = buildUpCuts(b, sr, [[150, 500, 'muddy'], [500, 1000, 'boxy']]);
          if (cuts.length) {
            toneEq(b, sr, { extra: cuts.map((c) => ({ type: 'peaking', freq: c.freq, q: c.q, gain: c.gainDb })) });
            rep.cleanup = cuts.map((c) => `${fmt(c.gainDb)} dB at ${c.freq} Hz (${c.range})`).join(', ');
          }
        }
      }
      if (TONES[cfg.tone] && TONES[cfg.tone].length) toneEq(b, sr, { extra: TONES[cfg.tone] });
      if ((cfg.width ?? 1) !== 1) width(b, { amount: cfg.width, sr, monoHz: 0 });
      if ((cfg.glue || 0) > 0.01 && !skipGlue) {
        // In a song, a bus's glue evens out hits and phrases, not sections: a part that is louder in the
        // chorus stays louder there, and the bus keeps the level its balance gave it.
        const slow = post ? null : slowLevel(b, sr);
        const c = compress(b, sr, { ratio: 1.5 + 2.5 * cfg.glue, attack: 20, release: glueRelease || 150, knee: 8, rmsMs: 10, thresholdPct: 0.7, thresholdOffset: -6 * cfg.glue, adaptive: true });
        rep.glue = { ratio: c.ratio, avgGr: c.avgGr, maxGr: c.maxGr };
        if (slow) keepSlowLevel(b, sr, slow);
      }
    }

    // --- Vocal rider (section-aware balance) ---
    progress('Riding the vocal', 0.4);
    const instrumental = stereoBuf(n);
    for (const key of ['drums', 'bass', 'music', 'fx']) if (used[key]) addInto(instrumental, buses[key], 1);
    let rider = null;
    // Your rough mix already has the vocal where it sits against the music, and has made its own room
    // for it, so the vocal is not ridden and the music does not dip, unless you set those yourself.
    const roomFromRough = !post && roughSet && !s.roomTouched;
    if (roomFromRough && used.vocals && ((s.riderStrength || 0) > 0.01 || (s.duckAmount || 0) > 0)) log.push('Your rough mix already makes room for the vocal, so the vocal is not ridden and the music does not dip under it.');
    if (!post && !roomFromRough && used.vocals && (s.riderStrength || 0) > 0.01 && (used.music || used.drums || used.bass)) {
      rider = this.vocalRider(buses.vocals, instrumental, s.riderStrength, s.riderWindow || 1.5, leadKey);
      log.push(`Vocal rider: kept the ${leadKey ? 'lead ' : ''}vocal-to-music ratio near ${rider.targetDiff.toFixed(1)} LU, moving the vocal between ${fmt(rider.minDb)} and ${fmt(rider.maxDb)} dB across sections${leadKey ? ' (only where the lead sings)' : ''}.`);
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
      // Either music dip may be off (null).
      const { music: dm, carve: dc } = postDucks;
      const musicPart = dm && dc ? `music ${fmt(-dm.amountDb)} dB (plus ${fmt(-dc.amountDb)} dB at 1-4 kHz)` : dm ? `music ${fmt(-dm.amountDb)} dB` : dc ? `music ${fmt(-dc.amountDb)} dB at 1-4 kHz` : null;
      const parts = [musicPart, postDucks.fx ? `effects ${fmt(-postDucks.fx.amountDb)} dB` : null, postDucks.ambience ? `ambience ${fmt(-postDucks.ambience.amountDb)} dB` : null].filter(Boolean);
      if (parts.length) log.push(`Under the dialogue: ${parts.join(', ')}, coming back up in pauses.`);
    }
    const duckKey = leadKey || buses.vocals;
    if (!post && !roomFromRough && used.vocals && used.music && (s.duckAmount || 0) > 0) {
      duck = this.duckUnderVocals(buses.music, duckKey, s.duckAmount, s.duckRelease || 180);
      log.push(`Music ducks up to ${s.duckAmount} dB in the vocal range (250 Hz-5 kHz) while the ${leadKey ? 'lead ' : ''}vocal is active; average ${duck.avgGr.toFixed(2)} dB.`);
    }
    if (!post && !roomFromRough && used.vocals && used.drums && (s.duckAmount || 0) > 0) {
      // Kick harmonics and snare snap (2-5 kHz) step back a little while the vocal sings.
      const dd = this.duckUnderVocals(buses.drums, duckKey, Math.min(2, 0.4 * s.duckAmount), s.duckRelease || 180, { lo: 2000, hi: 5000, hiShare: 0 });
      log.push(`Drums dip up to ${Math.min(2, 0.4 * s.duckAmount).toFixed(1)} dB between 2 and 5 kHz under the vocal, so snare snap and kick click do not mask it (average ${dd.avgGr.toFixed(2)} dB).`);
    }
    if (used.drums && used.bass && (s.bassDuck || 0) > 0) {
      bassDuck = this.duckBassUnderKick(buses.bass, buses.drums, s.bassDuck);
      log.push(`Bass ducks up to ${s.bassDuck} dB on kick hits; active ${bassDuck.activePct.toFixed(0)}% of the time.`);
    }

    // A balance you or Auto mix set stays set: the bus stages above may not move it.
    // (Music and drums keep the dip they take under a vocal, which is the point of it.)
    if (balance && (roughSet || held)) {
      for (const key of keys) {
        if (before[key] <= -70 || (used.vocals && !post && (key === 'music' || key === 'drums'))) continue;
        gain(buses[key], Math.max(-6, Math.min(6, setLufs[key] - integratedLufs(buses[key], sr))));
      }
    }
    // The drum stages above lift the hits over the height they came in at, and the limiter at the
    // end would then pull the whole mix down on each one. So they go back to that height here.
    if (balance && (roughSet || held) && used.drums && this.heldDrums) {
      const rawLufs = integratedLufs(this.heldDrums, sr);
      if (rawLufs > -70) {
        const ceilingDb = truePeak(this.heldDrums, sr).dbtp + setLufs.drums - rawLufs;
        const l = limitWithEnvelope(buses.drums, sr, peakEnvelope(buses.drums, sr), { ceilingDb, lookaheadMs: DRUM_HITS.lookaheadMs, releaseMs: DRUM_HITS.releaseMs });
        if (l.maxGr > 0.1) {
          log.push(`The drums’ hits go back to the height they came in at (up to ${l.maxGr.toFixed(1)} dB).`);
          if (!used.vocals) gain(buses.drums, Math.max(-6, Math.min(6, setLufs.drums - integratedLufs(buses.drums, sr))));
        }
      }
    }
    this.heldDrums = null;

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

    // --- Section balance (Auto mix keeps each group's place in the mix, section by section) ---
    let sectionBalance = null;
    if (balance && s.autoHold && this.holdBus && !sections) {
      progress('Checking each section', 0.58);
      const keys = BUS_KEYS.filter((k) => used[k] && this.holdBus[k]);
      if (keys.length >= 2) {
        const came = Object.fromEntries(keys.map((k) => [k, this.holdBus[k].energy]));
        const now = Object.fromEntries(keys.map((k) => [k, hopEnergies(buses[k], sr).energy]));
        let check = sectionDrift(came, now);
        const first = check.worst;
        const fixed = new Set();
        const hop = this.holdBus[keys[0]].hop;
        for (let pass = 0; pass < 3 * keys.length && check.worst && Math.abs(check.worst.db) > BAL_TOL; pass++) {
          const k = check.worst.key, d = check.drift[k];
          // The whole of each window that is too far off moves back, ramped over 1 s.
          const move = new Float64Array(now[k].length);
          d.forEach((x, w) => {
            if (x == null || Math.abs(x) <= BAL_TOL) return;
            const v = -(x - Math.max(-BAL_BACK, Math.min(BAL_BACK, x)));
            for (let j = w * BAL_STEP; j < Math.min(move.length, w * BAL_STEP + BAL_WIN); j++) if (Math.abs(v) > Math.abs(move[j])) move[j] = v;
          });
          hopGains(buses[k], movingAverage(move, 10), hop);
          now[k] = hopEnergies(buses[k], sr).energy;
          fixed.add(k);
          check = sectionDrift(came, now);
        }
        sectionBalance = { tol: BAL_TOL, first, last: check.worst, fixed: [...fixed] };
        const say = (x) => `${fmt(x.db)} dB for ${x.key} at ${fmtTime(x.at)}`;
        if (first) log.push(fixed.size ? `In one section ${say(first)} against the other parts, so ${[...fixed].join(' and ')} went back toward how ${fixed.size > 1 ? 'they' : 'it'} came in there (now at most ${say(check.worst)}).` : `Each group kept its place from one section to the next: at most ${say(first)} against the other parts.`);
      }
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
    let roughCurve = null, shape = null;
    // Auto mix judged the tone from the stems as they came, so the stages since then may not shift it.
    // Measured before the mix-bus tone below, so the Lows and Highs sliders stay on top.
    let keepTone = null;
    if (held && this.heldSum) {
      keepTone = referenceCurve(ltas(mix, sr), ltas(this.heldSum, sr), { strength: KEEP_TONE, maxDb: KEEP_TONE_DB, fraction: 2 });
      log.push('The overall tone is held close to your stems’, so the processing does not brighten or dull them.');
    }
    this.heldSum = null;
    const busChain = (m, quiet = false) => {
      if (lows || highs || tape > 0.01) {
        toneEq(m, sr, { low: lows, lowFreq: 120, high: highs - 1.5 * tape, highFreq: 8000 });
        if (tape > 0.01) saturate(m, sr, { drive: 5 * tape, mode: 'tape' });
        if (!quiet) log.push(`Mix-bus tone: lows ${fmt(lows)} dB at 120 Hz, highs ${fmt(highs - 1.5 * tape)} dB above 8 kHz${tape > 0.01 ? `, tape saturation ${(5 * tape).toFixed(1)} dB drive` : ''}.`);
      }
      let glue = null;
      if ((s.mixGlue || 0) > 0.01 && !skipGlue) {
        glue = compress(m, sr, { ratio: 1.4 + 1.6 * s.mixGlue, attack: 30, release: glueRelease ? Math.max(120, glueRelease) : 220, knee: 10, rmsMs: 15, thresholdPct: 0.7, thresholdOffset: -5 * s.mixGlue, adaptive: true });
        if (!quiet) log.push(`Mix-bus glue ${glue.ratio.toFixed(2)}:1, average ${glue.avgGr.toFixed(1)} dB.`);
      }
      if (keepTone) { const res = spectralProcess(m, sr, { staticCurve: keepTone }); m[0] = res.chs[0]; m[1] = res.chs[1]; }
      if (roughCurve) { const res = spectralProcess(m, sr, { staticCurve: roughCurve }); m[0] = res.chs[0]; m[1] = res.chs[1]; }
      if (shape) applyShape(m, shape);
      return glue;
    };
    const mixGlue = busChain(mix);

    // --- Tone of your rough mix (static EQ toward its long-term spectrum) ---
    let roughTone = null;
    if (roughOk && (s.roughTone || 0) > 0.01) {
      progress('Matching your rough mix tone', 0.74);
      const spec = ltas(mix, sr);
      roughCurve = referenceCurve(spec, this.rough.spec, { strength: s.roughTone, maxDb: ROUGH_MAX_DB, fraction: 2 });
      const res = spectralProcess(mix, sr, { staticCurve: roughCurve });
      mix[0] = res.chs[0];
      mix[1] = res.chs[1];
      const binHz = sr / spec.N;
      const pts = bandCenters(3, 31.5, 16000).map((f) => ({ freq: Math.round(f), db: roughCurve[Math.min(roughCurve.length - 1, Math.round(f / binHz))] }));
      roughTone = { strength: s.roughTone, curve: pts };
      const big = [...pts].sort((a, b) => Math.abs(b.db) - Math.abs(a.db)).slice(0, 3);
      log.push(`Tone moved toward your rough mix at ${Math.round(s.roughTone * 100)}% strength (${(ROUGH_MAX_DB * s.roughTone).toFixed(1)} dB at most). Largest moves: ${big.map((p) => `${fmt(p.db)} dB at ${p.freq} Hz`).join(', ')}.`);
    }

    // --- The song's rise and fall (compressors level out loud and quiet sections, not only hits) ---
    let heldRange = null;
    if (s.autoHold && (roughSet || held)) {
      progress('Keeping the song’s rise and fall', 0.76);
      let stemsEnergy = null, hop = 0;
      for (const bus of Object.values(this.holdBus || {})) { stemsEnergy ||= new Float64Array(bus.energy.length); hop = bus.hop; bus.energy.forEach((e, j) => { stemsEnergy[j] += e; }); }
      if (stemsEnergy) heldRange = loudnessRangeFromHops({ energy: stemsEnergy, hop });
      let target = stemsEnergy;
      if (roughSet) {
        const lag = Math.round((rough.lagSec || 0) / this.rough.k.hopSec), from = this.rough.k.energy;
        target = Float64Array.from({ length: Math.ceil(n / this.rough.k.hop) }, (_, j) => from[j + lag] || 0);
      }
      shape = target && shapeMoves(mix, sr, target);
      if (shape) {
        applyShape(mix, shape);
        log.push(`Loud and quiet sections moved back toward ${roughSet ? 'your rough mix' : 'your stems'}, up to ${shape.maxDb.toFixed(1)} dB, so the song keeps its rise and fall.`);
      }
    }

    // --- Output stage ---
    progress('Output level', 0.78);
    let outGain = 0, out = mix, limiter = null;
    if (s.outputMode === 'loudness') {
      // Standards that measure the dialogue: the whole programme moves so that the speech lands on target.
      let targetLufs = s.targetLufs ?? -14;
      if (post && DELIVERY[s.delivery]?.gate === 'dialogue' && used.vocals) {
        const gated = dialogueLoudness(mix, buses.vocals, sr), whole = integratedLufs(mix, sr);
        if (gated != null && whole > -70) targetLufs += whole - gated;
      }
      // A mix keeps its peaks: the limiter only catches the highest of them (s.limitMaxGr), and a dense
      // song lands a little under the target rather than being flattened to reach it (but not under
      // s.limitFloorLufs).
      const f = finalize(mix, sr, { targetLufs, ceiling: s.ceiling ?? -1, maxGr: post ? null : s.limitMaxGr ?? null, minLufs: post ? null : s.limitFloorLufs ?? null });
      out = f.chs; outGain = f.gainDb; limiter = { maxGr: f.limiter.maxGr, avgGr: f.limiter.avgGr, curve: f.limiter.curve, stepSec: f.limiter.curveStepSec, limitedBy: f.limitedBy };
      log.push(`Output: ${f.achievedLufs.toFixed(2)} LUFS at ${f.truePeakDbtp.toFixed(2)} dBTP through the true-peak limiter (max ${f.limiter.maxGr.toFixed(1)} dB).${f.limitedBy > 0.1 ? ` Reaching ${targetLufs} LUFS would have flattened the peaks, so the mix stays ${f.limitedBy.toFixed(1)} dB under it.` : ''}`);
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
      // A video mix also gets music and effects without the dialogue, the usual file for dubbing and re-edits.
      const noDialogue = BUS_KEYS.filter((k) => used[k] && k !== 'vocals');
      let me = null;
      if (post && used.vocals && noDialogue.length) { me = stereoBuf(n); for (const k of noDialogue) addInto(me, buses[k], 1); }
      const parts = { ...Object.fromEntries(BUS_KEYS.filter((k) => used[k]).map((k) => [k, buses[k]])), ...(me ? { me } : {}) };
      let peak = 0;
      for (const chs of Object.values(parts)) for (const ch of chs) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
      const limit = Math.pow(10, -1 / 20);
      const g = peak * og > limit ? limit / peak : og;
      busStemTrimDb = 20 * Math.log10(g / og);
      busStems = Object.fromEntries(Object.entries(parts).map(([k, chs]) => [k, chs.map((ch) => { const c = new Float32Array(ch); for (let i = 0; i < c.length; i++) c[i] *= g; return c; })]));
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
        heldRange,
        sectionBalance,
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
        rough: this.rough ? { lufs: this.rough.lufs, seconds: this.rough.seconds, fit: rough ? { errDb: rough.errDb, lagSec: rough.lagSec, rejected: !!rough.rejected, gains: rough.gains || null, stems: this.stemFit?.stems || null, share: this.stemFit?.share ?? null, stemsUnread: !!this.stemsUnread } : null, tone: roughTone } : null,
        spatial: spatial ? { layout: spatial.layout, lufs: spatial.lufs, dbtp: spatial.dbtp, maxGr: spatial.maxGr, levels: spatial.levels } : null,
      },
    };
  }

  /** Rides `vocals` against `inst`, judged by `key` (the lead alone, when there are backing parts too). */
  vocalRider(vocals, inst, strength, windowSec, key = null) {
    const sr = this.sr, n = this.n;
    const judged = key || vocals;
    const hv = hopEnergies(judged, sr), hi = hopEnergies(inst, sr);
    const H = hv.energy.length;
    const lv = new Float32Array(H), li = new Float32Array(H);
    for (let j = 0; j < H; j++) {
      let ev = 0, ei = 0;
      for (let k = Math.max(0, j - 3); k <= j; k++) { ev += hv.energy[k]; ei += hi.energy[k]; }
      const cnt = Math.min(4, j + 1) * hv.hop;
      lv[j] = ev > 0 ? -0.691 + 10 * Math.log10(ev / cnt) : -120;
      li[j] = ei > 0 ? -0.691 + 10 * Math.log10(ei / cnt) : -120;
    }
    const vocI = integratedLufs(judged, sr);
    const active = [];
    for (let j = 0; j < H; j++) if (lv[j] > vocI - 15 && li[j] > -70) active.push(lv[j] - li[j]);
    if (!active.length) return { targetDiff: 0, minDb: 0, maxDb: 0, curve: new Float32Array(0), stepSec: 0.1 };
    active.sort((a, b) => a - b);
    const target = active[Math.floor(active.length / 2)];
    const maxMove = 4 * strength;
    const want = new Float32Array(H);
    let last = 0, quiet = 0;
    for (let j = 0; j < H; j++) {
      if (lv[j] > vocI - 15 && li[j] > -70) { last = Math.max(-maxMove, Math.min(maxMove, (target - (lv[j] - li[j])) * 0.7)); quiet = 0; }
      // Over a breath the move holds; once the lead has been out for 2 s (a section the backing
      // parts carry), the vocal goes back to where it came in.
      else if (key && ++quiet > 20) last = 0;
      want[j] = last;
    }
    // Moving-average smoothing over the section window. Both the 400 ms level
    // and the average look back, so the result is moved earlier by half of
    // each, and every move lines up with the section it belongs to.
    const w = Math.max(1, Math.round(windowSec / 0.1));
    const trail = new Float32Array(H);
    let acc = 0;
    for (let j = 0; j < H; j++) {
      acc += want[j];
      if (j >= w) acc -= want[j - w];
      trail[j] = acc / Math.min(j + 1, w);
    }
    const shift = Math.round(1.5 + (w - 1) / 2);
    const sm = new Float32Array(H);
    for (let j = 0; j < H; j++) sm[j] = trail[Math.min(H - 1, j + shift)];
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
