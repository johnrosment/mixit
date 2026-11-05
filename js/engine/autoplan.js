// Auto mix's look at the stems together. Each stem is mapped band by band over
// time and the stems are added up. The whole is scored against goals read from
// finished songs, and the plan is the smallest set of moves that meets them,
// starting from the balance the stems came in at. Stems that already meet them
// are left alone, and the score is shown either way. Each goal notes what finished
// songs read at their real balance, so it can be checked later.

import { measureLoudness, truePeak, integratedLufs } from './loudness.js';
import { ltas, bandLevels } from './spectral.js';
import { measureStem, autoMixSliders } from './automix.js';
import { stemMap, MAP_BANDS, mapHop, waveStep, waveCopy, readStemLevels, roughFeatures, stemFeatures, addFeatures, fitBalance, roughBelongs } from './roughmix.js';

export { stemMap };

// Set safely under seven songs at their real balance, as moving a good balance
// does more harm than missing a bad one. Those songs are the only evidence so far.
export const GOALS = {
  heardShared: 0.3,   // the least of a part that comes through the rest, shared out as parts are added
                      // (quietest part with two to four parts: 26% to 47%; seven parts: 12%; six parts, one a quiet layer: 6%)
  heardVoice: 0.35,   // a lead voice carries the song (not yet checked on a real one)
  heardQuiet: 0.05,   // effects and ambience are meant to sit under
  swamp: { 2: 0.75, 3: 0.7, more: 0.55 }, // the most of the loudness one part may hold (two parts: 67%, three: 38% and 64%, four or more: 36% to 45%)
  holds: 0.6,         // shared out among up to four parts: the least of the loudness a melodic part or voice holds while it plays
                      // (two parts: 33%, three: 35%, four: 22%). Not bass or drums: one song's bass holds 6% and sounds right there.
  buildUp: 7,         // dB one octave from 125 Hz to 1 kHz may stand over its neighbours (songs: up to 6.8)
  tilt: [-10, -1],    // dB per octave from 250 Hz to 4 kHz (songs: -8.7 to -2.0)
  shape: 0.7,         // how much of the stems' loudness range the mix keeps (songs: 78% to 99%)
  mono: 3,            // LU lost when played in mono
};
const MOVE_UP = 12;   // dB a covered stem may come up
const MOVE_DOWN = 12; // dB a stem that swamps the rest may come down
const CUT_MAX = 4;    // dB any one cut may take
const CUT_STEMS = 2;  // how many stems may be cut for build-up
const CUT_HOLDS = 0.25; // the least of that octave a stem must hold to be cut
const CUT_Q = 1.4;    // about an octave wide
const CUT_AIM = 0.25; // dB under the goal to aim for, as the finished mix lands a little either side of the plan
const HIGHS_MAX = 0.5; // the Highs slider: 1 dB at most
const FINISHED = { lufs: -12, ceiling: -2 }; // where Easy finishes, for showing the limiter's work

const dB = (p) => 10 * Math.log10(p + 1e-20);
const CENTERS = MAP_BANDS;
const B = CENTERS.length;
// Rough ear weighting, as in loudness metering: little under 60 Hz, a lift above 2 kHz.
const EAR = CENTERS.map((f) => Math.pow(10, ((f < 100 ? 12 * Math.log2(f / 100) : 0) + (f > 1500 ? Math.min(4, (4 * Math.log2(f / 1500)) / 1.4) : 0)) / 10));
const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
const octaveOf = CENTERS.map((f) => OCTAVES.findIndex((c) => f >= c / Math.SQRT2 && f < c * Math.SQRT2));
const ACTIVE = 1e-3; // of a stem's loudest moment, to count as playing

// What a cut takes at another frequency, in dB (the shape of a bell, near enough for small cuts).
const bell = (f, cut) => cut.gain / (1 + Math.pow(CUT_Q * (f / cut.freq - cut.freq / f), 2));
const bandGains = (gainDb, cuts) => CENTERS.map((f) => Math.pow(10, (gainDb + cuts.reduce((a, c) => a + bell(f, c), 0)) / 10));

// How much of each part comes through the rest, from the loudness it adds on top
// of them against its loudness alone (loudness grows as a low power of energy).
// `share` is its part of the whole song, `holds` its part of the moments it plays in,
// so a part that plays once is not taken for one that is too quiet.
export function scoreParts(maps, gainsDb, cuts) {
  const m = maps.length, frames = maps[0].frames;
  const g = maps.map((_, i) => bandGains(gainsDb[i], cuts[i]));
  const root = (x) => Math.sqrt(Math.sqrt(x));
  let loudest = 0;
  const total = new Float64Array(B * frames);
  for (let i = 0; i < m; i++) { const e = maps[i].energy; for (let h = 0; h < frames; h++) for (let b = 0; b < B; b++) { const k = b + h * B; total[k] += g[i][b] * EAR[b] * e[k]; } }
  for (let k = 0; k < total.length; k++) if (total[k] > loudest) loudest = total[k];
  const floor = loudest * 1e-6, rootFloor = root(floor);
  const added = new Float64Array(m), alone = new Float64Array(m), inFrame = new Float64Array(frames);
  const each = Array.from({ length: m }, () => new Float64Array(frames));
  for (let i = 0; i < m; i++) {
    const e = maps[i].energy, row = each[i];
    for (let h = 0; h < frames; h++) for (let b = 0; b < B; b++) {
      const k = b + h * B, s = g[i][b] * EAR[b] * e[k], t = total[k];
      if (s <= 0 || t < floor) continue;
      alone[i] += root(s + floor) - rootFloor;
      row[h] += root(t + floor) - root(Math.max(0, t - s) + floor);
    }
    for (let h = 0; h < frames; h++) { added[i] += row[h]; inFrame[h] += row[h]; }
  }
  const sum = added.reduce((a, v) => a + v, 0);
  const holds = each.map((row, i) => {
    let top = 0, room = 0;
    for (const v of row) if (v > top) top = v;
    for (let h = 0; h < frames; h++) if (row[h] > ACTIVE * top) room += inFrame[h];
    return room > 0 ? added[i] / room : 0;
  });
  return { heard: Array.from(added, (v, i) => (alone[i] > 0 ? v / alone[i] : null)), share: Array.from(added, (v) => (sum > 0 ? v / sum : 0)), holds };
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
const isQuiet = (r) => r.category === 'fx' || r.category === 'ambience';
const heardGoal = (row, parts) => {
  if (row.category === 'vocals' && row.role === 'lead') return GOALS.heardVoice;
  if (isQuiet(row)) return GOALS.heardQuiet;
  return GOALS.heardShared / Math.max(2, parts);
};
// Drums keep the dynamics they came in with: compressing them and bringing the level back only lifts
// their hits, which the limiter then takes out of the whole mix. (On all three songs with drums.)
const heldComp = (row) => (row.category === 'drums' ? { comp: 0 } : {});
const swampGoal = (parts) => GOALS.swamp[parts] ?? GOALS.swamp.more;
const holdsGoals = (rows, parts) => rows.map((r) => (parts >= 2 && parts <= 4 && !isQuiet(r) && r.category !== 'drums' && r.category !== 'bass' ? GOALS.holds / parts : 0));

// A part that swamps the rest comes down first: often that alone clears the rest.
function solveSwamp(rows, maps, gains, cuts) {
  const m = rows.length, move = Float64Array.from(gains);
  const live = rows.map((r) => r.m.lufs > -70);
  const parts = live.filter(Boolean).length;
  if (parts < 2) return move;
  const limit = swampGoal(parts);
  for (let step = 0; step < 2 * MOVE_DOWN * m; step++) {
    const s = scoreParts(maps, move, cuts);
    let top = -1, most = limit;
    for (let i = 0; i < m; i++) if (live[i] && s.share[i] > most && move[i] > gains[i] - MOVE_DOWN) { most = s.share[i]; top = i; }
    if (top < 0) break;
    move[top] -= 0.5;
  }
  return move;
}

// Then a part still covered by the rest, or holding too little of the song, comes up.
function solveHeard(rows, maps, gains, cuts, start) {
  const m = rows.length, up = Float64Array.from(gains);
  const live = rows.map((r) => r.m.lufs > -70);
  const parts = live.filter(Boolean).length;
  const heard = rows.map((r) => heardGoal(r, parts)), holds = holdsGoals(rows, parts);
  for (let step = 0; step < 2 * MOVE_UP * m; step++) {
    const s = scoreParts(maps, up, cuts);
    let worst = -1, gap = 1;
    for (let i = 0; i < m; i++) {
      if (!live[i] || s.heard[i] == null || up[i] >= start[i] + MOVE_UP) continue;
      const g = Math.min(s.heard[i] / heard[i], holds[i] ? s.holds[i] / holds[i] : 1);
      if (g < gap) { gap = g; worst = i; }
    }
    if (worst < 0) break;
    up[worst] += 0.5;
  }
  return up;
}

// Then build-up, cut only on the stems that really hold that octave. Voices,
// drums and bass keep their body.
function solveCuts(rows, maps, levels, real) {
  const cuts = rows.map(() => []);
  const start = octaveLevels(maps, rows.map(() => 0), cuts);
  const predicted = () => { const now = octaveLevels(maps, levels, cuts); return real.map((v, i) => v + now[i] - start[i]); };
  for (let step = 0; step < 2 * CUT_MAX * CUT_STEMS; step++) {
    const hump = buildUpOf(predicted());
    if (hump.db <= GOALS.buildUp - CUT_AIM) break;
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

// The part furthest under a goal, by a ratio of what it has to what it needs.
function lowest(values, goals) {
  let at = -1;
  values.forEach((v, i) => { if (v != null && goals[i] > 0 && (at < 0 || v / goals[i] < values[at] / goals[at])) at = i; });
  return at;
}
const biggest = (s) => s.share.indexOf(Math.max(...s.share));
const BUSES = ['vocals', 'drums', 'bass', 'music', 'fx', 'ambience'];

/** Stems are read one at a time, then the whole is scored and the plan made. */
export class AutoSession {
  /** `rough`: a rough mix will be added, so what is needed to check it against the stems is kept. */
  constructor(sr, length, { rough = false, stems = 0 } = {}) {
    this.sr = sr;
    this.n = length;
    this.sum = [new Float32Array(length), new Float32Array(length)];
    this.maps = [];
    this.measures = [];
    this.hopSec = mapHop(length, sr);
    if (rough) {
      this.waveStep = waveStep(sr, length, Math.max(1, stems));
      this.waves = [];
      this.features = [];
    }
  }

  addStem(audio) {
    const src = audio.channels.length > 1 ? audio.channels.slice(0, 2) : [audio.channels[0], audio.channels[0]];
    const chs = src.map((c) => { const o = new Float32Array(this.n); o.set(c.subarray(0, Math.min(this.n, c.length))); return o; });
    for (let c = 0; c < 2; c++) { const s = this.sum[c], x = chs[c]; for (let i = 0; i < this.n; i++) s[i] += x[i]; }
    const m = measureStem(chs, this.sr);
    this.maps.push(stemMap(chs, this.sr, this.hopSec));
    this.measures.push(m);
    if (this.waves) {
      this.waves.push(waveCopy(chs, this.waveStep, this.n));
      this.features.push(stemFeatures(chs, this.sr));
    }
    return m;
  }

  /** The rough mix, if there is one. Whether it is used is decided in plan(). */
  setRough(audio) {
    this.roughWave = waveCopy(audio.channels, this.waveStep, this.n);
    this.roughFeat = roughFeatures(audio.channels, this.sr);
  }

  // The same check the mix itself makes, so the plan and the mix cannot disagree.
  roughFits(meta) {
    const read = meta.length > 1 ? readStemLevels(this.waves, this.roughWave, this.sr / this.waveStep) : null;
    const found = !!read && read.db.some((v) => v != null);
    const buses = {};
    meta.forEach((x, i) => { const k = BUSES.includes(x.category) ? x.category : 'music'; buses[k] = addFeatures(buses[k], this.features[i]); });
    return roughBelongs(fitBalance(buses, this.roughFeat), found);
  }

  /** meta: [{ name, category, role }] in the order the stems were added. */
  plan(meta) {
    const rows = meta.map((x, i) => ({ ...x, m: this.measures[i] }));
    const offered = !!this.roughFeat;
    const rough = offered && this.roughFits(meta);
    const whole = measureWhole(this.sum, this.sr);
    const board = { rangeStems: whole.lra, before: { buildUp: whole.buildUp, tilt: whole.tilt, limiter: whole.limiterNeed, mono: whole.monoLoss } };
    this.sum = this.waves = this.features = this.roughWave = this.roughFeat = null;
    const maps = this.maps;
    this.maps = null;
    // Your rough mix decides the balance and tone, so only the whole is scored.
    if (rough) {
      const { sliders, reasons } = autoMixSliders(rows, { rough: true });
      return { sliders, reasons, stems: rows.map((r) => ({ gainDb: 0, cuts: [], ...heldComp(r) })), board, hold: true };
    }

    const parts = rows.filter((r) => r.m.lufs > -70).length;
    const noCuts = rows.map(() => []);
    const zero = rows.map(() => 0);
    const first = scoreParts(maps, zero, noCuts);
    const swamp = solveSwamp(rows, maps, zero, noCuts);
    const raised = parts >= 2 ? solveHeard(rows, maps, swamp, noCuts, zero) : swamp;
    const cuts = parts >= 2 ? solveCuts(rows, maps, raised, whole.levels) : noCuts;
    const move = Array.from(parts >= 2 ? solveHeard(rows, maps, raised, cuts, zero) : raised);
    const last = scoreParts(maps, move, cuts);
    const names = meta.map((x) => plainName(x.name));

    const said = [];
    if (offered) said.push('Your rough mix did not line up with these stems, so it was set aside and the mix was planned from the stems alone. Check that it is a bounce of the same song from the same starting point.');
    cuts.forEach((c, i) => { if (c.length) said.push(`Too much builds up around ${c[0].freq} Hz, mostly from ${names[i]}, so it is cut ${(-c[0].gain).toFixed(1)} dB there.`); });
    let anyMove = false;
    move.forEach((v, i) => {
      if (!v) return;
      anyMove = true;
      if (v < 0) said.push(`${names[i]} swamped the rest, so it comes down ${(-v).toFixed(1)} dB.`);
      else said.push(`${names[i]} was covered by the rest, so it comes up ${v.toFixed(1)} dB.`);
    });
    const { sliders, reasons } = autoMixSliders(rows.map((r, i) => ({ ...r, gainDb: move[i] })), { moved: anyMove });
    // Tone only moves when the stems together sit outside what finished songs do.
    const [lo, hi] = GOALS.tilt;
    const now = octaveLevels(maps, move, cuts), start = octaveLevels(maps, zero, noCuts);
    const tilt = tiltOf(whole.levels.map((v, i) => v + now[i] - start[i]));
    if (tilt < lo) { sliders.highs = Math.min(HIGHS_MAX, Math.round((lo - tilt) * 10) / 20 + 0.1); said.push('The stems together are darker than finished songs, so the highs come up a little.'); }
    else if (tilt > hi) { sliders.highs = -Math.min(HIGHS_MAX, Math.round((tilt - hi) * 10) / 20 + 0.1); said.push('The stems together are brighter than finished songs, so the highs come down a little.'); }
    const unmoved = !anyMove && !cuts.some((c) => c.length) && !sliders.highs;
    if (unmoved) said.push('Played together, your stems already meet the balance and tone goals, so each one stays at its level.');

    const heardGoals = rows.map((r) => heardGoal(r, parts)), holds = holdsGoals(rows, parts);
    const lo0 = lowest(first.heard, heardGoals), lo1 = lowest(last.heard, heardGoals);
    if (lo0 >= 0 && lo1 >= 0) {
      const part = (values, goals, at) => ({ name: names[at], value: values[at], goal: goals[at] });
      board.before.heard = part(first.heard, heardGoals, lo0);
      board.after = { heard: part(last.heard, heardGoals, lo1) };
      const h0 = lowest(first.holds, holds), h1 = lowest(last.holds, holds);
      if (h0 >= 0 && h1 >= 0) {
        board.before.holds = part(first.holds, holds, h0);
        board.after.holds = part(last.holds, holds, h1);
      }
      if (parts >= 2) {
        const hi0 = biggest(first), hi1 = biggest(last);
        board.before.swamp = { name: names[hi0], value: first.share[hi0] };
        board.after.swamp = { name: names[hi1], value: last.share[hi1] };
        board.swampGoal = swampGoal(parts);
      }
    }
    return {
      sliders, reasons: [...said, ...reasons], hold: true, roughSetAside: offered,
      stems: rows.map((r, i) => ({ gainDb: move[i], cuts: cuts[i], ...heldComp(r) })),
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
    out.push(row('Every part comes through', `at least ${Math.round(a.goal * 100)}%`, pct(board.before.heard), pct(a), Math.round(a.value * 100) >= Math.round(a.goal * 100)));
  }
  if (board.before.holds) {
    const a = board.after.holds;
    out.push(row('Every part holds its place', `at least ${Math.round(a.goal * 100)}% of the loudness while it plays`, pct(board.before.holds), pct(a), Math.round(a.value * 100) >= Math.round(a.goal * 100)));
  }
  if (board.before.swamp) out.push(row('No part swamps the rest', `at most ${Math.round(board.swampGoal * 100)}% of the loudness`, pct(board.before.swamp), pct(board.after.swamp), Math.round(board.after.swamp.value * 100) <= Math.round(board.swampGoal * 100)));
  const [lo, hi] = GOALS.tilt;
  out.push(row('No build-up in one range', `at most ${GOALS.buildUp} dB over its neighbours`, `${db1(board.before.buildUp.db)} at ${board.before.buildUp.freq} Hz`, `${db1(whole.buildUp.db)} at ${whole.buildUp.freq} Hz`, r1(whole.buildUp.db) <= GOALS.buildUp));
  out.push(row('Tone like finished songs', `${lo} to ${hi} dB per octave`, db1(board.before.tilt), db1(whole.tilt), r1(whole.tilt) >= lo && r1(whole.tilt) <= hi));
  // (With the plan's moves in, as moving a stem changes the stems' own range.)
  const range = report.heldRange ?? board.rangeStems;
  out.push(row('Quiet and loud parts keep their shape', `at least ${Math.round(GOALS.shape * 100)}% of the stems’ range`, `${range.toFixed(1)} LU`, `${whole.lra.toFixed(1)} LU`, r1(whole.lra) >= r1(GOALS.shape * range)));
  out.push(row('Holds up in mono', `loses at most ${GOALS.mono} LU`, `${board.before.mono.toFixed(1)} LU`, `${whole.monoLoss.toFixed(1)} LU`, r1(whole.monoLoss) <= GOALS.mono));
  // Not a goal: stems that are already loud need this much at the finished level however well they are mixed.
  out.push(row('Limiter at the finished level', 'Not a goal, shown so you can see its work.', db1(board.before.limiter), db1(report.limiter?.maxGr ?? 0), null));
  return out;
}
