// Entry point: tabs, the Easy / Advanced switch, shared engine, and wiring
// between workspaces.

import { Engine } from './engine-client.js';
import { initMaster } from './master-ui.js';
import { initMix } from './mix-ui.js';
import { initAnalyze } from './analyze-ui.js';
import { GUIDE_HTML } from './guide.js';
import { drawRidges } from './home-art.js';
import { storage, store, toast } from './controls.js';

const engine = new Engine();
const TABS = ['home', 'mix', 'master', 'analyze', 'guide'];
const modeButtons = [...document.querySelectorAll('.mode-switch button')];

function openTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    document.getElementById(`tab-${b.dataset.tab}`).hidden = !on;
  }
  store('mixit.tab', name);
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0 });
}

const tabs = [...document.querySelectorAll('.tabs button')];
tabs.forEach((b, i) => {
  b.addEventListener('click', () => openTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    openTab(next.dataset.tab);
  });
});
for (const b of document.querySelectorAll('[data-go]')) {
  b.addEventListener('click', (e) => { e.preventDefault(); openTab(b.dataset.go); });
}

// ---- Easy / Advanced (one switch on each of the Mix and Master pages, kept in step) ----
const modeListeners = [];
function setMode(mode) {
  document.documentElement.dataset.mode = mode;
  for (const b of modeButtons) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  store('mixit.mode', mode);
  modeListeners.forEach((fn) => fn(mode));
}
const onMode = (fn) => { modeListeners.push(fn); fn(document.documentElement.dataset.mode); };
for (const b of modeButtons) b.addEventListener('click', () => setMode(b.dataset.mode));
document.documentElement.dataset.mode = storage('mixit.mode', 'easy') === 'advanced' ? 'advanced' : 'easy';
setMode(document.documentElement.dataset.mode);

document.getElementById('guide').innerHTML = GUIDE_HTML;
drawRidges(document.getElementById('hero-art'));

const master = initMaster({ engine, onMode });
const sendToMaster = (file) => {
  master.addFiles([file], { profile: 'auto' });
  openTab('master');
  toast(`${file.name} added to Master`);
};
initMix({ engine, sendToMaster, onMode });
initAnalyze({ engine, sendToMaster });

const initial = location.hash.slice(1) || storage('mixit.tab', 'home');
openTab(TABS.includes(initial) ? initial : 'home');
// Links, back and forward change the hash; follow them.
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t)) openTab(t); });

// Space toggles the visible player when focus is not in a form field.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.target.closest('input, select, textarea, button, [contenteditable]')) return;
  const panel = document.querySelector('.tab:not([hidden])');
  const play = [...(panel?.querySelectorAll('.player .play') || [])].find((p) => p.offsetParent);
  if (play) { e.preventDefault(); play.click(); }
});

document.documentElement.dataset.ready = '1';
