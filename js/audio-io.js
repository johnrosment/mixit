// File probing, decoding, resampling and downloads on the page side.

import { encodeWav } from './engine/wav.js';
import { encodeFlac } from './engine/flac.js';
import { isAiff, describeComm, finishHeader } from './engine/aiff.js';

const decodedCache = new WeakMap();
export const COMPRESSED_DECODE_SR = 48000;

const RIFF = 0x52494646, WAVE = 0x57415645;

async function readAt(file, off, len) {
  return new DataView(await file.slice(off, off + len).arrayBuffer());
}

/** AIFF / AIFF-C header walk over file slices (the audio is not read). */
async function probeAiff(file, head) {
  const aifc = head.getUint32(8, false) === 0x41494643;
  let off = 12, comm = null, dataOff = -1, dataLen = 0, guard = 0;
  while (off + 8 <= file.size && guard++ < 512) {
    const h = await readAt(file, off, 8);
    const id = h.getUint32(0, false), size = h.getUint32(4, false);
    if (id === 0x434f4d4d) comm = describeComm(await readAt(file, off + 8, Math.min(size, 64)), aifc);
    else if (id === 0x53534e44) {
      const s = await readAt(file, off + 8, 8);
      dataOff = off + 16 + s.getUint32(0, false);
      dataLen = Math.max(0, Math.min(size - 8 - s.getUint32(0, false), file.size - dataOff));
    }
    if (comm && dataOff >= 0) break;
    off += 8 + size + (size & 1);
  }
  const h = finishHeader(comm, dataOff, dataLen);
  if (h.valid) return { valid: true, kind: 'aiff', format: h.float ? 3 : 1, channels: h.channels, sr: h.sr, bits: h.bits, float: h.float, frames: h.frames, duration: h.duration };
  // Compressed AIFF-C (IMA4, MACE, …): the browser may still decode it.
  if (comm && !comm.supported) {
    try { return await probeCompressed(file); } catch { /* fall through */ }
  }
  return { valid: false, kind: 'aiff', reason: h.reason };
}

async function probeCompressed(file) {
  const audio = await decodeCompressed(file, COMPRESSED_DECODE_SR);
  return { valid: true, kind: 'compressed', sr: audio.sr, channels: audio.channels.length, frames: audio.channels[0].length, duration: audio.channels[0].length / audio.sr };
}

/** Header-only inspection for WAV and AIFF; full decode for compressed formats. */
export async function probeFile(file) {
  if (!file || file.size < 12) return { valid: false, reason: 'Empty or incomplete file' };
  const head = await readAt(file, 0, 12);
  if (isAiff(head)) return probeAiff(file, head);
  if (head.getUint32(0, false) === RIFF && head.getUint32(8, false) === WAVE) {
    let off = 12, fmt = null, dataOff = -1, dataSize = 0, guard = 0;
    while (off + 8 <= file.size && guard++ < 512) {
      const h = await readAt(file, off, 8);
      const id = h.getUint32(0, false), size = h.getUint32(4, true);
      if (id === 0x666d7420) {
        const f = await readAt(file, off + 8, Math.min(40, size));
        let format = f.getUint16(0, true);
        if (format === 0xfffe && size >= 26) format = f.getUint16(24, true);
        fmt = { format, channels: f.getUint16(2, true), sr: f.getUint32(4, true), bits: f.getUint16(14, true) };
      } else if (id === 0x64617461) {
        dataOff = off + 8;
        dataSize = size === 0 || size === 0xffffffff ? file.size - dataOff : Math.min(size, file.size - dataOff);
      }
      if (fmt && dataOff >= 0) break;
      off += 8 + size + (size & 1);
    }
    if (!fmt) return { valid: false, kind: 'wav', reason: 'WAV has no format chunk' };
    if (dataOff < 0) return { valid: false, kind: 'wav', reason: 'WAV has no audio data' };
    const ok = (fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && [32, 64].includes(fmt.bits));
    if (!ok) return { valid: false, kind: 'wav', ...fmt, reason: `Unsupported WAV encoding (${fmt.bits}-bit, format ${fmt.format})` };
    const frames = Math.floor(dataSize / ((fmt.bits / 8) * fmt.channels));
    if (!frames) return { valid: false, kind: 'wav', ...fmt, reason: 'WAV contains no samples' };
    return { valid: true, kind: 'wav', ...fmt, float: fmt.format === 3, frames, duration: frames / fmt.sr };
  }
  try {
    return await probeCompressed(file);
  } catch (err) {
    return { valid: false, kind: 'unknown', reason: 'This browser could not decode the file' };
  }
}

async function decodeCompressed(file, sr) {
  const cached = decodedCache.get(file);
  if (cached && cached.sr === sr) return cached;
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, sr);
  const ab = await ctx.decodeAudioData(buf);
  const audio = { sr: ab.sampleRate, channels: Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c).slice()) };
  decodedCache.set(file, audio);
  return audio;
}

export async function resample(audio, sr) {
  if (audio.sr === sr) return audio;
  const nIn = audio.channels[0].length;
  const len = Math.ceil((nIn * sr) / audio.sr);
  const chCount = audio.channels.length;
  const ctx = new OfflineAudioContext(chCount, len, sr);
  const buf = ctx.createBuffer(chCount, nIn, audio.sr);
  audio.channels.forEach((ch, i) => buf.copyToChannel(ch, i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return { sr, channels: Array.from({ length: chCount }, (_, i) => out.getChannelData(i).slice()) };
}

/**
 * Payload for the worker. WAV and AIFF files at the wanted rate are sent as raw
 * bytes (the worker parses them); anything else is decoded/resampled here first.
 */
export async function workerPayload(file, info, targetSr = null) {
  const raw = info.kind === 'wav' || info.kind === 'aiff';
  if (raw && (!targetSr || targetSr === info.sr)) {
    const bytes = await file.arrayBuffer();
    return { payload: { [info.kind]: bytes }, transfer: [bytes] };
  }
  let audio;
  if (raw) {
    const { parseWav } = await import('./engine/wav.js');
    const { parseAiff } = await import('./engine/aiff.js');
    const p = (info.kind === 'aiff' ? parseAiff : parseWav)(await file.arrayBuffer());
    audio = { sr: p.sr, channels: p.channels };
  } else {
    audio = await decodeCompressed(file, targetSr || COMPRESSED_DECODE_SR);
    audio = { sr: audio.sr, channels: audio.channels.map((c) => c.slice()) };
  }
  if (targetSr && audio.sr !== targetSr) audio = await resample(audio, targetSr);
  return { payload: { audio }, transfer: audio.channels.map((c) => c.buffer) };
}

export function framesAt(info, sr) {
  return Math.ceil((info.frames * sr) / info.sr);
}

/**
 * WAV (16/24-bit PCM or 32-bit float, optional bext) or FLAC (16/24-bit).
 * Mono audio is written as dual-mono stereo unless `keepMono` is set.
 */
export async function encodeForDownload(audio, { bits = 24, dither = 'tpdf', outputRate = 0, meta = null, bext = null, format = 'wav', keepMono = false, channelMask = 0 } = {}) {
  let a = audio;
  if (outputRate && outputRate !== audio.sr) a = await resample(audio, outputRate);
  const chs = a.channels.length === 1 && !keepMono ? [a.channels[0], a.channels[0]] : a.channels;
  // Speaker beds are always WAV (WAVE_FORMAT_EXTENSIBLE with the speaker mask).
  if (format === 'flac' && chs.length <= 2) return { buffer: encodeFlac(chs, a.sr, { bits: bits === 16 ? 16 : 24, dither, meta }), sr: a.sr };
  return { buffer: encodeWav(chs, a.sr, { bits, dither, meta, bext, channelMask }), sr: a.sr };
}

export function download(data, name, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_');
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

export function describeInfo(info) {
  if (!info) return 'Reading…';
  if (!info.valid) return info.reason;
  const rate = `${(info.sr / 1000).toFixed(info.sr % 1000 ? 1 : 0)} kHz`;
  const depth = info.kind === 'wav' || info.kind === 'aiff' ? `${info.kind === 'aiff' ? 'AIFF ' : ''}${info.bits}-bit${info.float ? ' float' : ''}` : 'compressed';
  const ch = info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch`;
  return `${fmtDuration(info.duration)} · ${rate} · ${depth} · ${ch}`;
}
