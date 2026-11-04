// Auto mix's look at the stems together. Each stem is mapped band by band over
// time and the stems are added up. The whole is scored against goals read from
// finished records, and the plan is the smallest set of moves that meets them.
// A session that already meets them is left alone, and the score is shown either
// way. Each goal notes what finished records read, so it can be checked later.

import { fft, nextPow2 } from './fft.js';
import { measureLoudness, truePeak, integratedLufs } from './loudness.js';
import { ltas, bandLevels } from './spectral.js';
import { measureStem, autoMixSliders } from './automix.js';

export const GOALS = {
  heard: 0.1,         // the least of a part that comes through the rest (a melody on a finished record: 11%)
  heardVoice: 0.35,   // a lead voice carries the song
  heardQuiet: 0.05,   // effects and ambience are meant to sit under
  swamp: 0.5,         // the most of the loudness one part may hold, with three or more parts
  buildUp: 7,         // dB one octave from 125 Hz to 1 kHz may stand over its neighbours (records: up to 6.8)
  tilt: [-9, -3],     // dB per octave from 250 Hz to 4 kHz (records: -8.5 to -3.3)
  limiter: 3,         // dB of limiting at the finished level. Only reported: stem moves and stem
                      // compression were both tried on heavy cases and cost more than they save.
  limiterDrums: 6,    // the same with drums, whose hits are what a limiter is for
  shape: 0.7,         // how much of the stems' loudness range the mix keeps
  mono: 3,            // LU lost when played in mono
};
const MOVE_UP = 6;    // dB a covered stem may come up: a quiet texture may be quiet on purpose
const MOVE_DOWN = 9;  // dB a stem that swamps the rest may come down
const CUT_MAX = 4;    // dB any one cut may take
const CUT_STEMS = 2;  // how many stems may be cut for build-up
const CUT_HOLDS = 0.25; // the least of that octave a stem must hold to be cut
const CUT_Q = 1.4;    // about an octave wide
const HIGHS_MAX = 0.5; // the Highs slider: 1 dB at most
const FINISHED = { lufs: -12, ceiling: -2 }; // where Easy finishes, for judging the limiter
const BALANCE = 0.75; // how far the mix engine evens out the buses
// The buses the engine evens out, as in mix.js.
const BUS_LUFS = { vocals: -18, drums: -20, bass: -21, music: -19.5, fx: -27, ambience: -30 };

const dB = (p) => 10 * Math.log10(p + 1e-20);
const FRAME_SEC = 0.085, HOP_SEC = 0.1, MAX_FRAMES = 1200;
const CENTERS = Array.from({ length: 27 }, (_, k) => 40 * Math.pow(2, k / 3));
const EDGE = Math.pow(2, 1 / 6);
const B = CENTERS.length;
// Rough ear weighting, as in loudness metering: little under 60 Hz, a lift above 2 kHz.
const EAR = CENTERS.map((f) => Math.pow(10, ((f < 100 ? 12 * Math.log2(f / 100) : 0) + (f > 1500 ? Math.min(4, (4 * Math.log2(f / 1500)) / 1.4) : 0)) / 10));
const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
const octaveOf = CENTERS.map((f) => OCTAVES.findIndex((c) => f >= c / Math.SQRT2 && f < c * Math.SQRT2));

/** Energy of one stem per third octave and moment. Flat array: band + frame * B. */
export function stemMap(chs, sr, hopSec = HOP_SEC) {
  const N = nextPow2(FRAME_SEC * sr), hop = Math.round(hopSec * sr);
  const frames = Math.max(1, Math.floor((chs[0].length - N) / hop) + 1);
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const edges = CENTERS.map((f) => [Math.round((f / EDGE) * N / sr), Math.min(N / 2, Math.round((f * EDGE * N) / sr))]);
  const energy = new Float32Array(B * frames), re = new Float64Array(N), im = new Float64Array(N);
  for (const c of chs) {
    for (let h = 0; h < frames; h++) {
      let any = 0;
      for (let j = 0; j < N; j++) { const v = (c[h * hop + j] || 0) * hann[j]; re[j] = v; im[j] = 0; any += v * v; }
      if (any < 1e-12) continue;
      fft(re, im);
      for (let b = 0; b < B; b++) {
        let e = 0;
        for (let k = edges[b][0]; k < edges[b][1]; k++) e += re[k] * re[k] + im[k] * im[k];
        energy[b + h * B] += e;
      }
    }
  }
  return { energy, frames };
}

// What a cut takes at another frequency, in dB (the shape of a bell, near enough for small cuts).
const bell = (f, cut) => cut.gain / (1 + Math.pow(CUT_Q * (f / cut.freq - cut.freq / f), 2));
const bandGains = (gainDb, cuts) => CENTERS.map((f) => Math.pow(10, (gainDb + cuts.reduce((a, c) => a + bell(f, c), 0)) / 10));

// How much of each part comes through the rest, from the loudness it adds on top
// of them against its loudness alone (loudness grows as a low power of energy).
function scoreParts(maps, gainsDb, cuts) {
  const m = maps.length, frames = maps[0].frames;
  const g = maps.map((_, i) => bandGains(gainsDb[i], cuts[i]));
  const root = (x) => Math.sqrt(Math.sqrt(x));
  let loudest = 0;
  const total = new Float64Array(B * frames);
  for (let i = 0; i < m; i++) { const e = maps[i].energy; for (let h = 0; h < frames; h++) for (let b = 0; b < B; b++) { const k = b + h * B; total[k] += g[i][b] * EAR[b] * e[k]; } }
  for (let k = 0; k < total.length; k++) if (total[k] > loudest) loudest = total[k];
  const floor = loudest * 1e-6, rootFloor = root(floor);
  const added = new Float64Array(m), alone = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const e = maps[i].energy;
    for (let h = 0; h < frames; h++) for (let b = 0; b < B; b++) {
      const k = b + h * B, s = g[i][b] * EAR[b] * e[k], t = total[k];
      if (s <= 0 || t < floor) continue;
      alone[i] += root(s + floor) - rootFloor;
      added[i] += root(t + floor) - root(Math.max(0, t - s) + floor);
    }
  }
  const sum = added.reduce((a, v) => a + v, 0);
  return { heard: Array.from(added, (v, i) => (alone[i] > 0 ? v / alone[i] : null)), share: Array.from(added, (v) => (sum > 0 ? v / sum : 0)) };
}

function octaveLevels(maps, gainsDb, cuts) {
  const out = new Float64Array(OCTAVES.length);
  maps.forEach((map, i) => {
    const g = bandGains(gainsDb[i], cuts[i]);
    for (let h = 0; h < map.frames; h++) for (let b = 0; b < B; b++) if (octaveOf[b] >= 0) out[octaveOf[b]] += g[b] * map.energy[b + h * B];
  });
  return Array.from(out, dB);
}

// The worst build-up: an octave against the mean of the two beside it, 125 Hz to 1 kHz.
function buildUpOf(levels) {
  let best = { db: -Infinity, at: 1 };
  for (let i = 1; i <= 4; i++) { const v = levels[i] - (levels[i - 1] + levels[i + 1]) / 2; if (v > best.db) best = { db: v, at: i }; }
  return { db: best.db, at: best.at, freq: OCTAVES[best.at] };
}

// Slope in dB per octave, 250 Hz to 4 kHz, by a straight-line fit.
function tiltOf(levels) {
  const pts = levels.slice(2, 7), mean = pts.reduce((a, v) => a + v, 0) / pts.length;
  return pts.reduce((a, v, i) => a + (i - 2) * (v - mean), 0) / 10;
}

/** The measures of the whole file, the same before and after the mix. */
export function measureWhole(chs, sr) {
  const st = chs.length > 1 ? chs.slice(0, 2) : [chs[0], chs[0]];
  const loud = measureLoudness(st, sr, { series: false });
  const peak = truePeak(st, sr).dbtp;
  const mid = Float32Array.from(st[0], (v, i) => (v + st[1][i]) / 2);
  const levels = bandLevels(ltas(st, sr), OCTAVES, 1);
  let ll = 0, rr = 0;
  for (let i = 0; i < mid.length; i++) { ll += st[0][i] * st[0][i]; rr += st[1][i] * st[1][i]; }
  return {
    lufs: loud.integrated, lra: loud.lra, peak, levels, tilt: tiltOf(levels), buildUp: buildUpOf(levels),
    monoLoss: loud.integrated - integratedLufs([mid, mid], sr),
    leftRightDb: dB(ll) - dB(rr),
    limiterNeed: Math.max(0, peak + (FINISHED.lufs - loud.integrated) - FINISHED.ceiling),
  };
}

const plainName = (name) => name.replace(/\.[^.]+$/, '').replace(/^(.+?)\1(_\d+)?$/, '$1$2');
const goalFor = (row, parts) => {
  if (row.category === 'vocals') return row.role === 'lead' ? GOALS.heardVoice : Math.min(GOALS.heard, 1 / parts);
  if (row.category === 'fx' || row.category === 'ambience') return GOALS.heardQuiet;
  return Math.min(GOALS.heard, 1 / parts);
};
// Where the engine's bus balance will put each stem.
function busBalance(rows) {
  const bus = {};
  for (const r of rows) bus[r.category] = (bus[r.category] || 0) + Math.pow(10, r.m.lufs / 10);
  return rows.map((r) => BALANCE * ((BUS_LUFS[r.category] ?? -24) - dB(bus[r.category])));
}

// A part that swamps the rest comes down first: often that alone clears the rest.
function solveSwamp(rows, maps, base) {
  const m = rows.length, move = new Float64Array(m), cuts = rows.map(() => []);
  const live = rows.map((r) => r.m.lufs > -70);
  if (live.filter(Boolean).length < 3) return move;
  for (let step = 0; step < 2 * MOVE_DOWN; step++) {
    const s = scoreParts(maps, base.map((v, i) => v + move[i]), cuts);
    let top = -1, most = GOALS.swamp;
    for (let i = 0; i < m; i++) if (live[i] && s.share[i] > most && move[i] > -MOVE_DOWN) { most = s.share[i]; top = i; }
    if (top < 0) break;
    move[top] -= 0.5;
  }
  return move;
}

// Then build-up, cut only on the stems that really hold that octave. Voices,
// drums and bass keep their body.
function solveCuts(rows, maps, levels, real) {
  const cuts = rows.map(() => []);
  const start = octaveLevels(maps, levels, cuts);
  const predicted = () => { const now = octaveLevels(maps, levels, cuts); return real.map((v, i) => v + now[i] - start[i]); };
  for (let step = 0; step < 2 * CUT_MAX * CUT_STEMS; step++) {
    const hump = buildUpOf(predicted());
    if (hump.db <= GOALS.buildUp) break;
    let top = -1, most = 0, band = 0, all = 0;
    maps.forEach((map, i) => {
      const g = bandGains(levels[i], cuts[i]);
      let held = 0, strongest = 0, at = 0;
      for (let b = 0; b < B; b++) {
        if (octaveOf[b] !== hump.at) continue;
        let e = 0;
        for (let h = 0; h < map.frames; h++) e += map.energy[b + h * B];
        e *= g[b];
        held += e;
        if (e > strongest) { strongest = e; at = b; }
      }
      all += held;
      const allowed = !['vocals', 'bass', 'drums'].includes(rows[i].category);
      const free = cuts[i].length ? cuts[i][0].gain > -CUT_MAX : cuts.filter((c) => c.length).length < CUT_STEMS;
      if (allowed && free && held > most) { most = held; top = i; band = at; }
    });
    if (top < 0 || most < CUT_HOLDS * all) break;
    if (!cuts[top].length) cuts[top].push({ type: 'peaking', freq: Math.round(CENTERS[band]), q: CUT_Q, gain: 0 });
    cuts[top][0].gain -= 0.5;
  }
  return cuts;
}

// Last, a part still covered by the rest comes up.
function solveHeard(rows, maps, levels, cuts, move) {
  const m = rows.length, up = Float64Array.from(move);
  const live = rows.map((r) => r.m.lufs > -70);
  const parts = live.filter(Boolean).length;
  const goals = rows.map((r) => goalFor(r, parts));
  for (let step = 0; step < 16 * MOVE_UP; step++) {
    const s = scoreParts(maps, levels.map((v, i) => v + up[i] - move[i]), cuts);
    let worst = -1, gap = 1;
    for (let i = 0; i < m; i++) {
      if (!live[i] || s.heard[i] == null || s.heard[i] >= goals[i] || up[i] >= MOVE_UP) continue;
      const g = s.heard[i] / goals[i];
      if (g < gap) { gap = g; worst = i; }
    }
    if (worst < 0) break;
    up[worst] += 0.5;
  }
  return Array.from(up);
}

// The part furthest from its goal.
const lowest = (rows, s) => {
  let at = -1;
  const parts = rows.filter((r) => r.m.lufs > -70).length;
  rows.forEach((r, i) => { if (s.heard[i] != null && (at < 0 || s.heard[i] / goalFor(r, parts) < s.heard[at] / goalFor(rows[at], parts))) at = i; });
  return at;
};
const biggest = (s) => s.share.indexOf(Math.max(...s.share));

/** Stems are read one at a time, then the whole is scored and the plan made. */
export class AutoSession {
  constructor(sr, length) {
    this.sr = sr;
    this.n = length;
    this.sum = [new Float32Array(length), new Float32Array(length)];
    this.maps = [];
    this.measures = [];
    this.hopSec = Math.max(HOP_SEC, length / sr / MAX_FRAMES);
  }

  addStem(audio) {
    const src = audio.channels.length > 1 ? audio.channels.slice(0, 2) : [audio.channels[0], audio.channels[0]];
    const chs = src.map((c) => { const o = new Float32Array(this.n); o.set(c.subarray(0, Math.min(this.n, c.length))); return o; });
    for (let c = 0; c < 2; c++) { const s = this.sum[c], x = chs[c]; for (let i = 0; i < this.n; i++) s[i] += x[i]; }
    const m = measureStem(chs, this.sr);
    this.maps.push(stemMap(chs, this.sr, this.hopSec));
    this.measures.push(m);
    return m;
  }

  /** meta: [{ name, category, role }] in the order the stems were added. */
  plan(meta, { rough = false } = {}) {
    const rows = meta.map((x, i) => ({ ...x, m: this.measures[i] }));
    const { sliders, reasons } = autoMixSliders(rows, { rough });
    const whole = measureWhole(this.sum, this.sr);
    const board = { rangeStems: whole.lra, limiterGoal: rows.some((r) => r.category === 'drums') ? GOALS.limiterDrums : GOALS.limiter, before: { buildUp: whole.buildUp, tilt: whole.tilt, limiter: whole.limiterNeed, mono: whole.monoLoss } };
    this.sum = null;
    const maps = this.maps;
    this.maps = null;
    const none = rows.map(() => ({ gainDb: 0, cuts: [] }));
    // Your rough mix decides the balance and tone, so only the whole is scored.
    if (rough) return { sliders, reasons, stems: none, buses: {}, board };

    const parts = rows.filter((r) => r.m.lufs > -70).length;
    const base = busBalance(rows);
    const noCuts = rows.map(() => []);
    const first = scoreParts(maps, base, noCuts);
    const swamp = solveSwamp(rows, maps, base);
    const levels = base.map((v, i) => v + swamp[i]);
    const cuts = parts >= 2 ? solveCuts(rows, maps, levels, whole.levels) : noCuts;
    const move = solveHeard(rows, maps, levels, cuts, swamp);
    const final = base.map((v, i) => v + move[i]);
    const last = scoreParts(maps, final, cuts);
    const names = meta.map((x) => plainName(x.name));

    const said = [];
    cuts.forEach((c, i) => { if (c.length) said.push(`Too much builds up around ${c[0].freq} Hz, mostly from ${names[i]}, so it is cut ${(-c[0].gain).toFixed(1)} dB there.`); });
    move.forEach((v, i) => {
      if (swamp[i] < 0) said.push(`${names[i]} swamped the rest, so it comes down ${(-swamp[i]).toFixed(1)} dB.`);
      if (v > swamp[i]) said.push(`${names[i]} was covered by the rest, so it comes up ${(v - swamp[i]).toFixed(1)} dB.`);
    });
    // Tone only moves when the stems together sit outside what finished records do.
    if (!sliders.highs) {
      const [lo, hi] = GOALS.tilt;
      const now = octaveLevels(maps, final, cuts), start = octaveLevels(maps, base, noCuts);
      const tilt = tiltOf(whole.levels.map((v, i) => v + now[i] - start[i]));
      if (tilt < lo) { sliders.highs = Math.min(HIGHS_MAX, Math.round((lo - tilt) * 10) / 20 + 0.1); said.push('The stems together are darker than finished records, so the highs come up a little.'); }
      else if (tilt > hi) { sliders.highs = -Math.min(HIGHS_MAX, Math.round((tilt - hi) * 10) / 20 + 0.1); said.push('The stems together are brighter than finished records, so the highs come down a little.'); }
    }
    if (!said.length) said.push('Played together, your stems already meet the balance and tone goals, so no stem needs to move.');

    // The engine evens out each bus again afterwards, so a bus that moved as a whole keeps its move.
    const buses = {};
    const moved = (r, i) => Math.pow(10, (r.m.lufs + move[i] + (cuts[i][0]?.gain || 0) / 3) / 10);
    for (const k of new Set(rows.map((r) => r.category))) {
      const a = rows.reduce((p, r, i) => p + (r.category === k ? moved(r, i) : 0), 0);
      const z = rows.reduce((p, r) => p + (r.category === k ? Math.pow(10, r.m.lufs / 10) : 0), 0);
      if (a > 0 && z > 0) buses[k] = BALANCE * (dB(a) - dB(z));
    }
    if (Object.keys(buses).length < 2) for (const k of Object.keys(buses)) delete buses[k];
    for (const k of Object.keys(buses)) { buses[k] = Math.round(buses[k] * 2) / 2; if (!buses[k]) delete buses[k]; }

    const lo0 = lowest(rows, first), lo1 = lowest(rows, last), hi0 = biggest(first), hi1 = biggest(last);
    if (lo0 >= 0 && lo1 >= 0) {
      const heard = (s, at) => ({ name: names[at], value: s.heard[at], goal: goalFor(rows[at], parts) });
      board.before.heard = heard(first, lo0);
      board.after = { heard: heard(last, lo1) };
      if (parts >= 3) {
        board.before.swamp = { name: names[hi0], value: first.share[hi0] };
        board.after.swamp = { name: names[hi1], value: last.share[hi1] };
      }
    }
    return {
      sliders, reasons: [...said, ...reasons], buses,
      stems: rows.map((_, i) => ({ gainDb: move[i], cuts: cuts[i] })),
      board,
    };
  }
}

/** The score card: what the stems read together, what the finished mix reads, and whether each goal is met. */
export function scoreCard(board, whole, report) {
  if (!board || !whole) return null;
  const db1 = (v) => `${v.toFixed(1)} dB`;
  const r1 = (v) => Math.round(v * 10) / 10; // judged as shown
  const row = (label, goal, before, after, pass) => ({ label, goal, before, after, pass });
  const pct = (x) => `${x.name} ${Math.round(x.value * 100)}%`;
  const out = [];
  if (board.before.heard) {
    const a = board.after.heard;
    out.push(row('Every part comes through', `each at least ${Math.round(a.goal * 100)}%`, pct(board.before.heard), pct(a), Math.round(a.value * 100) >= Math.round(a.goal * 100)));
  }
  if (board.before.swamp) out.push(row('No part swamps the rest', `at most ${Math.round(GOALS.swamp * 100)}% of the loudness`, pct(board.before.swamp), pct(board.after.swamp), Math.round(board.after.swamp.value * 100) <= Math.round(GOALS.swamp * 100)));
  const [lo, hi] = GOALS.tilt;
  out.push(row('No build-up in one range', `at most ${GOALS.buildUp} dB over its neighbours`, `${db1(board.before.buildUp.db)} at ${board.before.buildUp.freq} Hz`, `${db1(whole.buildUp.db)} at ${whole.buildUp.freq} Hz`, r1(whole.buildUp.db) <= GOALS.buildUp));
  out.push(row('Tone like finished records', `${lo} to ${hi} dB per octave`, db1(board.before.tilt), db1(whole.tilt), r1(whole.tilt) >= lo && r1(whole.tilt) <= hi));
  const lim = report.limiter?.maxGr ?? 0;
  out.push(row('Light limiting', `at most ${board.limiterGoal} dB`, db1(board.before.limiter), db1(lim), r1(lim) <= board.limiterGoal));
  out.push(row('Quiet and loud parts keep their shape', `at least ${Math.round(GOALS.shape * 100)}% of the stems’ range`, `${board.rangeStems.toFixed(1)} LU`, `${whole.lra.toFixed(1)} LU`, r1(whole.lra) >= r1(GOALS.shape * board.rangeStems)));
  out.push(row('Holds up in mono', `loses at most ${GOALS.mono} LU`, `${board.before.mono.toFixed(1)} LU`, `${whole.monoLoss.toFixed(1)} LU`, r1(whole.monoLoss) <= GOALS.mono));
  return out;
}
