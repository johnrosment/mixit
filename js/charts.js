// Small canvas chart helper: time or log-frequency x axis, line/area/bar
// series, reference lines, hover read-out, and theme-aware colours.

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (c) => (c && c.startsWith('--') ? cssVar(c) : c);

function niceStep(range, target = 5) {
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

export function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function fmtHz(f) {
  return f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`;
}

function pointX(s, i) {
  return s.xs ? s.xs[i] : (s.x0 || 0) + i * s.step;
}

export function chart(container, opts) {
  container.classList.add('chart');
  if (opts.height) container.style.height = `${opts.height}px`;
  const canvas = document.createElement('canvas');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.append(canvas, tip);
  const pad = { l: 46, r: 12, t: 10, b: 24 };
  let geom = null;

  const extent = () => {
    let xMin = opts.xMin, xMax = opts.xMax;
    if (xMin == null || xMax == null) {
      let lo = Infinity, hi = -Infinity;
      for (const s of opts.series) {
        if (!s.data?.length) continue;
        lo = Math.min(lo, pointX(s, 0));
        hi = Math.max(hi, pointX(s, s.data.length - 1));
      }
      xMin = xMin ?? (Number.isFinite(lo) ? lo : 0);
      xMax = xMax ?? (Number.isFinite(hi) ? hi : 1);
    }
    if (xMax <= xMin) xMax = xMin + 1;
    return { xMin, xMax };
  };

  const draw = () => {
    const rect = container.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width, H = rect.height;
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const { xMin, xMax } = extent();
    const { yMin, yMax } = opts;
    const log = opts.xScale === 'log';
    const X = (x) => pad.l + (log ? (Math.log(x) - Math.log(xMin)) / (Math.log(xMax) - Math.log(xMin)) : (x - xMin) / (xMax - xMin)) * pw;
    const Y = (y) => pad.t + (1 - (Math.max(yMin, Math.min(yMax, y)) - yMin) / (yMax - yMin)) * ph;
    geom = { X, Y, xMin, xMax, log, pw };
    ctx.clearRect(0, 0, W, H);
    const grid = color('--line');
    const label = color('--faint');
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.lineWidth = 1;
    // Y grid
    const yStep = opts.yStep || niceStep(yMax - yMin, 5);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax + 1e-9; y += yStep) {
      const py = Math.round(Y(y)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(W - pad.r, py); ctx.stroke();
      ctx.fillStyle = label;
      ctx.fillText(opts.yFmt ? opts.yFmt(y) : `${+y.toFixed(2)}`, pad.l - 6, py);
    }
    // X grid
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = [];
    if (log) {
      for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) if (f >= xMin && f <= xMax) xTicks.push(f);
    } else {
      const span = xMax - xMin;
      const cands = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
      const step = opts.xStep || cands.find((c) => span / c <= 8) || 600;
      for (let t = Math.ceil(xMin / step) * step; t <= xMax + 1e-9; t += step) xTicks.push(t);
    }
    for (const t of xTicks) {
      const px = Math.round(X(t)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, H - pad.b); ctx.stroke();
      ctx.fillStyle = label;
      ctx.fillText(log ? fmtHz(t) : opts.xFmt ? opts.xFmt(t) : fmtTime(t), px, H - pad.b + 5);
    }
    // Reference lines
    for (const r of opts.refLines || []) {
      const py = Math.round(Y(r.y)) + 0.5;
      ctx.strokeStyle = color(r.color || '--muted');
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(W - pad.r, py); ctx.stroke();
      ctx.setLineDash([]);
      if (r.label) {
        ctx.fillStyle = color(r.color || '--muted');
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(r.label, W - pad.r - 4, py - 2);
      }
    }
    // Series
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph);
    ctx.clip();
    const baseline = opts.baseline ?? (yMin < 0 && yMax > 0 ? 0 : yMin);
    for (const s of opts.series) {
      const d = s.data;
      if (!d?.length) continue;
      const c = color(s.color);
      if (s.type === 'bars') {
        ctx.fillStyle = c;
        ctx.globalAlpha = s.alpha ?? 0.85;
        for (let i = 0; i < d.length; i++) {
          const x = pointX(s, i);
          const next = i + 1 < d.length ? pointX(s, i + 1) : x * (log ? 1.12 : 1) + (log ? 0 : s.step || 1);
          const x0 = X(x), x1 = X(next);
          const w = Math.max(1, (x1 - x0) * 0.78);
          const y0 = Y(baseline), y1 = Y(d[i]);
          ctx.fillRect(x0 - w / 2, Math.min(y0, y1), w, Math.abs(y1 - y0));
        }
        ctx.globalAlpha = 1;
        continue;
      }
      const gap = s.gapBelow ?? -100;
      const stepPx = d.length > 2 * pw ? Math.ceil(d.length / (2 * pw)) : 1;
      const path = () => {
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < d.length; i += stepPx) {
          let v = d[i];
          if (stepPx > 1) {
            // keep the extreme value of each decimation bucket
            for (let k = 1; k < stepPx && i + k < d.length; k++) {
              if (s.keepMin ? d[i + k] < v : d[i + k] > v) v = d[i + k];
            }
          }
          if (v <= gap || !Number.isFinite(v)) { pen = false; continue; }
          const px = X(pointX(s, i)), py = Y(v);
          if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
        }
      };
      if (s.fill) {
        ctx.globalAlpha = s.fillAlpha ?? 0.18;
        ctx.fillStyle = c;
        path();
        ctx.lineTo(X(pointX(s, d.length - 1)), Y(baseline));
        ctx.lineTo(X(pointX(s, 0)), Y(baseline));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = c;
      ctx.lineWidth = s.width ?? 1.6;
      ctx.globalAlpha = s.alpha ?? 1;
      if (s.dash) ctx.setLineDash(s.dash);
      path();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  };

  const onMove = (ev) => {
    if (!geom) return;
    const rect = container.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    if (mx < pad.l || mx > rect.width - pad.r) { tip.hidden = true; return; }
    const frac = (mx - pad.l) / geom.pw;
    const x = geom.log ? Math.exp(Math.log(geom.xMin) + frac * (Math.log(geom.xMax) - Math.log(geom.xMin))) : geom.xMin + frac * (geom.xMax - geom.xMin);
    const lines = [geom.log ? `${fmtHz(x)} Hz` : opts.xFmt ? opts.xFmt(x) : fmtTime(x)];
    for (const s of opts.series) {
      if (!s.data?.length || s.noTip) continue;
      let idx;
      if (s.xs) {
        idx = 0;
        let best = Infinity;
        for (let i = 0; i < s.xs.length; i++) {
          const dd = Math.abs((geom.log ? Math.log(s.xs[i]) - Math.log(x) : s.xs[i] - x));
          if (dd < best) { best = dd; idx = i; }
        }
      } else idx = Math.round((x - (s.x0 || 0)) / s.step);
      if (idx < 0 || idx >= s.data.length) continue;
      const v = s.data[idx];
      if (!Number.isFinite(v) || v <= (s.gapBelow ?? -100)) continue;
      lines.push(`${s.label}: ${opts.yFmt ? opts.yFmt(v, true) : v.toFixed(1)}`);
    }
    tip.innerHTML = lines.map((l, i) => (i ? l : `<b>${l}</b>`)).join('<br>');
    tip.hidden = false;
    const tx = mx + 14 + tip.offsetWidth > rect.width ? mx - tip.offsetWidth - 10 : mx + 14;
    tip.style.left = `${tx}px`;
    tip.style.top = `${Math.max(0, ev.clientY - rect.top - 10)}px`;
  };
  container.addEventListener('mousemove', onMove);
  container.addEventListener('mouseleave', () => { tip.hidden = true; });
  new ResizeObserver(draw).observe(container);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', draw);
  draw();
  return { redraw: draw };
}

export function legend(items) {
  const box = document.createElement('div');
  box.className = 'legend';
  for (const it of items) {
    const span = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = color(it.color);
    if (it.dash) sw.style.background = `repeating-linear-gradient(90deg, ${color(it.color)} 0 4px, transparent 4px 7px)`;
    span.append(sw, it.label);
    box.append(span);
  }
  return box;
}
