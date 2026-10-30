// MP3 for easy sharing: LAME (lamejs) in its own worker, 320 kbps unless the
// file would pass about 10 MB (a common chat upload limit), then the highest
// bitrate that fits. MP3 only allows 32, 44.1 and 48 kHz, so other rates are
// converted first. An ID3v2.3 tag carries the title and artist.

import { resample } from './audio-io.js';

const BITRATES = [320, 256, 224, 192, 160, 128];
const SIZE_LIMIT = 9.5e6; // bytes, a little under 10 MB

export function mp3Bitrate(seconds) {
  return BITRATES.find((k) => k * 125 * seconds + 4096 <= SIZE_LIMIT) || 128;
}

export const mp3SizeMb = (kbps, seconds) => (kbps * 125 * seconds) / 1e6;

function mp3Rate(sr) {
  if ([32000, 44100, 48000].includes(sr)) return sr;
  return sr % 11025 === 0 ? 44100 : 48000;
}

/** ID3v2.3 tag with UTF-16 text frames. */
function id3(meta) {
  const frames = [['TIT2', meta.title], ['TPE1', meta.artist], ['TALB', meta.album], ['TYER', meta.year], ['TSSE', 'MIXIT']]
    .filter(([, v]) => v)
    .map(([id, v]) => {
      const s = String(v);
      const f = new Uint8Array(10 + 3 + 2 * s.length);
      for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
      new DataView(f.buffer).setUint32(4, 3 + 2 * s.length);
      f.set([1, 0xff, 0xfe], 10);
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); f[13 + 2 * i] = c & 255; f[14 + 2 * i] = c >> 8; }
      return f;
    });
  const size = frames.reduce((a, f) => a + f.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  let o = 10;
  for (const f of frames) { tag.set(f, o); o += f.length; }
  return tag;
}

/** audio: { sr, channels } → { data: Uint8Array, kbps, sr } */
export async function encodeMp3(audio, { meta = {} } = {}) {
  let a = audio;
  const sr = mp3Rate(a.sr);
  if (sr !== a.sr) a = await resample(a, sr);
  const kbps = mp3Bitrate(a.channels[0].length / sr);
  // Copies, so the master stays playable; mono becomes two equal channels.
  const chs = [a.channels[0].slice(), (a.channels[1] || a.channels[0]).slice()];
  const worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
  try {
    const frames = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => { if (e.data.error) reject(new Error(e.data.error)); else if (e.data.data) resolve(e.data.data); };
      worker.onerror = (e) => reject(new Error(e.message || 'The MP3 encoder could not start'));
      worker.postMessage({ channels: chs, sr, kbps }, chs.map((c) => c.buffer));
    });
    const tag = id3(meta);
    const data = new Uint8Array(tag.length + frames.length);
    data.set(tag);
    data.set(frames, tag.length);
    return { data, kbps, sr };
  } finally {
    worker.terminate();
  }
}
