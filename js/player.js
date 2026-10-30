// A/B player: switches between versions at the same position. Playback level
// can be loudness-matched, at file level, or as a streaming service's
// normalisation would play it (turn-down only). A monitor menu approximates
// mono, phone, laptop, small-speaker and car playback with level
// compensation, so translation checks are not biased by loudness either.

import { el } from './controls.js';
import { fmtDuration } from './audio-io.js';
import { kCoeffs } from './engine/loudness.js';
import { magnitudeDb } from './engine/filters.js';

const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>';
const COLUMNS = 1600;

export const LEVEL_MODES = [
  { key: 'matched', label: 'Matched loudness' },
  { key: 'file', label: 'File level' },
  { key: 'spotify', label: 'Spotify (-14 LUFS)', target: -14 },
  { key: 'youtube', label: 'YouTube (-14 LUFS)', target: -14 },
  { key: 'apple', label: 'Apple Music (-16 LUFS)', target: -16 },
  { key: 'broadcast', label: 'Broadcast (-23 LUFS)', target: -23 },
];

// Rough playback-system approximations. Filter Q for lowpass/highpass is in dB
// (Web Audio convention); peaking Q is linear.
export const MONITORS = [
  { key: 'full', label: 'Full range', filters: [] },
  { key: 'mono', label: 'Mono', mono: true, filters: [] },
  { key: 'phone', label: 'Phone speaker', mono: true, filters: [['highpass', 380, 3], ['highpass', 380, -3], ['peaking', 2200, 1.2, 5], ['lowpass', 8000, -3]] },
  { key: 'laptop', label: 'Laptop', filters: [['highpass', 180, 2], ['highpass', 180, -3], ['peaking', 450, 1, -3], ['peaking', 3000, 1, 3], ['lowpass', 15000, -3]] },
  { key: 'speaker', label: 'Small speaker', mono: true, filters: [['highpass', 85, 4], ['highpass', 85, -3], ['peaking', 160, 1.5, 3], ['peaking', 1200, 1, -1.5], ['lowpass', 13000, -3]] },
  { key: 'car', label: 'Car', filters: [['lowshelf', 70, 0, 5], ['peaking', 300, 1.2, -2], ['peaking', 2500, 1, 1.5], ['lowpass', 14000, -3]] },
];

let sharedCtx = null;
function audioCtx() {
  if (!sharedCtx) sharedCtx = new AudioContext({ latencyHint: 'playback' });
  return sharedCtx;
}

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function peaks(chs) {
  const n = chs[0].length;
  const per = Math.max(1, Math.floor(n / COLUMNS));
  const cols = Math.ceil(n / per);
  const mn = new Float32Array(cols), mx = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    let lo = 0, hi = 0;
    const end = Math.min(n, (c + 1) * per);
    for (const ch of chs) {
      for (let i = c * per; i < end; i++) { const v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    mn[c] = lo; mx[c] = hi;
  }
  return { mn, mx };
}

const K_COEFFS = kCoeffs(48000);
const kWeightDb = (f) => K_COEFFS.reduce((a, c) => a + magnitudeDb(c, f, 48000), 0);

export class ABPlayer {
  constructor(root) {
    this.root = root;
    this.sources = [];
    this.current = null;
    this.playing = false;
    this.offset = 0;
    this.level = 'matched';
    this.monitor = 'full';
    this.node = null;
    this.gainNode = null;
    this.monitorIn = null;
    this.monitorNodes = [];
    this.raf = 0;
    this.playBtn = el('button', { class: 'play', 'aria-label': 'Play', html: PLAY, onclick: () => this.toggle() });
    this.seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Version' });
    this.timeEl = el('span', { class: 'time' }, '0:00.0 / 0:00.0');
    const levelSel = el('select', { 'aria-label': 'Playback level' }, LEVEL_MODES.map((m) => el('option', { value: m.key }, m.label)));
    levelSel.addEventListener('change', () => { this.level = levelSel.value; this.applyGain(); this.updateNote(); this.drawWave(); });
    const monSel = el('select', { 'aria-label': 'Monitor' }, MONITORS.map((m) => el('option', { value: m.key }, m.label)));
    monSel.addEventListener('change', () => { this.monitor = monSel.value; this.buildMonitor(); this.applyGain(); this.updateNote(); });
    this.note = el('span', { class: 'gain-note' });
    this.canvas = el('canvas');
    this.head = el('div', { class: 'playhead' });
    this.wave = el('div', { class: 'wave-wrap', title: 'Click to seek' }, this.canvas, this.head);
    this.wave.addEventListener('click', (e) => {
      const r = this.wave.getBoundingClientRect();
      this.seek(((e.clientX - r.left) / r.width) * this.duration());
    });
    root.append(el('div', { class: 'player' },
      el('div', { class: 'player-row' }, this.playBtn, this.seg, this.timeEl),
      el('div', { class: 'player-row options' },
        el('label', { class: 'inline-select' }, el('span', {}, 'Level'), levelSel),
        el('label', { class: 'inline-select' }, el('span', {}, 'Monitor'), monSel)),
      this.wave, this.note));
    new ResizeObserver(() => this.drawWave()).observe(this.wave);
  }

  /**
   * sources: [{ key, label, cls, audio: { sr, channels }, lufs, truePeak,
   *   bands?: { centers, levels }, monoLossLu?, follow?: key }]
   * A source with `follow` plays at the gain of that source (used for the
   * difference signal, which should be heard at the master's level).
   */
  setSources(sources, initial) {
    this.stop();
    this.sources = sources.map((s) => ({ ...s, peaks: peaks(s.audio.channels.length > 1 ? s.audio.channels : [s.audio.channels[0]]), buffer: null }));
    // Common playback level every version can reach with its peaks under -1 dBFS.
    const reach = this.sources.filter((s) => !s.follow).map((s) => s.lufs + (-1 - s.truePeak));
    this.targetLufs = Math.min(...reach);
    this.seg.innerHTML = '';
    for (const s of this.sources) {
      const b = el('button', { type: 'button', class: s.cls || '', 'aria-pressed': 'false', title: s.title || '' }, s.label);
      b.addEventListener('click', () => this.select(s.key));
      s.btn = b;
      this.seg.append(b);
    }
    this.offset = 0;
    this.select(initial || this.sources[this.sources.length - 1].key);
  }

  duration() {
    const s = this.current;
    return s ? s.audio.channels[0].length / s.audio.sr : 0;
  }

  levelGainDb(s) {
    const mode = LEVEL_MODES.find((m) => m.key === this.level);
    if (this.level === 'matched') return this.targetLufs - s.lufs;
    if (this.level === 'file') return 0;
    return Math.min(0, mode.target - s.lufs);
  }

  // Loudness change caused by the monitor filters (K-weighted, from the source's spectrum).
  monitorGainDb(s) {
    const mon = MONITORS.find((m) => m.key === this.monitor);
    if (!mon || (!mon.filters.length && !mon.mono)) return 0;
    let comp = mon.mono ? Math.max(0, s.monoLossLu || 0) : 0;
    if (mon.filters.length && s.bands && this.monitorNodes.length) {
      const freqs = Float32Array.from(s.bands.centers);
      const total = new Float32Array(freqs.length).fill(1);
      const mag = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
      for (const node of this.monitorNodes) {
        if (!node.getFrequencyResponse) continue;
        node.getFrequencyResponse(freqs, mag, ph);
        for (let i = 0; i < freqs.length; i++) total[i] *= mag[i];
      }
      let num = 0, den = 0;
      s.bands.levels.forEach((lv, i) => {
        const p = Math.pow(10, (lv + kWeightDb(freqs[i])) / 10);
        num += p * total[i] * total[i];
        den += p;
      });
      if (den > 0 && num > 0) comp += -10 * Math.log10(num / den);
    }
    return Math.max(-12, Math.min(18, comp));
  }

  gainFor(s) {
    const base = s.follow ? this.sources.find((x) => x.key === s.follow) || s : s;
    return Math.pow(10, (this.levelGainDb(base) + this.monitorGainDb(base)) / 20);
  }

  updateNote() {
    const s = this.current;
    if (!s) return;
    const base = s.follow ? this.sources.find((x) => x.key === s.follow) || s : s;
    const lv = this.levelGainDb(base), mon = this.monitorGainDb(base);
    const g = lv + mon;
    const sg = `${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`;
    const mode = LEVEL_MODES.find((m) => m.key === this.level);
    const monitor = MONITORS.find((m) => m.key === this.monitor);
    let text;
    if (s.follow) text = `${s.label}: only what the chain changed, played at the ${base.label.toLowerCase()}'s gain (${sg}).`;
    else if (this.level === 'matched') text = `Playing ${s.label} at ${this.targetLufs.toFixed(1)} LUFS (${sg}) so every version is heard at the same loudness.`;
    else if (this.level === 'file') text = `Playing ${s.label} at file level.`;
    else text = `Playing ${s.label} as ${mode.label.replace(/ \(.*/, '')} would: ${lv < -0.05 ? `turned down ${(-lv).toFixed(1)} dB to ${mode.target} LUFS` : 'not turned down (already at or below the reference)'}. Quiet tracks are not turned up.`;
    if (monitor.key !== 'full') text += ` Monitor: ${monitor.label.toLowerCase()} approximation${Math.abs(mon) > 0.05 ? `, ${mon > 0 ? '+' : ''}${mon.toFixed(1)} dB level compensation` : ''}.`;
    if (!s.follow) text += ` File: ${s.lufs.toFixed(1)} LUFS, ${s.truePeak.toFixed(1)} dBTP.`;
    this.note.textContent = text;
  }

  select(key) {
    const s = this.sources.find((x) => x.key === key);
    if (!s) return;
    const pos = this.position();
    const wasPlaying = this.playing;
    if (wasPlaying) this.halt(true);
    this.current = s;
    for (const x of this.sources) x.btn.setAttribute('aria-pressed', String(x === s));
    this.offset = Math.min(pos, this.duration());
    this.drawWave();
    this.updateNote();
    this.updateTime();
    if (wasPlaying) this.start();
  }

  bufferFor(s) {
    if (!s.buffer) {
      const ctx = audioCtx();
      const chs = s.audio.channels;
      const buf = ctx.createBuffer(Math.min(2, chs.length), chs[0].length, s.audio.sr);
      for (let c = 0; c < buf.numberOfChannels; c++) buf.copyToChannel(chs[c], c);
      s.buffer = buf;
    }
    return s.buffer;
  }

  buildMonitor() {
    const ctx = audioCtx();
    if (!this.monitorIn) this.monitorIn = ctx.createGain();
    this.monitorIn.disconnect();
    for (const n of this.monitorNodes) n.disconnect();
    const mon = MONITORS.find((m) => m.key === this.monitor);
    const nodes = [];
    if (mon.mono) {
      const m = ctx.createGain();
      m.channelCount = 1;
      m.channelCountMode = 'explicit';
      m.channelInterpretation = 'speakers';
      nodes.push(m);
    }
    for (const [type, freq, q, gainDb = 0] of mon.filters) {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      f.gain.value = gainDb;
      nodes.push(f);
    }
    this.monitorNodes = nodes;
    let prev = this.monitorIn;
    for (const n of nodes) { prev.connect(n); prev = n; }
    prev.connect(ctx.destination);
  }

  position() {
    if (!this.playing) return this.offset;
    return Math.min(this.duration(), this.offset + (audioCtx().currentTime - this.startedAt));
  }

  start() {
    const ctx = audioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    if (!this.monitorIn) this.buildMonitor();
    const s = this.current;
    const src = ctx.createBufferSource();
    src.buffer = this.bufferFor(s);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(this.gainFor(s), ctx.currentTime + 0.015);
    src.connect(g).connect(this.monitorIn);
    if (this.offset >= this.duration() - 0.05) this.offset = 0;
    src.start(0, this.offset);
    src.onended = () => { if (this.node === src) { this.playing = false; this.offset = 0; this.playBtn.innerHTML = PLAY; this.updateTime(); } };
    this.node = src;
    this.gainNode = g;
    this.startedAt = ctx.currentTime;
    this.playing = true;
    this.playBtn.innerHTML = PAUSE;
    this.playBtn.setAttribute('aria-label', 'Pause');
    const tick = () => { this.updateTime(); if (this.playing) this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }

  halt(keepPosition) {
    if (!this.node) return;
    const ctx = audioCtx();
    const pos = this.position();
    const { node, gainNode } = this;
    gainNode.gain.cancelScheduledValues(ctx.currentTime);
    gainNode.gain.setValueAtTime(gainNode.gain.value, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.015);
    node.onended = null;
    node.stop(ctx.currentTime + 0.02);
    this.node = null;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (keepPosition) this.offset = pos;
    this.playBtn.innerHTML = PLAY;
    this.playBtn.setAttribute('aria-label', 'Play');
  }

  stop() {
    this.halt(false);
    this.offset = 0;
  }

  toggle() {
    if (!this.current) return;
    if (this.playing) this.halt(true); else this.start();
  }

  seek(t) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.halt(false);
    this.offset = Math.max(0, Math.min(this.duration(), t));
    this.updateTime();
    if (wasPlaying) this.start();
  }

  applyGain() {
    if (this.gainNode && this.current) this.gainNode.gain.setTargetAtTime(this.gainFor(this.current), audioCtx().currentTime, 0.01);
  }

  updateTime() {
    const pos = this.position();
    const dur = this.duration();
    this.timeEl.textContent = `${fmtDuration(pos)} / ${fmtDuration(dur)}`;
    this.head.style.left = `${dur ? (pos / dur) * 100 : 0}%`;
  }

  drawWave() {
    const rect = this.wave.getBoundingClientRect();
    if (!rect.width || !this.current) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const H = rect.height, mid = H / 2;
    const base = this.sources[0];
    const layers = base === this.current ? [[base, cssVar('--before'), 0.9]] : [[base, cssVar('--before'), 0.35], [this.current, cssVar('--accent'), 0.9]];
    // Draw on a common scale: each layer at its playback gain.
    let maxAbs = 1e-9;
    for (const [s] of layers) {
      const g = this.gainFor(s);
      for (let i = 0; i < s.peaks.mx.length; i++) maxAbs = Math.max(maxAbs, s.peaks.mx[i] * g, -s.peaks.mn[i] * g);
    }
    for (const [s, col, alpha] of layers) {
      const g = this.gainFor(s) / maxAbs;
      const { mn, mx } = s.peaks;
      ctx.fillStyle = col;
      ctx.globalAlpha = alpha;
      const cols = mn.length;
      for (let x = 0; x < rect.width; x++) {
        const a = Math.floor((x / rect.width) * cols), b = Math.max(a + 1, Math.floor(((x + 1) / rect.width) * cols));
        let lo = 0, hi = 0;
        for (let i = a; i < b && i < cols; i++) { if (mn[i] < lo) lo = mn[i]; if (mx[i] > hi) hi = mx[i]; }
        const y0 = mid - hi * g * (mid - 4), y1 = mid - lo * g * (mid - 4);
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }
    ctx.globalAlpha = 1;
  }
}
