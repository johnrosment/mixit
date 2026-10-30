// Master tab: files, references and sound profiles, profile chips, controls,
// presets, batch rendering (with release cohesion) and results.

import { el, buildSections, buildEasy, easyWords, chipGroup, toast, wireDrop, setProgress, storage, store } from './controls.js';
import { probeFile, workerPayload, encodeForDownload, download, baseName, describeInfo, resample } from './audio-io.js';
import { ABPlayer } from './player.js';
import { makeZip } from './zip.js';
import { trimAndFade, frequencyLayers, makeLoop, assembleAlbum } from './engine/deliver.js';
import { sha256Hex, qcHtml, manifest } from './qc.js';
import { renderBinaural } from './binaural.js';
import { encodeMp3, mp3Bitrate, mp3SizeMb } from './mp3.js';
import { LAYOUTS } from './engine/spatial.js';
import { DELIVERY } from './engine/post.js';
import {
  fx, sx, metricsTable, kpis, loudnessChart, spectrumChart, correlationChart, gainReductionChart, barChart, curveChart,
  stageLog, callouts, section, downloadsRow, toJson, loudnessCsv, spectrumCsv, monoChart, spectrogramChart, repairTable,
} from './report.js';

export const MASTER_DEFAULTS = {
  delivery: 'custom', targetLufs: -14, ceiling: -1, lookahead: 5, release: 80,
  hpf: 25, low: 0, mid: 0, high: 0, tilt: 0, air: 0, deMud: 0, deMudFreq: 300,
  refStrength: 0.7, profileWidth: 0.5, profileLoudness: false, resonance: 0.3, deess: 0.15,
  multiband: 0.35, xLow: 120, xHigh: 2500, glue: 0.28,
  attack: 0, sustain: 0, bassDebloom: 0, sectionDyn: 0, sectionWindow: 10, deBox: 0, deBoxFreq: 140, hfReserve: 0, oversample: 1, hiss: 0, verb: 0, harshCut: 0, harshFreq: 3000, nasalCut: 0, nasalFreq: 700, exciter: 0,
  saturation: 0, satMode: 'tape',
  widthLow: 1, widthMid: 1, widthHigh: 1, monoBass: 0, balanceRepair: true,
  delayRepair: false, declip: false, clickRepair: 0, hum: 0, denoise: 0, bandBalance: false, bandwidthGuard: true,
  format: 'wav', bitDepth: 24, dither: 'tpdf', outputRate: 0, trim: false, fadeIn: 0, fadeOut: 0,
  platformPack: false, variations: false, mono: false, vinyl: false, layers: false, loop: false, loopSeam: 1, hiRes: false,
  spatial: 'off', spatialCentre: 0.5, spatialSurround: 0.6, spatialLfe: -12,
  cohesion: false, albumGap: 2,
  title: '', artist: '', album: '', year: '', isrc: '',
};

// Keys that shape files and deliverables rather than the processing chain.
const OUTPUT_ONLY = ['delivery', 'format', 'bitDepth', 'dither', 'outputRate', 'trim', 'fadeIn', 'fadeOut', 'platformPack', 'variations', 'mono', 'vinyl',
  'layers', 'loop', 'loopSeam', 'hiRes', 'spatial', 'spatialCentre', 'spatialSurround', 'spatialLfe', 'cohesion', 'albumGap', 'title', 'artist', 'album', 'year', 'isrc'];
const OUTPUT_KEYS = [...OUTPUT_ONLY, 'targetLufs', 'ceiling'];

export const PROFILES = {
  auto: { label: 'Auto', hint: 'Listens to the track first, then sets brightness, muddiness cleanup, "s" softening, compression and centred bass to suit it. Anything you change by hand afterwards is kept. Repair tools stay off until you turn them on.', set: {} },
  transparent: { label: 'Transparent', hint: 'Just level and peak control, with almost no colour. For mixes that already sound finished.', set: { multiband: 0.12, glue: 0.1, resonance: 0.15, deess: 0.1, saturation: 0 } },
  balanced: { label: 'Balanced', hint: 'A bit of everything: moderate compression and gentle smoothing of harsh spots.', set: {} },
  punch: { label: 'Punch', hint: 'Snappier hits, a little tape warmth and a louder result.', set: { multiband: 0.5, glue: 0.45, saturation: 1.5, satMode: 'tape', targetLufs: -11, widthHigh: 1.08, attack: 0.25 } },
  warm: { label: 'Warm', hint: 'Darker, rounder and softer. Good for bright or harsh mixes.', set: { tilt: -1, high: -0.5, saturation: 3, satMode: 'tube', glue: 0.35, resonance: 0.35 } },
  bright: { label: 'Bright', hint: 'More presence and sparkle, with extra smoothing so it never gets harsh.', set: { tilt: 1, air: 1.5, deess: 0.45, resonance: 0.5 } },
  loud: { label: 'Loud', hint: 'Very loud and dense for competitive releases: heavier compression, sudden jumps tamed, sharp highs held back and a soft clipper before the limiter.', set: { targetLufs: -9, multiband: 0.6, glue: 0.5, saturation: 2, satMode: 'clip', resonance: 0.4, sectionDyn: 0.4, hfReserve: 0.5 } },
};

const pct = (v) => `${Math.round(v * 100)}%`;
const spct = (v) => (Math.abs(v) < 0.005 ? 'Off' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
const offPct = (v) => (v ? pct(v) : 'Off');

const SCHEMA = [
  { title: 'Loudness and peaks', open: true, items: [
    { key: 'delivery', label: 'Made for', type: 'select', options: [{ value: 'custom', label: 'Music (set loudness below)' }, ...Object.entries(DELIVERY).map(([value, d]) => ({ value, label: `${d.label}: ${d.lufs} LUFS, peaks ${d.ceiling} dBTP` }))], help: 'Video, ad, podcast and TV standards set the loudness and peak limit for you. Always check your platform’s own spec.' },
    { key: 'targetLufs', label: 'Loudness', type: 'range', min: -24, max: -6, step: 0.5, unit: ' LUFS', decimals: 1, help: 'How loud the finished song is. Streaming apps sit around -14; -9 is very loud.' },
    { key: 'ceiling', label: 'Peak limit', type: 'range', min: -3, max: -0.1, step: 0.1, unit: ' dBTP', help: 'The loudest any moment can get. -1 stays clean on streaming apps.' },
    { key: 'lookahead', label: 'Limiter reaction time', type: 'range', min: 1, max: 10, step: 0.5, unit: ' ms', help: 'How far ahead the limiter looks. Leave it unless hits sound dull.' },
    { key: 'release', label: 'Limiter recovery', type: 'range', min: 20, max: 400, step: 5, unit: ' ms', help: 'How fast the volume comes back after a peak. Faster is louder; slower is smoother.' },
    { key: 'hfReserve', label: 'Hold back sharp highs', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'When hi-hats or "s" sounds would hit the limiter, only the top end dips for that moment.' },
    { key: 'oversample', label: 'Processing quality', type: 'select', numeric: true, options: [{ value: 1, label: 'Normal' }, { value: 2, label: 'High (2x, slower)' }], help: 'High is a little cleaner and takes about twice as long.' },
  ] },
  { title: 'Repair', items: [
    { key: 'delayRepair', label: 'Fix left/right timing', type: 'toggle', help: 'Lines up left and right when one is slightly late.' },
    { key: 'declip', label: 'Repair clipped peaks', type: 'toggle', help: 'Rebuilds peaks flattened by clipping, as well as it can.' },
    { key: 'clickRepair', label: 'Remove clicks', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => (v ? `sensitivity ${pct(v)}` : 'Off'), help: 'Smooths over tiny pops and clicks. Drum hits are left alone.' },
    { key: 'hum', label: 'Remove hum', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Cuts electrical hum (a low 50/60 Hz buzz).' },
    { key: 'denoise', label: 'Reduce background noise', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => (v ? `${pct(v)} (max ${(6 + 12 * v).toFixed(0)} dB)` : 'Off'), help: 'Learns the steady hiss from quiet moments and lowers it.' },
    { key: 'bandBalance', label: 'Even out left/right per range', type: 'toggle', help: 'Nudges lows, mids or highs that lean to one side back to the middle.' },
    { key: 'bandwidthGuard', label: 'Protect lossy files', type: 'toggle', help: 'Skips boosting a top end that isn’t there (as in many MP3s).' },
  ] },
  { title: 'Tone', items: [
    { key: 'hpf', label: 'Rumble filter', type: 'range', min: 0, max: 60, step: 1, unit: ' Hz', zeroLabel: 'Off', help: 'Removes deep rumble below this point.' },
    { key: 'low', label: 'Bass (120 Hz)', type: 'range', min: -6, max: 6, step: 0.5, unit: ' dB', signed: true, help: 'Adds or removes low-end weight.' },
    { key: 'mid', label: 'Mids (1.5 kHz)', type: 'range', min: -6, max: 6, step: 0.5, unit: ' dB', signed: true, help: 'Raise to push vocals forward; lower to soften.' },
    { key: 'high', label: 'Treble (7 kHz)', type: 'range', min: -6, max: 6, step: 0.5, unit: ' dB', signed: true, help: 'Adds or removes brightness and bite.' },
    { key: 'tilt', label: 'Overall brightness', type: 'range', min: -4, max: 4, step: 0.5, unit: ' dB', signed: true, help: 'Tips the whole sound brighter (+) or darker (-).' },
    { key: 'air', label: 'Air (12 kHz)', type: 'range', min: 0, max: 4, step: 0.5, unit: ' dB', zeroLabel: 'Off', help: 'A gentle lift at the very top for sparkle.' },
    { key: 'deMud', label: 'Clear muddiness', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => (v ? `${(-3 * v).toFixed(1)} dB` : 'Off'), help: 'A broad cut where mixes turn cloudy.' },
    { key: 'deMudFreq', label: 'Muddiness point', type: 'range', min: 150, max: 600, step: 10, unit: ' Hz', help: 'Where that cut sits.' },
    { key: 'nasalCut', label: 'Tame nasal tone', type: 'range', min: 0, max: 3, step: 0.5, format: (v) => (v ? `-${v} dB` : 'Off'), help: 'A narrow cut where the mix sounds boxy or nasal.' },
    { key: 'nasalFreq', label: 'Nasal point', type: 'range', min: 500, max: 1200, step: 10, unit: ' Hz' },
    { key: 'harshCut', label: 'Tame harshness', type: 'range', min: 0, max: 3, step: 0.5, format: (v) => (v ? `-${v} dB` : 'Off'), help: 'A narrow cut where the upper mids sound harsh.' },
    { key: 'harshFreq', label: 'Harshness point', type: 'range', min: 2000, max: 6000, step: 50, unit: ' Hz' },
  ] },
  { title: 'Dynamics', items: [
    { key: 'multiband', label: 'Even out lows, mids and highs', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Keeps lows, mids and highs from jumping out.' },
    { key: 'xLow', label: 'Low/mid split', type: 'range', min: 60, max: 300, step: 5, unit: ' Hz', help: 'Where the low range ends for the setting above.' },
    { key: 'xHigh', label: 'Mid/high split', type: 'range', min: 1000, max: 6000, step: 100, unit: ' Hz', help: 'Where the high range begins.' },
    { key: 'glue', label: 'Glue', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Gentle compression that makes it feel like one performance.' },
    { key: 'attack', label: 'Hit strength', type: 'range', min: -1, max: 1, step: 0.05, format: spct, help: 'Makes the start of each hit snappier (+) or softer (-).' },
    { key: 'sustain', label: 'Ring and tails', type: 'range', min: -1, max: 1, step: 0.05, format: spct, help: 'Lets notes ring longer (+) or tightens them (-).' },
    { key: 'deBox', label: 'Remove boxiness when it builds up', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Dips boxy low mids only when they pile up.' },
    { key: 'deBoxFreq', label: 'Boxiness point', type: 'range', min: 140, max: 600, step: 10, format: (v) => (v < 150 ? 'Auto' : `${v} Hz`), help: 'Auto uses the boxy spot MIXIT finds in your track.' },
    { key: 'bassDebloom', label: 'Tighten boomy bass', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Shortens bass that rings on too long.' },
    { key: 'sectionDyn', label: 'Tame sudden jumps', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Turns down short jumps in volume, but keeps verses quieter than choruses.' },
    { key: 'sectionWindow', label: 'Song part length', type: 'range', min: 4, max: 20, step: 1, unit: ' s', help: 'How long a "part of the song" is for the setting above.' },
    { key: 'deess', label: 'Soften "s" sounds', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Turns down harsh "s", "sh" and "t" sounds.' },
    { key: 'resonance', label: 'Smooth harsh ringing', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Turns down narrow ringing spots while they ring.' },
  ] },
  { title: 'Character', items: [
    { key: 'verb', label: 'Reverb', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'A touch of room on the whole song. The bass stays dry.' },
    { key: 'exciter', label: 'Sparkle (exciter)', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Adds fresh harmonics to the top end only, more in quiet parts.' },
    { key: 'saturation', label: 'Warmth', type: 'range', min: 0, max: 12, step: 0.5, unit: ' dB', zeroLabel: 'Off', help: 'Gentle grit that makes the sound warmer and fuller.' },
    { key: 'satMode', label: 'Warmth type', type: 'select', options: [{ value: 'tape', label: 'Tape (smooth)' }, { value: 'tube', label: 'Tube (rich, adds body)' }, { value: 'clip', label: 'Soft clip (loud, mostly clean)' }] },
    { key: 'hiss', label: 'Vintage tape hiss', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Faint tape noise underneath, heard mostly in quiet parts.' },
  ] },
  { title: 'Stereo width', items: [
    { key: 'widthLow', label: 'Width: lows', type: 'range', min: 0, max: 1.5, step: 0.05, format: pct, help: 'Keep at or below 100% so the bass stays solid.' },
    { key: 'widthMid', label: 'Width: mids', type: 'range', min: 0, max: 1.8, step: 0.05, format: pct },
    { key: 'widthHigh', label: 'Width: highs', type: 'range', min: 0, max: 2, step: 0.05, format: pct, help: 'Wider highs feel more open. Widening backs off by itself if it would hurt how the song sounds in mono.' },
    { key: 'monoBass', label: 'Centre the bass below', type: 'range', min: 0, max: 250, step: 10, unit: ' Hz', zeroLabel: 'Off', help: 'Everything below this plays from the middle, so bass stays punchy.' },
    { key: 'balanceRepair', label: 'Fix a lopsided mix', type: 'toggle', help: 'If one side is louder overall, brings it back toward the middle.' },
  ] },
  { title: 'Reference and sound profile', items: [
    { key: 'refStrength', label: 'How close to the reference', type: 'range', min: 0, max: 1, step: 0.05, format: pct, help: 'How far the tone moves toward your reference.' },
    { key: 'profileWidth', label: 'Match its width', type: 'range', min: 0, max: 1, step: 0.05, format: offPct, help: 'Moves the stereo width toward the reference too.' },
    { key: 'profileLoudness', label: 'Match its loudness', type: 'toggle' },
  ] },
  { title: 'Files', items: [
    { key: 'format', label: 'File type', type: 'select', options: [{ value: 'wav', label: 'WAV' }, { value: 'flac', label: 'FLAC (smaller, lossless)' }] },
    { key: 'bitDepth', label: 'Bit depth', type: 'select', numeric: true, options: [{ value: 16, label: '16-bit (CD)' }, { value: 24, label: '24-bit (recommended)' }, { value: 32, label: '32-bit float (WAV only)' }] },
    { key: 'dither', label: 'Dither', type: 'select', options: [{ value: 'tpdf', label: 'Standard' }, { value: 'shaped', label: 'Noise-shaped (best for 16-bit)' }, { value: 'none', label: 'None' }], help: 'Tiny noise that hides rounding errors. Leave it on Standard.' },
    { key: 'outputRate', label: 'Sample rate', type: 'select', numeric: true, options: [{ value: 0, label: 'Same as source' }, { value: 44100, label: '44.1 kHz' }, { value: 48000, label: '48 kHz' }, { value: 88200, label: '88.2 kHz' }, { value: 96000, label: '96 kHz' }, { value: 192000, label: '192 kHz' }] },
    { key: 'trim', label: 'Trim silence at the ends', type: 'toggle', help: 'Cuts silence at the start and end.' },
    { key: 'fadeIn', label: 'Fade in', type: 'range', min: 0, max: 5000, step: 50, unit: ' ms', zeroLabel: 'Off' },
    { key: 'fadeOut', label: 'Fade out', type: 'range', min: 0, max: 15000, step: 250, unit: ' ms', zeroLabel: 'Off' },
  ] },
  { title: 'Extra versions', items: [
    { key: 'platformPack', label: 'A version for each platform', type: 'toggle', help: 'Also makes masters at -14 (streaming), -16 (Apple), -8 (club) and -23 LUFS (broadcast).' },
    { key: 'variations', label: 'Alternative takes', type: 'toggle', help: 'Also makes Transparent, Warm and Loud takes to compare.' },
    { key: 'mono', label: 'Mono version', type: 'toggle', help: 'A single-speaker version at the same loudness.' },
    { key: 'vinyl', label: 'Vinyl / cassette version', type: 'toggle', help: 'A gentler version for cutting to vinyl or tape.' },
    { key: 'layers', label: 'Frequency layers', type: 'toggle', help: 'Low, mid and high files that add up to the master (not instrument stems).' },
    { key: 'loop', label: 'Seamless loop', type: 'toggle', help: 'A version whose end flows straight back into its start.' },
    { key: 'loopSeam', label: 'Loop crossfade length', type: 'range', min: 0.1, max: 4, step: 0.1, unit: ' s' },
    { key: 'hiRes', label: 'Hi-res files in the release package', type: 'toggle', help: 'Adds 24-bit/96 kHz and 32-bit float WAVs to the release ZIP.' },
    { key: 'spatial', label: 'Surround version', type: 'select', options: [{ value: 'off', label: 'Off' }, { value: '5.1', label: '5.1 speakers' }, { value: '7.1.4', label: '7.1.4 speakers (with height)' }], help: 'Spreads the master over surround speakers, plus a headphone version. Not a Dolby Atmos master.' },
    { key: 'spatialCentre', label: 'Centre speaker amount', type: 'range', min: 0, max: 1, step: 0.05, format: pct, help: 'How much of the centre (usually the vocal) goes to the middle speaker.' },
    { key: 'spatialSurround', label: 'Surround amount', type: 'range', min: 0, max: 1, step: 0.05, format: pct, help: 'How much of the room sound moves behind you (and above, in 7.1.4).' },
    { key: 'spatialLfe', label: 'Subwoofer level', type: 'range', min: -30, max: -6, step: 1, format: (v) => (v <= -30 ? 'Off' : `${v} dB`), help: 'How much deep bass also goes to the subwoofer.' },
    { key: 'cohesion', label: 'Make a batch sit together', type: 'toggle', help: 'Nudges several songs toward each other so an EP or album feels consistent.' },
    { key: 'albumGap', label: 'Gap between album tracks', type: 'range', min: 0, max: 6, step: 0.5, unit: ' s', help: 'Silence between songs in the gapless album file (batches only).' },
  ] },
  { title: 'Song info', items: [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'artist', label: 'Artist', type: 'text' },
    { key: 'album', label: 'Album', type: 'text' },
    { key: 'year', label: 'Year', type: 'text', maxlength: 4 },
    { key: 'isrc', label: 'ISRC', type: 'text', maxlength: 15 },
  ] },
];

// ---- Easy page: eight plain sliders mapped onto the full chain ----
const EASY_LUFS = -12;
const EASY_DEFAULTS = { lows: 0, highs: 0, punch: 0.5, width: 0.5, clean: 0.3, verb: 0, tape: 0, hiss: 0 };
const EASY = [
  { key: 'lows', label: 'Lows', help: 'Kick and bass weight.', min: -1, max: 1, def: 0, ends: ['Lighter', 'Heavier'], show: (v) => easyWords(v, { lo: 'Lighter', hi: 'Heavier', off: '' }) },
  { key: 'highs', label: 'Highs', help: 'Cymbals and sparkle.', min: -1, max: 1, def: 0, ends: ['Darker', 'Brighter'], show: (v) => easyWords(v, { lo: 'Darker', hi: 'Brighter', off: '' }) },
  { key: 'punch', label: 'Punch', help: 'How hard the hits land.', min: 0, max: 1, def: 0.5, ends: ['Smooth', 'Punchy'], show: (v) => easyWords(v, { centre: 0.5, lo: 'Smoother', hi: 'Punchier' }) },
  { key: 'width', label: 'Width', help: 'How wide it spreads.', min: 0, max: 1, def: 0.5, ends: ['Narrow', 'Wide'], show: (v) => easyWords(v, { centre: 0.5, lo: 'Narrower', hi: 'Wider' }) },
  { key: 'clean', label: 'Clean-up', help: 'Tames boxy and harsh spots.', min: 0, max: 1, def: 0.3, ends: ['Leave it', 'Polish'], show: offPct },
  { key: 'verb', label: 'Reverb', help: 'A touch of room on the whole song.', min: 0, max: 1, def: 0, ends: ['Dry', 'Roomy'], show: offPct },
  { key: 'tape', label: 'Vintage tape', help: 'A warm, old-tape sound.', min: 0, max: 1, def: 0, ends: ['Clean', 'Warm tape'], show: offPct },
  { key: 'hiss', label: 'Tape hiss', help: 'Faint tape noise underneath.', min: 0, max: 1, def: 0, ends: ['None', 'Noticeable'], show: offPct },
];

/** Advanced values for the Easy sliders, on top of the Auto profile (the sliders' keys are locked). */
function easyMasterValues(e) {
  const q = (x, step) => Math.round(x / step) * step;
  const set = {
    low: q(2.5 * e.lows, 0.5), bassDebloom: e.lows > 0 ? q(0.3 * e.lows, 0.05) : 0, hpf: e.lows < 0 ? Math.round(25 - 15 * e.lows) : 25,
    high: q(2 * e.highs - 1.5 * e.tape, 0.5),
    attack: q((e.punch - 0.5) * 0.8, 0.05), sustain: q(-(e.punch - 0.5) * 0.3, 0.05),
    widthMid: q(1 + (e.width - 0.5) * 0.4, 0.01), widthHigh: q(1 + (e.width - 0.5) * 0.7, 0.01),
    deBox: q(0.7 * e.clean, 0.05), resonance: q(0.15 + 0.5 * e.clean, 0.05),
    hiss: e.hiss, verb: e.verb, hfReserve: 0.3,
  };
  if (e.highs > 0.05) set.air = q(1.5 * e.highs, 0.5);
  if (e.highs > 0.5) set.deess = 0.45;
  if (e.tape > 0.01) { set.saturation = q(5 * e.tape, 0.5); set.satMode = 'tape'; }
  return { values: { ...MASTER_DEFAULTS, ...set, targetLufs: EASY_LUFS, ceiling: -1 }, locked: Object.keys(set) };
}

const STATE_KEY = 'mixit.master.v1';
const PRESET_KEY = 'mixit.master-presets.v1';
const SOUND_KEY = 'mixit.sound-profiles.v1';
const MAX_REFS = 8;

export function initMaster({ engine, onMode }) {
  const saved = storage(STATE_KEY, null);
  const state = {
    files: [],
    refs: [],
    sound: saved?.sound || '',
    profile: saved?.profile || 'auto',
    values: { ...MASTER_DEFAULTS, ...(saved?.values || {}) },
    easy: { ...EASY_DEFAULTS, ...(saved?.easy || {}) },
    locked: new Set(saved?.locked || []),
    results: [],
    selected: 0,
    busy: false,
  };
  const $ = (id) => document.getElementById(id);
  const resultsRoot = $('m-results');
  const renderBtn = $('m-render');
  const easyBtn = $('me-render');

  const persist = () => store(STATE_KEY, { profile: state.profile, values: state.values, locked: [...state.locked], sound: state.sound, easy: state.easy });
  buildEasy($('me-controls'), EASY, state.easy, persist);
  // Results sit under the Easy controls, or in the right-hand column in Advanced.
  onMode((mode) => $(mode === 'easy' ? 'me-results-slot' : 'm-results-slot').append(resultsRoot));

  const profileDefaults = () => ({ ...MASTER_DEFAULTS, ...PROFILES[state.profile].set });
  const controls = buildSections($('m-controls'), SCHEMA, state.values, profileDefaults(), (key) => {
    // A delivery standard sets loudness and peaks; moving either by hand goes back to custom.
    if (key === 'delivery' && DELIVERY[state.values.delivery]) {
      state.values.targetLufs = DELIVERY[state.values.delivery].lufs;
      state.values.ceiling = DELIVERY[state.values.delivery].ceiling;
      controls.update(state.values);
    } else if ((key === 'targetLufs' || key === 'ceiling') && state.values.delivery !== 'custom') {
      state.values.delivery = 'custom';
      controls.update(state.values);
    }
    if (state.profile === 'auto' && !OUTPUT_KEYS.includes(key)) state.locked.add(key);
    persist();
  });

  const profiles = chipGroup($('m-profiles'), Object.entries(PROFILES).map(([k, p]) => [k, p.label]), state.profile, (key) => applyProfile(key));
  function applyProfile(key) {
    state.profile = key;
    state.locked.clear();
    const keep = Object.fromEntries(OUTPUT_ONLY.map((k) => [k, state.values[k]]));
    Object.assign(state.values, MASTER_DEFAULTS, PROFILES[key].set, keep);
    // A chosen video, podcast or TV standard keeps its loudness and peak limit.
    const std = DELIVERY[state.values.delivery];
    if (std) Object.assign(state.values, { targetLufs: std.lufs, ceiling: std.ceiling });
    controls.update(state.values);
    $('m-profile-hint').textContent = PROFILES[key].hint;
    persist();
  }
  $('m-profile-hint').textContent = PROFILES[state.profile].hint;

  // ---- Files ----
  async function addFiles(files, opts = {}) {
    for (const file of files) {
      const entry = { file, info: null, id: crypto.randomUUID() };
      state.files.push(entry);
      renderFiles();
      entry.info = await probeFile(file);
      renderFiles();
    }
    if (opts.profile) { profiles.set(opts.profile); applyProfile(opts.profile); }
  }
  async function addRefs(files) {
    for (const file of files) {
      if (state.refs.length >= MAX_REFS) { toast(`Up to ${MAX_REFS} reference tracks.`, { error: true }); break; }
      const entry = { file, info: null };
      state.refs.push(entry);
      renderFiles();
      entry.info = await probeFile(file);
      renderFiles();
    }
  }
  function fileItem(entry, onRemove) {
    const meta = el('span', { class: `meta${entry.info && !entry.info.valid ? ' bad' : ''}` }, describeInfo(entry.info));
    return el('li', {}, el('span', { class: 'name', title: entry.file.name }, entry.file.name), meta,
      el('button', { class: 'icon-btn', 'aria-label': `Remove ${entry.file.name}`, onclick: onRemove, disabled: state.busy }, '×'));
  }
  const soundProfiles = () => storage(SOUND_KEY, {});
  const activeProfile = () => (state.sound ? soundProfiles()[state.sound] || null : null);
  function renderFiles() {
    for (const id of ['m-files', 'me-files']) {
      const list = $(id);
      list.innerHTML = '';
      for (const entry of state.files) list.append(fileItem(entry, () => { state.files = state.files.filter((x) => x !== entry); renderFiles(); }));
    }
    for (const id of ['m-ref', 'me-ref']) {
      const refList = $(id);
      refList.innerHTML = '';
      for (const entry of state.refs) refList.append(fileItem(entry, () => { state.refs = state.refs.filter((x) => x !== entry); renderFiles(); }));
    }
    renderSound();
    const hasRef = !!activeProfile() || state.refs.some((r) => r.info?.valid);
    for (const k of ['refStrength', 'profileWidth', 'profileLoudness']) controls.setDisabled(k, !hasRef);
    const valid = state.files.filter((f) => f.info?.valid);
    renderBtn.disabled = easyBtn.disabled = state.busy || !valid.length || state.files.some((f) => !f.info) || state.refs.some((r) => !r.info);
    renderBtn.textContent = valid.length > 1 ? `Master ${valid.length} tracks` : 'Master track';
    easyBtn.textContent = valid.length > 1 ? `Master ${valid.length} songs` : 'Master it';
  }
  wireDrop($('m-drop'), $('m-file'), (files) => addFiles(files));
  wireDrop($('me-drop'), $('me-file'), (files) => addFiles(files));
  wireDrop($('m-ref-drop'), $('m-ref-file'), (files) => addRefs(files));
  wireDrop($('me-ref-drop'), $('me-ref-file'), (files) => addRefs(files));

  // ---- Sound profiles (learned from references, saved in this browser) ----
  function renderSound() {
    const box = $('m-sound');
    box.innerHTML = '';
    const all = soundProfiles();
    const names = Object.keys(all).sort();
    if (state.sound && !all[state.sound]) state.sound = '';
    const validRefs = state.refs.filter((r) => r.info?.valid);
    const sel = el('select', { 'aria-label': 'Sound profile' },
      el('option', { value: '' }, validRefs.length ? `Reference files above (${validRefs.length})` : 'None (add references above)'),
      names.map((n) => el('option', { value: n }, `${n} · ${all[n].count} ref${all[n].count > 1 ? 's' : ''}`)));
    sel.value = state.sound;
    sel.addEventListener('change', () => { state.sound = sel.value; persist(); renderFiles(); });
    const del = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Delete this sound profile', title: 'Delete this sound profile', disabled: !state.sound }, '×');
    del.addEventListener('click', () => {
      const p = soundProfiles();
      delete p[state.sound];
      store(SOUND_KEY, p);
      toast(`Deleted sound profile “${state.sound}”`);
      state.sound = '';
      persist();
      renderFiles();
    });
    const name = el('input', { type: 'text', placeholder: 'Profile name', maxlength: 40, 'aria-label': 'New sound profile name' });
    const save = el('button', { class: 'btn', type: 'button', disabled: !validRefs.length || state.busy }, 'Learn and save');
    save.addEventListener('click', async () => {
      const n = name.value.trim();
      if (!n) { toast('Give the sound profile a name first.'); return; }
      const p = soundProfiles();
      if (!p[n] && Object.keys(p).length >= 10) { toast('Sound profile limit reached (10). Delete one first.', { error: true }); return; }
      save.disabled = true;
      save.textContent = 'Learning…';
      try {
        const refs = [], transfer = [];
        for (const r of validRefs) { const w = await workerPayload(r.file, r.info); refs.push({ ...w.payload, name: r.file.name }); transfer.push(...w.transfer); }
        const { profile } = await engine.run('learnProfile', { references: refs, name: n }, transfer);
        p[n] = profile;
        store(SOUND_KEY, p);
        state.sound = n;
        persist();
        toast(`Saved sound profile “${n}” from ${profile.count} reference${profile.count > 1 ? 's' : ''}`);
      } catch (err) {
        toast(`Could not learn the profile: ${err.message}`, { error: true });
      }
      renderFiles();
    });
    const cur = activeProfile();
    box.append(...[
      el('div', { class: 'preset-row' }, sel, del),
      cur ? el('p', { class: 'hint' }, `${cur.count} reference${cur.count > 1 ? 's' : ''}, ${fx(cur.lufs, 1)} LUFS average, width ${cur.widthDb.map((w) => fx(w, 1)).join(' / ')} dB side-to-mid (low/mid/high). Saved ${new Date(cur.created).toLocaleDateString()}.`) : null,
      el('div', { class: 'preset-row' }, name, save),
      el('p', { class: 'hint' }, 'Several references are averaged into one profile. Saved profiles keep only the measurements, not the audio.'),
    ].filter(Boolean));
  }

  // ---- Presets ----
  function renderPresets() {
    const presets = storage(PRESET_KEY, {});
    const list = $('m-presets');
    list.innerHTML = '';
    const names = Object.keys(presets).sort();
    if (!names.length) list.append(el('li', { class: 'hint' }, 'Saved presets stay in this browser.'));
    for (const name of names) {
      list.append(el('li', {},
        el('button', { class: 'btn small load', onclick: () => {
          Object.assign(state.values, MASTER_DEFAULTS, presets[name].values);
          state.profile = presets[name].profile || 'balanced';
          state.locked = new Set(presets[name].locked || []);
          profiles.set(state.profile);
          $('m-profile-hint').textContent = PROFILES[state.profile].hint;
          controls.update(state.values);
          persist();
          toast(`Loaded preset “${name}”`);
        } }, name),
        el('button', { class: 'icon-btn', 'aria-label': `Delete preset ${name}`, onclick: () => { const p = storage(PRESET_KEY, {}); delete p[name]; store(PRESET_KEY, p); renderPresets(); } }, '×')));
    }
  }
  $('m-preset-save').addEventListener('click', () => {
    const name = $('m-preset-name').value.trim();
    if (!name) { toast('Give the preset a name first.'); return; }
    const p = storage(PRESET_KEY, {});
    if (!p[name] && Object.keys(p).length >= 40) { toast('Preset limit reached (40). Delete one first.', { error: true }); return; }
    p[name] = { values: { ...state.values }, profile: state.profile, locked: [...state.locked] };
    store(PRESET_KEY, p);
    $('m-preset-name').value = '';
    renderPresets();
    toast(`Saved preset “${name}”`);
  });
  renderPresets();

  // ---- Render ----
  // A job is what one render uses: the Easy sliders mapped onto the Auto
  // profile, or the Advanced values as they stand.
  function renderJob(mode) {
    if (mode === 'easy') {
      const { values, locked } = easyMasterValues(state.easy);
      return { mode, values, profile: 'auto', locked, sound: null, progress: $('me-progress') };
    }
    return { mode, values: state.values, profile: state.profile, locked: [...state.locked], sound: activeProfile(), progress: $('m-progress') };
  }
  function engineSettings(job) {
    const v = job.values;
    const s = {};
    for (const k of Object.keys(MASTER_DEFAULTS)) if (!OUTPUT_ONLY.includes(k)) s[k] = v[k];
    if (job.profile === 'auto') { s.auto = true; s.locked = job.locked; }
    return s;
  }

  // Release cohesion: per-track tilt and width trims toward the batch average.
  function cohesionTrims(analyses) {
    const slope = analyses.map((a) => a.spectrum.tonal.slopeDbPerOct);
    const width = analyses.map((a) => a.stereo.sideToMidDb);
    const mean = (x) => x.reduce((p, c) => p + c, 0) / x.length;
    const ms = mean(slope), mw = mean(width.map((w) => Math.max(-30, w)));
    return analyses.map((a, i) => ({
      tiltTrim: Math.round(Math.max(-2, Math.min(2, (ms - slope[i]) * 0.8)) * 4) / 4,
      widthTrim: width[i] < -30 ? 1 : Math.round(Math.max(0.85, Math.min(1.18, Math.pow(10, ((mw - width[i]) / 20) * 0.5))) * 100) / 100,
      slope: slope[i], width: width[i], meanSlope: ms, meanWidth: mw,
    }));
  }

  renderBtn.addEventListener('click', () => render(renderJob('advanced')));
  easyBtn.addEventListener('click', () => render(renderJob('easy')));
  async function render(job) {
    const queue = state.files.filter((f) => f.info?.valid);
    if (!queue.length || state.busy) return;
    state.busy = true;
    renderFiles();
    const v = job.values;
    const progressBox = job.progress;
    const baseSettings = engineSettings(job);
    const deliverables = {
      platformPack: v.platformPack, variations: v.variations, mono: v.mono, vinyl: v.vinyl,
      spatial: v.spatial !== 'off' ? { layout: v.spatial, centre: v.spatialCentre, surround: v.spatialSurround, lfeDb: v.spatialLfe <= -30 ? -99 : v.spatialLfe, targetLufs: -18, ceiling: -1 } : null,
    };
    const output = {
      bits: v.format === 'flac' && v.bitDepth === 32 ? 24 : v.bitDepth, dither: v.dither, outputRate: v.outputRate, format: v.format,
      meta: { title: v.title, artist: v.artist, album: v.album, year: v.year, isrc: v.isrc, software: 'MIXIT' },
      finish: { trim: v.trim, fadeIn: v.fadeIn, fadeOut: v.fadeOut }, delivery: v.delivery,
      deliver: { layers: v.layers, loop: v.loop, loopSeam: v.loopSeam, hiRes: v.hiRes, albumGap: v.albumGap },
    };
    const saved = job.sound;
    const newResults = [];
    try {
      let trims = null;
      if (v.cohesion && queue.length > 1) {
        const analyses = [];
        for (let i = 0; i < queue.length; i++) {
          setProgress(progressBox, `Release cohesion: measuring ${i + 1}/${queue.length}`, (i / queue.length) * 0.1);
          const t = await workerPayload(queue[i].file, queue[i].info);
          analyses.push((await engine.run('analyze', t.payload, t.transfer)).analysis);
        }
        trims = cohesionTrims(analyses);
      }
      for (let i = 0; i < queue.length; i++) {
        const entry = queue[i];
        const label = queue.length > 1 ? `Track ${i + 1}/${queue.length}: ` : '';
        const base = trims ? 0.1 : 0;
        setProgress(progressBox, `${label}Reading ${entry.file.name}`, base);
        const track = await workerPayload(entry.file, entry.info);
        const transfer = [...track.transfer];
        const references = [];
        if (!saved) {
          for (const r of state.refs.filter((x) => x.info?.valid)) {
            const w = await workerPayload(r.file, r.info);
            references.push({ ...w.payload, name: r.file.name });
            transfer.push(...w.transfer);
          }
        }
        const settings = trims ? { ...baseSettings, tiltTrim: trims[i].tiltTrim, widthTrim: trims[i].widthTrim } : baseSettings;
        const t0 = performance.now();
        const res = await engine.run('master', { track: track.payload, references, profile: saved, settings, deliverables }, transfer,
          (stage, f) => setProgress(progressBox, `${label}${stage}`, base + (1 - base) * ((i + f) / queue.length)));
        const sp = res.extras.find((e) => e.kind === 'spatial');
        let binaural = null;
        if (sp) {
          // Headphone version at the stereo master's loudness and ceiling.
          setProgress(progressBox, `${label}Binaural render (${sp.layout})`, base + (1 - base) * ((i + 0.995) / queue.length));
          const chs = await renderBinaural(sp.chs, res.sr, sp.layout);
          const f = await engine.run('finalize', { audio: { sr: res.sr, channels: chs }, targetLufs: res.report.settings.targetLufs, ceiling: res.report.settings.ceiling }, chs.map((c) => c.buffer));
          binaural = { layout: sp.layout, chs: f.channels, lufs: f.lufs, dbtp: f.dbtp, maxGr: f.maxGr };
        }
        newResults.push({
          name: entry.file.name, base: baseName(entry.file.name), sr: res.sr, binaural,
          source: { sr: res.sr, channels: res.source.channels },
          master: { sr: res.sr, channels: res.channels },
          extras: res.extras, report: res.report, output, profile: job.profile, easy: job.mode === 'easy', cohesion: trims?.[i] || null,
          hasRef: !!res.report.profile, seconds: (performance.now() - t0) / 1000,
        });
      }
      state.results = newResults;
      state.selected = 0;
      if (job.mode === 'advanced' && state.profile === 'auto' && newResults.length === 1) {
        Object.assign(state.values, newResults[0].report.autoApplied);
        controls.update(state.values);
      }
      setProgress(progressBox, `Done: ${newResults.length} master${newResults.length > 1 ? 's' : ''} ready`, 1, 'done');
      renderResults();
      toast('Master ready');
    } catch (err) {
      console.error(err);
      setProgress(progressBox, `Stopped: ${err.message}`, 1, 'failed');
      toast(`Mastering failed: ${err.message}`, { error: true, ms: 6000 });
    } finally {
      state.busy = false;
      renderFiles();
    }
  }

  let player = null;
  function renderResults() {
    resultsRoot.innerHTML = '';
    if (player) player.stop();
    const r = state.results[state.selected];
    if (!r) return;
    const rep = r.report;
    const head = el('div', { class: 'card' },
      el('div', { class: 'result-head' },
        el('div', {}, el('div', { class: 'title' }, r.name),
          el('div', { class: 'sub' }, `${r.easy ? 'Easy' : `${PROFILES[r.profile]?.label || r.profile} profile`} · ${(r.sr / 1000).toFixed(1)} kHz · made in ${r.seconds.toFixed(1)} s on this computer${rep.profile ? ` · ${rep.profile.name ? `profile “${rep.profile.name}”` : `${rep.profile.count} reference${rep.profile.count > 1 ? 's' : ''}`} matched` : ''}`)),
        state.results.length > 1 ? el('label', { class: 'batch-select' }, 'Track',
          (() => { const s = el('select', {}, state.results.map((x, i) => el('option', { value: i }, x.name))); s.value = String(state.selected); s.addEventListener('change', () => { state.selected = Number(s.value); renderResults(); }); return s; })()) : null),
      kpis(rep.input, rep.output));
    resultsRoot.append(head);
    const warn = callouts(rep.warnings);
    if (warn) resultsRoot.append(warn);

    const playerCard = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, 'Compare'), el('span', { class: 'hint' }, 'Switch versions while playing; position is kept. Level and Monitor change how every version is heard.')));
    resultsRoot.append(playerCard);
    player = new ABPlayer(playerCard);
    const bandsOf = (a) => ({ centers: a.spectrum.bands.centers, levels: a.spectrum.bands.levels });
    const sources = [
      { key: 'original', label: 'Original', cls: 'src-before', audio: r.source, lufs: rep.input.loudness.integrated, truePeak: rep.input.peak.truePeakDbtp, bands: bandsOf(rep.input), monoLossLu: rep.input.stereo.monoLossLu },
      { key: 'master', label: 'Master', cls: 'src-after', audio: r.master, lufs: rep.output.loudness.integrated, truePeak: rep.output.peak.truePeakDbtp, bands: bandsOf(rep.output), monoLossLu: rep.output.stereo.monoLossLu },
      ...r.extras.filter((e) => e.kind !== 'spatial').map((e) => ({ key: `${e.kind}-${e.key}`, label: e.label.replace(/ \(.*\)/, '').replace(' pre-master', ''), cls: 'src-after', audio: { sr: r.sr, channels: e.chs }, lufs: e.lufs, truePeak: e.dbtp, bands: bandsOf(rep.output), monoLossLu: e.chs.length === 1 ? 0 : rep.output.stereo.monoLossLu })),
    ];
    if (r.binaural) sources.push({ key: 'binaural', label: `Binaural ${r.binaural.layout}`, cls: 'src-after', title: `The ${r.binaural.layout} bed rendered for headphones (browser HRTF)`, audio: { sr: r.sr, channels: r.binaural.chs }, lufs: r.binaural.lufs, truePeak: r.binaural.dbtp, bands: bandsOf(rep.output), monoLossLu: rep.output.stereo.monoLossLu });
    const delta = differenceSignal(r);
    if (delta) sources.push({ key: 'delta', label: 'Difference', cls: 'src-delta', title: 'Only what the chain changed: master minus the loudness-matched original', audio: delta, lufs: rep.output.loudness.integrated, truePeak: rep.output.peak.truePeakDbtp, follow: 'master' });
    player.setSources(sources, 'master');

    const fmtDesc = r.output.format === 'flac' ? `FLAC ${r.output.bits}-bit` : `WAV ${r.output.bits === 32 ? '32-bit float' : `${r.output.bits}-bit`}`;
    const finishDesc = [r.output.finish.trim ? 'edge silence trimmed' : null, r.output.finish.fadeIn ? `${r.output.finish.fadeIn} ms fade-in` : null, r.output.finish.fadeOut ? `${r.output.finish.fadeOut} ms fade-out` : null].filter(Boolean).join(', ');
    resultsRoot.append(section('Download', downloadsRow(downloadItems(r)),
      el('p', { class: 'hint' }, `Master: ${fmtDesc}, ${r.output.outputRate ? `${r.output.outputRate / 1000} kHz` : 'same sample rate as the source'}${finishDesc ? `, ${finishDesc}` : ''}. Files are made right here; nothing is uploaded.`)));
    const std = DELIVERY[r.output.delivery];
    if (std) {
      const lufs = rep.output.loudness.integrated, tp = rep.output.peak.truePeakDbtp;
      const row = (ok, text) => el('li', {}, el('span', { class: `mark ${ok ? 'pass' : 'check'}` }, ok ? 'Pass' : 'Check'), el('span', {}, text));
      resultsRoot.append(section(`Delivery check: ${std.label}`, el('ul', { class: 'check-list' },
        row(Math.abs(lufs - std.lufs) <= std.tolerance, `Loudness ${fx(lufs, 1)} LUFS (target ${std.lufs}, within ${std.tolerance})`),
        row(tp <= std.ceiling + 0.05, `Peaks ${fx(tp, 1)} dBTP (at most ${std.ceiling})`)),
        el('p', { class: 'hint' }, 'These are common targets. Always check the delivery spec from your broadcaster, platform or client.')));
    }
    // Everything after this point is the detailed report (Advanced only).
    const core = resultsRoot.children.length;

    const grid = el('div', { class: 'chart-grid' });
    grid.append(loudnessChart([
      { label: 'Original', color: '--before', analysis: rep.input },
      { label: 'Master', color: '--accent', analysis: rep.output },
    ], { target: rep.settings.targetLufs }));
    if (rep.input.spectrogram && rep.output.spectrogram) grid.append(spectrogramChart([{ label: 'Original', spec: rep.input.spectrogram }, { label: 'Master', spec: rep.output.spectrogram }]));
    const specEntries = [
      { label: 'Original', color: '--before', centers: rep.input.spectrum.bands.centers, levels: rep.input.spectrum.bands.levels, offset: -rep.input.loudness.integrated },
      { label: 'Master', color: '--accent', centers: rep.output.spectrum.bands.centers, levels: rep.output.spectrum.bands.levels, offset: -rep.output.loudness.integrated },
    ];
    if (rep.reference) specEntries.push({ label: rep.reference.profile?.name ? `Profile: ${rep.reference.profile.name}` : 'Reference', color: '--ref', centers: rep.input.spectrum.bands.centers, levels: rep.reference.referenceBands, offset: -rep.reference.referenceLufs, dash: [5, 4], width: 1.4 });
    grid.append(spectrumChart(specEntries, { title: 'Tonal balance', caption: 'Each curve is shown relative to its own loudness, so only tonal differences remain.' }));
    grid.append(correlationChart([
      { label: 'Original', color: '--before', analysis: rep.input },
      { label: 'Master', color: '--accent', analysis: rep.output },
    ]));
    grid.append(monoChart([
      { label: 'Original', color: '--before', analysis: rep.input },
      { label: 'Master', color: '--accent', analysis: rep.output },
    ]));
    const step = rep.curves.stepSec;
    const curves = [{ label: 'Limiter', color: '--bad', data: rep.curves.limiter, step, fill: true }];
    if (rep.curves.glue) curves.push({ label: 'Glue', color: '--before', data: rep.curves.glue, step });
    (rep.curves.multiband || []).forEach((c, i) => curves.push({ label: `Multiband ${['low', 'mid', 'high'][i]}`, color: ['--c-bass', '--c-music', '--c-fx'][i], data: c, step }));
    if (rep.curves.debloom) curves.push({ label: 'Bass de-bloom', color: '--ref', data: rep.curves.debloom, step });
    if (rep.curves.section) curves.push({ label: 'Section dynamics', color: '--warn', data: rep.curves.section, step: rep.curves.sectionStep });
    if (rep.curves.deBox) curves.push({ label: 'Low-mid de-box', color: '--c-vocals', data: rep.curves.deBox, step });
    if (rep.curves.hfReserve) curves.push({ label: 'HF peak reserve', color: '--c-drums', data: rep.curves.hfReserve, step });
    grid.append(gainReductionChart(curves));
    if (rep.curves.shaper) grid.append(gainReductionChart([{ label: 'Attack / sustain', color: '--accent', data: rep.curves.shaper, step, fill: true }], { title: 'Attack / sustain shaping', caption: 'Gain added (+) at hits or taken away (-) in tails, strongest value per 50 ms.' }));
    if (rep.resonance && rep.settings.resonance > 0) {
      grid.append(barChart('Resonance map', 'Where narrow resonances were turned down, and how much on average (dB).', rep.resonance.map.map((m) => m.freq), rep.resonance.map.map((m) => m.weight), { color: '--c-fx' }));
    }
    if (rep.reference) {
      grid.append(curveChart('Reference match curve', 'Static EQ applied to move toward the reference’s tonal balance.', rep.reference.curve.map((p) => p.freq), rep.reference.curve.map((p) => p.db)));
    }
    resultsRoot.append(grid);

    resultsRoot.append(section('Processing chain', stageLog(rep.stages)));
    const rt = repairTable(rep.input);
    if (rt) resultsRoot.append(section('Repair check (input)', el('p', { class: 'hint' }, 'What the restoration detectors found in the source. Repair tools only change audio when you turn them on.'), rt));
    const reasons = rep.input.suggestions.reasons;
    const applied = Object.entries(rep.autoApplied || {});
    if (reasons.length || applied.length || r.cohesion) {
      resultsRoot.append(section('Analysis notes',
        reasons.length ? el('ul', { class: 'reasons' }, reasons.map((x) => el('li', {}, x))) : null,
        applied.length ? el('p', { class: 'hint' }, `Auto profile applied: ${applied.map(([k, v]) => `${k} = ${typeof v === 'number' ? +v.toFixed(2) : v}`).join(', ')}.`) : null,
        r.cohesion ? el('p', { class: 'hint' }, `Release cohesion: this track's slope is ${fx(r.cohesion.slope, 2)} dB/oct (batch ${fx(r.cohesion.meanSlope, 2)}) and side-to-mid ${fx(r.cohesion.width, 1)} dB (batch ${fx(r.cohesion.meanWidth, 1)}), so tilt was trimmed ${sx(r.cohesion.tiltTrim, 2)} dB and width ×${r.cohesion.widthTrim.toFixed(2)}.`) : null));
    }
    if (rep.profile && !rep.profile.name) {
      const name = el('input', { type: 'text', placeholder: 'Profile name', maxlength: 40, 'aria-label': 'Sound profile name' });
      const btn = el('button', { class: 'btn', type: 'button' }, 'Save as sound profile');
      btn.addEventListener('click', () => {
        const n = name.value.trim();
        if (!n) { toast('Give the sound profile a name first.'); return; }
        const p = soundProfiles();
        if (!p[n] && Object.keys(p).length >= 10) { toast('Sound profile limit reached (10). Delete one first.', { error: true }); return; }
        p[n] = { ...rep.profile, name: n };
        store(SOUND_KEY, p);
        toast(`Saved sound profile “${n}”`);
        renderFiles();
      });
      resultsRoot.append(section('Reference profile', el('p', { class: 'hint' }, `Learned from ${rep.profile.count} reference${rep.profile.count > 1 ? 's' : ''} (${rep.profile.sources.filter(Boolean).join(', ')}): ${fx(rep.profile.lufs, 1)} LUFS, PLR ${fx(rep.profile.plr, 1)} dB, LRA ${fx(rep.profile.lra, 1)} LU. Save it to reuse without the audio files.`), el('div', { class: 'preset-row' }, name, btn)));
    }
    resultsRoot.append(section('Measurements', metricsTable([{ label: 'Original', analysis: rep.input }, { label: 'Master', analysis: rep.output }])));
    if (r.extras.length) {
      resultsRoot.append(section('Deliverables', el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Version'), el('th', {}, 'Channels'), el('th', {}, 'Loudness'), el('th', {}, 'True peak'), el('th', {}, 'Limiter max'))),
        el('tbody', {}, [...r.extras.map((e) => el('tr', {}, el('td', {}, e.label), el('td', { class: 'num' }, e.layout ? `${e.layout} (${e.chs.length} ch)` : e.chs.length === 1 ? 'mono' : 'stereo'), el('td', { class: 'num' }, `${fx(e.lufs, 2)} LUFS${e.layout ? ' (weighted)' : ''}`), el('td', { class: 'num' }, `${fx(e.dbtp, 2)} dBTP`), el('td', { class: 'num' }, `${fx(e.maxGr, 1)} dB`))),
          r.binaural ? el('tr', {}, el('td', {}, `Binaural ${r.binaural.layout} (headphones)`), el('td', { class: 'num' }, 'stereo'), el('td', { class: 'num' }, `${fx(r.binaural.lufs, 2)} LUFS`), el('td', { class: 'num' }, `${fx(r.binaural.dbtp, 2)} dBTP`), el('td', { class: 'num' }, `${fx(r.binaural.maxGr, 1)} dB`)) : null]))),
      r.extras.some((e) => e.kind === 'mono') ? el('p', { class: 'hint' }, `Mono compatibility of the master: ${fx(rep.output.stereo.monoLossLu, 2)} LU lost when folded, correlation ${fx(rep.output.stereo.correlation, 2)}, low-end correlation ${fx(rep.output.stereo.lowCorrelation, 2)}. Worst bands: ${worstMonoBands(rep.output)}. The mono file's loudness is matched as heard on two speakers.`) : null));
    }
    for (const e of r.extras.filter((x) => x.kind === 'spatial')) resultsRoot.append(spatialSection(e));
    resultsRoot.append(section('Streaming playback estimate',
      el('p', { class: 'hint' }, 'Approximate turn-down applied by loudness normalisation (attenuation only; services that also turn quiet tracks up are not modelled). Use Level in the player to hear it.'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Service'), el('th', {}, 'Reference'), el('th', {}, 'Playback gain'))),
        el('tbody', {}, rep.playbackNormalisation.map((p) => el('tr', {}, el('td', {}, p.platform), el('td', { class: 'num' }, `${p.target} LUFS`), el('td', { class: 'num' }, `${sx(p.gainDb, 1)} dB`))))))));
    [...resultsRoot.children].slice(core).forEach((n) => n.classList.add('adv-only'));
    resultsRoot.insertBefore(el('p', { class: 'hint center easy-only' }, 'Want charts and more versions? Switch to Advanced at the top of the page.'), resultsRoot.children[core] || null);
  }

  function spatialSection(e) {
    return section(`Spatial ${e.layout}`,
      el('p', { class: 'hint' }, `Upmixed from the processed stereo: ${fx(e.ambiencePct, 1)}% of the energy was measured as ambience (uncorrelated between the channels) and ${Math.round(e.settings.surround * 100)}% of that moved to the ${e.layout === '7.1.4' ? 'surround and height' : 'surround'} speakers; ${fx(e.centrePct, 1)}% went to the centre speaker. Loudness ${fx(e.lufs, 1)} LUFS with BS.1770 channel weights (${e.layout === '7.1.4' ? 'side surrounds' : 'surrounds'} +1.5 dB, LFE excluded), true peak ${fx(e.dbtp, 2)} dBTP. Channel order follows the WAV speaker mask (${LAYOUTS[e.layout].channels.map((c) => c.id).join(', ')}).`),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Channel'), el('th', {}, 'Speaker'), el('th', {}, 'Position'), el('th', {}, 'Level vs loudest'))),
        el('tbody', {}, e.levels.map((c, i) => { const ch = LAYOUTS[e.layout].channels[i]; return el('tr', {}, el('td', {}, String(i + 1)), el('td', {}, `${c.name} (${c.id})`), el('td', { class: 'num' }, ch.lfe ? '–' : `${ch.az ? `${Math.abs(ch.az)}° ${ch.az > 0 ? 'left' : 'right'}` : 'front'}${ch.el ? `, ${ch.el}° up` : ''}`), el('td', { class: 'num' }, c.db <= -119 ? 'silent' : `${sx(c.db, 1)} dB`)); })))));
  }

  function worstMonoBands(a) {
    const b = a.stereo.monoLossBands;
    if (!b) return '–';
    return b.centers.map((f, i) => [f, b.lossDb[i]]).sort((x, y) => x[1] - y[1]).slice(0, 3).map(([f, d]) => `${f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`} ${sx(d, 1)} dB`).join(', ');
  }

  // Master minus the loudness-matched original, so only the processing remains.
  function differenceSignal(r) {
    const m = r.master.channels, o = r.source.channels;
    if (!m || !o || m[0].length !== o[0].length) return null;
    const g = Math.pow(10, (r.report.output.loudness.integrated - r.report.input.loudness.integrated) / 20);
    const oc = o.length > 1 ? o : [o[0], o[0]];
    return { sr: r.sr, channels: m.map((ch, c) => { const d = new Float32Array(ch.length); const src = oc[c]; for (let i = 0; i < ch.length; i++) d[i] = ch[i] - g * src[i]; return d; }) };
  }

  // Every file one result can produce. packageFiles(full) is what Download all
  // zips: the master, CD-quality and FLAC (or WAV) versions and a QC report,
  // plus every extra version and data file when `full` (Advanced).
  function fileSet(r) {
    const rep = r.report;
    const out = r.output;
    const meta = { ...out.meta, title: out.meta.title || r.base };
    const ext = out.format === 'flac' ? 'flac' : 'wav';
    const mime = out.format === 'flac' ? 'audio/flac' : 'audio/wav';
    // Trim points come from the main master so every version is cut identically.
    let bounds = null;
    const finish = (audio) => {
      const f = out.finish;
      if (!f.trim && !f.fadeIn && !f.fadeOut) return audio;
      if (!bounds) bounds = trimAndFade(r.master.channels, r.sr, { trim: f.trim }).bounds;
      return { sr: audio.sr, channels: trimAndFade(audio.channels, audio.sr, { bounds, fadeInMs: f.fadeIn, fadeOutMs: f.fadeOut }).chs };
    };
    const loudnessOf = (lufs, dbtp, full) => (full ? { integrated: full.loudness.integrated, lra: full.loudness.lra, truePeak: full.peak.truePeakDbtp, momentaryMax: full.loudness.momentaryMax, shortTermMax: full.loudness.shortTermMax } : { integrated: lufs, truePeak: dbtp });
    const encode = async (audio, name, { bits = out.bits, dither = out.dither, outputRate = out.outputRate, format = out.format, loudness = null, keepMono = false, kind = '', channelMask = 0 } = {}) => {
      const a = finish(audio);
      if (a.channels.length > 2) format = 'wav';
      const bx = format === 'wav' ? {
        description: `${meta.title}${meta.artist ? ` - ${meta.artist}` : ''}${kind ? ` (${kind})` : ''}, mastered with MIXIT`,
        originatorReference: (meta.isrc || '').slice(0, 32),
        loudness,
        codingHistory: `A=PCM,F=${outputRate || a.sr},W=${bits},M=${a.channels.length === 1 && keepMono ? 'mono' : a.channels.length > 2 ? `${a.channels.length}ch` : 'stereo'},T=MIXIT`,
      } : null;
      const { buffer } = await encodeForDownload(a, { bits, dither, outputRate, format, meta: { ...meta, loudness }, bext: bx, keepMono, channelMask });
      return { name, data: new Uint8Array(buffer) };
    };
    const masterLoud = loudnessOf(0, 0, rep.output);
    const lo = { lufs: rep.output.loudness.integrated, dbtp: rep.output.peak.truePeakDbtp };
    const masterFile = () => encode(r.master, `${r.base}_master.${ext}`, { loudness: masterLoud, kind: 'master' });
    const mp3File = async () => { const m = await encodeMp3(finish(r.master), { meta, peakDbtp: rep.output.peak.truePeakDbtp }); return { name: `${r.base}.mp3`, data: m.data, kbps: m.kbps }; };
    const cdFile = () => encode(r.master, `${r.base}_CD_16bit_44k1.wav`, { format: 'wav', bits: 16, dither: 'shaped', outputRate: 44100, loudness: masterLoud, kind: 'CD master' });
    const altFile = () => (ext === 'wav'
      ? encode(r.master, `${r.base}_master_24bit.flac`, { format: 'flac', bits: 24, loudness: masterLoud })
      : encode(r.master, `${r.base}_master_24bit.wav`, { format: 'wav', bits: 24, loudness: masterLoud, kind: 'master' }));
    const extraFile = (e) => (e.layout
      ? encode({ sr: r.sr, channels: e.chs }, `${r.base}_${e.key}.wav`, { bits: out.bits === 16 ? 24 : out.bits, loudness: loudnessOf(e.lufs, e.dbtp), kind: e.label, channelMask: LAYOUTS[e.layout].mask })
      : encode({ sr: r.sr, channels: e.chs }, `${r.base}_${e.key}.${ext}`, { loudness: loudnessOf(e.lufs, e.dbtp), keepMono: e.chs.length === 1, kind: e.label }));
    const binauralFile = () => encode({ sr: r.sr, channels: r.binaural.chs }, `${r.base}_binaural_${r.binaural.layout.replace(/\./g, '')}.${ext}`, { loudness: loudnessOf(r.binaural.lufs, r.binaural.dbtp), kind: `binaural ${r.binaural.layout}` });
    const reportJson = () => toJson({ file: r.name, profile: r.profile, renderedSeconds: r.seconds, cohesion: r.cohesion, ...rep, extras: r.extras.map(({ chs, ...e }) => e), binaural: r.binaural ? { layout: r.binaural.layout, lufs: r.binaural.lufs, dbtp: r.binaural.dbtp } : null });
    const lcsv = () => loudnessCsv([{ name: 'original', analysis: rep.input }, { name: 'master', analysis: rep.output }]);
    const scsv = () => spectrumCsv([
      { name: 'original', centers: rep.input.spectrum.bands.centers, levels: rep.input.spectrum.bands.levels },
      { name: 'master', centers: rep.output.spectrum.bands.centers, levels: rep.output.spectrum.bands.levels },
    ]);
    const layerFiles = async () => {
      const L = frequencyLayers(finish(r.master).channels, r.sr);
      const names = [['low', 'below 200 Hz'], ['mid', '200 Hz-3 kHz'], ['high', 'above 3 kHz']];
      const files = [];
      for (const [k, d] of names) {
        const { buffer } = await encodeForDownload({ sr: r.sr, channels: L[k] }, { bits: out.bits === 32 ? 32 : 24, dither: 'none', outputRate: out.outputRate, meta: { ...meta, title: `${meta.title} (${k} layer, ${d})` } });
        files.push({ name: `${r.base}_layer_${k}.wav`, data: new Uint8Array(buffer) });
      }
      files.push({ name: `${r.base}_layers_readme.txt`, data: `Frequency layers of ${meta.title}: low (<200 Hz), mid (200 Hz-3 kHz) and high (>3 kHz).\nZero-phase crossovers; summed they rebuild the master (error ${fx(L.reconstructionDb, 0)} dB in float). Written without dither (24-bit or 32-bit float) so the sum stays exact.\nThese are frequency bands, not instrument stems.\n` });
      return files;
    };
    const loopFile = async () => {
      const lp = makeLoop(finish(r.master).channels, r.sr, { seamSec: out.deliver.loopSeam });
      const { buffer } = await encodeForDownload({ sr: r.sr, channels: lp.chs }, { bits: out.bits, dither: out.dither, outputRate: out.outputRate, meta: { ...meta, title: `${meta.title} (loop)` } });
      return { file: { name: `${r.base}_loop.wav`, data: new Uint8Array(buffer) }, info: lp };
    };
    const sizeOf = (d) => (typeof d === 'string' ? new TextEncoder().encode(d).length : d.length);
    const describe = async (files, kinds) => Promise.all(files.map(async (f, i) => ({ name: f.name, size: sizeOf(f.data), sha256: await sha256Hex(f.data), ...(kinds[i] || {}) })));
    const deliveredSec = () => finish(r.master).channels[0].length / r.sr;
    const profileLabel = r.easy ? 'Easy' : PROFILES[r.profile]?.label || r.profile;
    const qcFor = async (files, kinds) => qcHtml({ title: meta.title, source: r.name, profile: profileLabel, rep, renderedSeconds: r.seconds, files: await describe(files, kinds), deliveredSec: deliveredSec() });

    async function packageFiles(full) {
      const files = [], kinds = [];
      const add = (f, k) => { files.push(f); kinds.push(k); };
      add(await masterFile(), { kind: `Master ${ext.toUpperCase()}`, format: ext, ...lo });
      const mp3 = await mp3File();
      add({ name: mp3.name, data: mp3.data }, { kind: `MP3 (${mp3.kbps} kbps, for sharing)`, format: 'mp3', ...lo });
      add(await cdFile(), { kind: 'CD-quality WAV (16-bit, 44.1 kHz, noise-shaped dither)', format: 'wav', ...lo });
      add(await altFile(), { kind: ext === 'wav' ? 'FLAC 24-bit' : 'WAV 24-bit', format: ext === 'wav' ? 'flac' : 'wav', ...lo });
      if (full) {
        if (out.deliver.hiRes) {
          add(await encode(r.master, `${r.base}_hires_24bit_96k.wav`, { format: 'wav', bits: 24, outputRate: 96000, loudness: masterLoud, kind: 'hi-res' }), { kind: 'Hi-res WAV (24-bit, 96 kHz)', format: 'wav', ...lo });
          add(await encode(r.master, `${r.base}_hires_32float.wav`, { format: 'wav', bits: 32, loudness: masterLoud, kind: 'hi-res float' }), { kind: 'Hi-res WAV (32-bit float)', format: 'wav', ...lo });
        }
        for (const e of r.extras) add(await extraFile(e), { kind: e.layout ? `${e.label} (${LAYOUTS[e.layout].channels.map((c) => c.id).join(' ')})` : e.label, format: e.layout ? 'wav' : ext, lufs: e.lufs, dbtp: e.dbtp });
        if (r.binaural) add(await binauralFile(), { kind: `Binaural ${r.binaural.layout} (headphones)`, format: ext, lufs: r.binaural.lufs, dbtp: r.binaural.dbtp });
        if (out.deliver.layers) for (const f of await layerFiles()) add(f, { kind: f.name.endsWith('.txt') ? 'Layer notes' : 'Frequency layer' });
        if (out.deliver.loop) { const { file } = await loopFile(); add(file, { kind: 'Seamless loop', format: 'wav' }); }
        add({ name: `${r.base}_report.json`, data: reportJson() }, { kind: 'Full report (JSON)' });
        add({ name: `${r.base}_loudness.csv`, data: lcsv() }, { kind: 'Loudness timeline (CSV)' });
        add({ name: `${r.base}_spectrum.csv`, data: scsv() }, { kind: 'Spectrum (CSV)' });
      }
      const described = await describe(files, kinds);
      const qc = qcHtml({ title: meta.title, source: r.name, profile: profileLabel, rep, renderedSeconds: r.seconds, files: described, deliveredSec: deliveredSec() });
      const man = manifest({ title: meta.title, artist: meta.artist, files: described, rep, deliveredSec: deliveredSec() });
      files.push({ name: `${r.base}_QC.html`, data: qc }, { name: 'manifest.json', data: man.json }, { name: 'manifest.txt', data: man.text });
      return files;
    }
    return { ext, mime, lo, masterFile, mp3File, cdFile, altFile, extraFile, binauralFile, reportJson, lcsv, scsv, layerFiles, loopFile, qcFor, packageFiles };
  }

  // The MP3 button shows the bitrate it will use and roughly how big the file will be.
  function mp3Item(audio, make) {
    const secs = audio.channels[0].length / audio.sr;
    const kbps = mp3Bitrate(secs);
    return { label: 'MP3', sub: `${kbps} kbps · about ${mp3SizeMb(kbps, secs).toFixed(1)} MB · for sharing`, easy: true, run: async () => { const x = await make(); download(x.data, x.name, 'audio/mpeg'); } };
  }

  function downloadItems(r) {
    const f = fileSet(r);
    const out = r.output;
    const ext = f.ext.toUpperCase();
    const full = () => document.documentElement.dataset.mode !== 'easy';
    const save = (make, mime) => async () => { const x = await make(); download(x.data, x.name, mime); };
    const batch = state.results.length > 1;
    const items = [
      { label: 'Download all (ZIP)', sub: batch ? `all ${state.results.length} songs, every file below` : 'every file below, plus a quality report', primary: true, easy: true, run: async () => {
        if (!batch) { download(makeZip(await f.packageFiles(full())), `${r.base}_all.zip`); return; }
        const files = [];
        for (const x of state.results) for (const file of await fileSet(x).packageFiles(full())) files.push({ ...file, name: `${x.base}/${file.name}` });
        download(makeZip(files), 'masters_all.zip');
      } },
      { label: `Master ${ext}`, sub: `${fx(f.lo.lufs, 1)} LUFS · ${fx(f.lo.dbtp, 1)} dBTP`, easy: true, run: save(f.masterFile, f.mime) },
      mp3Item(r.master, f.mp3File),
      { label: 'CD-quality WAV', sub: '16-bit, 44.1 kHz', easy: true, run: save(f.cdFile, 'audio/wav') },
      { label: f.ext === 'wav' ? 'FLAC' : 'WAV 24-bit', sub: f.ext === 'wav' ? 'smaller, same quality' : 'uncompressed', easy: true, run: save(f.altFile, f.ext === 'wav' ? 'audio/flac' : 'audio/wav') },
      ...r.extras.map((e) => ({ label: `${e.label.replace(/ \(.*\)/, '')} ${e.layout ? 'WAV' : ext}`, sub: `${fx(e.lufs, 1)} LUFS${e.chs.length === 1 ? ' · mono' : e.layout ? ` · ${e.chs.length} channels` : ''}`, run: save(() => f.extraFile(e), e.layout ? 'audio/wav' : f.mime) })),
    ];
    if (r.binaural) items.push({ label: `Binaural ${r.binaural.layout} ${ext}`, sub: `headphones · ${fx(r.binaural.lufs, 1)} LUFS`, run: save(f.binauralFile, f.mime) });
    if (out.deliver.layers) items.push({ label: 'Frequency layers (ZIP)', sub: 'low / mid / high, sum = master', run: async () => download(makeZip(await f.layerFiles()), `${r.base}_layers.zip`) });
    if (out.deliver.loop) items.push({ label: 'Seamless loop WAV', sub: `${out.deliver.loopSeam} s cross-faded seam`, run: async () => { const { file } = await f.loopFile(); download(file.data, file.name, 'audio/wav'); } });
    items.push(
      { label: 'QC report (HTML)', sub: 'checks, before/after, hashes', run: async () => { const m = await f.masterFile(); download(await f.qcFor([m], [{ kind: `Master ${ext}`, ...f.lo }]), `${r.base}_QC.html`, 'text/html'); } },
      { label: 'Report (JSON)', sub: 'every measurement + chain', run: async () => download(f.reportJson(), `${r.base}_report.json`, 'application/json') },
      { label: 'Loudness timeline (CSV)', sub: '100 ms resolution', run: async () => download(f.lcsv(), `${r.base}_loudness.csv`, 'text/csv') },
      { label: 'Spectrum (CSV)', sub: '1/6 octave', run: async () => download(f.scsv(), `${r.base}_spectrum.csv`, 'text/csv') },
    );
    if (batch) {
      items.push({ label: 'All masters (ZIP)', sub: `${state.results.length} songs, masters only`, easy: true, run: async () => {
        const files = [];
        for (const x of state.results) files.push(await fileSet(x).masterFile());
        download(makeZip(files), 'masters.zip');
      } });
      items.push({ label: 'Album: gapless WAV + CUE (ZIP)', sub: `${state.results.length} tracks, ${out.deliver.albumGap} s gaps`, run: async () => {
        const rate = out.outputRate || state.results[0].sr;
        const tracks = [];
        for (const x of state.results) {
          const t = x.output.finish;
          let a = t.trim || t.fadeIn || t.fadeOut ? { sr: x.sr, channels: trimAndFade(x.master.channels, x.sr, { trim: t.trim, fadeInMs: t.fadeIn, fadeOutMs: t.fadeOut }).chs } : x.master;
          if (a.sr !== rate) a = await resample(a, rate);
          tracks.push({ chs: a.channels, title: x.base, performer: x.output.meta.artist });
        }
        const albumName = out.meta.album || 'Album';
        const file = `${baseName(albumName)}.wav`;
        const al = assembleAlbum(tracks, rate, { gapSec: out.deliver.albumGap, album: albumName, performer: out.meta.artist, fileName: file });
        const { buffer } = await encodeForDownload({ sr: rate, channels: al.chs }, { bits: out.bits, dither: out.dither, meta: { title: albumName, artist: out.meta.artist, album: albumName, year: out.meta.year, software: 'MIXIT' } });
        download(makeZip([{ name: file, data: new Uint8Array(buffer) }, { name: `${baseName(albumName)}.cue`, data: al.cue }, { name: 'tracklist.txt', data: al.tracklist }]), `${baseName(albumName)}_album.zip`);
      } });
    }
    return items;
  }

  renderFiles();
  return { addFiles };
}
