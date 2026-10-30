// In-place iterative radix-2 complex FFT with cached twiddle and bit-reversal tables.

const tables = new Map();

function getTables(n) {
  let t = tables.get(n);
  if (t) return t;
  const levels = Math.round(Math.log2(n));
  if (1 << levels !== n) throw new Error(`FFT size must be a power of two, got ${n}`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < levels; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  tables.set(n, t);
  return t;
}

export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = getTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sgn = inverse ? -1 : 1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = start + j;
        const b = a + half;
        const c = cos[k];
        const s = sgn * sin[k];
        const xr = re[b];
        const xi = im[b];
        const tr = xr * c + xi * s;
        const ti = xi * c - xr * s;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] *= inv; }
  }
}

export function nextPow2(x) {
  let n = 1;
  while (n < x) n <<= 1;
  return n;
}
