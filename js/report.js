// Shared result rendering: KPI tiles, metric tables, charts, logs, downloads,
// and JSON/CSV exports.

import { el, toast } from './controls.js';
import { chart, legend, fmtHz, fmtTime } from './charts.js';
import { download } from './audio-io.js';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export const fx = (v, d = 1) => (Number.isFinite(v) ? Number(v).toFixed(d) : '–');
export const sx = (v, d = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}` : '–');

export const METRICS = [
  ['Loudness'],
  ['Integrated loudness', (a) => a.loudness.integrated, 'LUFS', 2],
  ['Short-term max (3 s)', (a) => a.loudness.shortTermMax, 'LUFS', 1],
  ['Momentary max (400 ms)', (a) => a.loudness.momentaryMax, 'LUFS', 1],
  ['Loudness range (LRA)', (a) => a.loudness.lra, 'LU', 1],
  ['Peaks and dynamics'],
  ['True peak', (a) => a.peak.truePeakDbtp, 'dBTP', 2],
  ['True peak L / R', (a) => a.peak.truePeakPerChannel, 'dBTP', 2],
  ['Sample peak', (a) => a.peak.samplePeakDbfs, 'dBFS', 2],
  ['RMS', (a) => a.level.rmsDbfs, 'dBFS', 1],
  ['Crest factor', (a) => a.level.crestDb, 'dB', 1],
  ['Peak-to-loudness ratio', (a) => a.level.plrDb, 'dB', 1],
  ['Clipped samples', (a) => a.level.clippedSamples, '', 0],
  ['DC offset L / R', (a) => a.level.dcOffsetPct, '%', 4],
  ['Silence', (a) => a.level.silencePct, '%', 1],
  ['Stereo image'],
  ['Correlation', (a) => a.stereo.correlation, '', 2],
  ['Low-end correlation (<150 Hz)', (a) => a.stereo.lowCorrelation, '', 2],
  ['High correlation (>4 kHz)', (a) => a.stereo.highCorrelation, '', 2],
  ['Side vs mid energy', (a) => a.stereo.sideToMidDb, 'dB', 1],
  ['L/R balance', (a) => a.stereo.balanceDb, 'dB', 2],
  ['Loss when folded to mono', (a) => a.stereo.monoLossLu, 'LU', 2],
  ['Tone'],
  ['Spectral centroid', (a) => a.spectrum.centroidHz, 'Hz', 0],
  ['85% energy roll-off', (a) => a.spectrum.rolloff85Hz, 'Hz', 0],
  ['Spectral slope', (a) => a.spectrum.tonal.slopeDbPerOct, 'dB/oct', 2],
  ['Low-mids vs trend (180-500 Hz)', (a) => a.spectrum.tonal.mudDb, 'dB', 1],
  ['Mids vs trend (500 Hz-1 kHz)', (a) => a.spectrum.tonal.boxDb, 'dB', 1],
  ['Upper-mids vs trend (2-5 kHz)', (a) => a.spectrum.tonal.harshDb, 'dB', 1],
  ['Sibilance index (5-9 kHz bursts)', (a) => a.sibilance.indexDb, 'dB', 1],
  ['Energy share'],
  ['Sub (20-60 Hz)', (a) => a.spectrum.bandSharePct.sub, '%', 1],
  ['Bass (60-200 Hz)', (a) => a.spectrum.bandSharePct.bass, '%', 1],
  ['Low-mid (200-500 Hz)', (a) => a.spectrum.bandSharePct.lowMid, '%', 1],
  ['Mid (500 Hz-2 kHz)', (a) => a.spectrum.bandSharePct.mid, '%', 1],
  ['Upper-mid (2-4 kHz)', (a) => a.spectrum.bandSharePct.upperMid, '%', 1],
  ['Presence (4-8 kHz)', (a) => a.spectrum.bandSharePct.presence, '%', 1],
  ['Air (8-20 kHz)', (a) => a.spectrum.bandSharePct.air, '%', 1],
  ['Rhythm'],
  ['Tempo estimate', (a) => a.rhythm.bpm, 'BPM', 1],
  ['Tempo confidence', (a) => a.rhythm.confidence * 100, '%', 0],
  ['Onsets per second', (a) => a.rhythm.onsetsPerSec, '/s', 2],
];

function cellValue(v, d) {
  if (Array.isArray(v)) return v.map((x) => fx(x, d)).join(' / ');
  return fx(v, d);
}

/** cols: [{ label, analysis }]. With exactly two columns a change column is added. */
export function metricsTable(cols) {
  const withDelta = cols.length === 2;
  const head = el('tr', {}, el('th', {}, 'Measurement'), cols.map((c) => el('th', {}, c.label)), withDelta ? el('th', {}, 'Change') : null, el('th', {}, ''));
  const rows = METRICS.map(([label, get, unit, d]) => {
    if (!get) return el('tr', { class: 'group' }, el('td', { colspan: cols.length + (withDelta ? 3 : 2) }, label));
    const vals = cols.map((c) => { try { return get(c.analysis); } catch { return NaN; } });
    let delta = null;
    if (withDelta && !Array.isArray(vals[0]) && Number.isFinite(vals[0]) && Number.isFinite(vals[1])) {
      const dv = vals[1] - vals[0];
      delta = el('td', { class: `num ${dv > 0.005 ? 'delta-up' : dv < -0.005 ? 'delta-down' : ''}` }, sx(dv, d));
    } else if (withDelta) delta = el('td', { class: 'num' }, '');
    return el('tr', {}, el('td', {}, label), vals.map((v) => el('td', { class: 'num' }, cellValue(v, d))), delta, el('td', { class: 'num', style: 'color:var(--faint)' }, unit));
  });
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, el('thead', {}, head), el('tbody', {}, rows)));
}

export function kpis(before, after) {
  const items = [
    ['Loudness', (a) => a.loudness.integrated, 'LUFS', 1],
    ['True peak', (a) => a.peak.truePeakDbtp, 'dBTP', 1],
    ['Loudness range', (a) => a.loudness.lra, 'LU', 1],
    ['Crest factor', (a) => a.level.crestDb, 'dB', 1],
    ['Correlation', (a) => a.stereo.correlation, '', 2],
    ['Centroid', (a) => a.spectrum.centroidHz, 'Hz', 0],
  ];
  return el('div', { class: 'kpis' }, items.map(([k, get, unit, d]) => {
    const v = get(after);
    let delta = null;
    if (before) {
      const dv = v - get(before);
      delta = el('div', { class: `d ${dv > 0.005 ? 'up' : dv < -0.005 ? 'down' : ''}` }, `${sx(dv, d)} ${unit} vs input`);
    }
    return el('div', { class: 'kpi' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, `${fx(v, d)}`, el('small', { style: 'font-size:12px;color:var(--muted)' }, ` ${unit}`)), delta);
  }));
}

/** Saves a chart card's canvas as a PNG with its title, on the card background. */
function exportPng(card, title) {
  const canvas = card.querySelector('canvas');
  if (!canvas || !canvas.width) return;
  const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  const head = Math.round(30 * dpr);
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height + head;
  const ctx = out.getContext('2d');
  ctx.fillStyle = cssVar('--card') || '#181e26';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = cssVar('--text') || '#e7ebf1';
  ctx.font = `600 ${Math.round(13 * dpr)}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(title, Math.round(10 * dpr), head / 2);
  ctx.drawImage(canvas, 0, head);
  out.toBlob((b) => b && download(b, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`, 'image/png'));
}

export function chartCard(title, caption, { wide = false, height = 210 } = {}) {
  const body = el('div', { style: `height:${height}px` });
  const png = el('button', { class: 'png-btn', type: 'button', title: 'Save this chart as a PNG image', 'aria-label': `Save ${title} as PNG` }, 'PNG');
  const card = el('div', { class: `chart-card${wide ? ' wide' : ''}` }, el('div', { class: 'chart-head' }, el('h3', {}, title), png), caption ? el('p', { class: 'cap' }, caption) : null, body);
  png.addEventListener('click', () => exportPng(card, title));
  return { card, body };
}

function seriesRange(arrays, { floor = -100, pad = 3, minSpan = 12 } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrays) for (let i = 0; i < (a?.length || 0); i++) { const v = a[i]; if (v > floor && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!Number.isFinite(lo)) return { yMin: -60, yMax: 0 };
  lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  if (hi - lo < minSpan) lo = hi - minSpan;
  return { yMin: lo, yMax: hi };
}

/** entries: [{ label, color, analysis, momentary?: bool }] */
export function loudnessChart(entries, { target = null } = {}) {
  const { card, body } = chartCard('Loudness over time', 'Short-term (3 s) loudness; the thin line is momentary (400 ms) loudness of the result.', { wide: true, height: 230 });
  const series = [];
  const arrays = [];
  entries.forEach((e, i) => {
    const L = e.analysis.loudness;
    arrays.push(L.shortTerm);
    series.push({ label: `${e.label} short-term`, color: e.color, data: L.shortTerm, step: L.hopSec, width: 2 });
    if (i === entries.length - 1) {
      series.push({ label: `${e.label} momentary`, color: e.color, data: L.momentary, step: L.hopSec, width: 1, alpha: 0.35, noTip: false });
      arrays.push(L.momentary);
    }
  });
  const r = seriesRange(arrays, { minSpan: 18 });
  r.yMin = Math.max(r.yMin, r.yMax - 40);
  if (target != null) { r.yMax = Math.max(r.yMax, target + 3); r.yMin = Math.min(r.yMin, target - 6); }
  for (const s of series) s.gapBelow = r.yMin;
  chart(body, { series, ...r, yFmt: (v, tip) => (tip ? `${v.toFixed(1)} LUFS` : `${v}`), refLines: target != null ? [{ y: target, label: `target ${target} LUFS`, color: '--muted' }] : [] });
  card.append(legend(entries.map((e) => ({ label: e.label, color: e.color }))));
  return card;
}

/** entries: [{ label, color, centers, levels, offset }] – levels are shifted by `offset` (e.g. -LUFS). */
export function spectrumChart(entries, { title = 'Spectrum', caption = '1/6-octave average spectrum.', relative = true } = {}) {
  const { card, body } = chartCard(title, caption, { height: 230 });
  const series = entries.map((e) => ({ label: e.label, color: e.color, xs: e.centers, data: e.levels.map((v) => v + (e.offset || 0)), width: e.width || 1.8, dash: e.dash, gapBelow: -200 }));
  const r = seriesRange(series.map((s) => s.data), { floor: -190, pad: 4, minSpan: 30 });
  r.yMin = Math.max(r.yMin, r.yMax - 75);
  chart(body, { series, xScale: 'log', xMin: 20, xMax: 20000, ...r, yFmt: (v, tip) => (tip ? `${v.toFixed(1)} dB` : `${v}`) });
  card.append(legend(entries.map((e) => ({ label: e.label, color: e.color, dash: e.dash }))));
  if (relative) card.querySelector('.cap').textContent = caption;
  return card;
}

export function correlationChart(entries) {
  const { card, body } = chartCard('Stereo correlation over time', '+1 = mono, 0 = unrelated channels, below 0 = phase problems in mono.', { height: 200 });
  const series = entries.map((e) => ({ label: e.label, color: e.color, data: e.analysis.stereo.correlationTimeline, step: e.analysis.stereo.correlationStepSec, width: 1.6, gapBelow: -2 }));
  chart(body, { series, yMin: -1, yMax: 1, yStep: 0.5, yFmt: (v) => v.toFixed(2), baseline: 0 });
  card.append(legend(entries.map((e) => ({ label: e.label, color: e.color }))));
  return card;
}

/** curves: [{ label, color, data (dB, <= 0), step }] */
export function gainReductionChart(curves, { title = 'Gain reduction', caption = 'How hard each dynamics stage worked over time (dB of reduction).' } = {}) {
  const { card, body } = chartCard(title, caption, { wide: true, height: 200 });
  const series = curves.filter((c) => c.data?.length).map((c) => ({ label: c.label, color: c.color, data: c.data, step: c.step, width: 1.4, fill: c.fill, keepMin: true, gapBelow: -1000 }));
  let lo = 0, hi = 0;
  for (const s of series) for (let i = 0; i < s.data.length; i++) { const v = s.data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  chart(body, { series, yMin: Math.min(-3, Math.floor(lo - 1)), yMax: hi > 0.05 ? Math.ceil(hi + 0.5) : 0.5, yFmt: (v, tip) => (tip ? `${v.toFixed(2)} dB` : `${v}`), baseline: 0 });
  card.append(legend(curves.filter((c) => c.data?.length).map((c) => ({ label: c.label, color: c.color }))));
  return card;
}

export function barChart(title, caption, xs, values, { color = '--accent', unit = 'dB', logX = true } = {}) {
  const { card, body } = chartCard(title, caption, { height: 190 });
  const hi = Math.max(0.1, ...values);
  chart(body, {
    series: [{ label: title, color, xs, data: values, type: 'bars' }],
    xScale: logX ? 'log' : 'linear', xMin: logX ? Math.max(20, xs[0] / 1.2) : xs[0], xMax: logX ? Math.min(20000, xs[xs.length - 1] * 1.2) : xs[xs.length - 1],
    yMin: 0, yMax: hi * 1.15, yFmt: (v, tip) => (tip ? `${v.toFixed(2)} ${unit}` : v.toFixed(hi < 2 ? 1 : 0)),
  });
  return card;
}

export function curveChart(title, caption, xs, values, { color = '--ref' } = {}) {
  const { card, body } = chartCard(title, caption, { height: 190 });
  const lim = Math.max(2, Math.ceil(Math.max(...values.map(Math.abs)) + 1));
  chart(body, { series: [{ label: title, color, xs, data: values, width: 2 }], xScale: 'log', xMin: 20, xMax: 20000, yMin: -lim, yMax: lim, baseline: 0, refLines: [{ y: 0 }], yFmt: (v, tip) => (tip ? `${sx(v, 2)} dB` : sx(v, 0)) });
  return card;
}

export function stageLog(stages) {
  return el('ul', { class: 'log' }, stages.map((s) => el('li', {}, el('b', {}, s.stage), el('span', {}, s.detail))));
}

export function callouts(messages) {
  if (!messages?.length) return null;
  return el('div', {}, messages.map((m) => el('div', { class: 'callout' }, m)));
}

export function section(title, ...content) {
  return el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', {}, title)), ...content);
}

/**
 * items: [{ label, sub, primary, easy, run: async () => {} }]. Primary items
 * (Download all) sit on top; the rest are single files. Items without `easy`
 * show only in Advanced.
 */
export function downloadsRow(items) {
  const button = (it) => {
    const b = el('button', { class: `btn${it.primary ? ' primary' : ''}${it.easy ? ' in-easy' : ''}`, type: 'button' }, it.label, it.sub ? el('small', {}, it.sub) : null);
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      const text = b.firstChild.textContent;
      b.disabled = true;
      b.firstChild.textContent = 'Preparing…';
      try { await it.run(); } catch (err) { console.error(err); toast(`Export failed: ${err.message}`, { error: true }); }
      b.firstChild.textContent = text;
      b.disabled = false;
    });
    return b;
  };
  const main = items.filter((it) => it.primary), rest = items.filter((it) => !it.primary);
  return el('div', { class: 'download-panel' },
    main.length ? el('div', { class: 'downloads main' }, main.map(button)) : null,
    main.length && rest.length ? el('p', { class: 'hint files-label' }, 'Or one file at a time:') : null,
    rest.length ? el('div', { class: 'downloads files' }, rest.map(button)) : null);
}

/** JSON-safe copy: typed arrays become rounded plain arrays; audio buffers are dropped. */
export function toJson(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (k === 'channels' || k === 'chs' || k === 'audio' || k === 'spectrogram') return undefined;
    if (ArrayBuffer.isView(v)) return Array.from(v, (x) => Math.round(x * 1000) / 1000);
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    return v;
  }, 2);
}

export function loudnessCsv(cols) {
  // cols: [{ name, analysis }]
  const hop = cols[0].analysis.loudness.hopSec;
  const n = Math.max(...cols.map((c) => c.analysis.loudness.shortTerm.length));
  const header = ['time_s', ...cols.flatMap((c) => [`${c.name}_momentary_lufs`, `${c.name}_shortterm_lufs`])];
  const lines = [header.join(',')];
  for (let i = 0; i < n; i++) {
    const row = [((i + 1) * hop).toFixed(1)];
    for (const c of cols) {
      const L = c.analysis.loudness;
      row.push(i < L.momentary.length && L.momentary[i] > -100 ? L.momentary[i].toFixed(2) : '', i < L.shortTerm.length && L.shortTerm[i] > -100 ? L.shortTerm[i].toFixed(2) : '');
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

export function spectrumCsv(cols) {
  const centers = cols[0].centers;
  const lines = [['freq_hz', ...cols.map((c) => `${c.name}_db`)].join(',')];
  centers.forEach((f, i) => lines.push([f.toFixed(1), ...cols.map((c) => (c.levels[i] != null ? c.levels[i].toFixed(2) : ''))].join(',')));
  return lines.join('\n');
}

/** Per-band mono fold-down loss. entries: [{ label, color, analysis }] */
export function monoChart(entries) {
  const { card, body } = chartCard('Mono compatibility by band', 'Level change when L and R are summed to mono, per 1/3 octave: 0 dB = identical channels, -3 dB = unrelated, lower = phase cancellation.', { height: 200 });
  const series = entries.filter((e) => e.analysis.stereo.monoLossBands).map((e) => ({ label: e.label, color: e.color, xs: e.analysis.stereo.monoLossBands.centers, data: e.analysis.stereo.monoLossBands.lossDb, width: 1.8, gapBelow: -100 }));
  let lo = -6;
  for (const s of series) for (const v of s.data) if (v < lo) lo = v;
  chart(body, { series, xScale: 'log', xMin: 25, xMax: 20000, yMin: Math.floor(lo - 1), yMax: 1, refLines: [{ y: -3, label: 'unrelated', color: '--faint' }], yFmt: (v, tip) => (tip ? `${sx(v, 1)} dB` : `${v}`) });
  card.append(legend(entries.map((e) => ({ label: e.label, color: e.color }))));
  return card;
}

const RAMP = [[0, [245, 239, 227]], [0.35, [164, 206, 198]], [0.6, [27, 122, 115]], [0.82, [22, 48, 46]], [1, [210, 68, 44]]];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < RAMP.length - 2 && RAMP[j + 1][0] < t) j++;
    const [t0, c0] = RAMP[j], [t1, c1] = RAMP[j + 1];
    const u = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * u;
  }
  return lut;
})();

/** Log-frequency spectrograms, one strip per entry. entries: [{ label, spec }] */
export function spectrogramChart(entries, { title = 'Spectrogram', caption = 'Level over time and frequency (log scale), 96 dB range relative to each file\'s loudest moment.' } = {}) {
  const list = entries.filter((e) => e.spec);
  const strip = 150;
  const { card, body } = chartCard(title, caption, { wide: true, height: strip * list.length + 22 });
  body.classList.add('chart', 'spectro');
  const canvas = document.createElement('canvas');
  const tip = el('div', { class: 'chart-tip', hidden: true });
  body.append(canvas, tip);
  const pad = { l: 46, r: 12, t: 4, b: 22 };
  const images = list.map(({ spec }) => {
    const img = document.createElement('canvas');
    img.width = spec.cols;
    img.height = spec.rows;
    const ctx = img.getContext('2d');
    const id = ctx.createImageData(spec.cols, spec.rows);
    for (let c = 0; c < spec.cols; c++) {
      for (let r = 0; r < spec.rows; r++) {
        const v = spec.data[c * spec.rows + r];
        const o = ((spec.rows - 1 - r) * spec.cols + c) * 4;
        id.data[o] = LUT[v * 3]; id.data[o + 1] = LUT[v * 3 + 1]; id.data[o + 2] = LUT[v * 3 + 2]; id.data[o + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
    return img;
  });
  let geom = null;
  const draw = () => {
    const rect = body.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const pw = rect.width - pad.l - pad.r;
    const sh = (rect.height - pad.t - pad.b) / list.length;
    ctx.font = '11px ui-monospace, Menlo, monospace';
    list.forEach((e, i) => {
      const y0 = pad.t + i * sh;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(images[i], pad.l, y0, pw, sh - 4);
      const { fMin, fMax } = e.spec;
      ctx.fillStyle = cssVar('--faint');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const f of [100, 1000, 10000]) {
        if (f < fMin || f > fMax) continue;
        const py = y0 + (sh - 4) * (1 - Math.log(f / fMin) / Math.log(fMax / fMin));
        ctx.fillText(fmtHz(f), pad.l - 6, py);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(e.label, pad.l + 6, y0 + 4);
    });
    const dur = list[0].spec.cols * list[0].spec.stepSec;
    const span = dur;
    const step = [1, 2, 5, 10, 15, 30, 60, 120].find((c) => span / c <= 8) || 120;
    ctx.fillStyle = cssVar('--faint');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= dur; t += step) ctx.fillText(fmtTime(t), pad.l + (t / dur) * pw, rect.height - pad.b + 5);
    geom = { pw, sh, dur };
  };
  body.addEventListener('mousemove', (ev) => {
    if (!geom) return;
    const rect = body.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top - pad.t;
    const i = Math.floor(my / geom.sh);
    if (mx < pad.l || mx > rect.width - pad.r || i < 0 || i >= list.length) { tip.hidden = true; return; }
    const spec = list[i].spec;
    const fx2 = (mx - pad.l) / geom.pw, fy = 1 - (my - i * geom.sh) / (geom.sh - 4);
    if (fy < 0 || fy > 1) { tip.hidden = true; return; }
    const c = Math.min(spec.cols - 1, Math.floor(fx2 * spec.cols)), r = Math.min(spec.rows - 1, Math.floor(fy * spec.rows));
    const f = spec.fMin * Math.pow(spec.fMax / spec.fMin, (r + 0.5) / spec.rows);
    const db = (spec.data[c * spec.rows + r] / 255) * spec.rangeDb - spec.rangeDb;
    tip.innerHTML = `<b>${list[i].label}</b><br>${fmtTime(c * spec.stepSec)} · ${fmtHz(f)} Hz<br>${db.toFixed(0)} dB re max`;
    tip.hidden = false;
    tip.style.left = `${mx + 14 + tip.offsetWidth > rect.width ? mx - tip.offsetWidth - 10 : mx + 14}px`;
    tip.style.top = `${Math.max(0, ev.clientY - rect.top - 10)}px`;
  });
  body.addEventListener('mouseleave', () => { tip.hidden = true; });
  new ResizeObserver(draw).observe(body);
  draw();
  return card;
}

/** Restoration scan results as a table (analysis with repairScan). */
export function repairTable(a) {
  const r = a.repair;
  if (!r) return null;
  const bw = a.spectrum.bandwidth;
  const rows = [
    ['Mains hum', r.hum.detected, r.hum.detected ? `${r.hum.mains} Hz series` : 'None found',
      r.hum.detected ? `Measured ${r.hum.f0.toFixed(2)} Hz; steady harmonics ${r.hum.harmonics.map((h) => `${h.n}× ${h.prominenceDb.toFixed(0)} dB`).join(', ')}` : 'No steady 50/60 Hz harmonic series in both halves of the track.'],
    ['Clicks', r.clicks.count > 0, r.clicks.count ? `${r.clicks.count} (${r.clicks.perMinute.toFixed(1)}/min)` : 'None found',
      `${r.clicks.count ? `First at ${r.clicks.times.slice(0, 4).map((t) => fmtTime(t)).join(', ')}. ` : ''}Ignored: ${r.clicks.skippedOnsets} onset-like, ${r.clicks.skippedClusters} clustered, ${r.clicks.skippedLong} long events.`],
    ['Clipped peaks', r.clipping.runs > 0, r.clipping.runs ? `${r.clipping.runs} runs` : 'None found',
      r.clipping.runs ? `${r.clipping.samples} samples on flat tops${r.clipping.skippedLongRuns ? `; ${r.clipping.skippedLongRuns} runs too long to rebuild` : ''}.` : 'No runs of 3+ samples at the channel extremes.'],
    ['Stereo delay', r.stereoDelay.detected, r.stereoDelay.detected ? `${Math.abs(r.stereoDelay.lagMs).toFixed(3)} ms (${r.stereoDelay.lagSamples > 0 ? 'R late' : 'L late'})` : 'Aligned',
      `Correlation ${r.stereoDelay.corrAtZero.toFixed(2)} as is${r.stereoDelay.detected ? `, ${r.stereoDelay.corrAtLag.toFixed(2)} aligned` : ''}.`],
    ['Noise floor', r.noise.qualified && r.noise.floorDbfs > -75, r.noise.qualified ? `${r.noise.floorDbfs.toFixed(0)} dBFS` : 'Not measurable', r.noise.reason],
    ['Bandwidth', bw?.limited, bw ? `${(bw.bandwidthHz / 1000).toFixed(1)} kHz` : '–', bw?.limited ? `Content ends below the format's range${bw.brickwall ? `, steep ${bw.dropDb.toFixed(0)} dB wall (typical of lossy encoding)` : ''}.` : 'Full bandwidth.'],
  ];
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data repair' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Check'), el('th', {}, 'Result'), el('th', {}, 'Detail'))),
    el('tbody', {}, rows.map(([k, flag, v, d]) => el('tr', {}, el('td', {}, k), el('td', { class: `num ${flag ? 'flag' : 'ok'}` }, v), el('td', { class: 'wrap' }, d))))));
}
