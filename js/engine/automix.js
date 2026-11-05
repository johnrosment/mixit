// Auto mix and Auto master: measurements become positions for the Easy sliders,
// each with a plain reason. Moves stay small and only follow clear evidence, so
// anything in doubt stays where it changes nothing. Echo, tape and hiss are
// creative choices and are never set here.

import { measureLoudness, truePeak } from './loudness.js';
import { ltas } from './spectral.js';
import { noiseProfile } from './repair.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const step = (v) => Math.round(v * 20) / 20;
const db = (p) => 10 * Math.log10(p + 1e-20);

/** What Auto needs to know about one stem. Band powers are absolute and scaled by how long the stem plays. */
export function measureStem(chs, sr, { noise = false } = {}) {
  const spec = ltas(chs, sr, { gateDb: -70 });
  const binHz = sr / spec.N;
  const band = (lo, hi) => {
    let p = 0;
    for (let k = Math.ceil(lo / binHz); k <= Math.min(spec.power.length - 1, Math.floor(hi / binHz)); k++) p += spec.power[k];
    return p;
  };
  const L = chs[0], R = chs[1] || chs[0], n = L.length;
  let ll = 0, rr = 0, lr = 0;
  for (let i = 0; i < n; i++) { ll += L[i] * L[i]; rr += R[i] * R[i]; lr += L[i] * R[i]; }
  const totalFrames = Math.max(1, Math.floor(n / (spec.N / 2)));
  const loud = measureLoudness(chs, sr, { series: false });
  const scale = spec.frames / totalFrames;
  const nf = noise ? noiseProfile(chs, sr) : null;
  return {
    lufs: loud.integrated,
    lra: loud.lra,
    crest: truePeak(chs, sr).dbtp - loud.integrated,
    correlation: ll && rr ? lr / Math.sqrt(ll * rr) : 1,
    noiseDb: nf?.qualified ? nf.floorDbfs : null,
    bands: {
      all: band(30, 18000) * scale, lows: band(40, 120) * scale, body: band(200, 800) * scale,
      words: band(1000, 4000) * scale, bright: band(2000, 5000) * scale, air: band(6000, 16000) * scale,
    },
  };
}

// The balance a video mix will set (see POST_TARGETS in mix.js), to judge stems as they will sit together.
const POST_TARGETS = { vocals: -20, drums: -27, bass: -27, music: -25, fx: -26, ambience: -32 };
const BALANCE = 0.75;
function balancedBands(rows, targets) {
  const lufs = {};
  for (const r of rows) lufs[r.category] = (lufs[r.category] || 0) + (r.m.lufs > -70 ? Math.pow(10, r.m.lufs / 10) : 0);
  const out = {};
  for (const r of rows) {
    const bus = db(lufs[r.category] || 0);
    const g = bus > -70 ? Math.pow(10, (BALANCE * ((targets[r.category] ?? -24) - bus)) / 10) : 1;
    const o = (out[r.category] ||= {});
    for (const [k, p] of Object.entries(r.m.bands)) o[k] = (o[k] || 0) + p * g;
  }
  return out;
}
// A song stays at the balance it came in at, with the plan's moves.
function heldBands(rows) {
  const out = {};
  for (const r of rows) {
    const g = Math.pow(10, (r.gainDb || 0) / 10);
    const o = (out[r.category] ||= {});
    for (const [k, p] of Object.entries(r.m.bands)) o[k] = (o[k] || 0) + p * g;
  }
  return out;
}
const sumBands = (byBus, keys, band) => keys.reduce((a, k) => a + (byBus[k]?.[band] || 0), 0);
const loudestFirst = (rows) => [...rows].sort((a, b) => b.m.lufs - a.m.lufs);
export const leadOf = (rows) => loudestFirst(rows.filter((r) => r.category === 'vocals' && r.role === 'lead'))[0] || loudestFirst(rows.filter((r) => r.category === 'vocals'))[0] || null;
// Below this much correlation a stem already has its own space (stereo reverb or a wide patch).
const spaceOf = (rows) => {
  let e = 0, w = 0;
  for (const r of rows) { const g = Math.pow(10, r.m.lufs / 10); e += g * r.m.correlation; w += g; }
  return w ? e / w : 1;
};
function clarityFor(lead, reasons, word) {
  const tilt = db(lead.m.bands.bright) - db(lead.m.bands.body);
  if (tilt < -22) { reasons.push(`The ${word} sounds a little dull, so its clarity comes up.`); return 0.4; }
  if (tilt > -6) { reasons.push(`The ${word} is already bright, so its clarity comes down a little.`); return -0.3; }
  return 0;
}

/**
 * Sliders for a song. rows: [{ category, role, m, gainDb }], gainDb being what the plan moved.
 * With a rough mix, its balance and tone stand. The song's overall tone is the plan's to judge.
 */
export function autoMixSliders(rows, { rough = false, moved = false } = {}) {
  const live = rows.filter((r) => r.m.lufs > -70);
  const has = (c) => live.some((r) => r.category === c);
  const reasons = [];
  const e = { vocal: 0, clarity: 0, lows: 0, highs: 0, punch: 0.5, verb: 0.4, echo: 0, tape: 0 };
  const lead = leadOf(live);
  const others = ['drums', 'bass', 'music', 'fx'];
  const by = heldBands(live);

  if (lead) {
    if (!rough && others.some(has)) {
      const margin = db(sumBands(by, ['vocals'], 'words')) - db(sumBands(by, others, 'words'));
      if (margin < -4) { e.vocal = step(Math.min(0.5, (-4 - margin) / 8)); reasons.push('The music covers the voice, so the vocal comes up.'); }
      else if (margin > 7) { e.vocal = -0.25; reasons.push('The vocal stands well clear of the music, so it comes down a little.'); }
    }
    e.clarity = clarityFor(lead, reasons, 'voice');
  }
  // Lows only move where something carries them: a piece of held pads is meant to sound that way.
  if (!rough && (has('drums') || has('vocals')) && (has('drums') || has('bass'))) {
    const keys = Object.keys(by);
    const lows = db(sumBands(by, keys, 'lows')) - db(sumBands(by, keys, 'all'));
    if (lows < -18) { e.lows = 0.2; reasons.push('The low end is light, so the lows come up a little.'); }
    else if (lows > -3) { e.lows = -0.2; reasons.push('The low end is heavy, so the lows come down a little.'); }
  }
  if (has('drums')) {
    const drums = loudestFirst(live.filter((r) => r.category === 'drums'))[0];
    if (drums.m.crest < 12) { e.punch = 0.65; reasons.push('The drums are already squashed, so they get a little more punch.'); }
    reasons.push('The drums keep the dynamics they came in with, so the limiter has less to do.');
  }
  // Space: the voice decides if there is one; otherwise how wide the instruments already are.
  if (lead) {
    if (lead.m.correlation < 0.75) { e.verb = 0.15; reasons.push('The voice already has its own space, so reverb stays low.'); }
  } else {
    const dry = spaceOf(live.filter((r) => !['bass', 'drums'].includes(r.category)));
    if (!has('drums') && dry < 0.8) { e.verb = 0; reasons.push('Your stems already have their own space, so reverb stays off.'); }
    else if (dry < 0.8) { e.verb = 0.1; reasons.push('Your stems already have their own space, so reverb stays low.'); }
    else e.verb = 0.25;
  }
  if (rough) reasons.push('Your rough mix sets the balance and tone.');
  else if (moved && rows.length > 1 && rows.every((r) => r.m.lufs + r.m.crest > -1)) reasons.push('Every stem peaks right at the top, so they were probably levelled one by one, which may be why some had to move. If you have the finished song, add it as your rough mix and MIXIT will read each stem’s level from it.');
  if (!has('vocals') && !has('drums')) reasons.push('No drums or vocals to make room for, so clean-up and glue stay off.');
  if (!reasons.length) reasons.push('Everything measures well, so the sliders stay at their usual places.');
  return { sliders: e, reasons };
}

/** Sliders for a video, ad or podcast. Where it is going stays your choice. */
export function autoPostSliders(rows) {
  const live = rows.filter((r) => r.m.lufs > -70);
  const reasons = [];
  const e = { clarity: 0, even: 0.6, clean: 0, music: 0, under: 0.5, fx: 0, amb: 0 };
  const voices = live.filter((r) => r.category === 'vocals');
  if (!voices.length) {
    reasons.push('There is no dialogue, so nothing needs to make room.');
    return { sliders: e, reasons };
  }
  const lead = loudestFirst(voices)[0];
  e.clarity = clarityFor(lead, reasons, 'voice');
  // Phrase-to-phrase range sets how much the voices are evened out.
  const lra = Math.max(...voices.map((r) => r.m.lra || 0));
  e.even = step(clamp(0.3 + 0.04 * lra, 0.35, 0.8));
  if (lra > 11) reasons.push('The voices swing between quiet and loud, so they are evened out more.');
  else if (lra < 3) reasons.push('The voices are already steady, so they are evened out less.');
  // Steady sound in the pauses means room noise or hiss.
  const noise = Math.max(...voices.map((r) => r.m.noiseDb ?? -200));
  if (noise > -65) {
    e.clean = step(clamp((noise + 65) / 25, 0.15, 0.6));
    reasons.push('There is steady noise under the voices, so clean-up is on.');
  }
  if (live.some((r) => r.category === 'music')) {
    const by = balancedBands(live, POST_TARGETS);
    const margin = db(sumBands(by, ['vocals'], 'words')) - db(sumBands(by, ['music'], 'words'));
    if (margin < 0) { e.under = 0.7; reasons.push('The music fills the range the words use, so it drops further under them.'); }
    else if (margin > 8) { e.under = 0.3; reasons.push('The music leaves the words plenty of room, so it drops less.'); }
  }
  return { sliders: e, reasons };
}

/**
 * Sliders for a master, from the analysis of the song. The tone itself is
 * already set from the same analysis on every Easy master, so Lows only moves
 * here for a clear case. `extra` holds settings with no slider of their own.
 */
export function autoMasterSliders(a, { reference = false } = {}) {
  const s = a.suggestions.settings;
  const reasons = [];
  const extra = {};
  const e = { lows: 0, highs: 0, punch: 0.5, width: 0.5, clean: 0, verb: 0, tape: 0, hiss: 0 };
  const crest = a.level.bodyCrestDb ?? a.level.crestDb;
  const beat = a.rhythm?.confidence ?? 0;
  const I = a.loudness.integrated;
  // Already limited to a finished level, or held sounds with no steady beat
  // (compressors only ride the quiet and loud parts, and held notes look like
  // harsh or boxy spots): level and peaks only.
  const finished = I > -14 && (a.level.plrDb <= 11 || (I > -11 && crest < 11));
  const held = beat < 0.2 && crest < 16;
  if (finished || held) {
    Object.assign(extra, { hpf: 0, glue: 0, multiband: 0, nasalCut: 0, harshCut: 0, deMud: 0, tilt: 0, air: 0, exciter: 0, deess: 0, monoBass: 0, hfReserve: 0, balanceRepair: false });
    if (finished) reasons.push('It is already at a finished level, so only its level is set.');
    else reasons.push(`It has no steady beat, so compression and clean-up stay off${reference ? '' : ', and its tone stays as it is'}.`);
    if (reference) reasons.push('Your reference song sets the overall tone.');
    return { sliders: e, extra, reasons };
  }
  const st = a.stereo;
  if (st.sideToMidDb > -40) {
    if (st.correlation < 0.25) { e.width = 0.35; reasons.push('It is very wide already, so the width comes in a little to hold up in mono.'); }
    else if (st.sideToMidDb < -18) { e.width = 0.65; reasons.push('It is quite narrow, so the width opens up a little.'); }
  }
  e.clean = step(clamp(((s.resonance ?? 0.3) - 0.15) / 0.5, 0, 0.6));
  if (e.clean < 0.15) reasons.push('Nothing harsh or boxy stands out, so clean-up stays low.');
  else if (e.clean > 0.35) reasons.push('Harsh spots stand out, so clean-up goes up.');

  if (beat > 0.3 && crest < 13) { e.punch = 0.6; reasons.push('The hits are a little flat, so punch comes up slightly.'); }
  if (reference) reasons.push('Your reference song sets the overall tone.');
  else {
    const { centers, levels } = a.spectrum.bands;
    let lows = 0, all = 0;
    centers.forEach((f, i) => { const p = Math.pow(10, levels[i] / 10); all += p; if (f >= 40 && f <= 120) lows += p; });
    const share = db(lows) - db(all);
    if (beat > 0.3 && share < -24) { e.lows = 0.2; reasons.push('The low end is light, so the lows come up a little.'); }
    else if (beat > 0.3 && share > -2) { e.lows = -0.2; reasons.push('The low end is heavy, so the lows come down a little.'); }
    const tilt = s.tilt || 0;
    if (tilt > 0) reasons.push('It leans dark, so the tone is brightened gently.');
    else if (tilt < 0) reasons.push('It leans bright, so the tone is darkened gently.');
    else reasons.push('The tone is well balanced, so it stays as it is.');
  }
  return { sliders: e, extra, reasons };
}
