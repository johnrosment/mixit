// Master QC report (self-contained HTML) and release manifests with SHA-256
// hashes of every delivered file.

import { METRICS, fx, sx } from './report.js';

export async function sha256Hex(data) {
  const buf = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} kB`);

function metricRows(before, after) {
  return METRICS.map(([label, get, unit, d]) => {
    if (!get) return `<tr class="g"><td colspan="5">${esc(label)}</td></tr>`;
    const v = [before, after].map((a) => { try { return get(a); } catch { return NaN; } });
    const cell = (x) => (Array.isArray(x) ? x.map((y) => fx(y, d)).join(' / ') : fx(x, d));
    const delta = !Array.isArray(v[0]) && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? sx(v[1] - v[0], d) : '';
    return `<tr><td>${esc(label)}</td><td>${cell(v[0])}</td><td>${cell(v[1])}</td><td>${delta}</td><td class="u">${esc(unit)}</td></tr>`;
  }).join('');
}

function checks(rep) {
  const o = rep.output, s = rep.settings;
  const list = [
    ['Loudness within ±0.5 LU of target', Math.abs(o.loudness.integrated - s.targetLufs) <= 0.5, `${fx(o.loudness.integrated, 2)} LUFS vs ${s.targetLufs}`],
    ['True peak at or below ceiling', o.peak.truePeakDbtp <= s.ceiling + 0.05, `${fx(o.peak.truePeakDbtp, 2)} dBTP vs ${s.ceiling}`],
    ['No clipped samples in the master', o.level.clippedSamples === 0, `${o.level.clippedSamples} samples`],
    ['Low end mono compatible (corr > 0.5 below 150 Hz)', o.stereo.lowCorrelation > 0.5, fx(o.stereo.lowCorrelation, 2)],
    ['Mono fold-down loses less than 3 LU', o.stereo.monoLossLu < 3, `${fx(o.stereo.monoLossLu, 2)} LU`],
    ['DC offset under 0.1%', o.level.dcOffsetPct.every((d) => Math.abs(d) < 0.1), o.level.dcOffsetPct.map((d) => fx(d, 4)).join(' / ') + ' %'],
  ];
  return list.map(([k, ok, v]) => `<tr><td>${esc(k)}</td><td class="${ok ? 'pass' : 'fail'}">${ok ? 'Pass' : 'Check'}</td><td>${esc(v)}</td></tr>`).join('');
}

/**
 * files: [{ name, size, sha256, kind, lufs?, dbtp?, format? }]
 */
export function qcHtml({ title, source, profile, rep, files, renderedSeconds, deliveredSec = rep.output.durationSec }) {
  const settingRows = Object.entries(rep.settings).filter(([k]) => !['locked', 'auto'].includes(k))
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'number' ? +v.toFixed(3) : v)}</td></tr>`).join('');
  const stageRows = rep.stages.map((st) => `<li><b>${esc(st.stage)}</b> ${esc(st.detail)}</li>`).join('');
  const fileRows = files.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.kind || '')}</td><td>${f.lufs != null ? `${fx(f.lufs, 2)} LUFS` : ''}</td><td>${f.dbtp != null ? `${fx(f.dbtp, 2)} dBTP` : ''}</td><td>${bytes(f.size)}</td><td class="h">${esc(f.sha256)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QC report: ${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#141a22;--mut:#5b6676;--line:#e1e6ed;--ok:#15803d;--bad:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0d1014;--fg:#e7ebf1;--mut:#8d98a9;--line:#262e3a;--ok:#4ade80;--bad:#fbbf24}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;max-width:980px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:28px 0 8px}.sub{color:var(--mut)}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
td:not(:first-child){font-family:ui-monospace,Menlo,monospace}tr.g td{color:var(--mut);text-transform:uppercase;font-size:11px;letter-spacing:.06em;padding-top:14px}
.u{color:var(--mut)}.pass{color:var(--ok);font-weight:600}.fail{color:var(--bad);font-weight:600}.h{word-break:break-all;font-size:11.5px}
ul{padding-left:18px}li{margin:4px 0}.wrap{overflow-x:auto}.warn{border-left:3px solid var(--bad);padding:6px 10px;margin:6px 0}
</style></head><body>
<h1>QC report: ${esc(title)}</h1>
<p class="sub">Source ${esc(source)} · ${esc(profile)} profile · ${(rep.output.sampleRate / 1000).toFixed(1)} kHz · ${fx(deliveredSec, 1)} s delivered${Math.abs(deliveredSec - rep.output.durationSec) > 0.01 ? ` (${fx(rep.output.durationSec, 1)} s before trim)` : ''} · rendered in ${fx(renderedSeconds, 1)} s · ${esc(new Date().toISOString())} · MIXIT (runs locally in the browser)</p>
${rep.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
<h2>Delivery checks</h2><div class="wrap"><table><tbody>${checks(rep)}</tbody></table></div>
<h2>Files</h2><div class="wrap"><table><thead><tr><th>File</th><th>Type</th><th>Loudness</th><th>True peak</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>${fileRows}</tbody></table></div>
<h2>Before / after</h2><div class="wrap"><table><thead><tr><th>Measurement</th><th>Original</th><th>Master</th><th>Change</th><th></th></tr></thead><tbody>${metricRows(rep.input, rep.output)}</tbody></table></div>
<h2>Processing chain</h2><ul>${stageRows}</ul>
<h2>Settings</h2><div class="wrap"><table><tbody>${settingRows}</tbody></table></div>
</body></html>`;
}

export function manifest({ title, artist, files, rep, deliveredSec = rep.output.durationSec }) {
  const json = {
    title, artist,
    created: new Date().toISOString(),
    generator: 'MIXIT',
    master: { lufs: rep.output.loudness.integrated, truePeakDbtp: rep.output.peak.truePeakDbtp, lra: rep.output.loudness.lra, durationSec: deliveredSec, renderedDurationSec: rep.output.durationSec, sampleRate: rep.output.sampleRate },
    files: files.map(({ name, size, sha256, kind, lufs, dbtp, format }) => ({ name, kind, format, size, sha256, lufs, truePeakDbtp: dbtp })),
  };
  const text = [
    `${title}${artist ? ` - ${artist}` : ''}`,
    `Created ${json.created} with MIXIT`,
    `Master: ${fx(json.master.lufs, 2)} LUFS integrated, ${fx(json.master.truePeakDbtp, 2)} dBTP, LRA ${fx(json.master.lra, 1)} LU, ${fx(json.master.durationSec, 2)} s at ${json.master.sampleRate} Hz`,
    '',
    ...files.map((f) => `${f.name}\n  ${f.kind || ''}${f.lufs != null ? ` · ${fx(f.lufs, 2)} LUFS · ${fx(f.dbtp, 2)} dBTP` : ''} · ${f.size} bytes\n  SHA-256 ${f.sha256}`),
  ].join('\n');
  return { json: JSON.stringify(json, null, 2), text };
}
