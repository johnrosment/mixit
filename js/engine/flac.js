// FLAC encoder: fixed predictors (order 0-4), partitioned Rice residuals,
// per-frame choice of stereo decorrelation (L/R, L/S, S/R, M/S), constant and
// verbatim fallbacks, STREAMINFO with MD5 and a Vorbis comment block.

import { quantizeChannels } from './wav.js';

const BLOCK = 4096;

class BitWriter {
  constructor(cap) {
    this.buf = new Uint8Array(cap);
    this.pos = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  grow(extra) {
    if (this.pos + extra < this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra + 65536));
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  // n <= 24 bits, v unsigned and < 2^n.
  bits(v, n) {
    this.acc = (this.acc << n) | v;
    this.nbits += n;
    while (this.nbits >= 8) {
      this.nbits -= 8;
      this.buf[this.pos++] = (this.acc >>> this.nbits) & 0xff;
    }
    this.acc &= (1 << this.nbits) - 1;
  }
  wide(v, n) {
    // Unsigned value of up to 53 bits.
    while (n > 24) { n -= 24; this.bits(Math.floor(v / 2 ** n) % 2 ** 24, 24); }
    this.bits(v % 2 ** n, n);
  }
  signed(v, n) {
    this.wide(v < 0 ? v + 2 ** n : v, n);
  }
  zeros(n) {
    while (n > 24) { this.bits(0, 24); n -= 24; }
    if (n) this.bits(0, n);
  }
  align() {
    if (this.nbits) this.bits(0, 8 - this.nbits);
  }
  bytes(arr) {
    this.grow(arr.length);
    this.buf.set(arr, this.pos);
    this.pos += arr.length;
  }
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
const crc8 = (b, a, e) => { let c = 0; for (let i = a; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = (b, a, e) => { let c = 0; for (let i = a; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

// ---- MD5 (RFC 1321), streaming ----
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

class MD5 {
  constructor() { this.h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]; this.tail = new Uint8Array(64); this.tlen = 0; this.total = 0; this.w = new Uint32Array(16); }
  block(b, o) {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = b[o + 4 * i] | (b[o + 4 * i + 1] << 8) | (b[o + 4 * i + 2] << 16) | (b[o + 4 * i + 3] << 24);
    let [a, bb, c, d] = this.h;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (bb & c) | (~bb & d); g = i; } else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; } else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; } else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
      const t = d;
      d = c;
      c = bb;
      const x = (a + f + MD5_K[i] + w[g]) | 0;
      bb = (bb + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
      a = t;
    }
    this.h = [(this.h[0] + a) | 0, (this.h[1] + bb) | 0, (this.h[2] + c) | 0, (this.h[3] + d) | 0];
  }
  update(b, len = b.length) {
    this.total += len;
    let i = 0;
    if (this.tlen) {
      while (this.tlen < 64 && i < len) this.tail[this.tlen++] = b[i++];
      if (this.tlen < 64) return;
      this.block(this.tail, 0);
      this.tlen = 0;
    }
    for (; i + 64 <= len; i += 64) this.block(b, i);
    while (i < len) this.tail[this.tlen++] = b[i++];
  }
  digest() {
    const bitsLen = this.total * 8;
    const pad = new Uint8Array(((this.tlen < 56 ? 56 : 120) - this.tlen) + 8);
    pad[0] = 0x80;
    for (let i = 0; i < 8; i++) pad[pad.length - 8 + i] = Math.floor(bitsLen / 2 ** (8 * i)) & 0xff;
    this.update(pad);
    const out = new Uint8Array(16);
    this.h.forEach((v, i) => { for (let j = 0; j < 4; j++) out[4 * i + j] = (v >>> (8 * j)) & 0xff; });
    return out;
  }
}

const RATE_CODES = { 88200: 1, 176400: 2, 192000: 3, 8000: 4, 16000: 5, 22050: 6, 24000: 7, 32000: 8, 44100: 9, 48000: 10, 96000: 11 };

function utf8Number(w, v) {
  if (v < 0x80) { w.bits(v, 8); return; }
  const n = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  w.bits(((0xff00 >> n) & 0xff) | (v >>> (6 * (n - 1))), 8);
  for (let i = n - 2; i >= 0; i--) w.bits(0x80 | ((v >>> (6 * i)) & 0x3f), 8);
}

// Residual of fixed predictor `order` for x[0..n), written into res[0..n-order).
function fixedResidual(x, n, order, res) {
  for (let i = order; i < n; i++) {
    let e;
    switch (order) {
      case 0: e = x[i]; break;
      case 1: e = x[i] - x[i - 1]; break;
      case 2: e = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: e = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: e = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    res[i - order] = e;
  }
}

function bestFixedOrder(x, n) {
  const sums = [0, 0, 0, 0, 0];
  for (let i = 4; i < n; i++) {
    const e0 = x[i], e1 = e0 - x[i - 1], e2 = e1 - (x[i - 1] - x[i - 2]);
    const e3 = e2 - (x[i - 1] - 2 * x[i - 2] + x[i - 3]);
    const e4 = e3 - (x[i - 1] - 3 * x[i - 2] + 3 * x[i - 3] - x[i - 4]);
    sums[0] += Math.abs(e0); sums[1] += Math.abs(e1); sums[2] += Math.abs(e2); sums[3] += Math.abs(e3); sums[4] += Math.abs(e4);
  }
  let best = 0;
  for (let o = 1; o < 5; o++) if (sums[o] < sums[best]) best = o;
  return { order: n > 4 ? best : 0, cost: sums[best] };
}

// Choose partition order and Rice parameters; returns the plan and estimated bits.
function ricePlan(u, count, blockSize, order) {
  let maxP = 0;
  while (maxP < 8 && blockSize % (1 << (maxP + 1)) === 0 && (blockSize >> (maxP + 1)) > order) maxP++;
  // Partition sums at the finest order, aggregated upwards.
  let parts = 1 << maxP;
  let sums = new Float64Array(parts);
  const psize = blockSize >> maxP;
  for (let p = 0, idx = 0; p < parts; p++) {
    const len = p === 0 ? psize - order : psize;
    let s = 0;
    for (let i = 0; i < len; i++) s += u[idx++];
    sums[p] = s;
  }
  let best = null;
  for (let po = maxP; po >= 0; po--) {
    const np = 1 << po;
    const size = blockSize >> po;
    const params = new Uint8Array(np);
    let bits = 0;
    for (let p = 0; p < np; p++) {
      const n = p === 0 ? size - order : size;
      const S = sums[p];
      let k = n > 0 && S > n ? Math.floor(Math.log2(S / n)) : 0;
      if (k > 30) k = 30;
      const est = (kk) => n * (kk + 1) + S / 2 ** kk;
      if (k < 30 && est(k + 1) < est(k)) k++;
      if (k > 0 && est(k - 1) < est(k)) k--;
      params[p] = k;
      bits += est(k);
    }
    const wide = params.some((k) => k > 14);
    bits += 6 + np * (wide ? 5 : 4);
    if (!best || bits < best.bits) best = { po, params, bits, wide };
    if (po > 0) {
      const next = new Float64Array(np >> 1);
      for (let p = 0; p < np >> 1; p++) next[p] = sums[2 * p] + sums[2 * p + 1];
      sums = next;
    }
  }
  return best;
}

function writeSubframe(w, x, n, bps, scratch) {
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) { w.bits(0, 8); w.signed(x[0], bps); return; }
  const { order } = bestFixedOrder(x, n);
  const res = scratch.res;
  fixedResidual(x, n, order, res);
  const count = n - order;
  const u = scratch.u;
  for (let i = 0; i < count; i++) { const e = res[i]; u[i] = e >= 0 ? 2 * e : -2 * e - 1; }
  const plan = ricePlan(u, count, n, order);
  if (plan.bits + order * bps >= n * bps) {
    w.bits(0x02, 8); // VERBATIM
    for (let i = 0; i < n; i++) w.signed(x[i], bps);
    return;
  }
  w.bits((0x08 | order) << 1, 8); // FIXED, no wasted bits
  for (let i = 0; i < order; i++) w.signed(x[i], bps);
  w.bits(plan.wide ? 1 : 0, 2);
  w.bits(plan.po, 4);
  const np = 1 << plan.po;
  const size = n >> plan.po;
  let idx = 0;
  for (let p = 0; p < np; p++) {
    const k = plan.params[p];
    w.bits(k, plan.wide ? 5 : 4);
    const len = p === 0 ? size - order : size;
    const mask = (1 << k) - 1;
    for (let i = 0; i < len; i++) {
      const v = u[idx++];
      const q = Math.floor(v / 2 ** k);
      if (q + 1 + k <= 24) w.bits((1 << k) | (v & mask), q + 1 + k);
      else { w.zeros(q); w.bits(1, 1); if (k) w.wide(v % 2 ** k, k); }
    }
  }
}

function vorbisComment(meta) {
  const enc = new TextEncoder();
  const vendor = enc.encode('MIXIT');
  const map = { title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', year: 'DATE', isrc: 'ISRC', genre: 'GENRE', comment: 'COMMENT' };
  const tags = Object.entries(meta || {}).filter(([k, v]) => map[k] && v).map(([k, v]) => enc.encode(`${map[k]}=${v}`));
  if (meta?.loudness) {
    // ReplayGain-style informational tags from the measured master.
    tags.push(enc.encode(`LOUDNESS_LUFS=${meta.loudness.integrated.toFixed(2)}`), enc.encode(`TRUE_PEAK_DBTP=${meta.loudness.truePeak.toFixed(2)}`));
  }
  const len = 8 + vendor.length + tags.reduce((a, t) => a + 4 + t.length, 0);
  const b = new Uint8Array(len);
  const dv = new DataView(b.buffer);
  let o = 0;
  dv.setUint32(o, vendor.length, true); o += 4; b.set(vendor, o); o += vendor.length;
  dv.setUint32(o, tags.length, true); o += 4;
  for (const t of tags) { dv.setUint32(o, t.length, true); o += 4; b.set(t, o); o += t.length; }
  return b;
}

/**
 * Encode channels ([-1, 1] floats) to FLAC. bits: 16 or 24. Dither as for
 * WAV. Returns an ArrayBuffer.
 */
export function encodeFlac(chs, sr, { bits = 24, dither = 'tpdf', meta = null } = {}) {
  const bps = bits >= 24 ? 24 : 16;
  const q = quantizeChannels(chs, bps, dither);
  const nch = q.length;
  const total = q[0].length;
  const bytesPerSample = bps / 8;
  const w = new BitWriter(Math.ceil(total * nch * bytesPerSample * 1.02) + 65536);
  const md5 = new MD5();
  const md5buf = new Uint8Array(BLOCK * nch * bytesPerSample);
  // fLaC + STREAMINFO (patched at the end) + VORBIS_COMMENT
  w.bytes([0x66, 0x4c, 0x61, 0x43]);
  const vc = vorbisComment(meta);
  w.bytes([0x00, 0, 0, 34]);
  const siPos = w.pos;
  w.bytes(new Uint8Array(34));
  w.bytes([0x80 | 4, (vc.length >> 16) & 0xff, (vc.length >> 8) & 0xff, vc.length & 0xff]);
  w.bytes(vc);
  const scratch = { res: new Int32Array(BLOCK), u: new Float64Array(BLOCK) };
  const side = new Int32Array(BLOCK), mid = new Int32Array(BLOCK);
  let minFrame = Infinity, maxFrame = 0;
  const rateCode = RATE_CODES[sr] ?? 0;
  const sizeCode = bps === 24 ? 6 : 4;
  for (let start = 0, frame = 0; start < total; start += BLOCK, frame++) {
    const n = Math.min(BLOCK, total - start);
    // MD5 over interleaved little-endian samples.
    let mo = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        const v = q[c][start + i];
        md5buf[mo++] = v & 0xff;
        md5buf[mo++] = (v >> 8) & 0xff;
        if (bps === 24) md5buf[mo++] = (v >> 16) & 0xff;
      }
    }
    md5.update(md5buf, mo);
    const xs = q.map((ch) => ch.subarray(start, start + n));
    let assign = nch - 1;
    let subs = xs.map((x) => ({ x, bps }));
    if (nch === 2) {
      const [L, R] = xs;
      for (let i = 0; i < n; i++) { side[i] = L[i] - R[i]; mid[i] = (L[i] + R[i]) >> 1; }
      const cL = bestFixedOrder(L, n).cost, cR = bestFixedOrder(R, n).cost;
      const cS = bestFixedOrder(side, n).cost, cM = bestFixedOrder(mid, n).cost;
      const opts = [[1, cL + cR], [8, cL + cS], [9, cS + cR], [10, cM + cS]];
      opts.sort((a, b) => a[1] - b[1]);
      assign = opts[0][0];
      const S = { x: side.subarray(0, n), bps: bps + 1 };
      if (assign === 8) subs = [{ x: L, bps }, S];
      else if (assign === 9) subs = [S, { x: R, bps }];
      else if (assign === 10) subs = [{ x: mid.subarray(0, n), bps }, S];
    }
    const fStart = w.pos;
    w.grow(n * nch * 4 + 64);
    w.bits(0xfff8 >> 8, 8);
    w.bits(0xf8, 8);
    const bsCode = n === BLOCK ? 12 : 7;
    w.bits((bsCode << 4) | rateCode, 8);
    w.bits((assign << 4) | (sizeCode << 1), 8);
    utf8Number(w, frame);
    if (bsCode === 7) w.bits(n - 1, 16);
    w.bits(crc8(w.buf, fStart, w.pos), 8);
    for (const sf of subs) writeSubframe(w, sf.x, n, sf.bps, scratch);
    w.align();
    const c16 = crc16(w.buf, fStart, w.pos);
    w.bits(c16 >> 8, 8);
    w.bits(c16 & 0xff, 8);
    const size = w.pos - fStart;
    if (size < minFrame) minFrame = size;
    if (size > maxFrame) maxFrame = size;
  }
  // STREAMINFO
  const si = new BitWriter(34);
  si.bits(BLOCK, 16);
  si.bits(BLOCK, 16);
  si.bits(Number.isFinite(minFrame) ? minFrame : 0, 24);
  si.bits(maxFrame, 24);
  si.bits(sr, 20);
  si.bits(nch - 1, 3);
  si.bits(bps - 1, 5);
  si.wide(total, 36);
  si.bytes(md5.digest());
  w.buf.set(si.buf.subarray(0, 34), siPos);
  return w.buf.slice(0, w.pos).buffer;
}
