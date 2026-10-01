/* ==========================================================================
   ui/visualizer.js — spectrum canvases
   Three flavours share one smoothing model: a full hero spectrum with
   reflections and peak caps, a compact bar, and the sidebar strip.
   ========================================================================== */

import { addTask } from '../core/raf.js';
import { cssVar } from '../core/dom.js';
import { hexToRgb, rgba } from '../core/prng.js';

/** Log-ish mapping of bars onto FFT bins */
const binFor = (i, bars, bins) => Math.floor(((i / bars) ** 1.55) * (bins * 0.72));

/** 30fps is plenty for bars, and every saved frame is GPU time back */
const FRAME = 1 / 30;
/** re-measure the canvases at most this often (getBoundingClientRect forces layout) */
const MEASURE = 0.5;

class Bars {
  constructor(canvas, { bars = 48, mirrored = true, caps = true, min = 0.04 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = bars;
    this.mirrored = mirrored;
    this.caps = caps;
    this.min = min;
    this.values = new Float32Array(bars);
    this.peaks = new Float32Array(bars);
    this.a = hexToRgb(cssVar('--accent-a') || '#7c8cff');
    this.b = hexToRgb(cssVar('--accent-b') || '#c07cff');
    this.themeKey = '';
    this.acc = 0;
    this.measureIn = 0;
    this.grad = null;
    this.gradKey = '';
    this.cap = rgba([255, 255, 255], 0.55);
  }

  refreshTheme() {
    this.a = hexToRgb(cssVar('--accent-a') || '#7c8cff');
    this.b = hexToRgb(cssVar('--accent-b') || '#c07cff');
    this.grad = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round((rect.width || this.canvas.width) * dpr));
    const h = Math.max(1, Math.round((rect.height || this.canvas.height) * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.grad = null;
    }
    this.dpr = dpr;
  }

  /** @param {Uint8Array|null} spectrum  @param {number} dt */
  draw(spectrum, dt, active) {
    this.measureIn -= dt;
    if (this.measureIn <= 0) {
      this.resize();
      this.measureIn = MEASURE;
    }
    this.acc += dt;
    if (this.acc < FRAME && this.grad) return;
    const step = Math.min(this.acc, 0.2);
    this.acc = 0;
    dt = step;

    const { ctx, dpr } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!W || !H) return;

    /* Music is playing but there is no spectrum to read — a live radio stream
       bypasses the graph entirely, so the analyser sees nothing. Drawing the
       usual floor of stub bars would look like a real signal sitting at a
       constant low level, so show nothing instead. An idle player keeps its
       faint baseline; only "playing with no data" goes blank. */
    if (active && !spectrum) {
      this.values.fill(0);
      this.peaks?.fill(0);
      return;
    }

    const bins = spectrum ? spectrum.length : 0;
    const n = this.bars;
    const gap = Math.max(1, (W / n) * 0.28);
    const bw = (W - gap * (n - 1)) / n;
    const mid = this.mirrored ? H / 2 : H;
    const maxH = this.mirrored ? H / 2 - dpr * 2 : H - dpr * 2;

    /* the gradient only changes with the theme or the canvas size */
    if (!this.grad) {
      const grad = ctx.createLinearGradient(0, this.mirrored ? 0 : H, 0, H);
      grad.addColorStop(0, rgba(this.b, 0.95));
      grad.addColorStop(0.5, rgba(this.a, 0.9));
      grad.addColorStop(1, rgba(this.a, this.mirrored ? 0.5 : 0.95));
      this.grad = grad;
    }
    const grad = this.grad;

    for (let i = 0; i < n; i++) {
      let v = 0;
      if (spectrum && active) {
        const lo = binFor(i, n, bins);
        const hi = Math.max(lo + 1, binFor(i + 1, n, bins));
        let sum = 0;
        for (let k = lo; k < hi; k++) sum += spectrum[k];
        v = sum / (hi - lo) / 255;
      }
      v = Math.max(this.min, v ** 1.15);
      const cur = this.values[i];
      const target = active ? v : this.min;
      // fast attack, slow release
      this.values[i] = cur + (target - cur) * (target > cur ? Math.min(1, dt * 22) : Math.min(1, dt * 6));

      const h = Math.max(2 * dpr, this.values[i] * maxH);
      const x = i * (bw + gap);
      const r = Math.min(bw / 2, h / 2);

      ctx.fillStyle = grad;
      this.#roundRect(x, mid - h - (this.mirrored ? dpr : 0), bw, h, r);
      ctx.fill();

      if (this.mirrored) {
        ctx.globalAlpha = 0.32;
        this.#roundRect(x, mid + dpr, bw, h * 0.72, r);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      if (this.caps) {
        this.peaks[i] = Math.max(this.values[i], this.peaks[i] - dt * 0.34);
        const py = mid - h - (this.mirrored ? dpr : 0) - dpr * 1.6;
        ctx.fillStyle = this.cap;
        this.#roundRect(x, Math.max(0, py), bw, Math.max(1, dpr * 1.4), dpr);
        ctx.fill();
      }
    }
  }

  #roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}

/* ------------------------------ sidebar strip --------------------------- */
class SideStrip {
  constructor(container) {
    this.nodes = Array.from(container.querySelectorAll('i'));
    this.values = new Float32Array(this.nodes.length);
  }

  draw(spectrum, dt, active) {
    const n = this.nodes.length;
    if (!n) return;
    if (!spectrum) {
      /* Let the strip fall back to its idle height rather than freezing on
         whatever the last track drew — a live stream leaves no spectrum at
         all, and a frozen bar would be a leftover lie. */
      for (const el of this.nodes) {
        el.style.height = '8%';
        el.style.opacity = '0.35';
      }
      this.values?.fill(0);
      return;
    }
    this.acc = (this.acc || 0) + dt;
    if (this.acc < 1 / 20) return; // DOM writes — 20fps is plenty
    const step = Math.min(this.acc, 0.2);
    this.acc = 0;
    dt = step;
    const bins = spectrum.length;
    for (let i = 0; i < n; i++) {
      const lo = Math.floor(((i / n) ** 1.4) * bins * 0.55);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) / n) ** 1.4 * bins * 0.55));
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += spectrum[k];
      const v = active ? sum / (hi - lo) / 255 : 0.06;
      this.values[i] += (v - this.values[i]) * (v > this.values[i] ? 0.4 : 0.12) * (step * 60);
      const el = this.nodes[i];
      el.style.height = `${Math.max(8, Math.min(100, this.values[i] * 108))}%`;
      el.style.opacity = String(0.35 + this.values[i] * 0.6);
    }
  }
}

/* ------------------------------------------------------------------------ */
export function createVisualizers({ getSpectrum, isPlaying }) {
  const hero = new Bars(document.getElementById('hero-viz'), { bars: 56, mirrored: true, caps: true });
  const mini = new Bars(document.getElementById('bar-viz'), { bars: 30, mirrored: false, caps: false, min: 0.05 });
  const side = new SideStrip(document.getElementById('side-spectrum'));

  /* Столбики спектра не обязаны идти каждый кадр. Раньше они перерисовывались
     на каждом кадре браузера — 56 полос с градиентами, ещё 30, плюс запись в 16
     элементов боковой полоски, — то есть около сотни операций с оверхедом на
     каждый кадр ради картинки, которую глаз не отличает от тридцати в секунду.
     Полмига — это ровно то, как выглядит эквалайзер в большинстве плееров. */
  const FRAME = 1 / 30;
  let acc = 0;

  const stop = addTask((dt) => {
    if (document.hidden) {
      acc = 0;
      return;
    }
    acc += dt;
    if (acc < FRAME) return;
    acc = 0;
    const data = getSpectrum();
    const active = isPlaying();
    hero.draw(data, dt, active);
    mini.draw(data, dt, active);
    side.draw(data, dt, active);
  });

  /* re-measure immediately instead of waiting for the next poll tick */
  const onResize = () => {
    hero.measureIn = 0;
    mini.measureIn = 0;
  };
  window.addEventListener('resize', onResize);

  return {
    stop,
    refreshTheme() {
      hero.refreshTheme();
      mini.refreshTheme();
    },
  };
}
