// Processing worker: keeps heavy DSP off the page's main thread.

import { analyze } from './analyze.js';
import { master, finalize } from './master.js';
import { MixSession } from './mix.js';
import { parseWav } from './wav.js';
import { parseAiff } from './aiff.js';
import { learnProfile } from './profile.js';
import { measureStem } from './automix.js';
import { AutoSession, measureWhole } from './autoplan.js';

let session = null;
let auto = null;

// Surround files (WAV / SMPTE channel order: L R C LFE, then the surrounds and
// heights) are folded to stereo the usual way: centre, surrounds and heights
// at -3 dB, LFE left out. Without this only L and R were used, losing the
// centre (where dialogue lives). Orders this does not know keep L and R.
const FOLD = {
  3: 'L R C', 4: 'L R Ls Rs', 5: 'L R C Ls Rs', 6: 'L R C LFE Ls Rs', 7: 'L R C LFE Cs Ls Rs', 8: 'L R C LFE Ls Rs Ls Rs',
  10: 'L R C LFE Ls Rs Ls Rs Ls Rs', 12: 'L R C LFE Ls Rs Ls Rs Ls Rs Ls Rs',
};
const FOLD_GAIN = { L: [1, 0], R: [0, 1], C: [Math.SQRT1_2, Math.SQRT1_2], LFE: [0, 0], Ls: [Math.SQRT1_2, 0], Rs: [0, Math.SQRT1_2], Cs: [0.5, 0.5] };
function toStereo(audio) {
  const map = FOLD[audio.channels.length]?.split(' ');
  if (!map) return audio.channels.length > 2 ? { ...audio, channels: audio.channels.slice(0, 2) } : audio;
  const n = audio.channels[0].length;
  const out = [new Float32Array(n), new Float32Array(n)];
  audio.channels.forEach((ch, c) => {
    const [gl, gr] = FOLD_GAIN[map[c]];
    if (gl) for (let i = 0; i < n; i++) out[0][i] += ch[i] * gl;
    if (gr) for (let i = 0; i < n; i++) out[1][i] += ch[i] * gr;
  });
  return { sr: audio.sr, channels: out };
}

// A float file can hold NaN or infinite samples. One is enough to turn every
// filter after it, and so the whole stem, into silence or noise; they become 0.
function repairSamples(audio) {
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) ch[i] = 0;
  return audio;
}

function toAudio(payload) {
  if (payload.wav) {
    const p = parseWav(payload.wav);
    return toStereo(repairSamples({ sr: p.sr, channels: p.channels }));
  }
  if (payload.aiff) {
    const p = parseAiff(payload.aiff);
    return toStereo(repairSamples({ sr: p.sr, channels: p.channels }));
  }
  return toStereo(repairSamples(payload.audio));
}

function buffersOf(chs) {
  return chs ? chs.map((c) => c.buffer) : [];
}

self.onmessage = (ev) => {
  const { id, type, payload } = ev.data;
  const progress = (stage, fraction) => self.postMessage({ id, type: 'progress', stage, fraction });
  try {
    if (type === 'analyze') {
      const audio = toAudio(payload);
      const result = analyze(audio, { progress, repairScan: !!payload.repairScan });
      self.postMessage({ id, type: 'result', data: { analysis: result, sr: audio.sr } });
    } else if (type === 'measureStem') {
      const audio = toAudio(payload);
      self.postMessage({ id, type: 'result', data: measureStem(audio.channels, audio.sr, { noise: !!payload.noise }) });
    } else if (type === 'autoBegin') {
      auto = new AutoSession(payload.sr, payload.length);
      self.postMessage({ id, type: 'result', data: { ok: true } });
    } else if (type === 'autoStem') {
      const audio = toAudio(payload);
      if (audio.sr !== auto.sr) throw new Error(`Stem sample rate ${audio.sr} does not match the session (${auto.sr}).`);
      auto.addStem(audio);
      self.postMessage({ id, type: 'result', data: { ok: true } });
    } else if (type === 'autoPlan') {
      const plan = auto.plan(payload.rows, { rough: payload.rough });
      auto = null;
      self.postMessage({ id, type: 'result', data: plan });
    } else if (type === 'decode') {
      const audio = toAudio(payload);
      self.postMessage({ id, type: 'result', data: audio }, buffersOf(audio.channels));
    } else if (type === 'learnProfile') {
      progress('Measuring references', 0.1);
      const refs = payload.references.map((r) => ({ ...toAudio(r), name: r.name }));
      const profile = learnProfile(refs, { name: payload.name || '', names: refs.map((r) => r.name || '') });
      if (!profile) throw new Error('These files have no sound in them.');
      self.postMessage({ id, type: 'result', data: { profile } });
    } else if (type === 'master') {
      const audio = toAudio(payload.track);
      const references = (payload.references || []).map((r) => ({ ...toAudio(r), name: r.name }));
      const res = master(audio, payload.settings, { references, profile: payload.profile || null, deliverables: payload.deliverables || {}, progress });
      const transfers = [...buffersOf(res.channels), ...res.extras.flatMap((e) => buffersOf(e.chs)), ...new Set(buffersOf(audio.channels))];
      self.postMessage({ id, type: 'result', data: { channels: res.channels, extras: res.extras, report: res.report, sr: audio.sr, source: audio } }, transfers);
    } else if (type === 'finalize') {
      // Loudness and true-peak targeting for audio made on the page (e.g. a binaural render).
      const f = finalize(payload.audio.channels, payload.audio.sr, { targetLufs: payload.targetLufs, ceiling: payload.ceiling, release: payload.release || 120 });
      self.postMessage({ id, type: 'result', data: { channels: f.chs, lufs: f.achievedLufs, dbtp: f.truePeakDbtp, gainDb: f.gainDb, maxGr: f.limiter.maxGr } }, buffersOf(f.chs));
    } else if (type === 'mixBegin') {
      session = new MixSession(payload.settings, payload.sr, payload.length);
      self.postMessage({ id, type: 'result', data: { ok: true } });
    } else if (type === 'mixStem') {
      if (!session) throw new Error('No mix session is open.');
      const audio = toAudio(payload);
      if (audio.sr !== session.sr) throw new Error(`Stem sample rate ${audio.sr} does not match the session (${session.sr}).`);
      const row = session.addStem(payload.index, audio);
      self.postMessage({ id, type: 'result', data: { row } });
    } else if (type === 'mixRough') {
      if (!session) throw new Error('No mix session is open.');
      const audio = toAudio(payload);
      if (audio.sr !== session.sr) throw new Error(`Rough mix sample rate ${audio.sr} does not match the session (${session.sr}).`);
      self.postMessage({ id, type: 'result', data: session.setRoughMix(audio) });
    } else if (type === 'mixRoughStem') {
      if (!session) throw new Error('No mix session is open.');
      session.readRoughStem(payload.index, toAudio(payload));
      self.postMessage({ id, type: 'result', data: { ok: true } });
    } else if (type === 'mixRoughFit') {
      if (!session) throw new Error('No mix session is open.');
      self.postMessage({ id, type: 'result', data: session.fitRoughStems() });
    } else if (type === 'mixFinish') {
      if (!session) throw new Error('No mix session is open.');
      const res = session.finish(progress);
      if (payload.autoCheck) res.report.whole = measureWhole(res.channels, session.sr);
      session = null;
      const transfers = [...buffersOf(res.channels), ...buffersOf(res.rawSum), ...Object.values(res.busStems || {}).flatMap(buffersOf), ...buffersOf(res.spatial?.chs), ...(res.alternates || []).flatMap((a) => buffersOf(a.chs))];
      self.postMessage({ id, type: 'result', data: res }, transfers);
    } else {
      throw new Error(`Unknown job type ${type}`);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
