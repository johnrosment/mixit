// Analyze tab: full measurement report for one file, plus a hand-off to mastering.

import { el, toast, wireDrop, setProgress } from './controls.js';
import { probeFile, workerPayload, download, baseName, describeInfo } from './audio-io.js';
import { kpis, metricsTable, loudnessChart, spectrumChart, correlationChart, section, downloadsRow, toJson, loudnessCsv, spectrumCsv, fx, monoChart, spectrogramChart, repairTable } from './report.js';

const SETTING_LABELS = {
  targetLufs: 'Target loudness (LUFS)', multiband: 'Multiband compression', glue: 'Glue compression', saturation: 'Saturation (dB)',
  resonance: 'Resonance control', tilt: 'Tilt (dB)', deMud: 'Low-mid cleanup', deMudFreq: 'Cleanup frequency (Hz)',
  deess: 'De-esser', monoBass: 'Mono bass below (Hz)', balanceRepair: 'Repair L/R imbalance', air: 'Air (dB)',
};

export function initAnalyze({ engine, sendToMaster }) {
  const $ = (id) => document.getElementById(id);
  const root = $('a-results');
  const progressBox = $('a-progress');
  let busy = false;

  async function run(file) {
    if (busy) return;
    busy = true;
    root.innerHTML = '';
    try {
      setProgress(progressBox, `Reading ${file.name}`, 0);
      const info = await probeFile(file);
      if (!info.valid) throw new Error(info.reason);
      const { payload, transfer } = await workerPayload(file, info);
      const t0 = performance.now();
      const res = await engine.run('analyze', { ...payload, repairScan: true }, transfer, (stage, f) => setProgress(progressBox, stage, f));
      setProgress(progressBox, `Analysed in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 1, 'done');
      render(file, info, res.analysis);
    } catch (err) {
      console.error(err);
      setProgress(progressBox, `Stopped: ${err.message}`, 1, 'failed');
      toast(`Analysis failed: ${err.message}`, { error: true });
    } finally {
      busy = false;
    }
  }

  function render(file, info, a) {
    const base = baseName(file.name);
    root.append(el('div', { class: 'card' },
      el('div', { class: 'result-head' }, el('div', {}, el('div', { class: 'title' }, file.name), el('div', { class: 'sub' }, describeInfo(info)))),
      kpis(null, a)));
    const sug = a.suggestions;
    root.append(section('What the analysis suggests',
      sug.reasons.length ? el('ul', { class: 'reasons' }, sug.reasons.map((r) => el('li', {}, r))) : el('p', { class: 'hint' }, 'Nothing stands out; a balanced master is a good starting point.'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data', style: 'margin-top:10px' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Suggested starting setting'), el('th', {}, 'Value'))),
        el('tbody', {}, Object.entries(sug.settings).map(([k, v]) => el('tr', {}, el('td', {}, SETTING_LABELS[k] || k), el('td', { class: 'num' }, typeof v === 'number' ? fx(v, 2) : String(v))))))),
      el('div', { style: 'margin-top:12px' }, el('button', { class: 'btn primary', onclick: () => sendToMaster(file) }, 'Master this track with Auto →'))));
    const rt = repairTable(a);
    if (rt) root.append(section('Repair check', el('p', { class: 'hint' }, 'Restoration detectors. Each finding names the Repair tool in the Master tab that can address it; nothing is changed here.'), rt));
    const grid = el('div', { class: 'chart-grid' });
    grid.append(loudnessChart([{ label: 'Track', color: '--accent', analysis: a }]));
    if (a.spectrogram) grid.append(spectrogramChart([{ label: 'Track', spec: a.spectrogram }]));
    grid.append(spectrumChart([{ label: 'Track', color: '--accent', centers: a.spectrum.bands.centers, levels: a.spectrum.bands.levels }], { title: 'Spectrum', caption: '1/6-octave long-term average spectrum (band energy, dB).', relative: false }));
    grid.append(correlationChart([{ label: 'Track', color: '--accent', analysis: a }]));
    grid.append(monoChart([{ label: 'Track', color: '--accent', analysis: a }]));
    if (a.repair?.noise?.qualified) {
      const n = a.repair.noise;
      grid.append(spectrumChart([{ label: 'Noise floor', color: '--warn', centers: n.centers, levels: n.floorDb }], { title: 'Noise floor', caption: 'Average level per 1/6-octave band during the quietest passages (per-bin power, dB).', relative: false }));
    }
    root.append(grid);
    root.append(section('Download', downloadsRow([
      { label: 'Report (JSON)', sub: 'every measurement', primary: true, run: async () => download(toJson({ file: file.name, ...a }), `${base}_analysis.json`, 'application/json') },
      { label: 'Loudness timeline (CSV)', sub: '100 ms resolution', run: async () => download(loudnessCsv([{ name: 'track', analysis: a }]), `${base}_loudness.csv`, 'text/csv') },
      { label: 'Spectrum (CSV)', sub: '1/6 octave', run: async () => download(spectrumCsv([{ name: 'track', centers: a.spectrum.bands.centers, levels: a.spectrum.bands.levels }]), `${base}_spectrum.csv`, 'text/csv') },
    ])));
    root.append(section('Measurements', metricsTable([{ label: 'Track', analysis: a }])));
  }

  wireDrop($('a-drop'), $('a-file'), (files) => run(files[0]));
  return { run };
}
