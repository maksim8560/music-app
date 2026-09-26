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

  start(getLevel) {
    this.getLevel = getLevel;
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

    /* smooth colour transitions */
    for (let i = 0; i < 2; i++) {
      this.colors[i][0] = damp(this.colors[i][0], this.target[i][0], 1.1, dt);
      this.colors[i][1] = damp(this.colors[i][1], this.target[i][1], 1.1, dt);
      this.colors[i][2] = damp(this.colors[i][2], this.target[i][2], 1.1, dt);
    }
    this.base = [
      damp(this.base[0], this.baseTarget[0], 1.1, dt),
      damp(this.base[1], this.baseTarget[1], 1.1, dt),
      damp(this.base[2], this.baseTarget[2], 1.1, dt),
    ];

    const level = this.reactive && this.getLevel ? this.getLevel() : 0;
    /* A backdrop should breathe, not strobe. Following the low band with a fast
       coefficient made the whole screen pump on every kick drum, which reads as
       a flicker rather than as light. Slow enough that a beat lifts the glow
       over a second or two and lets it sink back between phrases. */
    this.energy = damp(this.energy, level, 1.1, dt);

    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = rgbCss(this.base);
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'screen';
    const boost = 1 + this.energy * 0.16;

    for (const b of this.blobs) {
      if (this.motion) b.step(dt, this.t);
      const cx = b.cx * w;
      const cy = b.cy * h;
      const rad = Math.max(w, h) * b.r * boost;
      const t = this.colors[b.index % 2];
      /* 1.2°/s: one pass through the wheel takes five minutes, so the tint
         shifts under the eye instead of chasing it */
      const hueShift = hsl((this.t * 1.2 + b.hue * 360) % 360, 0.75, 0.6);
      const col = mixRgb(t, hueShift, 0.12 + this.energy * 0.1);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, rgba(col, 0.5 + this.energy * 0.1));
      g.addColorStop(0.45, rgba(col, 0.16 + this.energy * 0.05));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.globalCompositeOperation = 'source-over';
    this.paletteDirty = false;
  }
}

const rgbCss = ([r, g, b]) => `rgb(${r | 0},${g | 0},${b | 0})`;

export const background = new Background(document.getElementById('bg-canvas'));
