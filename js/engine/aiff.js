// AIFF and AIFF-C parsing (Logic, Pro Tools and other Mac DAWs export these as
// their uncompressed format). PCM 8-32 bit in either byte order and 32/64-bit
// float are read directly; other AIFF-C codecs are left to the browser.
// Shared by the page and the worker.

const FORM = 0x464f524d, AIFF = 0x41494646, AIFC = 0x41494643, COMM = 0x434f4d4d, SSND = 0x53534e44;

// AIFF-C compression types this parser reads: [byte order, sample kind].
const CODECS = {
  NONE: ['be', 'int'], twos: ['be', 'int'], sowt: ['le', 'int'], in24: ['be', 'int'], in32: ['be', 'int'],
  '42ni': ['le', 'int'], '23ni': ['le', 'int'], 'raw ': ['be', 'uint'],
  fl32: ['be', 'float'], FL32: ['be', 'float'], fl64: ['be', 'float'], FL64: ['be', 'float'],
};
const CODEC_BITS = { in24: 24, in32: 32, '42ni': 24, '23ni': 32, 'raw ': 8, fl32: 32, FL32: 32, fl64: 64, FL64: 64 };

const fourcc = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

/** 80-bit IEEE 754 extended (big-endian), as used for the AIFF sample rate. */
function extended(dv, p) {
  const se = dv.getUint16(p, false);
  const hi = dv.getUint32(p + 2, false), lo = dv.getUint32(p + 6, false);
  const exp = se & 0x7fff;
  if (!exp && !hi && !lo) return 0;
  const v = (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
  return se & 0x8000 ? -v : v;
}

export function isAiff(dv) {
  return dv.byteLength >= 12 && dv.getUint32(0, false) === FORM && [AIFF, AIFC].includes(dv.getUint32(8, false));
}

/**
 * Reads the COMM chunk (and the SSND position when `ssnd` is given).
 * `comm` is a DataView over the chunk body; returns the stream description.
 */
export function describeComm(comm, isAifc) {
  const channels = comm.getUint16(0, false);
  const frames = comm.getUint32(2, false);
  let bits = comm.getUint16(6, false);
  const sr = Math.round(extended(comm, 8) * 1000) / 1000;
  const codec = isAifc && comm.byteLength >= 22 ? fourcc(comm, 18) : 'NONE';
  const known = CODECS[codec];
  if (CODEC_BITS[codec]) bits = CODEC_BITS[codec];
  const supported = !!known && channels > 0 && sr > 0 && (known[1] === 'float' ? [32, 64].includes(bits) : bits >= 1 && bits <= 32);
  return { channels, frames, bits, sr, codec, order: known?.[0], sample: known?.[1], supported, float: known?.[1] === 'float' };
}

export function readAiffHeader(buf) {
  const dv = new DataView(buf);
  if (!isAiff(dv)) return { valid: false, reason: 'Missing FORM/AIFF header' };
  const aifc = dv.getUint32(8, false) === AIFC;
  let off = 12, comm = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false), size = dv.getUint32(off + 4, false), p = off + 8;
    if (id === COMM) comm = describeComm(new DataView(buf, p, Math.min(size, dv.byteLength - p)), aifc);
    else if (id === SSND && p + 8 <= dv.byteLength) {
      dataOff = p + 8 + dv.getUint32(p, false);
      dataLen = Math.max(0, Math.min(size - 8 - dv.getUint32(p, false), dv.byteLength - dataOff));
    }
    if (comm && dataOff >= 0) break;
    off = p + size + (size & 1);
  }
  return finishHeader(comm, dataOff, dataLen);
}

/** Shared validity checks for the in-memory and the file-slice readers. */
export function finishHeader(comm, dataOff, dataLen) {
  if (!comm) return { valid: false, reason: 'AIFF has no COMM chunk' };
  if (!comm.supported) return { valid: false, ...comm, reason: `Unsupported AIFF-C compression “${comm.codec.trim()}”` };
  if (dataOff < 0) return { valid: false, ...comm, reason: 'AIFF has no sound data' };
  const bps = Math.ceil(comm.bits / 8);
  const frames = Math.min(comm.frames || Infinity, Math.floor(dataLen / (bps * comm.channels)));
  if (!frames) return { valid: false, ...comm, reason: 'AIFF contains no samples' };
  return { valid: true, ...comm, dataOff, dataLen, frames, duration: frames / comm.sr };
}

export function parseAiff(buf) {
  const h = readAiffHeader(buf);
  if (!h.valid) throw new Error(h.reason);
  const { channels, frames, bits, dataOff, order, sample, sr } = h;
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const le = order === 'le';
  const bps = Math.ceil(bits / 8);
  const stride = bps * channels;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  // Integer samples are left-justified in their bytes, so dividing by the
  // container's full scale gives the right level for 12- or 20-bit audio too.
  const scale = 1 / Math.pow(2, 8 * bps - 1);
  for (let c = 0; c < channels; c++) {
    const ch = out[c];
    let p = dataOff + c * bps;
    if (sample === 'float' && bits === 32) for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getFloat32(p, le);
    else if (sample === 'float') for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getFloat64(p, le);
    else if (sample === 'uint') for (let i = 0; i < frames; i++, p += stride) ch[i] = (bytes[p] - 128) / 128;
    else if (bps === 1) for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getInt8(p) * scale;
    else if (bps === 2) for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getInt16(p, le) * scale;
    else if (bps === 3) {
      for (let i = 0; i < frames; i++, p += stride) {
        let v = le ? bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) : (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
        if (v & 0x800000) v -= 0x1000000;
        ch[i] = v * scale;
      }
    } else for (let i = 0; i < frames; i++, p += stride) ch[i] = dv.getInt32(p, le) * scale;
  }
  return { sr, channels: out, bits, float: sample === 'float' };
}
