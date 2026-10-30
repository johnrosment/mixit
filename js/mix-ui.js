// Mix tab: stem import and routing, style, bus settings, rendering and results.

import { el, buildSections, buildEasy, easyWords, chipGroup, toast, wireDrop, setProgress, storage, store } from './controls.js';
import { probeFile, workerPayload, framesAt, encodeForDownload, download, describeInfo } from './audio-io.js';
import { encodeWav } from './engine/wav.js';
import { ABPlayer } from './player.js';
import { makeZip } from './zip.js';
import { renderBinaural } from './binaural.js';
import { encodeMp3, mp3Bitrate, mp3SizeMb } from './mp3.js';
import { chart, legend } from './charts.js';
import { NOTE_NAMES, noteName } from './engine/pitch.js';
import { LAYOUTS } from './engine/spatial.js';
import {
  fx, sx, metricsTable, kpis, loudnessChart, spectrumChart, correlationChart, gainReductionChart,
  callouts, section, downloadsRow, toJson, loudnessCsv, chartCard, curveChart,
} from './report.js';

const CATEGORIES = [['vocals', 'Vocals'], ['drums', 'Drums'], ['bass', 'Bass'], ['music', 'Music'], ['fx', 'FX']];
const ROLES = [['lead', 'Lead'], ['double', 'Double'], ['double_left', 'Double L'], ['double_right', 'Double R'], ['backing', 'Backing'], ['adlib', 'Ad-lib']];
const BUS_COLORS = { vocals: '--c-vocals', drums: '--c-drums', bass: '--c-bass', music: '--c-music', fx: '--c-fx' };

const STEM_DEFAULTS = {
  vocals: { hpf: 80, comp: 0.5, compMode: 'smooth', deess: true, width: 1, monoBass: false, tune: 0, tuneSpeed: 40 },
  drums: { hpf: 30, comp: 0.45, compMode: 'punch', deess: false, width: 1, monoBass: true },
  bass: { hpf: 25, comp: 0.45, compMode: 'smooth', deess: false, width: 0.6, monoBass: true },
  music: { hpf: 35, comp: 0.15, compMode: 'smooth', deess: false, width: 1, monoBass: true },
  fx: { hpf: 40, comp: 0.15, compMode: 'smooth', deess: false, width: 1, monoBass: false },
};

const BUS_DEFAULTS = {
  vocals: { gain: 0, glue: 0.12, tone: 'neutral', width: 1, sendReverb: 0.3, sendDelay: 0.2 },
  drums: { gain: 0, glue: 0.15, tone: 'neutral', width: 1, sendReverb: 0.08, sendDelay: 0 },
  bass: { gain: 0, glue: 0.1, tone: 'neutral', width: 1, sendReverb: 0, sendDelay: 0 },
  music: { gain: 0, glue: 0.08, tone: 'neutral', width: 1, sendReverb: 0.1, sendDelay: 0.05 },
  fx: { gain: 0, glue: 0, tone: 'neutral', width: 1, sendReverb: 0.15, sendDelay: 0.1 },
};

export const MIX_DEFAULTS = {
  autoBalance: true, balanceAmount: 0.75, roughTone: 0.5, vocalLevel: 0, vocalPresence: 0.5, riderStrength: 0.45, riderWindow: 1.5,
  transientEnergy: 0.5, bassTightness: 0.5, bassDuck: 2, stereoWidth: 0.5,
  duckAmount: 2.5, duckRelease: 180,
  reverbEnabled: true, reverbKind: 'plate', reverbDecay: 1.3, reverbPredelay: 25, reverbLevel: -14,
  delayEnabled: false, delayTime: 300, delayFeedback: 0.28, delayPingpong: true, delayLevel: -18,
  mixGlue: 0.25, mixLow: 0, mixHigh: 0, mixTape: 0, outputMode: 'headroom', headroom: -6, targetLufs: -14, ceiling: -1,
  bitDepth: 24, dither: 'tpdf', outputRate: 0, renderBusStems: true,
  spatial: 'off', spatialCentre: 0.6, spatialLfe: -12,
  tuneKey: 'auto', sectionAuto: 0,
  vocalChorus: 0.06, drumParallel: 0.3, drumDrive: 0.35, bassGrit: 0.3, delaySync: true, musicCleanup: true, alternates: false,
};

const STYLES = {
  clean: { label: 'Clean', set: {}, buses: {} },
  punchy: { label: 'Punchy', set: { transientEnergy: 0.68, mixGlue: 0.35, bassTightness: 0.62, bassDuck: 3 }, buses: { drums: { glue: 0.25 }, bass: { glue: 0.18 } } },
  warm: { label: 'Warm', set: { vocalPresence: 0.42, reverbKind: 'plate', reverbDecay: 1.6, mixGlue: 0.28 }, buses: { music: { tone: 'warm' }, vocals: { tone: 'warm' } } },
  dense: { label: 'Dense', set: { mixGlue: 0.5, duckAmount: 4, transientEnergy: 0.6, riderStrength: 0.6 }, buses: { drums: { glue: 0.3 }, vocals: { glue: 0.25 }, music: { glue: 0.2 } } },
  vocal: { label: 'Vocal forward', set: { vocalLevel: 2, vocalPresence: 0.66, duckAmount: 4.5, riderStrength: 0.6 }, buses: { music: { tone: 'dark' } } },
  wide: { label: 'Wide', set: { stereoWidth: 0.78, reverbKind: 'hall', reverbDecay: 2.2, reverbLevel: -12 }, buses: { music: { width: 1.15 }, fx: { width: 1.25 } } },
};

const pct = (v) => `${Math.round(v * 100)}%`;
const offPct = (v) => (v ? pct(v) : 'Off');
const SCHEMA = [
  { title: 'Balance', open: true, items: [
    { key: 'autoBalance', label: 'Even out the levels', type: 'toggle', help: 'Balances vocals, drums, bass and music before your own moves. With a rough mix loaded, its balance is used instead.' },
    { key: 'balanceAmount', label: 'How much to even out', type: 'range', min: 0, max: 1, step: 0.05, format: pct, help: 'Lower keeps more of the levels your stems came in with.' },
    { key: 'roughTone', label: 'Lean toward your rough mix’s tone', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Gently moves the final tone toward your rough mix.' },
    { key: 'vocalLevel', label: 'Vocal level', type: 'range', min: -12, max: 12, step: 0.5, unit: ' dB', signed: true, help: 'Turns the whole vocal up or down.' },
    { key: 'vocalPresence', label: 'Vocal clarity', type: 'range', min: 0, max: 1, step: 0.05, format: pct, help: 'Above 50% is crisper; below is softer.' },
    { key: 'riderStrength', label: 'Keep the vocal steady', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => (v ? `±${(4 * v).toFixed(1)} dB` : 'Off'), help: 'Keeps the vocal at the same level over quiet and loud parts.' },
    { key: 'riderWindow', label: 'How quickly it rides', type: 'range', min: 0.5, max: 4, step: 0.1, unit: ' s', help: 'Shorter reacts faster; longer is smoother.' },
  ] },
  { title: 'Groove and low end', items: [
    { key: 'transientEnergy', label: 'Drum punch', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => (Math.abs(v - 0.5) < 0.01 ? 'Neutral' : `${v > 0.5 ? '+' : '−'}${pct(Math.abs(v - 0.5) * 2)}`), help: 'Snappier drum hits, or softer below neutral.' },
    { key: 'bassTightness', label: 'Bass tightness', type: 'range', min: 0, max: 1, step: 0.05, format: pct, help: 'Evens out the bass so it sits tight with the kick.' },
    { key: 'bassDuck', label: 'Make room for the kick', type: 'range', min: 0, max: 8, step: 0.5, unit: ' dB', zeroLabel: 'Off', help: 'Dips the bass on each kick so both are heard.' },
    { key: 'drumParallel', label: 'Drum weight', type: 'range', min: 0, max: 0.8, step: 0.05, format: offPct, help: 'Blends a hard-squashed copy of the drums underneath for weight, keeping the hits.' },
    { key: 'drumDrive', label: 'Drum grit', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'A little tape saturation that helps the kit sit together.' },
    { key: 'bassGrit', label: 'Bass on small speakers', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Adds the bass notes’ upper harmonics, so the bass is heard on phones and laptops.' },
    { key: 'stereoWidth', label: 'Music width', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => pct(0.6 + 0.8 * v), help: 'How wide the instruments spread left and right.' },
  ] },
  { title: 'Vocal space', items: [
    { key: 'duckAmount', label: 'Make room for the vocal', type: 'range', min: 0, max: 8, step: 0.5, unit: ' dB', zeroLabel: 'Off', help: 'Dips the music slightly while someone sings.' },
    { key: 'duckRelease', label: 'How fast the music comes back', type: 'range', min: 50, max: 600, step: 10, unit: ' ms', help: 'How quickly the music returns once the vocal stops.' },
    { key: 'vocalChorus', label: 'Vocal shimmer', type: 'range', min: 0, max: 0.15, step: 0.01, format: offPct, help: 'A faint chorus on the lead vocal for movement. Keep it low.' },
  ] },
  { title: 'Mix tone', items: [
    { key: 'mixLow', label: 'Lows', type: 'range', min: -6, max: 6, step: 0.5, unit: ' dB', signed: true, help: 'Adds or removes weight across the whole mix.' },
    { key: 'mixHigh', label: 'Highs', type: 'range', min: -6, max: 6, step: 0.5, unit: ' dB', signed: true, help: 'Adds or removes brightness across the whole mix.' },
    { key: 'mixTape', label: 'Vintage tape', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Warmth and a softer top end, like an old tape machine.' },
    { key: 'musicCleanup', label: 'Clean up muddy instruments', type: 'toggle', help: 'Cuts muddy or boxy build-up in the instruments where it stands out.' },
  ] },
  { title: 'Pitch correction', items: [
    { key: 'tuneKey', label: 'Key', type: 'select', options: [
      { value: 'auto', label: 'Detect from the vocal' }, { value: 'chromatic', label: 'Any note (chromatic)' },
      ...NOTE_NAMES.flatMap((nm, i) => [{ value: `${i}:major`, label: `${nm} major` }, { value: `${i}:minor`, label: `${nm} minor` }]),
    ], help: 'Turn on Tune in a vocal stem’s ⋯ settings. Notes are pulled toward the key while the voice stays natural.' },
  ] },
  { title: 'Song sections', items: [
    { key: 'sectionAuto', label: 'Section moves', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Makes hooks bigger and verses drier. You can edit each section after a render.' },
  ] },
  { title: 'Reverb', items: [
    { key: 'reverbEnabled', label: 'Reverb', type: 'toggle', help: 'A shared room each bus sends into (amounts in Buses).' },
    { key: 'reverbKind', label: 'Type', type: 'select', options: [{ value: 'room', label: 'Room' }, { value: 'plate', label: 'Plate' }, { value: 'hall', label: 'Hall' }] },
    { key: 'reverbDecay', label: 'Length', type: 'range', min: 0.3, max: 5, step: 0.1, unit: ' s', help: 'How long the reverb tail lasts.' },
    { key: 'reverbPredelay', label: 'Gap before the reverb', type: 'range', min: 0, max: 120, step: 1, unit: ' ms', help: 'A short gap keeps words clear.' },
    { key: 'reverbLevel', label: 'Reverb level', type: 'range', min: -30, max: 0, step: 0.5, unit: ' dB' },
  ] },
  { title: 'Echo', items: [
    { key: 'delayEnabled', label: 'Echo', type: 'toggle' },
    { key: 'delayTime', label: 'Echo time', type: 'range', min: 60, max: 1000, step: 5, unit: ' ms' },
    { key: 'delayFeedback', label: 'Repeats', type: 'range', min: 0, max: 0.85, step: 0.01, format: pct, help: 'How long the echo keeps repeating.' },
    { key: 'delayPingpong', label: 'Bounce left and right', type: 'toggle' },
    { key: 'delaySync', label: 'Lock echo to the tempo', type: 'toggle', help: 'Sets the echo time from the song’s beat instead of the time above.' },
    { key: 'delayLevel', label: 'Echo level', type: 'range', min: -30, max: 0, step: 0.5, unit: ' dB' },
  ] },
  { title: 'Finishing and files', items: [
    { key: 'mixGlue', label: 'Glue', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Gentle compression that makes it feel like one performance.' },
    { key: 'outputMode', label: 'Output level', type: 'select', options: [{ value: 'headroom', label: 'Ready for mastering (leave room)' }, { value: 'loudness', label: 'Loud (finished level)' }], help: 'Ready for mastering leaves room for the Master page. Loud sounds finished.' },
    { key: 'headroom', label: 'Peak level (for mastering)', type: 'range', min: -12, max: -1, step: 0.5, unit: ' dBTP' },
    { key: 'targetLufs', label: 'Loudness (loud mode)', type: 'range', min: -20, max: -8, step: 0.5, unit: ' LUFS' },
    { key: 'ceiling', label: 'Peak limit (loud mode)', type: 'range', min: -3, max: -0.1, step: 0.1, unit: ' dBTP' },
    { key: 'bitDepth', label: 'Bit depth', type: 'select', numeric: true, options: [{ value: 16, label: '16-bit (CD)' }, { value: 24, label: '24-bit (recommended)' }, { value: 32, label: '32-bit float' }] },
    { key: 'dither', label: 'Dither', type: 'select', options: [{ value: 'tpdf', label: 'Standard' }, { value: 'shaped', label: 'Noise-shaped (best for 16-bit)' }, { value: 'none', label: 'None' }] },
    { key: 'outputRate', label: 'Sample rate', type: 'select', numeric: true, options: [{ value: 0, label: 'Same as the stems' }, { value: 44100, label: '44.1 kHz' }, { value: 48000, label: '48 kHz' }, { value: 96000, label: '96 kHz' }, { value: 192000, label: '192 kHz' }] },
    { key: 'renderBusStems', label: 'Also save each bus', type: 'toggle', help: 'Vocals, drums, bass, music and FX as separate files.' },
    { key: 'alternates', label: 'Alternate mixes', type: 'toggle', help: 'Also makes vocal up 1 and 2 dB, bass up 1 dB, instrumental, a cappella and a version without mix-bus processing. Takes longer.' },
  ] },
  { title: 'Surround', items: [
    { key: 'spatial', label: 'Surround mix', type: 'select', options: [{ value: 'off', label: 'Off' }, { value: '5.1', label: '5.1 speakers' }, { value: '7.1.4', label: '7.1.4 speakers (with height)' }], help: 'A surround speaker version of the mix, plus a headphone version. Not a Dolby Atmos master.' },
    { key: 'spatialCentre', label: 'Vocal in the centre speaker', type: 'range', min: 0, max: 1, step: 0.05, format: pct, help: 'How much of the vocal goes to the middle speaker.' },
    { key: 'spatialLfe', label: 'Subwoofer level', type: 'range', min: -30, max: -6, step: 1, format: (v) => (v <= -30 ? 'Off' : `${v} dB`), help: 'How much kick and bass also go to the subwoofer.' },
  ] },
];

// ---- Easy page: eight plain sliders mapped onto the full mix engine ----
const EASY_LUFS = -12;
const EASY_DEFAULTS = { vocal: 0, clarity: 0, lows: 0, highs: 0, punch: 0.5, verb: 0.4, echo: 0, tape: 0 };
const EASY = [
  { key: 'vocal', label: 'Vocal level', help: 'How loud the voice is.', min: -1, max: 1, def: 0, ends: ['Tucked in', 'Up front'], show: (v) => easyWords(v, { lo: 'Quieter', hi: 'Louder', off: '' }) },
  { key: 'clarity', label: 'Vocal clarity', help: 'How crisp the voice sounds.', min: -1, max: 1, def: 0, ends: ['Soft', 'Crisp'], show: (v) => easyWords(v, { lo: 'Softer', hi: 'Crisper', off: '' }) },
  { key: 'lows', label: 'Lows', help: 'Kick and bass weight.', min: -1, max: 1, def: 0, ends: ['Lighter', 'Heavier'], show: (v) => easyWords(v, { lo: 'Lighter', hi: 'Heavier', off: '' }) },
  { key: 'highs', label: 'Highs', help: 'Cymbals and sparkle.', min: -1, max: 1, def: 0, ends: ['Darker', 'Brighter'], show: (v) => easyWords(v, { lo: 'Darker', hi: 'Brighter', off: '' }) },
  { key: 'punch', label: 'Punch', help: 'How hard the drums hit.', min: 0, max: 1, def: 0.5, ends: ['Smooth', 'Punchy'], show: (v) => easyWords(v, { centre: 0.5, lo: 'Smoother', hi: 'Punchier' }) },
  { key: 'verb', label: 'Reverb', help: 'The room around the sound.', min: 0, max: 1, def: 0.4, ends: ['Dry', 'Roomy'], show: (v) => (v < 0.02 ? 'Dry' : pct(v)) },
  { key: 'echo', label: 'Echo', help: 'Repeats that trail off.', min: 0, max: 1, def: 0, ends: ['None', 'Lots'], show: offPct },
  { key: 'tape', label: 'Vintage tape', help: 'A warm, old-tape sound.', min: 0, max: 1, def: 0, ends: ['Clean', 'Warm tape'], show: offPct },
];

/** Full mix settings for the Easy sliders (a finished, loud mix). */
function easyMixValues(e) {
  const q = (x, step) => Math.round(x / step) * step;
  return {
    values: {
      ...MIX_DEFAULTS,
      vocalLevel: q(4 * e.vocal, 0.5), vocalPresence: q(0.5 + 0.18 * e.clarity, 0.01),
      mixLow: q(2.5 * e.lows, 0.5), bassTightness: q(0.5 + 0.2 * Math.max(0, e.lows), 0.05), mixHigh: q(2 * e.highs, 0.5),
      transientEnergy: q(0.5 + 0.6 * (e.punch - 0.5), 0.05), bassDuck: q(2 + 4 * (e.punch - 0.5), 0.5), drumParallel: q(0.15 + 0.3 * e.punch, 0.05),
      reverbEnabled: e.verb > 0.02, reverbLevel: q(-20 + 12 * e.verb, 0.5), reverbDecay: q(1 + 1.4 * e.verb, 0.1),
      delayEnabled: e.echo > 0.02, delayLevel: q(-26 + 12 * e.echo, 0.5), delayFeedback: q(0.2 + 0.25 * e.echo, 0.01),
      mixTape: e.tape,
      outputMode: 'loudness', targetLufs: EASY_LUFS, ceiling: -1, renderBusStems: true, spatial: 'off', sectionAuto: 0,
    },
    buses: structuredClone(BUS_DEFAULTS),
  };
}

export function inferCategory(name) {
  const n = name.toLowerCase();
  if (/(^|[^a-z])(vox|vocals?|voc|lead|hook|chorus|verse|adlibs?|ad-libs?|bgv|backing|harmon(y|ies)|doubles?|dbls?|stack)([^a-z]|$)/.test(n)) return 'vocals';
  if (/808|(^|[^a-z])(bass|sub|bassline)([^a-z]|$)/.test(n)) return 'bass';
  if (/(^|[^a-z])(kick|snare|clap|hats?|hihats?|hi-hats?|perc(ussion)?|toms?|rim|ride|cymbals?|crash|drums?|shaker|loop)([^a-z]|$)/.test(n)) return 'drums';
  if (/(^|[^a-z])(fx|sfx|riser|impact|sweep|noise|uplifter|downlifter|transition|reverse)([^a-z]|$)/.test(n)) return 'fx';
  return 'music';
}

/** Drum stem type by name: kick, snare, cymbals (hats, overheads, rooms), toms, percussion or a full kit. */
export function inferDrumRole(name) {
  const n = name.toLowerCase();
  const has = (re) => re.test(n);
  if (has(/(^|[^a-z])(kick|kik|bd|bass ?drum)([^a-z]|$)/)) return 'kick';
  if (has(/(^|[^a-z])(snare|snr|sd|clap|rim)([^a-z]|$)/)) return 'snare';
  if (has(/(^|[^a-z])(hats?|hi-?hats?|hh|oh|overheads?|cymbals?|crash|ride|room|ambience|amb)([^a-z]|$)/)) return 'cymbals';
  if (has(/(^|[^a-z])(toms?|floor ?tom|rack ?tom)([^a-z]|$)/)) return 'toms';
  if (has(/(^|[^a-z])(perc|percussion|shaker|tamb|tambourine|conga|bongo|cowbell|timbale|guiro|claves|triangle)([^a-z]|$)/)) return 'perc';
  return 'kit';
}

export function inferRole(name) {
  const n = name.toLowerCase();
  const isDouble = /(^|[^a-z0-9])(doubles?|dbls?|dubs?|stack)([^a-z0-9]|$)/.test(n);
  if (isDouble) {
    if (/(^|[^a-z0-9])(left|l)([^a-z0-9]|$)/.test(n)) return 'double_left';
    if (/(^|[^a-z0-9])(right|r)([^a-z0-9]|$)/.test(n)) return 'double_right';
    return 'double';
  }
  if (/ad-?libs?/.test(n)) return 'adlib';
  if (/(^|[^a-z])(backing|bgv|harmon(y|ies)|bv)([^a-z]|$)/.test(n)) return 'backing';
  return 'lead';
}

const rolePan = (role) => (role === 'double_left' ? -0.75 : role === 'double_right' ? 0.75 : 0);
// Double-tracked parts named left/right (guitars, keys…) start panned wide to their side.
const sidePan = (name) => {
  const n = name.toLowerCase();
  if (/(^|[^a-z0-9])(left|l|lft)([^a-z0-9]|$)/.test(n)) return -0.8;
  if (/(^|[^a-z0-9])(right|r|rt|rgt)([^a-z0-9]|$)/.test(n)) return 0.8;
  return 0;
};

const STATE_KEY = 'mixit.mix.v1';

export function initMix({ engine, sendToMaster, onMode }) {
  const saved = storage(STATE_KEY, null);
  const state = {
    stems: [],
    rough: null,
    style: saved?.style || 'clean',
    values: { ...MIX_DEFAULTS, ...(saved?.values || {}) },
    buses: structuredClone(saved?.buses || BUS_DEFAULTS),
    easy: { ...EASY_DEFAULTS, ...(saved?.easy?.space != null ? { verb: saved.easy.space } : {}), ...(saved?.easy || {}) },
    result: null,
    busy: false,
    // Per-section edits from the last render, used while the stem set is unchanged.
    sectionEdits: null,
  };
  const stemSig = () => state.stems.filter((s) => s.info?.valid).map((s) => `${s.name}:${s.info.duration.toFixed(2)}`).join('|');
  const $ = (id) => document.getElementById(id);
  const renderBtn = $('x-render');
  const easyBtn = $('xe-render');
  const persist = () => store(STATE_KEY, { style: state.style, values: state.values, buses: state.buses, easy: state.easy });
  buildEasy($('xe-controls'), EASY, state.easy, persist);
  // Results sit under the Easy controls, or below the stem routing in Advanced.
  onMode((mode) => $(mode === 'easy' ? 'xe-results-slot' : 'x-results-slot').append($('x-results')));

  const controls = buildSections($('x-controls'), SCHEMA, state.values, MIX_DEFAULTS, () => persist());

  const styleChips = chipGroup($('x-styles'), Object.entries(STYLES).map(([k, s]) => [k, s.label]), state.style, (key) => {
    state.style = key;
    const keep = Object.fromEntries(['bitDepth', 'dither', 'outputRate', 'renderBusStems', 'outputMode', 'headroom', 'targetLufs', 'ceiling', 'spatial', 'spatialCentre', 'spatialLfe'].map((k) => [k, state.values[k]]));
    Object.assign(state.values, MIX_DEFAULTS, STYLES[key].set, keep);
    state.buses = structuredClone(BUS_DEFAULTS);
    for (const [b, o] of Object.entries(STYLES[key].buses)) Object.assign(state.buses[b], o);
    controls.update(state.values);
    renderBuses();
    persist();
  });

  // ---- Buses panel ----
  function renderBuses() {
    const root = $('x-buses');
    root.innerHTML = '';
    root.append(el('span', { class: 'head' }, ''), el('span', { class: 'head' }, 'Level / tone'), el('span', { class: 'head' }, 'Glue / width'), el('span', { class: 'head' }, 'Reverb / delay'));
    for (const [key, label] of CATEGORIES) {
      const b = state.buses[key];
      const slider = (prop, min, max, step, fmt) => {
        const out = el('output', {}, fmt(b[prop]));
        const input = el('input', { type: 'range', min, max, step, 'aria-label': `${label} ${prop}` });
        input.value = b[prop];
        input.addEventListener('input', () => { b[prop] = Number(input.value); out.textContent = fmt(b[prop]); persist(); });
        return el('div', { class: 'cell' }, input, out);
      };
      const tone = el('select', { 'aria-label': `${label} tone` }, ['neutral', 'bright', 'dark', 'warm'].map((t) => el('option', { value: t }, t[0].toUpperCase() + t.slice(1))));
      tone.value = b.tone;
      tone.addEventListener('change', () => { b.tone = tone.value; persist(); });
      root.append(
        el('span', { class: 'bus-name', style: `--c: var(${BUS_COLORS[key]})` }, label),
        el('div', { style: `--c: var(${BUS_COLORS[key]})` }, slider('gain', -12, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${v} dB`)),
        el('div', { style: `--c: var(${BUS_COLORS[key]})` }, slider('glue', 0, 1, 0.05, (v) => `glue ${pct(v)}`)),
        el('div', { style: `--c: var(${BUS_COLORS[key]})` }, slider('sendReverb', 0, 1, 0.01, (v) => `verb ${pct(v)}`)),
        el('span'),
        el('div', { style: `--c: var(${BUS_COLORS[key]})` }, tone),
        el('div', { style: `--c: var(${BUS_COLORS[key]})` }, slider('width', 0, 1.6, 0.05, (v) => `width ${pct(v)}`)),
        el('div', { style: `--c: var(${BUS_COLORS[key]})` }, slider('sendDelay', 0, 1, 0.01, (v) => `delay ${pct(v)}`)),
      );
    }
  }
  renderBuses();

  // ---- Snapshots: style, controls, buses and per-stem settings (matched by file name) ----
  const SNAP_KEY = 'mixit.mix-snapshots.v1';
  const STEM_KEYS = ['category', 'role', 'drumRole', 'gain', 'pan', 'mute', 'solo', 'polarity', 'hpf', 'hpfAuto', 'comp', 'compMode', 'deess', 'width', 'monoBass', 'eqLow', 'eqMid', 'eqHigh', 'panTouched', 'tune', 'tuneSpeed'];
  function renderSnapshots() {
    const snaps = storage(SNAP_KEY, {});
    const list = $('x-snaps');
    list.innerHTML = '';
    const names = Object.keys(snaps).sort();
    if (!names.length) list.append(el('li', { class: 'hint' }, 'Snapshots keep settings only (no audio) in this browser. Stem settings are restored by file name.'));
    for (const name of names) {
      const snap = snaps[name];
      list.append(el('li', {},
        el('button', { class: 'btn small load', title: `${Object.keys(snap.stems || {}).length} stems · ${STYLES[snap.style]?.label || snap.style} style`, onclick: () => {
          state.style = snap.style;
          styleChips.set(snap.style);
          Object.assign(state.values, MIX_DEFAULTS, snap.values);
          state.buses = structuredClone(snap.buses);
          controls.update(state.values);
          renderBuses();
          let matched = 0;
          for (const st of state.stems) if (snap.stems?.[st.name]) { Object.assign(st, snap.stems[st.name]); matched++; }
          renderStems();
          persist();
          toast(`Loaded snapshot “${name}”${state.stems.length ? ` (${matched}/${state.stems.length} stems matched)` : ''}`);
        } }, name),
        el('button', { class: 'icon-btn', 'aria-label': `Delete snapshot ${name}`, onclick: () => { const p = storage(SNAP_KEY, {}); delete p[name]; store(SNAP_KEY, p); renderSnapshots(); } }, '×')));
    }
  }
  $('x-snap-save').addEventListener('click', () => {
    const name = $('x-snap-name').value.trim();
    if (!name) { toast('Give the snapshot a name first.'); return; }
    const p = storage(SNAP_KEY, {});
    if (!p[name] && Object.keys(p).length >= 20) { toast('Snapshot limit reached (20). Delete one first.', { error: true }); return; }
    p[name] = {
      style: state.style, values: { ...state.values }, buses: structuredClone(state.buses),
      stems: Object.fromEntries(state.stems.map((st) => [st.name, Object.fromEntries(STEM_KEYS.map((k) => [k, st[k]]))])),
    };
    store(SNAP_KEY, p);
    $('x-snap-name').value = '';
    renderSnapshots();
    toast(`Saved snapshot “${name}”`);
  });
  renderSnapshots();

  // ---- Stems ----
  function makeStem(file) {
    const category = inferCategory(file.name);
    const role = category === 'vocals' ? inferRole(file.name) : 'lead';
    return {
      id: crypto.randomUUID(), file, info: null, name: file.name, category, role, drumRole: inferDrumRole(file.name), hpfAuto: true,
      gain: 0, pan: category === 'vocals' ? rolePan(role) : sidePan(file.name), mute: false, solo: false, polarity: false,
      eqLow: 0, eqMid: 0, eqHigh: 0, open: false, panTouched: false,
      ...STEM_DEFAULTS[category],
    };
  }

  async function addFiles(files) {
    const fresh = files.map(makeStem);
    state.stems.push(...fresh);
    renderStems();
    await Promise.all(fresh.map(async (s) => { s.info = await probeFile(s.file); }));
    renderStems();
  }
  wireDrop($('x-drop'), $('x-file'), addFiles);
  wireDrop($('xe-drop'), $('xe-file'), addFiles);

  // ---- Your rough mix (optional balance and tone reference) ----
  async function addRough(files) {
    state.rough = { file: files[0], info: null };
    renderRough();
    state.rough.info = await probeFile(files[0]);
    renderRough();
    renderStems();
  }
  function renderRough() {
    for (const id of ['x-rough', 'xe-rough']) {
      const list = $(id);
      list.innerHTML = '';
      if (!state.rough) continue;
      const r = state.rough;
      list.append(el('li', {}, el('span', { class: 'name', title: r.file.name }, r.file.name),
        el('span', { class: `meta${r.info && !r.info.valid ? ' bad' : ''}` }, describeInfo(r.info)),
        el('button', { class: 'icon-btn', 'aria-label': `Remove ${r.file.name}`, onclick: () => { state.rough = null; renderRough(); renderStems(); } }, '×')));
    }
  }
  wireDrop($('x-rough-drop'), $('x-rough-file'), addRough);
  wireDrop($('xe-rough-drop'), $('xe-rough-file'), addRough);

  function mini(label, value, min, max, step, fmt, onInput) {
    const out = el('output', {}, fmt(value));
    const input = el('input', { type: 'range', min, max, step, 'aria-label': label });
    input.value = value;
    input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); onInput(Number(input.value)); });
    input.addEventListener('dblclick', () => { input.value = 0; out.textContent = fmt(0); onInput(0); });
    return el('div', { class: 'mini' }, el('span', {}, label), input, out);
  }

  function stemRow(s) {
    const row = el('div', { class: `stem${s.mute ? ' muted' : ''}${s.open ? ' open' : ''}`, dataset: { cat: s.category } });
    const cat = el('select', { 'aria-label': `${s.name} category` }, CATEGORIES.map(([k, l]) => el('option', { value: k }, l)));
    cat.value = s.category;
    cat.addEventListener('change', () => {
      s.category = cat.value;
      Object.assign(s, STEM_DEFAULTS[s.category]);
      if (s.category === 'vocals') { s.role = inferRole(s.name); if (!s.panTouched) s.pan = rolePan(s.role); }
      renderStems();
    });
    const role = el('select', { 'aria-label': `${s.name} vocal role`, disabled: s.category !== 'vocals' }, ROLES.map(([k, l]) => el('option', { value: k }, l)));
    role.value = s.role;
    role.addEventListener('change', () => { s.role = role.value; if (!s.panTouched) s.pan = rolePan(s.role); renderStems(); });
    const toggle = (cls, prop, label, title) => {
      const b = el('button', { type: 'button', class: cls, 'aria-pressed': String(!!s[prop]), title }, label);
      b.addEventListener('click', () => { s[prop] = !s[prop]; renderStems(); });
      return b;
    };
    const infoText = describeInfo(s.info);
    const main = el('div', { class: 'stem-main' },
      el('div', { class: 'stem-name' }, el('b', { title: s.name }, s.name), el('small', { class: s.info && !s.info.valid ? 'bad' : '' }, infoText)),
      cat, role,
      el('div', { class: 'msp' }, toggle('m', 'mute', 'M', 'Mute'), toggle('s', 'solo', 'S', 'Solo'), toggle('p', 'polarity', 'Ø', 'Invert polarity')),
      mini('Gain', s.gain, -24, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${v}`, (v) => { s.gain = v; }),
      mini('Pan', s.pan, -1, 1, 0.05, (v) => (Math.abs(v) < 0.01 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`), (v) => { s.pan = v; s.panTouched = true; }),
      el('div', { class: 'msp' },
        el('button', { type: 'button', title: 'More settings', 'aria-expanded': String(s.open), onclick: () => { s.open = !s.open; row.classList.toggle('open', s.open); } }, '⋯'),
        el('button', { type: 'button', title: 'Remove stem', onclick: () => { state.stems = state.stems.filter((x) => x !== s); renderStems(); } }, '×')));
    const mode = el('select', { 'aria-label': 'Compression character' }, el('option', { value: 'smooth' }, 'Smooth (levels)'), el('option', { value: 'punch' }, 'Punch (keeps attack)'));
    mode.value = s.compMode;
    mode.addEventListener('change', () => { s.compMode = mode.value; });
    const check = (prop, label) => {
      const c = el('input', { type: 'checkbox' });
      c.checked = !!s[prop];
      c.addEventListener('change', () => { s[prop] = c.checked; });
      return el('label', { class: 'check' }, c, label);
    };
    const more = el('div', { class: 'stem-more' },
      mini('High-pass', s.hpf, 0, 300, 5, (v) => (s.hpfAuto !== false ? `Auto ≥${v}` : v ? `${v} Hz` : 'Off'), (v) => { s.hpf = v; s.hpfAuto = false; }),
      mini('Compress', s.comp, 0, 1, 0.05, (v) => (v ? pct(v) : 'Off'), (v) => { s.comp = v; }),
      el('div', { class: 'mini' }, el('span', {}, 'Character'), mode),
      mini('Low 120', s.eqLow, -12, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${v}`, (v) => { s.eqLow = v; }),
      mini('Mid 1.5k', s.eqMid, -12, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${v}`, (v) => { s.eqMid = v; }),
      mini('High 7k', s.eqHigh, -12, 12, 0.5, (v) => `${v > 0 ? '+' : ''}${v}`, (v) => { s.eqHigh = v; }),
      mini('Width', s.width, 0, 2, 0.05, pct, (v) => { s.width = v; }),
      check('monoBass', 'Mono below 120 Hz'),
      s.category === 'vocals' ? check('deess', 'De-ess') : null,
      s.category === 'vocals' ? mini('Tune', s.tune ?? 0, 0, 1, 0.05, (v) => (v ? pct(v) : 'Off'), (v) => { s.tune = v; }) : null,
      s.category === 'vocals' ? mini('Retune', s.tuneSpeed ?? 40, 0, 200, 5, (v) => (v ? `${v} ms` : 'Hard'), (v) => { s.tuneSpeed = v; }) : null);
    row.append(main, more);
    return row;
  }

  // Easy page: one compact row per stem with its bus.
  function easyStemRow(s) {
    const cat = el('select', { 'aria-label': `${s.name} goes to` }, CATEGORIES.map(([k, l]) => el('option', { value: k }, l)));
    cat.value = s.category;
    cat.addEventListener('change', () => {
      s.category = cat.value;
      Object.assign(s, STEM_DEFAULTS[s.category]);
      if (s.category === 'vocals') { s.role = inferRole(s.name); if (!s.panTouched) s.pan = rolePan(s.role); }
      renderStems();
    });
    return el('div', { class: 'easy-stem', dataset: { cat: s.category } },
      el('div', { class: 'nm' }, el('b', { title: s.name }, s.name), el('small', { class: s.info && !s.info.valid ? 'bad' : '' }, describeInfo(s.info))),
      cat,
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${s.name}`, onclick: () => { state.stems = state.stems.filter((x) => x !== s); renderStems(); } }, '×'));
  }

  function renderStems() {
    const root = $('x-stems');
    root.innerHTML = '';
    if (!state.stems.length) root.append(el('p', { class: 'hint' }, 'Drop stems on the left. Each stem is routed to a bus by its name; change the category or vocal role here.'));
    for (const s of state.stems) root.append(stemRow(s));
    const easyRoot = $('xe-stems');
    easyRoot.innerHTML = '';
    for (const s of state.stems) easyRoot.append(easyStemRow(s));
    const counts = {};
    for (const s of state.stems) counts[s.category] = (counts[s.category] || 0) + 1;
    const summary = $('x-summary');
    summary.innerHTML = '';
    for (const [k, l] of CATEGORIES) if (counts[k]) summary.append(el('span', { class: 'tag', style: `--c: var(${BUS_COLORS[k]})` }, `${l} ${counts[k]}`));
    const valid = state.stems.filter((s) => s.info?.valid);
    const dur = Math.max(0, ...valid.map((s) => s.info.duration));
    $('x-stem-count').textContent = state.stems.length ? `${state.stems.length} stem${state.stems.length > 1 ? 's' : ''} · ${dur ? `${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}` : ''}` : '';
    renderBtn.disabled = easyBtn.disabled = state.busy || !valid.length || state.stems.some((s) => !s.info) || (state.rough && !state.rough.info);
    easyBtn.textContent = valid.length ? `Mix ${valid.length} stem${valid.length > 1 ? 's' : ''}` : 'Mix it';
  }
  renderStems();

  // ---- Render ----
  // A job is what one render uses: the Easy sliders, or the Advanced values as they stand.
  function renderJob(mode) {
    if (mode === 'easy') return { mode, ...easyMixValues(state.easy), style: 'Easy', progress: $('xe-progress') };
    return { mode, values: state.values, buses: state.buses, style: `${STYLES[state.style]?.label} style`, progress: $('x-progress') };
  }
  function engineSettings(sessionStems, job) {
    const v = job.values;
    return {
      stems: sessionStems.map((s) => ({
        name: s.name, category: s.category, role: s.category === 'vocals' ? s.role : '', gain: s.gain, pan: s.pan, mute: s.mute, solo: s.solo,
        polarity: s.polarity, hpf: s.hpf, hpfAuto: s.hpfAuto !== false, drumRole: s.category === 'drums' ? s.drumRole || inferDrumRole(s.name) : null,
        comp: s.comp, compMode: s.compMode, deess: s.deess, width: s.width, monoBass: s.monoBass,
        eqLow: s.eqLow, eqMid: s.eqMid, eqHigh: s.eqHigh, tune: s.category === 'vocals' ? s.tune || 0 : 0, tuneSpeed: s.tuneSpeed ?? 40,
      })),
      tuneKey: v.tuneKey, sectionAuto: v.sectionAuto, mixLow: v.mixLow, mixHigh: v.mixHigh, mixTape: v.mixTape,
      vocalChorus: v.vocalChorus, drumParallel: v.drumParallel, drumDrive: v.drumDrive, bassGrit: v.bassGrit, delaySync: v.delaySync, musicCleanup: v.musicCleanup, alternates: v.alternates,
      autoBalance: v.autoBalance, balanceAmount: v.balanceAmount, roughTone: v.roughTone, vocalLevel: v.vocalLevel, vocalPresence: v.vocalPresence, riderStrength: v.riderStrength, riderWindow: v.riderWindow,
      transientEnergy: v.transientEnergy, bassTightness: v.bassTightness, bassDuck: v.bassDuck, stereoWidth: v.stereoWidth,
      duckAmount: v.duckAmount, duckRelease: v.duckRelease, mixGlue: v.mixGlue,
      buses: structuredClone(job.buses),
      reverb: { enabled: v.reverbEnabled, kind: v.reverbKind, decay: v.reverbDecay, predelay: v.reverbPredelay, level: v.reverbLevel },
      delay: { enabled: v.delayEnabled, time: v.delayTime, feedback: v.delayFeedback, pingpong: v.delayPingpong, level: v.delayLevel },
      outputMode: v.outputMode, headroom: v.headroom, targetLufs: v.targetLufs, ceiling: v.ceiling, renderBusStems: v.renderBusStems,
      spatial: v.spatial !== 'off' ? { layout: v.spatial, centre: v.spatialCentre, lfeDb: v.spatialLfe <= -30 ? -99 : v.spatialLfe, targetLufs: -18, ceiling: -1 } : null,
    };
  }

  renderBtn.addEventListener('click', () => render(renderJob('advanced')));
  easyBtn.addEventListener('click', () => render(renderJob('easy')));
  async function render(job) {
    const stems = state.stems.filter((s) => s.info?.valid);
    if (!stems.length || state.busy) return;
    state.busy = true;
    const progressBox = job.progress;
    renderStems();
    try {
      // Session rate: the most common WAV/AIFF rate, else 48 kHz.
      const rates = {};
      for (const s of stems) if (s.info.kind === 'wav' || s.info.kind === 'aiff') rates[s.info.sr] = (rates[s.info.sr] || 0) + 1;
      const sr = Number(Object.entries(rates).sort((a, b) => b[1] - a[1])[0]?.[0]) || 48000;
      const length = Math.max(...stems.map((s) => framesAt(s.info, sr)));
      const settings = engineSettings(stems, job);
      if (job.mode === 'advanced' && state.sectionEdits && state.sectionEdits.sig === stemSig()) settings.sections = state.sectionEdits.list;
      const t0 = performance.now();
      await engine.run('mixBegin', { settings, sr, length });
      if (state.rough?.info?.valid) {
        setProgress(progressBox, `Reading your rough mix: ${state.rough.file.name}`, 0.01);
        const { payload, transfer } = await workerPayload(state.rough.file, state.rough.info, sr);
        await engine.run('mixRough', payload, transfer);
      }
      for (let i = 0; i < stems.length; i++) {
        setProgress(progressBox, `Processing stem ${i + 1}/${stems.length}: ${stems[i].name}`, (i / stems.length) * 0.6);
        const { payload, transfer } = await workerPayload(stems[i].file, stems[i].info, sr);
        await engine.run('mixStem', { ...payload, index: i }, transfer);
      }
      const res = await engine.run('mixFinish', {}, [], (stage, f) => setProgress(progressBox, stage, 0.6 + f * 0.38));
      let binaural = null;
      if (res.spatial) {
        // Headphone version at the stereo mix's loudness and peak level.
        setProgress(progressBox, `Binaural render (${res.spatial.layout})`, 0.99);
        const chs = await renderBinaural(res.spatial.chs, sr, res.spatial.layout);
        const o = res.report.settings;
        const f = await engine.run('finalize', { audio: { sr, channels: chs }, targetLufs: res.report.output.loudness.integrated, ceiling: o.outputMode === 'loudness' ? o.ceiling : o.headroom }, chs.map((c) => c.buffer));
        binaural = { layout: res.spatial.layout, chs: f.channels, lufs: f.lufs, dbtp: f.dbtp };
      }
      state.result = { ...res, binaural, sr, style: job.style, seconds: (performance.now() - t0) / 1000, output: { bits: job.values.bitDepth, dither: job.values.dither, outputRate: job.values.outputRate } };
      setProgress(progressBox, 'Mix ready', 1, 'done');
      renderResults();
      toast('Mix ready');
    } catch (err) {
      console.error(err);
      setProgress(progressBox, `Stopped: ${err.message}`, 1, 'failed');
      toast(`Mixing failed: ${err.message}`, { error: true, ms: 6000 });
    } finally {
      state.busy = false;
      renderStems();
    }
  }

  let player = null;
  function renderResults() {
    const root = $('x-results');
    root.innerHTML = '';
    if (player) player.stop();
    const r = state.result;
    if (!r) return;
    const rep = r.report;
    const out = rep.output;
    root.append(el('div', { class: 'card' },
      el('div', { class: 'result-head' },
        el('div', {}, el('div', { class: 'title' }, `Mix of ${rep.stems.length} stem${rep.stems.length > 1 ? 's' : ''}`),
          el('div', { class: 'sub' }, `${r.style} · ${(r.sr / 1000).toFixed(1)} kHz · made in ${r.seconds.toFixed(1)} s on this computer`))),
      kpis(null, out)));

    const playerCard = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Compare'), el('span', { class: 'hint' }, 'Unprocessed sum = stems added together with no processing.')));
    root.append(playerCard);
    player = new ABPlayer(playerCard);
    player.setSources([
      { key: 'raw', label: 'Unprocessed sum', cls: 'src-before', audio: { sr: r.sr, channels: r.rawSum }, lufs: rep.rawSumLufs, truePeak: rep.rawSumTruePeak, bands: { centers: out.spectrum.bands.centers, levels: out.spectrum.bands.levels }, monoLossLu: out.stereo.monoLossLu },
      { key: 'mix', label: 'Mix', cls: 'src-after', audio: { sr: r.sr, channels: r.channels }, lufs: out.loudness.integrated, truePeak: out.peak.truePeakDbtp, bands: { centers: out.spectrum.bands.centers, levels: out.spectrum.bands.levels }, monoLossLu: out.stereo.monoLossLu },
      ...(r.binaural ? [{ key: 'binaural', label: `Binaural ${r.binaural.layout}`, cls: 'src-after', title: `The ${r.binaural.layout} bed rendered for headphones (browser HRTF)`, audio: { sr: r.sr, channels: r.binaural.chs }, lufs: r.binaural.lufs, truePeak: r.binaural.dbtp, bands: { centers: out.spectrum.bands.centers, levels: out.spectrum.bands.levels }, monoLossLu: out.stereo.monoLossLu }] : []),
    ], 'mix');

    const reportJson = () => toJson({ style: state.style, renderedSeconds: r.seconds, ...rep });
    const wav = async (chs, name, channelMask = 0) => {
      const { buffer } = await encodeForDownload({ sr: r.sr, channels: chs }, { bits: chs.length > 2 && r.output.bits === 16 ? 24 : r.output.bits, dither: r.output.dither, outputRate: r.output.outputRate, meta: { software: 'MIXIT' }, channelMask });
      return { name, data: new Uint8Array(buffer) };
    };
    const tag = r.spatial ? r.spatial.layout.replace(/\./g, '') : '';
    const BUS_NAMES = Object.fromEntries(CATEGORIES);
    // Download all: the mix and each bus stem; in Advanced also the surround
    // files and data files.
    const mixMp3 = async () => ({ name: 'mix.mp3', data: (await encodeMp3({ sr: r.sr, channels: r.channels }, { meta: { title: 'Mix' }, peakDbtp: out.peak.truePeakDbtp })).data });
    const secs = r.channels[0].length / r.sr;
    const kbps = mp3Bitrate(secs);
    const packageFiles = async (full) => {
      const files = [await wav(r.channels, 'mix.wav'), await mixMp3()];
      for (const [k, chs] of Object.entries(r.busStems || {})) files.push(await wav(chs, `stems/${k}.wav`));
      if (full && r.spatial) {
        files.push(await wav(r.spatial.chs, `mix_spatial_${tag}.wav`, LAYOUTS[r.spatial.layout].mask));
        if (r.binaural) files.push(await wav(r.binaural.chs, `mix_binaural_${tag}.wav`));
      }
      if (full) for (const a of r.alternates || []) files.push(await wav(a.chs, `alternates/mix_${a.key}.wav`));
      if (full) files.push({ name: 'mix_report.json', data: reportJson() }, { name: 'mix_loudness.csv', data: loudnessCsv([{ name: 'mix', analysis: out }]) });
      return files;
    };
    const items = [
      { label: 'Download all (ZIP)', sub: r.busStems ? 'the mix and every stem below' : 'every file below', primary: true, easy: true, run: async () => download(makeZip(await packageFiles(document.documentElement.dataset.mode !== 'easy')), 'mix_all.zip') },
      { label: 'Mix WAV', sub: `${fx(out.loudness.integrated, 1)} LUFS · ${fx(out.peak.truePeakDbtp, 1)} dBTP`, easy: true, run: async () => { const f = await wav(r.channels, 'mix.wav'); download(f.data, f.name, 'audio/wav'); } },
      { label: 'Mix MP3', sub: `${kbps} kbps · about ${mp3SizeMb(kbps, secs).toFixed(1)} MB · for sharing`, easy: true, run: async () => { const f = await mixMp3(); download(f.data, f.name, 'audio/mpeg'); } },
      ...Object.entries(r.busStems || {}).map(([k, chs]) => ({ label: `${BUS_NAMES[k] || k} stem`, sub: 'WAV, processed', easy: true, run: async () => { const f = await wav(chs, `${k}.wav`); download(f.data, f.name, 'audio/wav'); } })),
    ];
    if (r.spatial) {
      items.push({ label: `Spatial ${r.spatial.layout} WAV`, sub: `${r.spatial.chs.length} channels · ${fx(r.spatial.lufs, 1)} LUFS`, run: async () => { const f = await wav(r.spatial.chs, `mix_spatial_${tag}.wav`, LAYOUTS[r.spatial.layout].mask); download(f.data, f.name, 'audio/wav'); } });
      if (r.binaural) items.push({ label: `Binaural ${r.spatial.layout} WAV`, sub: `headphones · ${fx(r.binaural.lufs, 1)} LUFS`, run: async () => { const f = await wav(r.binaural.chs, `mix_binaural_${tag}.wav`); download(f.data, f.name, 'audio/wav'); } });
    }
    for (const a of r.alternates || []) items.push({ label: `${a.label} WAV`, sub: `alternate mix · ${fx(a.lufs, 1)} LUFS`, run: async () => { const f = await wav(a.chs, `mix_${a.key}.wav`); download(f.data, f.name, 'audio/wav'); } });
    items.push(
      { label: 'Report (JSON)', sub: 'stems, buses, chain, measurements', run: async () => download(reportJson(), 'mix_report.json', 'application/json') },
      { label: 'Loudness timeline (CSV)', sub: '100 ms resolution', run: async () => download(loudnessCsv([{ name: 'mix', analysis: out }]), 'mix_loudness.csv', 'text/csv') },
      { label: 'Send to Master →', sub: 'open this mix on the Master page', easy: true, run: async () => {
        const buf = encodeWav(r.channels, r.sr, { bits: 32 });
        sendToMaster(new File([buf], 'mix.wav', { type: 'audio/wav' }));
      } },
    );
    root.append(section('Download', downloadsRow(items)));
    if (rep.rough) root.append(roughSection(rep.rough));
    // Everything after this point is the detailed report (Advanced only).
    const core = root.children.length;
    if (rep.log.length) root.append(section('What the mix engine did', el('ul', { class: 'reasons' }, rep.log.map((l) => el('li', {}, l)))));

    const grid = el('div', { class: 'chart-grid' });
    grid.append(loudnessChart([{ label: 'Mix', color: '--accent', analysis: out }], { target: rep.settings.outputMode === 'loudness' ? rep.settings.targetLufs : null }));
    const bs = rep.busSpectra;
    const busEntries = Object.entries(bs.levels).map(([k, levels]) => ({ label: k[0].toUpperCase() + k.slice(1), color: BUS_COLORS[k], centers: bs.centers, levels }));
    grid.append(spectrumChart([...busEntries, { label: 'Mix', color: '--text', centers: out.spectrum.bands.centers, levels: out.spectrum.bands.levels, dash: [5, 4], width: 1.2 }],
      { title: 'Bus spectra (masking view)', caption: 'Where each bus sits in frequency after processing. Overlapping curves compete for the same space.', relative: false }));
    const curves = [];
    if (rep.rider?.curve?.length) curves.push({ label: 'Vocal rider (dB)', color: '--c-vocals', data: rep.rider.curve, step: rep.rider.stepSec });
    for (const [k, c] of Object.entries(rep.sections?.curves || {})) curves.push({ label: `Section ${k}`, color: BUS_COLORS[k], data: c, step: rep.sections.stepSec });
    if (rep.ducking?.curve?.length) curves.push({ label: 'Music duck', color: '--c-music', data: rep.ducking.curve, step: rep.ducking.stepSec, fill: true });
    if (rep.limiter?.curve?.length) curves.push({ label: 'Limiter', color: '--bad', data: rep.limiter.curve, step: rep.limiter.stepSec });
    if (curves.length) grid.append(riderChart(curves));
    grid.append(correlationChart([{ label: 'Mix', color: '--accent', analysis: out }]));
    root.append(grid);

    root.append(section('Stems', el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ['Stem', 'Bus', 'Input', 'After processing', 'Compression', 'De-ess', 'Chain'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rep.stems.map((s) => el('tr', { style: s.audible ? '' : 'opacity:.5' },
        el('td', {}, s.name),
        el('td', {}, s.audible ? el('span', { class: 'tag', style: `border-color: var(${BUS_COLORS[s.category] || '--line-2'})` }, s.bus === 'vocalLead' ? 'vocal lead' : s.bus === 'vocalSupport' ? 'vocal support' : s.bus) : 'muted'),
        el('td', { class: 'num' }, `${fx(s.inputLufs, 1)} LUFS`),
        el('td', { class: 'num' }, `${fx(s.processedLufs, 1)} LUFS`),
        el('td', { class: 'num' }, s.comp ? `${fx(s.comp.avgGr, 1)} / ${fx(s.comp.maxGr, 1)} dB` : '–'),
        el('td', { class: 'num' }, s.deess ? `${fx(s.deess.activePct, 1)}%` : '–'),
        el('td', { style: 'text-align:left;white-space:normal;color:var(--muted);font-size:12px' }, s.steps.join(' · ')))))))));

    root.append(section('Buses', el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ['Bus', 'Input', 'Auto balance', 'Your gain', 'In the mix', 'Glue', 'Notes'].map((h) => el('th', {}, h)))),
      el('tbody', {}, Object.entries(rep.buses).map(([k, b]) => el('tr', {},
        el('td', {}, el('span', { style: `color: var(${BUS_COLORS[k]}); font-weight:600` }, k)),
        el('td', { class: 'num' }, `${fx(b.inputLufs, 1)} LUFS`),
        el('td', { class: 'num' }, `${sx(b.autoGainDb, 1)} dB`),
        el('td', { class: 'num' }, `${sx(b.userGainDb, 1)} dB`),
        el('td', { class: 'num' }, `${fx(b.outputLufs, 1)} LUFS`),
        el('td', { class: 'num' }, b.glue ? `${fx(b.glue.avgGr, 1)} dB avg` : '–'),
        el('td', { style: 'text-align:left;white-space:normal;color:var(--muted);font-size:12px' }, [b.presence, b.tightness, b.grit, b.parallel, b.drive, b.cleanup ? `cleanup ${b.cleanup}` : null, b.transient ? `transients ${sx(b.transient.maxChangeDb, 1)} dB peak` : null, b.width ? `width ${pct(b.width)}` : null].filter(Boolean).join(' · ')))))))));

    if (rep.sections) root.append(sectionsPanel(rep.sections));
    const tuned = rep.stems.filter((s) => s.tune?.applied);
    const untuned = rep.stems.filter((s) => s.tune && !s.tune.applied);
    if (untuned.length && !tuned.length) root.append(section('Pitch correction', el('p', { class: 'hint' }, untuned.map((s) => `${s.name}: not corrected, ${s.tune.reason}.`).join(' '))));
    if (tuned.length) {
      root.append(section('Pitch correction',
        el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, ['Stem', 'Key', 'Sung (pitched)', 'Notes', 'Off-key before', 'After', 'Largest move'].map((h) => el('th', {}, h)))),
          el('tbody', {}, tuned.map((s) => el('tr', {},
            el('td', {}, s.name),
            el('td', {}, `${s.tune.keyName}${s.tune.keySource ? ` (${s.tune.keySource})` : ''}`),
            el('td', { class: 'num' }, `${fx(s.tune.voicedPct, 0)}%`),
            el('td', { class: 'num' }, String(s.tune.notes)),
            el('td', { class: 'num' }, `${fx(s.tune.beforeCents, 1)} cents`),
            el('td', { class: 'num' }, `${fx(s.tune.afterCents, 1)} cents`),
            el('td', { class: 'num' }, `${fx(s.tune.maxShiftCents, 0)} cents`)))))),
        el('p', { class: 'hint' }, `Off-key = average distance from the nearest note of the key while singing, measured again on the corrected audio. With a slower retune, vibrato and scoops stay in, so the after figure stays above zero by design.${untuned.length ? ` Not corrected: ${untuned.map((s) => `${s.name} (${s.tune.reason})`).join('; ')}.` : ''}`),
        el('div', { class: 'chart-grid' }, tuned.map((s) => pitchChart(s)))));
    }
    if (r.spatial) {
      const lay = LAYOUTS[r.spatial.layout];
      root.append(section(`Spatial ${r.spatial.layout} bed`,
        el('p', { class: 'hint' }, `${fx(r.spatial.lufs, 1)} LUFS with BS.1770 channel weights, ${fx(r.spatial.dbtp, 2)} dBTP, limiter max ${fx(r.spatial.maxGr, 1)} dB. Channel order follows the WAV speaker mask (${lay.channels.map((c) => c.id).join(', ')}). The binaural version is the bed through the browser's HRTF, level-matched to the stereo mix.`),
        el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Channel'), el('th', {}, 'Speaker'), el('th', {}, 'Level vs loudest'))),
          el('tbody', {}, r.spatial.levels.map((c, i) => el('tr', {}, el('td', {}, String(i + 1)), el('td', {}, `${c.name} (${c.id})`), el('td', { class: 'num' }, c.db <= -119 ? 'silent' : `${sx(c.db, 1)} dB`))))))));
    }
    root.append(section('Mix measurements', metricsTable([{ label: 'Mix', analysis: out }])));
    [...root.children].slice(core).forEach((n) => n.classList.add('adv-only'));
    root.insertBefore(el('p', { class: 'hint center easy-only' }, 'Want charts and section editing? Switch to Advanced at the top of the page.'), root.children[core] || null);
  }

  function roughSection(rough) {
    const f = rough.fit;
    const lines = [];
    if (!f) lines.push('Your rough mix was loaded, but “Even out the levels” is off, so only its tone was used.');
    else if (f.rejected) lines.push('Your rough mix did not line up with these stems, so the standard balance was used. Check that it is a bounce of the same song from the same starting point.');
    else {
      const notes = [Math.abs(f.lagSec) >= 0.02 ? `it starts ${Math.abs(f.lagSec).toFixed(2)} s ${f.lagSec > 0 ? 'later' : 'earlier'} than the stems` : null, f.errDb >= 0.1 ? `matched to within ${fx(f.errDb, 1)} dB` : null].filter(Boolean);
      lines.push(`Levels follow your rough mix${notes.length ? ` (${notes.join('; ')})` : ''}.`);
    }
    if (rough.tone) lines.push(`The final tone was moved ${Math.round(rough.tone.strength * 100)}% toward it, never more than 4 dB.`);
    const card = section('Your rough mix', el('p', { class: 'hint' }, lines.join(' ')));
    if (rough.tone) {
      const c = curveChart('Tone moves toward your rough mix', 'EQ applied to the finished mix (dB).', rough.tone.curve.map((p) => p.freq), rough.tone.curve.map((p) => p.db));
      c.classList.add('adv-only');
      card.append(c);
    }
    return card;
  }

  const SECTION_LABELS = ['Intro', 'Verse', 'Hook / drop', 'Break', 'Outro'];
  const LABEL_COLORS = { Intro: '--line-2', Verse: '--c-music', 'Hook / drop': '--accent', Break: '--c-fx', Outro: '--line-2', 'Whole song': '--line-2' };
  const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

  function sectionsPanel(sec) {
    const sig = stemSig();
    if (!state.sectionEdits || state.sectionEdits.sig !== sig) {
      state.sectionEdits = { sig, list: sec.list.map((x) => ({ start: x.start, end: x.end, label: x.label, rel: x.rel, lufs: x.lufs, offsets: { ...(x.offsets || {}) } })) };
    }
    const list = state.sectionEdits.list;
    const total = list[list.length - 1].end;
    const bar = el('div', { class: 'sections-bar', role: 'img', 'aria-label': `Song sections: ${list.map((x) => `${x.label} at ${fmtT(x.start)}`).join(', ')}` });
    const drawBar = () => {
      bar.innerHTML = '';
      for (const x of list) bar.append(el('div', { style: `flex:${x.end - x.start} 0 0; --c: var(${LABEL_COLORS[x.label] || '--line-2'})`, title: `${x.label} ${fmtT(x.start)}-${fmtT(x.end)} (${sx(x.rel, 1)} LU vs the song)` }, x.label));
    };
    drawBar();
    const used = Object.keys(state.result.report.buses);
    const num = (x, key) => {
      const i = el('input', { type: 'number', min: -12, max: 12, step: 0.5, value: x.offsets[key] || 0, 'aria-label': `${x.label} at ${fmtT(x.start)}: ${key} offset in dB` });
      i.addEventListener('change', () => { const v = Math.max(-12, Math.min(12, Number(i.value) || 0)); i.value = v; x.offsets[key] = v; });
      return el('td', { class: 'num' }, i);
    };
    const rows = list.map((x, idx) => {
      const lab = el('select', { 'aria-label': `Section ${idx + 1} label` }, SECTION_LABELS.map((l) => el('option', { value: l }, l)));
      lab.value = SECTION_LABELS.includes(x.label) ? x.label : 'Verse';
      lab.addEventListener('change', () => { x.label = lab.value; drawBar(); });
      let start = el('td', { class: 'num' }, fmtT(x.start));
      if (idx > 0) {
        const inp = el('input', { type: 'number', step: 0.5, min: (list[idx - 1].start + 2).toFixed(1), max: (x.end - 2).toFixed(1), value: x.start.toFixed(1), 'aria-label': `Section ${idx + 1} start in seconds` });
        inp.addEventListener('change', () => {
          const v = Math.max(list[idx - 1].start + 2, Math.min(x.end - 2, Number(inp.value) || x.start));
          inp.value = v.toFixed(1); x.start = v; list[idx - 1].end = v; drawBar();
        });
        start = el('td', { class: 'num' }, inp, el('small', {}, ' s'));
      }
      return el('tr', {}, start, el('td', {}, lab), el('td', { class: 'num' }, `${sx(x.rel, 1)} LU`), ...used.map((k) => num(x, k)));
    });
    const rerender = el('button', { class: 'btn primary', type: 'button', onclick: () => { toast('Rendering with your section moves'); renderBtn.click(); } }, 'Render again with these moves');
    const reset = el('button', { class: 'btn', type: 'button', onclick: () => { state.sectionEdits = null; toast('Section edits cleared; sections will be found again on the next render'); } }, 'Clear edits');
    return section('Sections',
      el('p', { class: 'hint' }, `${sec.detected ? 'Found from loudness and tone changes in the balanced buses' : 'Your edited sections'}; labels are guesses from loudness. Automatic moves (${Math.round(sec.amount * 100)}%) add contrast and average out over the song. Edit labels, start times or add per-bus offsets (dB), then render again; edits are kept while the same stems are loaded.`),
      bar,
      el('div', { class: 'table-wrap' }, el('table', { class: 'data sections' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Start'), el('th', {}, 'Section'), el('th', {}, 'Loudness'), ...used.map((k) => el('th', {}, `${k[0].toUpperCase() + k.slice(1)} dB`)))),
        el('tbody', {}, rows))),
      el('div', { class: 'preset-row' }, rerender, reset));
  }

  function pitchChart(s) {
    const c = s.tune.curve;
    const { card, body } = chartCard(`Pitch: ${s.name}`, `Sung pitch before (red) and after (teal), with the target notes in ${s.tune.keyName}.`, { wide: true, height: 220 });
    let lo = Infinity, hi = -Infinity;
    for (const arr of [c.before, c.after]) for (const v of arr) if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) { lo = 55; hi = 75; }
    lo = Math.floor(lo - 1); hi = Math.ceil(hi + 1);
    chart(body, {
      series: [
        { label: 'Target', color: '--muted', data: c.target, step: c.stepSec, width: 1, dash: [3, 3], gapBelow: 1 },
        { label: 'Before', color: '--before', data: c.before, step: c.stepSec, width: 1.4, gapBelow: 1 },
        { label: 'After', color: '--accent', data: c.after, step: c.stepSec, width: 1.6, gapBelow: 1 },
      ],
      yMin: lo, yMax: hi, yStep: hi - lo > 14 ? 2 : 1,
      yFmt: (v, tip) => (tip ? `${noteName(v)} ${sx((v - Math.round(v)) * 100, 0)} c` : noteName(v)),
    });
    card.append(legend([{ label: 'Before', color: '--before' }, { label: 'After', color: '--accent' }, { label: 'Target note', color: '--muted', dash: [3, 3] }]));
    return card;
  }

  function riderChart(curves) {
    return gainReductionChart(curves, { title: 'Automation', caption: 'Vocal rider moves (above or below 0 dB), music ducking under the vocal, and limiter reduction.' });
  }

  return { addFiles };
}
