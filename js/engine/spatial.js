// Spatial audio: 5.1 and 7.1.4 speaker beds. A stereo upmix (per-bin
// primary/ambient decomposition with centre extraction) for finished masters,
// a bed built from mix buses for stem sessions, and BS.1770 channel weights.

import { fft } from './fft.js';
import { design, cascade, lr4 } from './filters.js';

// Channel order follows the WAVE_FORMAT_EXTENSIBLE mask bit order. Azimuth is
// positive to the left; elevation in degrees.
export const LAYOUTS = {
  '5.1': {
    label: '5.1', mask: 0x60f,
    channels: [
      { id: 'L', name: 'Left', az: 30, el: 0 }, { id: 'R', name: 'Right', az: -30, el: 0 }, { id: 'C', name: 'Centre', az: 0, el: 0 },
      { id: 'LFE', name: 'LFE', lfe: true }, { id: 'Ls', name: 'Left surround', az: 110, el: 0 }, { id: 'Rs', name: 'Right surround', az: -110, el: 0 },
    ],
  },
  '7.1.4': {
    label: '7.1.4', mask: 0x2d63f,
    channels: [
      { id: 'L', name: 'Left', az: 30, el: 0 }, { id: 'R', name: 'Right', az: -30, el: 0 }, { id: 'C', name: 'Centre', az: 0, el: 0 },
      { id: 'LFE', name: 'LFE', lfe: true }, { id: 'Lrs', name: 'Left rear surround', az: 150, el: 0 }, { id: 'Rrs', name: 'Right rear surround', az: -150, el: 0 },
      { id: 'Lss', name: 'Left side surround', az: 90, el: 0 }, { id: 'Rss', name: 'Right side surround', az: -90, el: 0 },
      { id: 'Ltf', name: 'Left top front', az: 45, el: 45 }, { id: 'Rtf', name: 'Right top front', az: -45, el: 45 },
      { id: 'Ltr', name: 'Left top rear', az: 135, el: 45 }, { id: 'Rtr', name: 'Right top rear', az: -135, el: 45 },
    ],
  },
};

/** BS.1770-4 weights: 1.41 for |azimuth| 60-120 degrees below 30 degrees elevation, 0 for LFE, else 1. */
export function loudnessWeights(layout) {
  return LAYOUTS[layout].channels.map((c) => (c.lfe ? 0 : Math.abs(c.az) >= 60 && Math.abs(c.az) <= 120 && c.el < 30 ? 1.41 : 1));
}

const index = (layout) => Object.fromEntries(LAYOUTS[layout].channels.map((c, i) => [c.id, i]));

function delayed(x, samples, g = 1) {
  const y = new Float32Array(x.length);
  for (let i = samples; i < x.length; i++) y[i] = x[i - samples] * g;
  return y;
}

function addInto(dst, src, g = 1, delay = 0) {
  if (!g) return;
  for (let i = delay; i < dst.length; i++) dst[i] += src[i - delay] * g;
}

// Ambience feeds for the surround and height speakers: different delays per
// speaker (decorrelation by precedence), no lows in the heights, softened top end.
function spreadAmbience(out, ids, ambL, ambR, sr, layout) {
  const ms = (t) => Math.round((t * sr) / 1000);
  const lp = [design('lowpass', 12000, sr, 0.7)];
  const hp = lr4('highpass', 180, sr);
  const soft = (x) => cascade(lp, x, new Float32Array(x));
  const aL = soft(ambL), aR = soft(ambR);
  if (layout === '5.1') {
    addInto(out[ids.Ls], aL, 1, ms(11));
    addInto(out[ids.Rs], aR, 1, ms(13));
    return;
  }
  const hL = cascade(hp, aL, new Float32Array(aL)), hR = cascade(hp, aR, new Float32Array(aR));
  // Energy shares: sides 40%, rears 30%, top front 15%, top rear 15%.
  addInto(out[ids.Lss], aL, Math.sqrt(0.4), ms(7));
  addInto(out[ids.Rss], aR, Math.sqrt(0.4), ms(9));
  addInto(out[ids.Lrs], aL, Math.sqrt(0.3), ms(19));
  addInto(out[ids.Rrs], aR, Math.sqrt(0.3), ms(17));
  addInto(out[ids.Ltf], hL, Math.sqrt(0.15), ms(4));
  addInto(out[ids.Rtf], hR, Math.sqrt(0.15), ms(5));
  addInto(out[ids.Ltr], hL, Math.sqrt(0.15), ms(23));
  addInto(out[ids.Rtr], hR, Math.sqrt(0.15), ms(26));
}

function lfeFeed(L, R, sr, lfeDb) {
  const m = new Float32Array(L.length);
  if (lfeDb <= -60) return m;
  const g = 0.5 * Math.pow(10, lfeDb / 20);
  for (let i = 0; i < m.length; i++) m[i] = (L[i] + R[i]) * g;
  return cascade([...lr4('lowpass', 120, sr)], m, m);
}

/**
 * Stereo to 5.1 / 7.1.4. Per FFT bin, the smoothed cross-spectra give the
 * power of the uncorrelated (ambient) part under the usual model (equal
 * ambient power in both channels): sigma_A^2 = (S - sqrt(S^2 - 4D)) / 2 with
 * S = Pll + Prr and D = Pll*Prr - |Plr|^2. Hard-panned dry sources therefore
 * stay in front. The primary part's panning decides how much goes to the
 * centre speaker. Energy is preserved in every bin.
 *
 * centre: 0..1 share of centred primary content moved to C.
 * surround: 0..1 share of ambience moved behind and above.
 * lfeDb: level of the low-passed (120 Hz) mono copy in the LFE channel
 * (played back +10 dB); <= -60 leaves it empty.
 */
export function upmix(chs, sr, { layout = '5.1', centre = 0.5, surround = 0.6, lfeDb = -12, onProgress } = {}) {
  const [L, R] = chs.length > 1 ? chs : [chs[0], chs[0]];
  const n = L.length;
  const N = sr > 48000 ? 4096 : 2048;
  const hop = N / 4;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const H = N / 2;
  const alpha = Math.exp(-hop / (0.12 * sr));
  const Pll = new Float64Array(H + 1), Prr = new Float64Array(H + 1), Pr = new Float64Array(H + 1), Pi = new Float64Array(H + 1);
  // Frame spectra (unpacked) and the cross-spectra smoothed over +-2 bins:
  // without that, independent noise still looks partly coherent.
  const sl = new Float64Array(2 * (H + 1)), srr = new Float64Array(2 * (H + 1));
  const fll = new Float64Array(H + 1), frr = new Float64Array(H + 1), fr0 = new Float64Array(H + 1), fi0 = new Float64Array(H + 1);
  // Output streams (padded): front L/R, centre, ambient L/R.
  const streams = Array.from({ length: 5 }, () => new Float32Array(n + 2 * N));
  const re = new Float64Array(N), im = new Float64Array(N);
  const z = [0, 1, 2].map(() => [new Float64Array(N), new Float64Array(N)]);
  const gS = Math.sqrt(surround);
  const frames = Math.ceil((n + N) / hop);
  let ambE = 0, cenE = 0, totE = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - N;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      const ok = j >= 0 && j < n;
      re[i] = ok ? L[j] * win[i] : 0;
      im[i] = ok ? R[j] * win[i] : 0;
    }
    fft(re, im, false);
    for (const [a, b] of z) { a.fill(0); b.fill(0); }
    for (let k = 0; k <= H; k++) {
      const k2 = (N - k) % N;
      // Unpack the two real spectra from the shared complex FFT.
      const lr = 0.5 * (re[k] + re[k2]), li = 0.5 * (im[k] - im[k2]);
      const rr = 0.5 * (im[k] + im[k2]), ri = -0.5 * (re[k] - re[k2]);
      sl[2 * k] = lr; sl[2 * k + 1] = li; srr[2 * k] = rr; srr[2 * k + 1] = ri;
      fll[k] = lr * lr + li * li; frr[k] = rr * rr + ri * ri;
      fr0[k] = lr * rr + li * ri; fi0[k] = li * rr - lr * ri;
    }
    for (let k = 0; k <= H; k++) {
      let a = 0, b = 0, c0 = 0, d = 0;
      const k0 = Math.max(0, k - 2), k1 = Math.min(H, k + 2);
      for (let q = k0; q <= k1; q++) { a += fll[q]; b += frr[q]; c0 += fr0[q]; d += fi0[q]; }
      const cnt = k1 - k0 + 1;
      Pll[k] = alpha * Pll[k] + (1 - alpha) * (a / cnt);
      Prr[k] = alpha * Prr[k] + (1 - alpha) * (b / cnt);
      Pr[k] = alpha * Pr[k] + (1 - alpha) * (c0 / cnt);
      Pi[k] = alpha * Pi[k] + (1 - alpha) * (d / cnt);
    }
    for (let k = 0; k <= H; k++) {
      const k2 = (N - k) % N;
      const lr = sl[2 * k], li = sl[2 * k + 1], rr = srr[2 * k], ri = srr[2 * k + 1];
      const pl = fll[k], pr = frr[k];
      const S = Pll[k] + Prr[k];
      let aL = 0, aR = 0, c = 0;
      if (S > 1e-20) {
        const D = Math.max(0, Pll[k] * Prr[k] - (Pr[k] * Pr[k] + Pi[k] * Pi[k]));
        const sA = 0.5 * (S - Math.sqrt(Math.max(0, S * S - 4 * D)));
        aL = Math.min(1, sA / (Pll[k] + 1e-30));
        aR = Math.min(1, sA / (Prr[k] + 1e-30));
        const pL = Math.max(0, Pll[k] - sA), pR = Math.max(0, Prr[k] - sA);
        const pan = (pL - pR) / (pL + pR + 1e-30);
        const w = Math.max(0, 1 - Math.abs(pan) / 0.35);
        // Only in-phase content belongs in the centre (anti-phase would cancel there).
        const ph = Math.max(0, Pr[k] / (Math.hypot(Pr[k], Pi[k]) + 1e-30));
        c = centre * w * w * ph * ph;
      }
      // Masks act on the mixture, so each speaker's gain is the square root of its energy share.
      const dL = Math.sqrt(1 - aL), dR = Math.sqrt(1 - aR);
      const fl = Math.sqrt((1 - aL) * (1 - c) + aL * (1 - surround));
      const fr = Math.sqrt((1 - aR) * (1 - c) + aR * (1 - surround));
      let cl = Math.sqrt(c) * dL * Math.SQRT1_2, cr = Math.sqrt(c) * dR * Math.SQRT1_2;
      if (c > 0) {
        // Give the centre exactly the energy taken from the fronts (c of the primary energy).
        const er = (cl * lr + cr * rr) ** 2 + (cl * li + cr * ri) ** 2;
        const want = c * ((1 - aL) * pl + (1 - aR) * pr);
        const g = er > 1e-30 ? Math.min(1.5, Math.sqrt(want / er)) : 0;
        cl *= g; cr *= g;
      }
      const al = Math.sqrt(aL) * gS, ar = Math.sqrt(aR) * gS;
      const outs = [
        [fl * lr, fl * li], [fr * rr, fr * ri],
        [cl * lr + cr * rr, cl * li + cr * ri],
        [al * lr, al * li], [ar * rr, ar * ri],
      ];
      if (k > 0 && k < H) {
        const e = pl + pr;
        totE += e;
        ambE += (al * al) * pl + (ar * ar) * pr;
        cenE += (outs[2][0] ** 2 + outs[2][1] ** 2);
      }
      // Pack pairs of real outputs (A + iB) for three inverse FFTs.
      for (let p = 0; p < 5; p++) {
        const [sr2, si2] = outs[p];
        const [zr, zi] = z[p >> 1];
        if ((p & 1) === 0) {
          zr[k] += sr2; zi[k] += si2;
          if (k2 !== k) { zr[k2] += sr2; zi[k2] -= si2; }
        } else {
          zr[k] -= si2; zi[k] += sr2;
          if (k2 !== k) { zr[k2] += si2; zi[k2] += sr2; }
        }
      }
    }
    const base = f * hop;
    for (let p = 0; p < 3; p++) {
      const [zr, zi] = z[p];
      fft(zr, zi, true);
      const a = streams[2 * p], b = streams[2 * p + 1];
      for (let i = 0; i < N; i++) {
        a[base + i] += zr[i] * win[i] * 0.5;
        if (b) b[base + i] += zi[i] * win[i] * 0.5;
      }
    }
    if (onProgress && f % 512 === 0) onProgress(f / frames);
  }
  const [fL, fR, C, ambL, ambR] = streams.map((s) => s.subarray(N, N + n).slice());
  const ids = index(layout);
  const out = LAYOUTS[layout].channels.map(() => new Float32Array(n));
  out[ids.L] = fL;
  out[ids.R] = fR;
  out[ids.C] = C;
  out[ids.LFE] = lfeFeed(L, R, sr, lfeDb);
  spreadAmbience(out, ids, ambL, ambR, sr, layout);
  return { chs: out, layout, ambiencePct: totE ? (100 * ambE) / totE : 0, centrePct: totE ? (100 * cenE) / totE : 0 };
}

/**
 * Speaker bed from mix buses (stereo each, already processed) and effect
 * returns. Lead-vocal and bass mids go partly to the centre, music and FX open
 * into the surrounds (and heights in 7.1.4), effect returns mostly behind and
 * above, and the low end of bass and kick feeds the LFE.
 */
export function bedFromBuses(buses, returns, sr, { layout = '5.1', vocalCentre = 0.6, lfeDb = -12 } = {}) {
  const n = (Object.values(buses).find(Boolean) || returns[0])[0].length;
  const ids = index(layout);
  const out = LAYOUTS[layout].channels.map(() => new Float32Array(n));
  const tall = layout === '7.1.4';
  const ms = (t) => Math.round((t * sr) / 1000);
  const ambL = new Float32Array(n), ambR = new Float32Array(n);
  const lowSum = [new Float32Array(n), new Float32Array(n)];
  // Mid to the centre (energy-preserving): L' = M*sqrt(1-k) + S, C = M*sqrt(2k).
  const front = (b, k) => {
    const [L, R] = b;
    const a = Math.sqrt(1 - k), cg = Math.sqrt(2 * k);
    for (let i = 0; i < n; i++) {
      const m = 0.5 * (L[i] + R[i]), s = 0.5 * (L[i] - R[i]);
      out[ids.L][i] += m * a + s;
      out[ids.R][i] += m * a - s;
      out[ids.C][i] += m * cg;
    }
  };
  const share = (b, frontE, ambE) => {
    addInto(out[ids.L], b[0], Math.sqrt(frontE));
    addInto(out[ids.R], b[1], Math.sqrt(frontE));
    addInto(ambL, b[0], Math.sqrt(ambE));
    addInto(ambR, b[1], Math.sqrt(ambE));
  };
  if (buses.vocals) front(buses.vocals, vocalCentre);
  if (buses.drums) { front(buses.drums, 0.2); addInto(lowSum[0], buses.drums[0]); addInto(lowSum[1], buses.drums[1]); }
  if (buses.bass) { front(buses.bass, 0.35); addInto(lowSum[0], buses.bass[0]); addInto(lowSum[1], buses.bass[1]); }
  if (buses.music) share(buses.music, 0.72, 0.28);
  if (buses.fx) share(buses.fx, 0.4, 0.6);
  for (const r of returns) share(r, 0.35, 0.65);
  spreadAmbience(out, ids, ambL, ambR, sr, layout);
  if (tall && buses.music) {
    // A little of the music's top end in the front heights lifts the image.
    const hp = lr4('highpass', 2500, sr);
    for (const [c, id, d] of [[0, 'Ltf', 3], [1, 'Rtf', 4]]) addInto(out[ids[id]], cascade(hp, buses.music[c], new Float32Array(n)), Math.sqrt(0.08), ms(d));
  }
  out[ids.LFE] = lfeFeed(lowSum[0], lowSum[1], sr, lfeDb);
  return { chs: out, layout };
}

/** Per-channel loudness contribution (dB relative to the loudest speaker), for the report. */
export function channelLevels(chs, layout) {
  const ch = LAYOUTS[layout].channels;
  const rms = chs.map((x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return s / Math.max(1, x.length); });
  const top = Math.max(...rms.filter((_, i) => !ch[i].lfe));
  return ch.map((c, i) => ({ id: c.id, name: c.name, db: rms[i] > 0 && top > 0 ? 10 * Math.log10(rms[i] / top) : -120 }));
}
