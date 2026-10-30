// Home page graphic: seven seismograph traces scrolling right to left, with a
// pen dot at the end of each. Between quakes the pens only tremble; a quake
// starts with a small fast shake (P wave), then a larger, slower swing (S
// wave), and reaches each trace a little after its neighbour, so it ripples
// across the stack. Each trace hides the ones behind it, ridgeline style, and
// a red disc sits over them in multiply. With reduced motion a still frame is
// drawn. The animation only runs while the graphic is on screen.

const NS = 'http://www.w3.org/2000/svg';
const LINES = 7, TOP = 82, GAP = 38, X0 = 24, X1 = 352, STEP = 3;
const N = Math.round((X1 - X0) / STEP) + 1;
const ACCENT = 3;            // the teal trace
const FPS = 30;              // samples added per second (one per frame)
const LINE_DELAY = 7;        // samples between neighbouring traces for a quake
const QUAKE_LEN = 140;       // samples a quake lasts on one trace

export function drawRidges(svg) {
  const node = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  svg.innerHTML = '';
  const lines = Array.from({ length: LINES }, (_, k) => {
    const base = TOP + k * GAP;
    const mask = node('path', { class: 'mask' });
    const trace = node('path', { class: `trace${k === ACCENT ? ' accent' : ''}` });
    const pen = node('circle', { class: `pen${k === ACCENT ? ' accent' : ''}`, r: 3.6, cx: X1 });
    svg.append(mask, trace, pen);
    return { base, mask, trace, pen, buf: new Float32Array(N), noise: 0 };
  });
  svg.append(node('circle', { class: 'sun', cx: 268, cy: 104, r: 62 }));

  const quakes = [];
  let t = 0, nextQuake = 0;
  const schedule = (at) => {
    quakes.push({ start: at, size: 20 + Math.random() * 38, first: Math.floor(Math.random() * LINES), period: 3.2 + Math.random() * 2, lag: 9 + Math.random() * 8 });
    nextQuake = at + Math.round(FPS * (2.2 + Math.random() * 3.2));
  };
  const quakeAt = (q, k, now) => {
    const far = Math.abs(k - q.first);
    const s = now - q.start - far * LINE_DELAY;
    if (s < 0 || s > QUAKE_LEN) return 0;
    const p = 0.22 * q.size * Math.exp(-s / 6) * Math.sin(s * 2.4);
    const ss = s - q.lag;
    const sw = ss > 0 ? q.size * Math.min(1, ss / 3) * Math.exp(-ss / 16) * Math.sin((2 * Math.PI * ss) / q.period) : 0;
    // Weaker further from where it started; swings both ways, the upward side a little taller.
    const v = (p + sw) * (0.55 + 0.45 * Math.exp(-far / 3));
    return v > 0 ? v : v * 0.55;
  };
  const step = () => {
    if (t >= nextQuake) schedule(t);
    while (quakes.length && t - quakes[0].start > QUAKE_LEN + LINES * LINE_DELAY) quakes.shift();
    lines.forEach((line, k) => {
      line.noise = 0.82 * line.noise + 0.36 * (Math.random() - 0.5);
      let v = line.noise * 1.6 + Math.sin(t / 9 + k) * 0.4;
      for (const q of quakes) v += quakeAt(q, k, t);
      line.buf.copyWithin(0, 1);
      line.buf[N - 1] = v;
    });
    t++;
  };
  const draw = () => {
    for (const line of lines) {
      const pts = [];
      for (let i = 0; i < N; i++) pts.push(`${X0 + i * STEP},${(line.base - line.buf[i]).toFixed(1)}`);
      const d = pts.join('L');
      line.trace.setAttribute('d', `M${d}`);
      line.mask.setAttribute('d', `M${X0},${line.base + 18}L${d}L${X1},${line.base + 18}Z`);
      line.pen.setAttribute('cy', (line.base - line.buf[N - 1]).toFixed(1));
    }
  };

  // Fill the paper with a few seconds of history so it never starts flat.
  schedule(-40);
  for (let i = 0; i < N; i++) step();
  draw();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let last = 0;
  const loop = (now) => {
    // Skip work while the Home page or the browser tab is hidden.
    if (document.hidden || svg.closest('[hidden]')) { setTimeout(() => requestAnimationFrame(loop), 400); return; }
    if (now - last >= 1000 / FPS) { last = now; step(); draw(); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
