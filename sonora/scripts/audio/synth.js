/* ==========================================================================
   audio/synth.js — generative music engine
   ----------------------------------------------------------------------------
   Каждый трек описан набором параметров (bpm, тоника, лад, настроение,
   сид). Движок детерминированно расписывает такты: аккорды, бас, арпеджио,
   мелодию и ударные. Никаких семплов — только осцилляторы и фильтры,
   поэтому плеер весит килобайты и звучит бесконечно.
   ========================================================================== */

import { rng } from '../core/prng.js';

export const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  majorPent: [0, 2, 4, 7, 9],
  minorPent: [0, 3, 5, 7, 10],
};

export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

/** Web Audio clamps out-of-range values with console warnings — do it ourselves */
const Hz = (f) => Math.min(Math.max(f, 20), 18000);

/** Scale degree (may be negative / > length) → midi note */
function degreeToMidi(root, scale, degree) {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  return root + scale[((degree % n) + n) % n] + 12 * oct;
}

const PROGRESSIONS = [
  [0, 5, 3, 4], // i – VI – iv – v
  [0, 3, 4, 3],
  [0, 2, 5, 4],
  [0, 5, 1, 4],
  [0, 4, 5, 3],
];

/* ==========================================================================
   Composer
   ========================================================================== */
export class Composer {
  constructor(track) {
    const t = track;
    this.track = t;
    this.scale = SCALES[t.scale] || SCALES.minorPent;
    this.root = t.root ?? 45;
    this.beat = 60 / (t.bpm || 80);
    this.barDur = this.beat * 4;
    this.mood = {
      brightness: 0.5,
      density: 0.5,
      drums: 0.4,
      reverb: 0.5,
      bass: 0.6,
      lead: 0.4,
      pluck: 0.5,
      ...(t.mood || {}),
    };

    /* the seed is per track, so a different seed is a different piece of music
       from otherwise identical settings — that is what the admin's
       "перегенерировать" button changes */
    const r = rng(`${t.seed ?? t.id}|sonora`);
    this.r = r;
    this.prog = r.pick(PROGRESSIONS);
    this.swing = 0.04 + r.next() * 0.14;
    this.useSeventh = r.chance(0.45);
    this.leadRange = r.pick([[7, 11], [7, 14], [9, 12]]);
    this.degree = r.int(0, this.scale.length);
    this.hatDivision = this.mood.drums > 0.7 ? 2 : 4; // 8ths or 16ths
    this.kickPattern = this.#kickPattern();
    this.snarePattern = this.#snarePattern();
    this.hatPattern = this.#hatPattern();
  }

  /* ------------------------- patterns per style ------------------------ */
  #kickPattern() {
    const d = this.mood.drums;
    if (d < 0.15) return [];
    if (d < 0.45) return [0, 8];
    if (d < 0.7) return [0, 7, 8];
    return [0, 6, 8, 11, 14];
  }

  #snarePattern() {
    const d = this.mood.drums;
    if (d < 0.12) return [];
    if (d < 0.45) return [4, 12];
    return [4, 12, 15];
  }

  #hatPattern() {
    const d = this.mood.drums;
    if (d < 0.2) return [];
    const step = this.hatDivision;
    const out = [];
    for (let i = 0; i < 16; i += step) {
      if (this.r.chance(0.86)) out.push({ step: i, open: i % 8 === 6 && this.r.chance(0.4) });
    }
    return out;
  }

  /* ----------------------------- harmony ------------------------------- */
  chordAt(bar) {
    const degree = this.prog[bar % this.prog.length];
    const tones = [degree + 7, degree + 9, degree + 11];
    if (this.useSeventh) tones.push(degree + 13);
    return tones;
  }

  /** Next melody note as a scale degree, with a bias towards chord tones */
  #nextDegree(chord) {
    const inChord = (d) => chord.some((c) => ((c - d) % this.scale.length + this.scale.length) % this.scale.length === 0);
    const dir = this.r.weighted([[1, 0.42], [-1, 0.42], [2, 0.1], [-2, 0.06]]);
    for (let attempt = 0; attempt < 6; attempt++) {
      const [lo, hi] = this.leadRange;
      const candidate = Math.max(lo, Math.min(hi, this.degree + dir));
      this.degree = candidate;
      if (inChord(candidate) || this.r.chance(0.55)) return candidate;
    }
    return this.degree;
  }

  /* ------------------------------ events ------------------------------- */
  /**
   * Build the event list for one bar. Times are relative to the bar start.
   * Pure function of bar index → seeking is instant and reproducible.
   */
  render(bar) {
    const ev = [];
    const B = this.beat;
    const chord = this.chordAt(bar);
    const sixteenth = B / 4;
    const barEnd = this.barDur;
    const m = this.mood;
    const fill = bar % 8 === 7;

    /* --- pad: one sustained chord per bar --- */
    if (m.reverb > 0.05) {
      for (const tone of chord) {
        ev.push({
          kind: 'pad',
          t: 0,
          dur: barEnd * 1.02,
          midi: degreeToMidi(this.root, this.scale, tone),
          vel: 0.16 + m.reverb * 0.1,
        });
      }
    }

    /* --- bass --- */
    if (m.bass > 0.1) {
      const pattern = this.r.weighted([
        [[0, 6, 8, 14], 0.4],
        [[0, 3, 8, 10], 0.35],
        [[0, 8], 0.25],
      ]);
      for (const step of pattern) {
        const degree = chord[0] + (step % 8 === 0 ? 0 : this.r.pick([0, 0, 2]));
        ev.push({
          kind: 'bass',
          t: step * sixteenth,
          dur: sixteenth * (this.r.chance(0.25) ? 3.2 : 1.7),
          midi: degreeToMidi(this.root, this.scale, degree) - 12,
          vel: 0.5 + m.bass * 0.25,
        });
      }
    }

    /* --- arpeggio / plucks --- */
    if (m.pluck > 0.15) {
      const div = m.density > 0.6 ? 1 : 2;
      for (let step = 0; step < 16; step += div) {
        if (!this.r.chance(0.32 + m.density * 0.42)) continue;
        const tone = this.r.pick(chord);
        const up = this.r.weighted([[7, 0.62], [12, 0.38]]);
        ev.push({
          kind: 'pluck',
          t: step * sixteenth,
          dur: sixteenth * 2.4,
          midi: degreeToMidi(this.root, this.scale, tone + up),
          vel: 0.2 + m.pluck * 0.16,
          swing: step % 2 === 1 ? this.swing * sixteenth : 0,
        });
      }
    }

    /* --- melody: sparse, one phrase every couple of bars --- */
    if (m.lead > 0.12 && bar % 2 === 0) {
      const steps = this.r.int(2, 5);
      let cursor = 0;
      for (let i = 0; i < steps; i++) {
        const degree = this.#nextDegree(chord);
        ev.push({
          kind: 'lead',
          t: cursor * sixteenth * 2,
          dur: sixteenth * 4,
          midi: degreeToMidi(this.root, this.scale, degree + 9),
          vel: 0.14 + m.lead * 0.14,
        });
        cursor += this.r.weighted([[1, 0.5], [2, 0.35], [3, 0.15]]);
        if (cursor > 14) break;
      }
    }

    /* --- bell accent at the top of every 4th bar --- */
    if (bar % 4 === 0) {
      ev.push({
        kind: 'bell',
        t: 0,
        dur: barEnd,
        midi: degreeToMidi(this.root, this.scale, chord[2] + 10),
        vel: 0.1,
      });
    }

    /* --- drums --- */
    if (this.kickPattern.length) {
      for (const step of this.kickPattern) ev.push({ kind: 'kick', t: step * sixteenth, vel: 0.85 });
      if (fill) ev.push({ kind: 'kick', t: 15 * sixteenth, vel: 0.5 });
    }
    for (const step of this.snarePattern) ev.push({ kind: 'snare', t: step * sixteenth, vel: 0.5 });
    if (fill && this.snarePattern.length) {
      for (let step = 12; step < 16; step += 1) {
        ev.push({ kind: 'snare', t: step * sixteenth, vel: 0.25 + this.r.next() * 0.25 });
      }
    }
    for (const h of this.hatPattern) {
      ev.push({
        kind: h.open ? 'openhat' : 'hat',
        t: h.step * sixteenth,
        vel: h.step % 4 === 0 ? 0.32 : 0.19,
      });
    }
    /* shaker 16ths keep the low-density grooves alive */
    if (m.drums > 0.25 && m.drums < 0.7) {
      for (let step = 2; step < 16; step += 4) {
        ev.push({ kind: 'shaker', t: step * sixteenth, vel: 0.14 });
      }
    }

    return ev;
  }
}

/* ==========================================================================
   Instrument voices
   Each takes (ctx, out, buses, ev, time, helpers) and builds real nodes.
   ========================================================================== */

function makeNoiseBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    // slight low-pass → warmer noise, less hiss
    last = last * 0.24 + white * 0.76;
    data[i] = last;
  }
  return buf;
}

const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    buf = makeNoiseBuffer(ctx);
    noiseCache.set(ctx, buf);
  }
  return buf;
}

function env(param, time, { a = 0.005, d = 0.1, s = 0, r = 0.08, peak = 1, dur = 0.2 }) {
  const hold = Math.max(0, dur - a - d);
  param.setValueAtTime(0.0001, time);
  param.linearRampToValueAtTime(peak, time + a);
  param.exponentialRampToValueAtTime(Math.max(s, 0.0001), time + a + d);
  if (hold > 0.001) param.setValueAtTime(Math.max(s, 0.0001), time + a + d + hold);
  param.exponentialRampToValueAtTime(0.0001, time + Math.max(dur, a + d + hold) + r);
}

function autoStop(node, time) {
  if (typeof node.stop === 'function') node.stop(time);
  if ('onended' in node) node.onended = () => node.disconnect();
}

/* ------------------------------ instruments ------------------------------ */
export const instruments = {
  kick(ctx, out, t, { vel = 0.8 }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(132, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    gain.gain.setValueAtTime(vel, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    osc.connect(gain).connect(out);
    osc.start(t);
    autoStop(osc, t + 0.45);

    // transient click
    const click = ctx.createBufferSource();
    click.buffer = noiseBuffer(ctx);
    const cf = ctx.createBiquadFilter();
    cf.type = 'highpass';
    cf.frequency.value = 1800;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(vel * 0.28, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    click.connect(cf).connect(cg).connect(out);
    click.start(t);
    autoStop(click, t + 0.04);
  },

  snare(ctx, out, t, { vel = 0.5 }, buses) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1750;
    bp.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    src.connect(bp).connect(gain).connect(out);
    if (buses.revSend) gain.connect(buses.revSend);
    src.start(t);
    autoStop(src, t + 0.2);

    const body = ctx.createOscillator();
    body.type = 'triangle';
    body.frequency.setValueAtTime(196, t);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(vel * 0.35, t);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    body.connect(bg).connect(out);
    body.start(t);
    autoStop(body, t + 0.12);
  },

  hat(ctx, out, t, { vel = 0.2 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    /* a lowpass on top keeps the noise from getting sibilant */
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 12000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel * 0.8, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    src.connect(hp).connect(lp).connect(gain).connect(out);
    src.start(t);
    autoStop(src, t + 0.06);
  },

  openhat(ctx, out, t, { vel = 0.2 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 11000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel * 0.7, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    src.connect(hp).connect(lp).connect(gain).connect(out);
    src.start(t);
    autoStop(src, t + 0.26);
  },

  shaker(ctx, out, t, { vel = 0.14 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4200;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vel * 0.85, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0.35;
    src.connect(hp).connect(lp).connect(gain).connect(pan).connect(out);
    src.start(t);
    autoStop(src, t + 0.12);
  },

  bass(ctx, out, t, ev, buses) {
    const freq = midiToFreq(ev.midi);
    const dur = ev.dur;
    const gain = ctx.createGain();
    env(gain.gain, t, { a: 0.012, d: dur * 0.5, s: ev.vel * 0.6, r: 0.09, peak: ev.vel * 0.5, dur });

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Hz(Math.min(freq * 8 + 220, 2600)), t);
    lp.frequency.exponentialRampToValueAtTime(Hz(Math.max(freq * 2.4, 90)), t + dur);
    lp.Q.value = 5;

    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq / 2;

    const g2 = ctx.createGain();
    g2.gain.value = 0.7;
    o1.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(gain).connect(out);
    o1.start(t);
    o2.start(t);
    autoStop(o1, t + dur + 0.12);
    autoStop(o2, t + dur + 0.12);
  },

  pad(ctx, out, t, ev, buses) {
    const freq = midiToFreq(ev.midi);
    const dur = ev.dur;
    const bright = buses.mood.brightness;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Hz(freq * (2.2 + bright * 3.2)), t);
    lp.frequency.linearRampToValueAtTime(Hz(freq * (3.4 + bright * 5)), t + dur * 0.55);
    lp.frequency.linearRampToValueAtTime(Hz(freq * 2), t + dur);
    lp.Q.value = 1.2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(ev.vel * 0.16, t + dur * 0.28);
    gain.gain.linearRampToValueAtTime(ev.vel * 0.11, t + dur * 0.8);
    gain.gain.linearRampToValueAtTime(0.0001, t + dur);

    // two detuned copies, panned apart → wide, glassy stereo
    for (const detune of [-7, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq * 2;
      const subG = ctx.createGain();
      subG.gain.value = 0.22;

      const pan = ctx.createStereoPanner();
      pan.pan.value = detune > 0 ? 0.45 : -0.45;
      osc.connect(pan);
      sub.connect(subG).connect(pan);
      pan.connect(lp);
      osc.start(t);
      sub.start(t);
      autoStop(osc, t + dur + 0.05);
      autoStop(sub, t + dur + 0.05);
    }
    lp.connect(gain).connect(out);
    if (buses.revSend) gain.connect(buses.revSend);
  },

  pluck(ctx, out, t, ev, buses) {
    const time = t + (ev.swing || 0);
    const freq = midiToFreq(ev.midi);
    const dur = ev.dur;

    const gain = ctx.createGain();
    env(gain.gain, time, { a: 0.004, d: dur * 0.6, r: 0.16, peak: ev.vel * 0.32, dur });

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Hz(freq * 3.4 + 700), time);
    lp.frequency.exponentialRampToValueAtTime(Hz(freq * 1.8 + 300), time + dur);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = Hz(freq);
    osc.detune.value = (Math.random() * 2 - 1) * 5;
    osc.connect(lp).connect(gain).connect(out);
    if (buses.delSend) gain.connect(buses.delSend);
    if (buses.revSend) gain.connect(buses.revSend);
    osc.start(time);
    autoStop(osc, time + dur + 0.2);
  },

  lead(ctx, out, t, ev, buses) {
    const time = t;
    const freq = midiToFreq(ev.midi);
    const dur = ev.dur;

    const gain = ctx.createGain();
    env(gain.gain, time, { a: 0.06, d: dur * 0.4, s: ev.vel * 0.5, r: 0.3, peak: ev.vel * 0.3, dur });

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Hz(freq * 4 + 500), time);
    lp.Q.value = 2;

    // vibrato for a human touch
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.2;
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, time);
    lfoGain.gain.linearRampToValueAtTime(6, time + dur * 0.6);

    for (const [type, mix] of [['sine', 1], ['triangle', 0.35]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = mix;
      lfo.connect(lfoGain).connect(osc.detune);
      osc.connect(g).connect(lp);
      osc.start(time);
      autoStop(osc, time + dur + 0.35);
    }
    lfo.start(time);
    autoStop(lfo, time + dur + 0.35);
    lp.connect(gain).connect(out);
    if (buses.revSend) gain.connect(buses.revSend);
  },

  bell(ctx, out, t, ev, buses) {
    const freq = midiToFreq(ev.midi);
    const dur = ev.dur;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(ev.vel * 0.3, t + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const partials = [1, 2.01, 3.02];
    for (let i = 0; i < partials.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = Hz(freq * partials[i]);
      const g = ctx.createGain();
      g.gain.value = 0.5 / (i + 1.4);
      osc.connect(g).connect(gain);
      osc.start(t);
      autoStop(osc, t + dur);
    }
    gain.connect(out);
    if (buses.revSend) gain.connect(buses.revSend);
  },
};
