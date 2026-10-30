// MP3 encoding off the page. A classic (non-module) worker, so it can load the
// LAME build with importScripts. Input: two Float32 channels, the sample rate
// and the bitrate; output: the MP3 frames (no tag).

importScripts('vendor/lame.min.js');

// Float to 16-bit with TPDF dither, as LAME takes 16-bit samples.
function toInt16(ch) {
  const out = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    const v = Math.round(ch[i] * 32767 + (Math.random() - Math.random()));
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

self.onmessage = (ev) => {
  const { channels, sr, kbps } = ev.data;
  try {
    const L = toInt16(channels[0]), R = toInt16(channels[1]);
    const enc = new lamejs.Mp3Encoder(2, sr, kbps);
    const BLOCK = 1152 * 16;
    const parts = [];
    let size = 0;
    const keep = (p) => { if (p.length) { parts.push(p); size += p.length; } };
    for (let i = 0; i < L.length; i += BLOCK) {
      keep(enc.encodeBuffer(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK)));
      if ((i / BLOCK) % 32 === 0) self.postMessage({ progress: i / L.length });
    }
    keep(enc.flush());
    const data = new Uint8Array(size);
    let o = 0;
    for (const p of parts) { data.set(new Uint8Array(p.buffer, p.byteOffset, p.length), o); o += p.length; }
    self.postMessage({ data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  }
};
