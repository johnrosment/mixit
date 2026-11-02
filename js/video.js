// MP4 and MOV: read the sound out of a video, and put a finished sound back in
// with the picture untouched. The picture is never decoded, so any codec works
// (H.264, H.265, ProRes). The file's bytes stay where they are; the old sound
// track is dropped from the movie's index (moov), and a new AAC track, encoded
// by the browser, is added at the end of the file with a rewritten index.

import { resample } from './audio-io.js';

export const isVideoFile = (file) => /\.(mp4|m4v|mov)$/i.test(file.name) || /^video\/(mp4|quicktime|x-m4v)$/.test(file.type);

const text4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);

/** Child boxes of a byte range: [{ type, start, body, end }]. */
function childBoxes(b, from = 0, to = b.length) {
  const out = [];
  for (let o = from; o + 8 <= to;) {
    let size = u32(b, o), body = o + 8;
    if (size === 1) { size = u64(b, o + 8); body = o + 16; } else if (size === 0) size = to - o;
    if (size < 8 || o + size > to) break;
    out.push({ type: text4(b, o + 4), start: o, body, end: o + size });
    o += size;
  }
  return out;
}
const child = (b, parent, type) => childBoxes(b, parent.body, parent.end).find((x) => x.type === type);

/** Top-level boxes of the file, read from its headers only (a video can be many gigabytes). */
async function fileBoxes(file) {
  const out = [];
  for (let o = 0; o + 8 <= file.size;) {
    const h = new Uint8Array(await file.slice(o, o + 16).arrayBuffer());
    let size = u32(h, 0), openEnded = false;
    if (size === 1) size = u64(h, 8); else if (size === 0) { size = file.size - o; openEnded = true; }
    if (size < 8) throw new Error('This video file looks damaged.');
    out.push({ type: text4(h, 4), start: o, end: o + size, openEnded });
    o += size;
  }
  return out;
}

async function readMovie(file) {
  const top = await fileBoxes(file);
  const box = top.find((x) => x.type === 'moov');
  if (!box) throw new Error('This video has no index to work from. Export it again as a normal MP4 or MOV.');
  const moov = new Uint8Array(await file.slice(box.start, box.end).arrayBuffer());
  const root = childBoxes(moov, 0, moov.length)[0];
  const parts = childBoxes(moov, root.body, root.end);
  // Fragmented files (common from live recorders) have no single index to rewrite.
  if (top.some((x) => x.type === 'moof') || parts.some((x) => x.type === 'mvex')) throw new Error('This video is stored in fragments. Export it again as a normal MP4 or MOV.');
  const handler = (trak) => {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    return hdlr ? text4(moov, hdlr.body + 8) : '';
  };
  return { top, box, moov, parts, handler };
}

/**
 * The first sound track as a small audio-only MP4, so the browser can decode it
 * without loading the whole video into memory. Null when there is no sound.
 */
export async function extractSound(file) {
  const { moov, parts, handler } = await readMovie(file);
  const trak = parts.find((x) => x.type === 'trak' && handler(x) === 'soun');
  if (!trak) return null;
  const stbl = child(moov, child(moov, child(moov, trak, 'mdia'), 'minf'), 'stbl');
  const co = child(moov, stbl, 'stco') || child(moov, stbl, 'co64');
  const wide = co.type === 'co64';
  const count = u32(moov, co.body + 4);
  const offsets = Array.from({ length: count }, (_, i) => (wide ? u64(moov, co.body + 8 + i * 8) : u32(moov, co.body + 8 + i * 4)));
  // Chunk sizes, from how many samples each chunk holds and how big those are.
  const stsc = child(moov, stbl, 'stsc'), stsz = child(moov, stbl, 'stsz');
  const uniform = u32(moov, stsz.body + 4);
  const sizeOf = (s) => uniform || u32(moov, stsz.body + 12 + s * 4);
  const runs = u32(moov, stsc.body + 4);
  const sizes = new Array(count);
  let sample = 0;
  for (let c = 0, r = 0; c < count; c++) {
    while (r + 1 < runs && u32(moov, stsc.body + 8 + (r + 1) * 12) <= c + 1) r++;
    const n = u32(moov, stsc.body + 12 + r * 12);
    let bytes = 0;
    for (let k = 0; k < n; k++) bytes += sizeOf(sample + k);
    sizes[c] = bytes;
    sample += n;
  }
  const total = sizes.reduce((a, v) => a + v, 0);
  const ftyp = box('ftyp', str('isom'), u32be(512), str('isomiso2mp41'));
  const mvhd = parts.find((x) => x.type === 'mvhd');
  const trakCopy = moov.slice(trak.start, trak.end);
  const newMoovSize = 8 + (mvhd.end - mvhd.start) + trakCopy.length;
  const base = ftyp.length + newMoovSize + 16;
  // Point the track's chunks at where they now sit, one after another.
  let at = base;
  const shift = co.body - trak.start;
  const dv = new DataView(trakCopy.buffer);
  for (let c = 0; c < count; c++) {
    if (wide) dv.setBigUint64(shift + 8 + c * 8, BigInt(at)); else dv.setUint32(shift + 8 + c * 4, at);
    at += sizes[c];
  }
  const out = new Uint8Array(base + total);
  out.set(ftyp, 0);
  let o = ftyp.length;
  new DataView(out.buffer).setUint32(o, newMoovSize); out.set(str('moov'), o + 4); o += 8;
  out.set(moov.subarray(mvhd.start, mvhd.end), o); o += mvhd.end - mvhd.start;
  out.set(trakCopy, o); o += trakCopy.length;
  new DataView(out.buffer).setUint32(o, 1); out.set(str('mdat'), o + 4); new DataView(out.buffer).setBigUint64(o + 8, BigInt(total + 16)); o += 16;
  for (let c = 0; c < count; c++) {
    out.set(new Uint8Array(await file.slice(offsets[c], offsets[c] + sizes[c]).arrayBuffer()), o);
    o += sizes[c];
  }
  return out.buffer;
}

// ---- Writing boxes ----
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u16be = (v) => Uint8Array.of(v >> 8, v & 255);
const u32be = (v) => Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const zeros = (n) => new Uint8Array(n);
function join(...parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const box = (type, ...parts) => { const body = join(...parts); return join(u32be(body.length + 8), str(type), body); };
const full = (type, version, flags, ...parts) => box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

function esds(asc, bitrate) {
  const desc = (tag, ...parts) => { const body = join(...parts); return join(Uint8Array.of(tag, body.length), body); };
  const config = desc(4, Uint8Array.of(0x40, 0x15, 0, 0, 0), u32be(bitrate), u32be(bitrate), desc(5, asc));
  return full('esds', 0, 0, desc(3, u16be(0), Uint8Array.of(0), config, desc(6, Uint8Array.of(2))));
}

function audioTrack({ asc, sizes, offset, sr, delay, bitrate, trackId, movieScale, length }) {
  const samples = sizes.length * 1024;
  const inMovie = Math.round((length / sr) * movieScale);
  const identity = join(u32be(0x10000), zeros(12), u32be(0x10000), zeros(12), u32be(0x40000000));
  const stsz = new Uint8Array(sizes.length * 4);
  const dv = new DataView(stsz.buffer);
  sizes.forEach((v, i) => dv.setUint32(i * 4, v));
  const entry = box('mp4a', zeros(6), u16be(1), zeros(8), u16be(2), u16be(16), zeros(4), u32be(sr * 65536), esds(asc, bitrate));
  const wide = offset > 0xffffffff;
  const hi = Math.floor(offset / 4294967296);
  const stbl = box('stbl',
    full('stsd', 0, 0, u32be(1), entry),
    full('stts', 0, 0, u32be(1), u32be(sizes.length), u32be(1024)),
    full('stsc', 0, 0, u32be(1), u32be(1), u32be(sizes.length), u32be(1)),
    full('stsz', 0, 0, u32be(0), u32be(sizes.length), stsz),
    wide ? full('co64', 0, 0, u32be(1), u32be(hi), u32be(offset - hi * 4294967296)) : full('stco', 0, 0, u32be(1), u32be(offset)));
  const minf = box('minf', full('smhd', 0, 0, zeros(4)), box('dinf', full('dref', 0, 0, u32be(1), full('url ', 0, 1))), stbl);
  const mdia = box('mdia',
    full('mdhd', 0, 0, zeros(8), u32be(sr), u32be(samples), u16be(0x55c4), zeros(2)),
    full('hdlr', 0, 0, zeros(4), str('soun'), zeros(12), str('Sound\0')),
    minf);
  // The edit list skips the encoder's start-up delay, so the sound lines up with the picture.
  const edts = box('edts', full('elst', 0, 0, u32be(1), u32be(inMovie), u32be(delay), u32be(0x10000)));
  const tkhd = full('tkhd', 0, 7, zeros(8), u32be(trackId), zeros(4), u32be(inMovie), zeros(8), zeros(2), u16be(0), u16be(0x100), zeros(2), identity, zeros(8));
  return box('trak', tkhd, edts, mdia);
}

// ---- AAC through the browser's own encoder ----
const CODEC = 'mp4a.40.2';

export async function canWriteVideoSound(sr = 48000) {
  if (typeof AudioEncoder === 'undefined') return false;
  try { return !!(await AudioEncoder.isConfigSupported({ codec: CODEC, sampleRate: sr, numberOfChannels: 2, bitrate: 256000 })).supported; } catch { return false; }
}

async function encodeAac(L, R, sr, bitrate, onProgress) {
  const frames = [];
  let asc = null, failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !asc) asc = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      frames.push(b);
    },
    error: (e) => { failure = e; },
  });
  encoder.configure({ codec: CODEC, sampleRate: sr, numberOfChannels: 2, bitrate });
  const step = 8192;
  for (let i = 0; i < L.length; i += step) {
    if (failure) break;
    const len = Math.min(step, L.length - i);
    const data = new Float32Array(len * 2);
    data.set(L.subarray(i, i + len), 0);
    data.set(R.subarray(i, i + len), len);
    const piece = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: len, numberOfChannels: 2, timestamp: Math.round((i / sr) * 1e6), data });
    encoder.encode(piece);
    piece.close();
    if (encoder.encodeQueueSize > 16) await new Promise((r) => setTimeout(r));
    if (onProgress && (i / step) % 64 === 0) onProgress(i / L.length);
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!asc) throw new Error('The sound encoder gave no setup data.');
  return { frames, asc };
}

// How far the encoder pushes sound back. It differs by browser and system, so
// it is measured with one click rather than assumed.
async function measureDelay(sr, bitrate) {
  const fallback = 2112;
  if (typeof AudioDecoder === 'undefined') return fallback;
  const at = 12000;
  const x = new Float32Array(sr);
  for (let k = 0; k < 8; k++) x[at + k] = (k % 2 ? -1 : 1) * 0.8;
  try {
    const { frames, asc } = await encodeAac(x, x, sr, bitrate);
    const pieces = [];
    const decoder = new AudioDecoder({ output: (d) => { const c = new Float32Array(d.numberOfFrames); d.copyTo(c, { planeIndex: 0, format: 'f32-planar' }); pieces.push(c); d.close(); }, error: () => {} });
    decoder.configure({ codec: CODEC, sampleRate: sr, numberOfChannels: 2, description: asc });
    frames.forEach((data, i) => decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((i * 1024 * 1e6) / sr), data })));
    await decoder.flush();
    decoder.close();
    let pos = 0, peak = 0, o = 0;
    for (const c of pieces) { for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) { peak = v; pos = o + i; } } o += c.length; }
    const delay = pos - at;
    return delay >= 0 && delay < 8192 ? delay : fallback;
  } catch { return fallback; }
}

/**
 * A copy of `file` with `audio` as its only sound track; returns a Blob.
 * `peakDbtp` is the sound's true peak: like MP3, AAC needs a little room, so
 * louder peaks are brought down to -1.5 dBTP before encoding.
 */
export async function replaceVideoSound(file, audio, { peakDbtp = null, bitrate = 256000, onProgress } = {}) {
  const { top, box: oldMoov, moov, parts, handler } = await readMovie(file);
  if (top.some((x) => x.openEnded && x.type !== 'moov')) throw new Error('This video needs exporting again as a normal MP4 or MOV.');
  let a = audio;
  if (![44100, 48000].includes(a.sr)) a = await resample(a, 48000);
  if (!(await canWriteVideoSound(a.sr))) throw new Error('This browser cannot write video sound yet. Try a current version of Chrome or Edge.');
  const g = peakDbtp != null && peakDbtp > -1.5 ? Math.pow(10, (-1.5 - peakDbtp) / 20) : 1;
  const scaled = (ch) => (g === 1 ? ch : Float32Array.from(ch, (v) => v * g));
  const L = scaled(a.channels[0]), R = a.channels[1] ? scaled(a.channels[1]) : L;
  const delay = await measureDelay(a.sr, bitrate);
  // Silence after the end, so the encoder's last frame holds all of the real sound.
  const padL = new Float32Array(L.length + delay + 2048), padR = new Float32Array(L.length + delay + 2048);
  padL.set(L); padR.set(R);
  const { frames, asc } = await encodeAac(padL, padR, a.sr, bitrate, onProgress);

  // What stays of the file: everything, with the old index blanked out (or cut, if it was last).
  const last = oldMoov.end >= file.size;
  const kept = last ? [file.slice(0, oldMoov.start)] : [file.slice(0, oldMoov.start + 4), str('free'), file.slice(oldMoov.start + 8)];
  const keptSize = last ? oldMoov.start : file.size;
  const sizes = frames.map((f) => f.length);
  const dataSize = sizes.reduce((x, v) => x + v, 0);

  const mvhd = parts.find((x) => x.type === 'mvhd');
  const version = moov[mvhd.body];
  const scaleAt = mvhd.body + (version === 1 ? 20 : 12);
  const movieScale = u32(moov, scaleAt);
  const nextId = u32(moov, mvhd.end - 4);
  const others = parts.filter((x) => x !== mvhd && !(x.type === 'trak' && handler(x) === 'soun'));
  const trackDuration = (t) => {
    const k = child(moov, t, 'tkhd');
    return moov[k.body] === 1 ? u64(moov, k.body + 28) : u32(moov, k.body + 20);
  };
  const track = audioTrack({ asc, sizes, offset: keptSize + 8, sr: a.sr, delay, bitrate, trackId: nextId, movieScale, length: L.length });
  const soundLength = Math.round((L.length / a.sr) * movieScale);
  const length = Math.max(soundLength, ...others.filter((x) => x.type === 'trak').map(trackDuration));
  // A copy of the movie header with the new length and next track number.
  const head = moov.slice(mvhd.start, mvhd.end);
  const hv = new DataView(head.buffer);
  const rel = mvhd.body - mvhd.start;
  if (version === 1) hv.setBigUint64(rel + 24, BigInt(length)); else hv.setUint32(rel + 16, length);
  hv.setUint32(mvhd.end - mvhd.start - 4, nextId + 1);
  const newMoov = box('moov', head, ...others.map((x) => moov.subarray(x.start, x.end)), track);
  const mdatHead = join(u32be(dataSize + 8), str('mdat'));
  return new Blob([...kept, mdatHead, ...frames, newMoov], { type: /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4' });
}

/** Keeps a video's own extension: clip.mov becomes clip_new.mov. */
export const videoOutName = (name, tag) => { const m = name.match(/^(.*?)(\.[^.]+)?$/); return `${m[1].replace(/[\\/:*?"<>|]+/g, '_')}_${tag}${m[2] || '.mp4'}`; };
