// 2x up/down conversion for oversampled processing: a linear-phase half-band
// FIR (Kaiser window, ~100 dB stop band) applied in polyphase form. Passband
// to 0.454 of the base rate (20 kHz at 44.1 kHz, 21.8 kHz at 48 kHz).

const M = 36; // non-zero taps on each side of the centre
const BETA = 10.06;

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

// Odd taps h[2j+1], j = 0..M-1 (the filter is symmetric; h[0] = 0.5 and the
// other even taps are zero). Normalised so the DC gain is exactly 1.
const ODD = (() => {
  const half = 2 * M;
  const h = new Float64Array(M);
  let sum = 0;
  for (let j = 0; j < M; j++) {
    const k = 2 * j + 1;
    const w = besselI0(BETA * Math.sqrt(1 - (k / half) ** 2)) / besselI0(BETA);
    h[j] = (Math.sin((Math.PI * k) / 2) / (Math.PI * k)) * w;
    sum += 2 * h[j];
  }
  for (let j = 0; j < M; j++) h[j] *= 0.5 / sum;
  return h;
})();

function padded(x, p) {
  const out = new Float32Array(x.length + 2 * p);
  out.set(x, p);
  return out;
}

/** Doubles the sample rate (zero-phase, so no delay is added). */
export function upsample2(x) {
  const n = x.length;
  const xp = padded(x, M + 1);
  const y = new Float32Array(2 * n);
  const o = M + 1;
  for (let i = 0; i < n; i++) {
    y[2 * i] = x[i];
    let acc = 0;
    const c = i + o;
    for (let j = 0; j < M; j++) acc += ODD[j] * (xp[c - j] + xp[c + 1 + j]);
    y[2 * i + 1] = 2 * acc;
  }
  return y;
}

/** Halves the sample rate after the anti-alias filter; output length is ceil(n / 2). */
export function downsample2(u) {
  const n = Math.ceil(u.length / 2);
  const up = padded(u, 2 * M + 1);
  const o = 2 * M + 1;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = 2 * i + o;
    let acc = 0.5 * up[c];
    for (let j = 0; j < M; j++) acc += ODD[j] * (up[c - 2 * j - 1] + up[c + 2 * j + 1]);
    y[i] = acc;
  }
  return y;
}

export const HALF_BAND = { taps: 4 * M - 1, passband: 0.454 };
