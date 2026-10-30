// Delivery helpers for finished masters (no DOM, cheap enough for the page):
// smart trim and release fades, complementary frequency layers, a crossfaded
// loop, and gapless album assembly with a CUE sheet.

import { zeroPhaseLowpass } from './filters.js';

/**
 * Removes edge silence below `thresholdDb` (keeping a short pre-roll and a
 * longer tail so quiet intros and reverb tails survive) and applies release
 * fades. A trimmed edge always gets a short fade so the cut cannot click.
 */
export function trimAndFade(chs, sr, { trim = true, thresholdDb = -90, preRollMs = 10, tailMs = 300, fadeInMs = 0, fadeOutMs = 0, bounds = null } = {}) {
  const n = chs[0].length;
  let start = 0, end = n;
  if (bounds) {
    // Same cut points as another version (e.g. the main master), scaled to this rate.
    start = Math.min(n, Math.round(bounds.startSec * sr));
    end = Math.max(start, n - Math.round(bounds.endSec * sr));
  } else if (trim) {
    const thr = Math.pow(10, thresholdDb / 20);
    let first = n, last = -1;
    outer: for (let i = 0; i < n; i++) for (const ch of chs) if (Math.abs(ch[i]) > thr) { first = i; break outer; }
    outer2: for (let i = n - 1; i >= 0; i--) for (const ch of chs) if (Math.abs(ch[i]) > thr) { last = i; break outer2; }
    if (last > first) {
      start = Math.max(0, first - Math.round((preRollMs * sr) / 1000));
      end = Math.min(n, last + 1 + Math.round((tailMs * sr) / 1000));
    }
  }
  const out = chs.map((ch) => ch.slice(start, end));
  const len = end - start;
  const fin = Math.min(len >> 1, Math.round(((fadeInMs || (start > 0 ? 5 : 0)) * sr) / 1000));
  const fout = Math.min(len >> 1, Math.round(((fadeOutMs || (end < n ? 20 : 0)) * sr) / 1000));
  for (const ch of out) {
    for (let i = 0; i < fin; i++) { const w = Math.sin((Math.PI / 2) * (i / fin)); ch[i] *= w * w; }
    for (let i = 0; i < fout; i++) { const w = Math.sin((Math.PI / 2) * (i / fout)); ch[len - 1 - i] *= w * w; }
  }
  return { chs: out, trimmedStartSec: start / sr, trimmedEndSec: (n - end) / sr, bounds: { startSec: start / sr, endSec: (n - end) / sr }, fadeInMs: (fin / sr) * 1000, fadeOutMs: (fout / sr) * 1000 };
}

/**
 * Low, mid and high layers that add back up to the master. The low-pass
 * filters are zero-phase, so each high layer is the exact remainder without a
 * bump at the crossover (both sides are -6 dB there, 24 dB/oct slopes).
 */
export function frequencyLayers(chs, sr, { low = 200, high = 3000 } = {}) {
  const lo = chs.map((ch) => zeroPhaseLowpass(ch, low, sr));
  const rest = chs.map((ch, c) => { const r = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) r[i] = ch[i] - lo[c][i]; return r; });
  const mid = rest.map((r) => zeroPhaseLowpass(r, high, sr));
  const hi = rest.map((r, c) => { for (let i = 0; i < r.length; i++) r[i] -= mid[c][i]; return r; });
  let err = 0, ref = 0;
  chs.forEach((ch, c) => { for (let i = 0; i < ch.length; i++) { const d = ch[i] - (lo[c][i] + mid[c][i] + hi[c][i]); err += d * d; ref += ch[i] * ch[i]; } });
  return { low: lo, mid, high: hi, crossovers: [low, high], reconstructionDb: err > 0 && ref > 0 ? 10 * Math.log10(err / ref) : -200 };
}

/**
 * Seamless loop: the last `seamSec` is cross-faded (equal power) into the
 * start, so the end runs straight into the beginning. With `rotate` the loop
 * starts half way through, putting the seam in the middle where it can be
 * auditioned.
 */
export function makeLoop(chs, sr, { seamSec = 1, rotate = true } = {}) {
  const n = chs[0].length;
  const X = Math.max(1, Math.min(Math.round(seamSec * sr), Math.floor(n / 3)));
  const len = n - X;
  const off = rotate ? Math.floor(len / 2) : 0;
  const out = chs.map((x) => {
    const y = new Float32Array(len);
    for (let j = 0; j < len; j++) {
      let v = x[j];
      if (j < X) { const w = (Math.PI / 2) * (j / X); v = x[j] * Math.sin(w) + x[n - X + j] * Math.cos(w); }
      y[(j - off + len) % len] = v;
    }
    return y;
  });
  return { chs: out, seamSec: X / sr, lengthSec: len / sr, rotatedBySec: off / sr };
}

const cueTime = (samples, sr) => {
  const frames = Math.round((samples / sr) * 75);
  const m = Math.floor(frames / (75 * 60)), s = Math.floor(frames / 75) % 60, f = frames % 75;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};
const cueText = (s) => String(s || '').replace(/"/g, "'");
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Joins masters (same sample rate) into one gapless file with `gapSec` of
 * silence between tracks, plus a CUE sheet (INDEX 00 marks each gap) and a
 * plain-text track list.
 */
export function assembleAlbum(tracks, sr, { gapSec = 2, album = 'Album', performer = '', fileName = 'album.wav' } = {}) {
  const G = Math.round(gapSec * sr);
  const stereo = tracks.map((t) => (t.chs.length > 1 ? t.chs.slice(0, 2) : [t.chs[0], t.chs[0]]));
  const total = stereo.reduce((a, c) => a + c[0].length, 0) + G * Math.max(0, tracks.length - 1);
  const out = [new Float32Array(total), new Float32Array(total)];
  const positions = [];
  let pos = 0;
  stereo.forEach((c, i) => {
    if (i > 0) pos += G;
    out[0].set(c[0], pos);
    out[1].set(c[1], pos);
    positions.push({ start: pos, end: pos + c[0].length });
    pos += c[0].length;
  });
  const lines = [];
  if (performer) lines.push(`PERFORMER "${cueText(performer)}"`);
  lines.push(`TITLE "${cueText(album)}"`, `FILE "${cueText(fileName)}" WAVE`);
  tracks.forEach((t, i) => {
    lines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${cueText(t.title)}"`);
    if (t.performer || performer) lines.push(`    PERFORMER "${cueText(t.performer || performer)}"`);
    if (t.isrc) lines.push(`    ISRC ${String(t.isrc).replace(/[^A-Z0-9]/gi, '').toUpperCase()}`);
    if (i > 0 && G > 0) lines.push(`    INDEX 00 ${cueTime(positions[i - 1].end, sr)}`);
    lines.push(`    INDEX 01 ${cueTime(positions[i].start, sr)}`);
  });
  const tracklist = [
    `${album}${performer ? ` - ${performer}` : ''}`,
    `${tracks.length} tracks, ${clock(total / sr)} total, ${gapSec} s gaps, ${sr} Hz`,
    '',
    ...tracks.map((t, i) => `${String(i + 1).padStart(2, '0')}. ${t.title}  ${clock((positions[i].end - positions[i].start) / sr)}  (starts ${clock(positions[i].start / sr)})`),
  ].join('\n');
  return { chs: out, cue: lines.join('\r\n') + '\r\n', tracklist, positions, totalSec: total / sr };
}
