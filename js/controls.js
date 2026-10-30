// Schema-driven control panels (sliders, selects, switches, text fields).

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

let uid = 0;

export function formatValue(item, v) {
  if (item.format) return item.format(v);
  if (item.zeroLabel != null && Number(v) === 0) return item.zeroLabel;
  if (item.type === 'range') {
    const decimals = item.decimals ?? Math.max(0, -Math.floor(Math.log10(item.step || 1)));
    const num = Number(v);
    const s = num.toFixed(decimals);
    return `${item.signed && num > 0 ? '+' : ''}${s}${item.unit || ''}`;
  }
  return String(v);
}

function rangeControl(item, values, defaults, onChange) {
  const id = `ctl-${++uid}`;
  const input = el('input', { type: 'range', id, min: item.min, max: item.max, step: item.step || 0.01 });
  input.value = values[item.key];
  const out = el('output', { class: 'val', for: id, title: 'Double-click to reset' });
  const root = el('div', { class: 'ctl' }, el('label', { for: id }, item.label), out, input, item.help ? el('p', { class: 'help' }, item.help) : null);
  const show = () => {
    out.textContent = formatValue(item, values[item.key]);
    out.classList.toggle('changed', defaults && defaults[item.key] !== undefined && Number(values[item.key]) !== Number(defaults[item.key]));
  };
  input.addEventListener('input', () => { values[item.key] = Number(input.value); show(); onChange(item.key, values[item.key]); });
  out.addEventListener('dblclick', () => {
    if (!defaults || defaults[item.key] === undefined) return;
    values[item.key] = defaults[item.key];
    input.value = values[item.key];
    show();
    onChange(item.key, values[item.key]);
  });
  show();
  return { el: root, set: (v) => { input.value = v; show(); }, input };
}

function selectControl(item, values, defaults, onChange) {
  const id = `ctl-${++uid}`;
  const select = el('select', { id }, item.options.map((o) => el('option', { value: o.value }, o.label)));
  select.value = String(values[item.key]);
  const root = el('div', { class: 'ctl' }, el('label', { for: id }, item.label), select, item.help ? el('p', { class: 'help' }, item.help) : null);
  select.addEventListener('change', () => {
    values[item.key] = item.numeric ? Number(select.value) : select.value;
    onChange(item.key, values[item.key]);
  });
  return { el: root, set: (v) => { select.value = String(v); }, input: select };
}

function toggleControl(item, values, defaults, onChange) {
  const id = `ctl-${++uid}`;
  const input = el('input', { type: 'checkbox', id, role: 'switch' });
  input.checked = !!values[item.key];
  const root = el('div', { class: 'ctl' }, el('label', { for: id }, item.label), el('span', { class: 'switch' }, input, el('span')), item.help ? el('p', { class: 'help' }, item.help) : null);
  input.addEventListener('change', () => { values[item.key] = input.checked; onChange(item.key, values[item.key]); });
  return { el: root, set: (v) => { input.checked = !!v; }, input };
}

function textControl(item, values, defaults, onChange) {
  const id = `ctl-${++uid}`;
  const input = el('input', { type: 'text', id, maxlength: item.maxlength || 80, placeholder: item.placeholder || '' });
  input.value = values[item.key] || '';
  const root = el('div', { class: 'ctl' }, el('label', { for: id }, item.label), input);
  input.addEventListener('input', () => { values[item.key] = input.value; onChange(item.key, values[item.key]); });
  return { el: root, set: (v) => { input.value = v || ''; }, input };
}

const BUILDERS = { range: rangeControl, select: selectControl, toggle: toggleControl, text: textControl };

/**
 * Render collapsible sections. Returns { update(values), setDisabled(key, bool) }.
 * `values` is mutated in place as the user edits.
 */
export function buildSections(root, schema, values, defaults, onChange) {
  root.innerHTML = '';
  const refs = {};
  for (const sec of schema) {
    const grid = el('div', { class: 'ctl-grid' });
    for (const item of sec.items) {
      const ref = BUILDERS[item.type](item, values, defaults, onChange);
      refs[item.key] = ref;
      grid.append(ref.el);
    }
    root.append(el('details', { class: 'ctl-section', open: !!sec.open }, el('summary', {}, sec.title), grid));
  }
  return {
    update(vals) { for (const [k, r] of Object.entries(refs)) if (vals[k] !== undefined) r.set(vals[k]); },
    setDisabled(key, disabled) {
      const r = refs[key];
      if (!r) return;
      r.input.disabled = disabled;
      r.el.classList.toggle('disabled', disabled);
    },
  };
}

/**
 * Easy-mode sliders: a big labelled slider with words at both ends and a
 * plain value. items: [{ key, label, help, min, max, step, ends: [lo, hi], show(v) }].
 */
export function buildEasy(root, items, values, onChange) {
  root.innerHTML = '';
  const refs = {};
  for (const item of items) {
    const id = `ctl-${++uid}`;
    const input = el('input', { type: 'range', id, min: item.min, max: item.max, step: item.step || 0.05 });
    input.value = values[item.key];
    const out = el('output', { for: id, title: 'Double-click to reset' });
    const show = () => { out.textContent = item.show(values[item.key]); };
    input.addEventListener('input', () => { values[item.key] = Number(input.value); show(); onChange(item.key, values[item.key]); });
    out.addEventListener('dblclick', () => { values[item.key] = item.def; input.value = item.def; show(); onChange(item.key, item.def); });
    show();
    root.append(el('div', { class: 'easy-ctl' }, el('label', { for: id }, item.label), out, el('p', { class: 'help' }, item.help), input,
      el('div', { class: 'ends', 'aria-hidden': 'true' }, el('span', {}, item.ends[0]), el('span', {}, item.ends[1]))));
    refs[item.key] = { input, show };
  }
  return { update(vals) { for (const [k, r] of Object.entries(refs)) if (vals[k] !== undefined) { r.input.value = vals[k]; r.show(); } } };
}

/** Plain words for an Easy slider value. Centred sliders (min < 0) read "Neutral" in the middle. */
export function easyWords(v, { centre = 0, lo = 'Less', hi = 'More', off = 'Off' } = {}) {
  const d = v - centre;
  if (Math.abs(d) < 0.025) return centre === 0 && off ? off : 'Neutral';
  const span = centre === 0 ? 1 : 0.5;
  return `${d > 0 ? hi : lo} ${Math.round((Math.abs(d) / span) * 100)}%`;
}

export function chipGroup(root, options, current, onSelect) {
  root.innerHTML = '';
  const chips = options.map(([key, label]) => {
    const b = el('button', { class: 'chip', role: 'radio', 'aria-checked': String(key === current), type: 'button' }, label);
    b.addEventListener('click', () => {
      chips.forEach((c) => c.setAttribute('aria-checked', String(c === b)));
      onSelect(key);
    });
    root.append(b);
    return b;
  });
  return {
    set(key) { chips.forEach((c, i) => c.setAttribute('aria-checked', String(options[i][0] === key))); },
  };
}

let toastTimer = null;
export function toast(msg, { error = false, ms = 3200 } = {}) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function wireDrop(zone, input, onFiles) {
  zone.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^audio\//.test(f.type) || /\.(wav|wave|aif|aiff|aifc|flac|mp3|m4a|aac|ogg|oga|opus|caf)$/i.test(f.name));
    if (files.length) onFiles(files);
    else toast('Those files do not look like audio.', { error: true });
  });
}

export function setProgress(box, stage, fraction, state = '') {
  box.hidden = false;
  box.classList.toggle('done', state === 'done');
  box.classList.toggle('failed', state === 'failed');
  box.querySelector('.bar i').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  box.querySelector('.stage').textContent = stage;
}

// Saved presets, snapshots and sound profiles from earlier versions (older key
// names). The working state is not carried over, so new defaults apply.
const OLD_PREFIX = ['mixdown', 'lab.'].join('-');
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(OLD_PREFIX)) continue;
    const nk = `mixit.${k.slice(OLD_PREFIX.length)}`;
    if (/(presets|snapshots|profiles)\.v1$/.test(k) && localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch { /* storage unavailable */ }

export function storage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
