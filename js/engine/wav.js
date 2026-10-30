// WAV parsing and encoding (PCM 8/16/24/32-bit, IEEE float 32/64, extensible
// headers), with TPDF or noise-shaped dither, optional LIST/INFO metadata and a
// Broadcast Wave (bext v2) chunk carrying loudness values. Shared by the page
// and the worker.

const RIFF = 0x52494646, WAVE = 0x57415645, FMT = 0x666d7420, DATA = 0x64617461;

export function readWavHeader(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 12 || dv.getUint32(0, false) !== RIFF || dv.getUint32(8, false) !== WAVE) {
    return { valid: false, reason: 'Missing RIFF/WAVE header' };
  }
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false);
    const size = dv.getUint32(off + 4, true);
    const p = off + 8;
    if (id === FMT) {
      if (p + 16 > dv.byteLength) break;
      let format = dv.getUint16(p, true);
      const channels = dv.getUint16(p + 2, true);
      const sr = dv.getUint32(p + 4, true);
      const bits = dv.getUint16(p + 14, true);
      if (format === 0xfffe && size >= 26 && p + 26 <= dv.byteLength) format = dv.getUint16(p + 24, true);
      fmt = { format, channels, sr, bits };
    } else if (id === DATA) {
      dataOff = p;
      const remaining = dv.byteLength - p;
      dataLen = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
    }
    if (fmt && dataOff >= 0) break;
    off = p + size + (size & 1);
  }
  if (!fmt) return { valid: false, reason: 'No format chunk' };
  if (dataOff < 0) return { valid: false, reason: 'No audio data chunk', ...fmt };
  const supported = (fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && [32, 64].includes(fmt.bits));
  if (!supported) return { valid: false, reason: `Unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`, ...fmt };
  const frames = Math.floor(dataLen / ((fmt.bits / 8) * fmt.channels));
  if (!frames) return { valid: false, reason: 'Empty audio data', ...fmt };
  return { valid: true, ...fmt, dataOff, dataLen, frames, duration: frames / fmt.sr };
}

export function parseWav(buf) {
  const h = readWavHeader(buf);
  if (!h.valid) throw new Error(h.reason);
  const { channels, bits, format, dataOff, frames, sr } = h;
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const bps = bits / 8;
  const stride = bps * channels;
  for (let c = 0; c < channels; c++) {
    const ch = out[c];
    let p = dataOff + c * bps;
    if (format === 3 && bits === 32) for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getFloat32(p, true);
    else if (format === 3) for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getFloat64(p, true);
    else if (bits === 16) for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getInt16(p, true) / 32768;
    else if (bits === 24) {
      for (let i = 0; i < frames; i++, p += stride) {
        let v = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        ch[i] = v / 8388608;
      }
    } else if (bits === 32) for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getInt32(p, true) / 2147483648;
    else for (let i = 0; i < frames; i++, p += stride) ch[i] = (bytes[p] - 128) / 128;
  }
  return { sr, channels: out, bits, format };
}

function infoChunk(meta) {
  const map = { title: 'INAM', artist: 'IART', album: 'IPRD', year: 'ICRD', genre: 'IGNR', comment: 'ICMT', isrc: 'ISRC', software: 'ISFT' };
  const entries = Object.entries(meta || {}).filter(([k, v]) => map[k] && v);
  if (!entries.length) return null;
  const enc = new TextEncoder();
  const parts = entries.map(([k, v]) => {
    const text = enc.encode(String(v));
    const size = text.length + 1;
    const padded = size + (size & 1);
    const b = new Uint8Array(8 + padded);
    for (let i = 0; i < 4; i++) b[i] = map[k].charCodeAt(i);
    new DataView(b.buffer).setUint32(4, size, true);
    b.set(text, 8);
    return b;
  });
  const bodyLen = 4 + parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(8 + bodyLen);
  const dv = new DataView(out.buffer);
  out.set([0x4c, 0x49, 0x53, 0x54], 0); // LIST
  dv.setUint32(4, bodyLen, true);
  out.set([0x49, 0x4e, 0x46, 0x4f], 8); // INFO
  let o = 12;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Broadcast Wave 'bext' chunk (EBU Tech 3285 v2), including the loudness
 * fields (integrated, range, max true peak, max momentary and short-term).
 */
function bextChunk(b) {
  if (!b) return null;
  const enc = new TextEncoder();
  const history = enc.encode(b.codingHistory ? `${b.codingHistory}\r\n` : '');
  const body = 602 + history.length;
  const size = body + (body & 1);
  const out = new Uint8Array(8 + size);
  const dv = new DataView(out.buffer);
  out.set([0x62, 0x65, 0x78, 0x74], 0); // bext
  dv.setUint32(4, body, true);
  const put = (off, str, len) => { const t = enc.encode(String(str || '')).subarray(0, len); out.set(t, 8 + off); };
  const now = b.date || new Date();
  const pad = (v) => String(v).padStart(2, '0');
  put(0, b.description, 256);
  put(256, b.originator || 'MIXIT', 32);
  put(288, b.originatorReference, 32);
  put(320, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, 10);
  put(330, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, 8);
  dv.setUint16(8 + 346, 2, true); // version
  // Loudness fields; 0x7FFF marks a value as not set.
  const L = b.loudness || {};
  const i16 = (off, v) => dv.setInt16(8 + off, Number.isFinite(v) ? Math.max(-32767, Math.min(32766, Math.round(v * 100))) : 0x7fff, true);
  i16(412, L.integrated);
  i16(414, L.lra);
  i16(416, L.truePeak);
  i16(418, L.momentaryMax);
  i16(420, L.shortTermMax);
  out.set(history, 8 + 602);
  return out;
}

/** Quantise float channels to integers of `bits` with TPDF, noise-shaped or no dither. */
export function quantizeChannels(chs, bits, dither = 'tpdf') {
  const scale = Math.pow(2, bits - 1);
  const maxV = scale - 1;
  return chs.map((ch) => {
    const out = new Int32Array(ch.length);
    let err = 0;
    for (let i = 0; i < ch.length; i++) {
      let v = ch[i] * scale;
      if (dither === 'shaped') v -= err;
      const d = dither === 'none' ? 0 : Math.random() - Math.random();
      let q = Math.round(v + d);
      if (q > maxV) q = maxV; else if (q < -scale) q = -scale;
      if (dither === 'shaped') err = q - v;
      out[i] = q;
    }
    return out;
  });
}

/**
 * Encode channels to a WAV ArrayBuffer.
 * bits: 16 | 24 (integer PCM) or 32 (IEEE float). dither: 'tpdf' | 'shaped' | 'none'.
 * More than two channels (or an explicit `channelMask`) are written as
 * WAVE_FORMAT_EXTENSIBLE with the speaker mask, channels in mask-bit order.
 */
export function encodeWav(chs, sr, { bits = 24, dither = 'tpdf', meta = null, bext = null, channelMask = 0 } = {}) {
  const float = bits === 32;
  const channels = chs.length;
  const n = chs[0].length;
  const bps = bits / 8;
  const dataLen = n * channels * bps;
  const info = infoChunk(meta);
  const infoLen = info ? info.length : 0;
  const bx = bextChunk(bext);
  const bxLen = bx ? bx.length : 0;
  const ext = channels > 2 || channelMask > 0;
  const fmtLen = ext ? 40 : 16;
  const buf = new ArrayBuffer(28 + fmtLen + bxLen + infoLen + dataLen);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF');
  dv.setUint32(4, 20 + fmtLen + bxLen + infoLen + dataLen, true);
  str(8, 'WAVE');
  let o = 12;
  if (bx) { u8.set(bx, o); o += bxLen; }
  str(o, 'fmt ');
  dv.setUint32(o + 4, fmtLen, true);
  dv.setUint16(o + 8, ext ? 0xfffe : float ? 3 : 1, true);
  dv.setUint16(o + 10, channels, true);
  dv.setUint32(o + 12, sr, true);
  dv.setUint32(o + 16, sr * channels * bps, true);
  dv.setUint16(o + 20, channels * bps, true);
  dv.setUint16(o + 22, bits, true);
  if (ext) {
    dv.setUint16(o + 24, 22, true);
    dv.setUint16(o + 26, bits, true);
    dv.setUint32(o + 28, channelMask || (channels === 1 ? 0x4 : channels === 2 ? 0x3 : 0), true);
    // KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT: xxxxxxxx-0000-0010-8000-00aa00389b71
    u8.set([float ? 3 : 1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], o + 32);
  }
  o += 8 + fmtLen;
  if (info) { u8.set(info, o); o += infoLen; }
  str(o, 'data');
  dv.setUint32(o + 4, dataLen, true);
  o += 8;
  const scale = Math.pow(2, bits - 1);
  const maxV = scale - 1;
  const err = new Float64Array(channels);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const x = chs[c][i];
      if (float) {
        dv.setFloat32(o, x, true);
      } else {
        let v = x * scale;
        if (dither === 'shaped') v -= err[c];
        const d = dither === 'none' ? 0 : Math.random() - Math.random();
        let q = Math.round(v + d);
        if (q > maxV) q = maxV; else if (q < -scale) q = -scale;
        if (dither === 'shaped') err[c] = q - v;
        if (bits === 16) dv.setInt16(o, q, true);
        else { u8[o] = q & 0xff; u8[o + 1] = (q >> 8) & 0xff; u8[o + 2] = (q >> 16) & 0xff; }
      }
      o += bps;
    }
  }
  return buf;
}
