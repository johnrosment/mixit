// Biquad design (RBJ audio-EQ cookbook), processing, and Linkwitz-Riley crossovers.

export function design(type, freq, sr, q = Math.SQRT1_2, gainDb = 0) {
  const f = Math.min(Math.max(freq, 1), sr * 0.49);
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f) / sr;
  const cs = Math.cos(w);
  const sn = Math.sin(w);
  const alpha = sn / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2;
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2;
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cs + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cs);
      b2 = A * ((A + 1) - (A - 1) * cs - s);
      a0 = (A + 1) + (A - 1) * cs + s;
      a1 = -2 * ((A - 1) + (A + 1) * cs);
      a2 = (A + 1) + (A - 1) * cs - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cs + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cs);
      b2 = A * ((A + 1) + (A - 1) * cs - s);
      a0 = (A + 1) - (A - 1) * cs + s;
      a1 = 2 * ((A - 1) - (A + 1) * cs);
      a2 = (A + 1) - (A - 1) * cs - s;
      break;
    }
    default:
      throw new Error(`Unknown filter type ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Values this small are flushed to zero: decaying filter tails would otherwise
// become subnormal numbers, which are ~10x slower on x86 CPUs.
export const TINY = 1e-25;

// Transposed direct form II. `output` may be the same array as `input`.
export function biquad(c, input, output = input) {
  const { b0, b1, b2, a1, a2 } = c;
  let z1 = 0, z2 = 0;
  const n = input.length;
  for (let i = 0; i < n; i++) {
    const x = input[i];
    let y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    if (y < TINY && y > -TINY) {
      y = 0;
      if (z1 < TINY && z1 > -TINY) z1 = 0;
      if (z2 < TINY && z2 > -TINY) z2 = 0;
    }
    output[i] = y;
  }
  return output;
}

export function cascade(coeffs, input, output = input) {
  if (!coeffs.length) {
    if (output !== input) output.set(input);
    return output;
  }
  let src = input;
  for (const c of coeffs) { biquad(c, src, output); src = output; }
  return output;
}

export function applyAll(coeffs, chs) {
  for (const ch of chs) cascade(coeffs, ch, ch);
  return chs;
}

// 4th-order Linkwitz-Riley = two cascaded 2nd-order Butterworth sections.
export function lr4(type, freq, sr) {
  const c = design(type, freq, sr, Math.SQRT1_2);
  return [c, c];
}

export function lr4Split2(x, freq, sr) {
  const low = cascade(lr4('lowpass', freq, sr), x, new Float32Array(x.length));
  const high = cascade(lr4('highpass', freq, sr), x, new Float32Array(x.length));
  return [low, high];
}

// Three phase-coherent bands. The low band is passed through the f2 all-pass so
// low + mid + high has a flat magnitude response.
export function lr4Split3(x, f1, f2, sr) {
  const n = x.length;
  const low = cascade(lr4('lowpass', f1, sr), x, new Float32Array(n));
  const rest = cascade(lr4('highpass', f1, sr), x, new Float32Array(n));
  const lowLp = cascade(lr4('lowpass', f2, sr), low, new Float32Array(n));
  cascade(lr4('highpass', f2, sr), low, low);
  for (let i = 0; i < n; i++) low[i] += lowLp[i];
  const mid = cascade(lr4('lowpass', f2, sr), rest, new Float32Array(n));
  cascade(lr4('highpass', f2, sr), rest, rest);
  return [low, mid, rest];
}

export function dcBlock(chs, sr, freq = 5) {
  const c = design('highpass', freq, sr, Math.SQRT1_2);
  for (const ch of chs) biquad(c, ch, ch);
  return chs;
}

// Zero-phase low-pass: a Butterworth biquad run forwards then backwards
// (-6 dB at `freq`, 24 dB/oct). x - result is the exact complementary high band.
export function zeroPhaseLowpass(x, freq, sr) {
  const c = design('lowpass', freq, sr);
  const y = biquad(c, x, new Float32Array(x.length));
  y.reverse();
  biquad(c, y, y);
  return y.reverse();
}

/** Magnitude response of a biquad at `freq`, in dB. */
export function magnitudeDb(c, freq, sr) {
  const w = (2 * Math.PI * freq) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
}
