/* ==========================================================================
   ui/background.js — reactive ambient backdrop
   A low-resolution canvas of drifting colour fields, gently pushed by the
   low-frequency energy of the music. CSS does the heavy blur.
   ========================================================================== */

import { addTask } from '../core/raf.js';
import { hexToRgb, mixRgb, rgba, hsl } from '../core/prng.js';
import { cssVar, damp } from '../core/dom.js';

const COUNT = 5;
const RES = 0.22; // internal resolution factor — upscaling to the viewport IS the blur
const FPS = 24; // slow-drifting colour fields don't need 60fps, and every repaint
                // forces the glass surfaces above to re-composite their blur
const FRAME = 1 / FPS;

class Blob {
  constructor(rand, index) {
    this.cx = rand();
    this.cy = rand();
    this.r = 0.3 + rand() * 0.34;
    this.vx = 0.02 + rand() * 0.05;
    this.vy = 0.015 + rand() * 0.045;
    this.phase = rand() * Math.PI * 2;
    this.speed = 0.06 + rand() * 0.12;
    this.hue = rand();
    this.index = index;
  }

  step(dt, t) {
    this.phase += dt * this.speed;
    this.cx = (this.cx + Math.cos(this.phase * 0.7) * this.vx * dt * 1.3 + 1) % 1;
    this.cy = (this.cy + Math.sin(this.phase) * this.vy * dt * 1.3 + 1) % 1;
  }
}

export class Background {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.blobs = [];
    this.colors = [hexToRgb('#7c8cff'), hexToRgb('#c07cff')];
    this.target = this.colors.map((c) => [...c]);
    this.base = hexToRgb(cssVar('--bg') || '#06060a');
    this.baseTarget = [...this.base];
    this.energy = 0;
    /* A backdrop should react to the *shape* of the music, not to how loud the
       record happens to be. An absolute level is useless for this: a mastered
       -loud track pins the low band at a constant 0.8, so the glow holds one
       value and the screen reads as static even though the music is moving.
       `floor` is a slow running average of that band, and the reaction is what
       stands above it — which is the beat, and which works the same on a quiet
       acoustic take and a loud club record. */
    this.floor = 0;
    this.air = 0;
    this.swell = 0;
    /* A beat is a transient, not a level, and a backdrop that ignores it looks
       dead next to one that answers it. The shape matters far more than the
       amount: this is a swell, not a flash. It opens over roughly 70ms and
       closes over roughly 180ms, which reads as the light breathing with the
       drums.

       The first attempt set it to full the instant an onset appeared and let it
       flicker away. At a few hits a second that is a strobe, and a strobe is a
       genuine problem for anyone sensitive to flashing light rather than a
       matter of taste — it was reported as "feels like a rave for an epileptic",
       which is exactly what it was. So: an attack that is quick but never
       instantaneous, a release slower than the attack, and a ceiling on how far
       the screen is allowed to move. */
    this.fast = 0;
    this.slow = 0;
    this.beat = 0;
    this.lastBeat = -1;
    /* 1 while nothing is playing: the backdrop goes grey and settles. */
    this.quiet = 1;
    this.reactive = true;
    this.motion = true;
    this.t = 0;
    this.resize();
  }

  resize() {
    const w = Math.max(120, Math.round(window.innerWidth * RES));
    const h = Math.max(120, Math.round(window.innerHeight * RES));
    this.canvas.width = w;
    this.canvas.height = h;
    this.w = w;
    this.h = h;
    this.#seed();
  }

  #seed() {
    this.blobs = Array.from({ length: COUNT }, (_, i) => {
      const b = new Blob(Math.random, i);
      return b;
    });
  }

  /** Blend the backdrop towards a track's palette */
  setPalette(track) {
    if (!track?.colors) return;
    this.target = track.colors.map((c) => hexToRgb(c));
    this.baseTarget = mixRgb(this.baseTarget, hexToRgb(track.colors[0]), 0.22);
    this.paletteDirty = true;
  }

  setThemeBase(hex) {
    this.baseTarget = hexToRgb(hex);
    this.paletteDirty = true;
  }

  start(getLevel, getAir, isPlaying) {
    this.getLevel = getLevel;
    this.getAir = getAir || null;
    this.isPlaying = isPlaying || null;
    /* the system setting, not our own: somebody who has asked the whole desktop
       for less motion should not have to find a switch in this site as well */
    const prefers = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (prefers) {
      this.calm = prefers.matches;
      prefers.addEventListener?.('change', (e) => { this.calm = e.matches; });
    }
    addTask((dt) => this.#frame(dt));
  }

  #frame(dt) {
    if (document.hidden) return;
    /* Someone who has asked their operating system for less motion gets a
       backdrop that does not move with the music at all. It is the same reason
       the beat detector is gone: a screen that pulses with the drums is a real
       problem for people who are sensitive to it, and the setting is already
       there, so honour it instead of making someone find a toggle. */
    const still = this.motion === false || this.calm;
    /* colours are still easing towards the target — keep drawing until settled */
    const settling =
      this.paletteDirty ||
      this.colors.some((c, i) => Math.abs(c[0] - this.target[i][0]) > 0.5 || Math.abs(c[2] - this.target[i][2]) > 0.5) ||
      Math.abs(this.base[0] - this.baseTarget[0]) > 0.5;
    if (!this.motion && !settling) return; // static backdrop: no repaints at all
    if (still && !settling) return;

    this.acc = (this.acc || 0) + dt;
    if (this.acc < FRAME) return; // cap the repaint rate
    const step = Math.min(this.acc, 0.25);
    this.acc = 0;
    dt = step;
    this.t += dt;

    /* Smooth colour transitions. Slower than the pulse on purpose: a track
       change should arrive as a shift in the light over several seconds, not as
       a step the eye catches. */
    for (let i = 0; i < 2; i++) {
      this.colors[i][0] = damp(this.colors[i][0], this.target[i][0], 0.45, dt);
      this.colors[i][1] = damp(this.colors[i][1], this.target[i][1], 0.45, dt);
      this.colors[i][2] = damp(this.colors[i][2], this.target[i][2], 0.45, dt);
    }
    this.base = [
      damp(this.base[0], this.baseTarget[0], 0.45, dt),
      damp(this.base[1], this.baseTarget[1], 0.45, dt),
      damp(this.base[2], this.baseTarget[2], 0.45, dt),
    ];

    const playing = this.reactive && this.isPlaying ? this.isPlaying() : !this.reactive;
    const level = !still && this.reactive && this.getLevel ? this.getLevel() : 0;
    const air = !still && this.reactive && this.getAir ? this.getAir() : 0;

    /* The floor is the record's own average, followed slowly, so it is the
       loudness rather than the movement. Everything the eye reacts to is what
       stands above it. */
    this.floor = damp(this.floor, level, 0.25, dt);
    this.slow = damp(this.slow, level, 1.1, dt);
    this.air = damp(this.air, air, 1.0, dt);

    /* The beat itself. A quick follower chases the band, a slow one trails it,
       and the distance between them is the transient — a kick or a snare is
       exactly that: a spike the running average never sees. A short refractory
       window keeps one hit from being counted three times. */
    this.fast = damp(this.fast, level, 16, dt);
    if (playing && !still && this.fast - this.slow > 0.022 && this.t - this.lastBeat > 0.14) {
      this.lastBeat = this.t;
      this.beat = 1;
    }
    /* the swell: quick to open, slower to close, and never a step */
    this.beat = this.beat > 0 ? damp(this.beat, 0, 5.5, dt) : damp(this.beat, 0, 18, dt);
    this.beat = Math.min(this.beat, 0.92);

    const pulse = clamp01((level - this.floor) * 3.2) * 0.55 + this.air * 0.45;
    const wanted = this.reactive ? pulse : 0;
    this.energy = damp(this.energy, wanted, 0.85, dt);
    this.swell = damp(this.swell, wanted, 0.3, dt);
    /* and the colour drains away as the music does, so silence looks like
       silence instead of like the track still playing quietly */
    this.quiet = damp(this.quiet, playing && this.reactive ? 0 : 1, 0.5, dt);

    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = rgbCss(this.base);
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'screen';
    /* Three contributions, all of them bounded. The beat swells the light, the
       pulse breathes it, and the swell shifts its colour. The beat carries the
       most weight because that is what the eye reads as "the music is here",
       but it is a wavefront crossing a soft gradient, not a flashbulb. */
    const boost = 1 + this.energy * 0.22 + this.beat * 0.3;
    const dim = 1 - this.quiet * 0.42;

    for (const b of this.blobs) {
      if (this.motion) b.step(dt, this.t);
      const cx = b.cx * w;
      const cy = b.cy * h;
      const rad = Math.max(w, h) * b.r * boost;
      const t = this.colors[b.index % 2];
      /* 1.2°/s: one pass through the wheel takes five minutes, so the tint
         shifts under the eye instead of chasing it */
      const hueShift = hsl((this.t * 1.2 + b.hue * 360) % 360, 0.75, 0.6);
      let col = mixRgb(t, hueShift, 0.12 + this.swell * 0.3);
      /* silence drains the colour toward grey rather than just dimming it, so
         a paused site reads as still and a playing one as alive */
      if (this.quiet > 0.002) col = mixRgb(col, greyOf(col), this.quiet * 0.82);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, rgba(col, (0.5 + this.energy * 0.3 + this.beat * 0.34) * dim));
      g.addColorStop(0.45, rgba(col, (0.18 + this.swell * 0.16 + this.beat * 0.12) * dim));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.globalCompositeOperation = 'source-over';
    this.paletteDirty = false;
  }
}

const rgbCss = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** the same colour with all its colour taken out — what silence looks like */
const greyOf = ([r, g, b]) => {
  const y = r * 0.299 + g * 0.587 + b * 0.114;
  return [y, y, y];
};

export const background = new Background(document.getElementById('bg-canvas'));
