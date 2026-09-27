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

  start(getLevel, getAir) {
    this.getLevel = getLevel;
    this.getAir = getAir || null;
    addTask((dt) => this.#frame(dt));
  }

  #frame(dt) {
    if (document.hidden) return;
    /* colours are still easing towards the target — keep drawing until settled */
    const settling =
      this.paletteDirty ||
      this.colors.some((c, i) => Math.abs(c[0] - this.target[i][0]) > 0.5 || Math.abs(c[2] - this.target[i][2]) > 0.5) ||
      Math.abs(this.base[0] - this.baseTarget[0]) > 0.5;
    if (!this.motion && !settling) return; // static backdrop: no repaints at all

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

    const level = this.reactive && this.getLevel ? this.getLevel() : 0;
    const air = this.reactive && this.getAir ? this.getAir() : 0;

    /* Two different rates on purpose. The floor follows the band's own average
       slowly, so it is the record's loudness and not its movement; the pulse is
       what sits above it. Rises fast enough to catch a beat, falls slower, so
       the light lifts and then settles instead of flickering. */
    this.floor = damp(this.floor, level, 0.25, dt);
    this.air = damp(this.air, air, 1.6, dt);

    const pulse = clamp01((level - this.floor) * 3.4) * 0.62 + this.air * 0.38;
    /* Back to rest when nothing is playing, so the site settles instead of
       holding the last glow forever. */
    const wanted = this.reactive ? pulse : 0;
    this.energy = damp(this.energy, wanted, 1.4, dt);
    /* a slow, wide swell for the big colour movement — separate from the pulse
       so the backdrop drifts over a phrase rather than pulsing with each beat */
    this.swell = damp(this.swell, wanted, 0.32, dt);

    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = rgbCss(this.base);
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'screen';
    /* the pulse moves the blobs' size, the swell their colour: two rates, so
       the backdrop never looks like one thing being turned up and down */
    const boost = 1 + this.energy * 0.3;

    for (const b of this.blobs) {
      if (this.motion) b.step(dt, this.t);
      const cx = b.cx * w;
      const cy = b.cy * h;
      const rad = Math.max(w, h) * b.r * boost;
      const t = this.colors[b.index % 2];
      /* 1.2°/s: one pass through the wheel takes five minutes, so the tint
         shifts under the eye instead of chasing it */
      const hueShift = hsl((this.t * 1.2 + b.hue * 360) % 360, 0.75, 0.6);
      const col = mixRgb(t, hueShift, 0.12 + this.swell * 0.26);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, rgba(col, 0.42 + this.energy * 0.24));
      g.addColorStop(0.45, rgba(col, 0.14 + this.swell * 0.12));
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

export const background = new Background(document.getElementById('bg-canvas'));
