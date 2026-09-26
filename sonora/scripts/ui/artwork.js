/* ==========================================================================
   ui/artwork.js — generative cover art
   Every track gets a unique, deterministic cover derived from its id:
   gradient + light blobs + a geometric motif + grain + vignette.
   Imported files use their embedded cover art when there is one.
   ========================================================================== */

import { rng, hexToRgb, rgba, mixRgb, rgbToHex, hsl } from '../core/prng.js';

const MASTER = 512;

function shade(hex, amount) {
  const rgb = hexToRgb(hex);
  const out = amount >= 0 ? mixRgb(rgb, [255, 255, 255], amount) : mixRgb(rgb, [0, 0, 0], -amount);
  return rgbToHex(out);
}

/* ------------------------------- motifs --------------------------------- */
const motifs = {
  rings(ctx, r, S) {
    const cx = S * r.range(0.3, 0.7);
    const cy = S * r.range(0.3, 0.7);
    const count = r.int(5, 9);
    const gap = S / (count * r.range(1.4, 2.4));
    ctx.lineWidth = Math.max(1, S / 420);
    for (let i = 1; i <= count; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, gap * i, 0, Math.PI * 2);
      ctx.strokeStyle = rgba([255, 255, 255], 0.05 + (1 - i / count) * 0.16);
      ctx.stroke();
    }
  },

  waves(ctx, r, S) {
    const lines = r.int(9, 16);
    const amp = S * r.range(0.03, 0.09);
    const freq = r.range(1.4, 3.2);
    const phase = r.range(0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, S / 380);
    for (let i = 0; i < lines; i++) {
      const y = (S / (lines + 1)) * (i + 1);
      ctx.beginPath();
      for (let x = -4; x <= S + 4; x += 6) {
        const yy = y + Math.sin((x / S) * Math.PI * freq + phase + i * 0.42) * amp * (1 - i / (lines * 1.4));
        if (x === -4) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.strokeStyle = rgba([255, 255, 255], 0.06 + (1 - i / lines) * 0.2);
      ctx.stroke();
    }
  },

  arcs(ctx, r, S) {
    const ox = S * r.range(-0.2, 1.2);
    const oy = S * r.range(-0.2, 1.2);
    const count = r.int(4, 7);
    ctx.lineWidth = Math.max(1.4, S / 300);
    for (let i = 1; i <= count; i++) {
      const rad = (S / count) * i * r.range(0.8, 1.15);
      const a0 = r.range(0, Math.PI * 2);
      ctx.beginPath();
      ctx.arc(ox, oy, rad, a0, a0 + r.range(1.1, 2.6));
      ctx.strokeStyle = rgba([255, 255, 255], 0.08 + (1 - i / count) * 0.22);
      ctx.stroke();
    }
  },

  dots(ctx, r, S) {
    const step = S / r.int(9, 15);
    const fx = r.range(0.3, 0.7);
    const fy = r.range(0.3, 0.7);
    for (let x = step; x < S; x += step) {
      for (let y = step; y < S; y += step) {
        const d = Math.hypot(x / S - fx, y / S - fy);
        const a = Math.max(0, 0.34 - d * 0.42);
        if (a <= 0.005) continue;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.6, step * 0.055 * (1 + a * 3)), 0, Math.PI * 2);
        ctx.fillStyle = rgba([255, 255, 255], a);
        ctx.fill();
      }
    }
  },

  bars(ctx, r, S) {
    const n = r.int(14, 26);
    const w = S / (n * 1.9);
    const base = S * r.range(0.72, 0.9);
    for (let i = 0; i < n; i++) {
      const h = S * r.range(0.12, 0.62) * (0.5 + 0.5 * Math.sin((i / n) * Math.PI * r.range(1, 2.4)));
      ctx.beginPath();
      ctx.roundRect(i * (w * 1.9) + w / 2, base - h, w, h, w / 2);
      ctx.fillStyle = rgba([255, 255, 255], 0.07 + (h / S) * 0.5);
      ctx.fill();
    }
  },
};

const MOTIF_NAMES = Object.keys(motifs);

/* ==========================================================================
   Renderer
   ========================================================================== */
export class ArtRenderer {
  constructor() {
    this.masters = new Map(); // trackId -> canvas
    this.images = new Map();  // coverUrl -> HTMLImageElement
  }

  /** Warm up cover images so they are ready before they are painted */
  preload(track) {
    if (!track?.coverUrl) return;
    if (this.images.has(track.coverUrl)) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = track.coverUrl;
    this.images.set(track.coverUrl, img);
  }

  master(track) {
    if (this.masters.has(track.id)) return this.masters.get(track.id);

    const S = MASTER;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    const r = rng(`${track.id}|art`);
    const [c1, c2] = track.colors || ['#6d7cff', '#b06bff'];

    /* base gradient */
    const angle = r.range(0, Math.PI * 2);
    const gx = Math.cos(angle);
    const gy = Math.sin(angle);
    const grad = ctx.createLinearGradient(
      S / 2 - gx * S * 0.6, S / 2 - gy * S * 0.6,
      S / 2 + gx * S * 0.6, S / 2 + gy * S * 0.6,
    );
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);

    /* light blobs */
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 4; i++) {
      const cx = S * r.range(-0.1, 1.1);
      const cy = S * r.range(-0.1, 1.1);
      const rad = S * r.range(0.3, 0.72);
      const col = i % 2 ? shade(c2, 0.25) : shade(c1, -0.2);
      const blob = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      blob.addColorStop(0, rgba(hexToRgb(col), 0.75));
      blob.addColorStop(0.55, rgba(hexToRgb(col), 0.22));
      blob.addColorStop(1, rgba(hexToRgb(col), 0));
      ctx.fillStyle = blob;
      ctx.fillRect(0, 0, S, S);
    }
    ctx.globalCompositeOperation = 'source-over';

    /* a third hue for depth, driven by the seed */
    const accent = rgbToHex(hsl(r.range(0, 360), 0.85, 0.6));
    ctx.globalCompositeOperation = 'overlay';
    const glow = ctx.createRadialGradient(S * r.range(0.2, 0.8), S * r.range(0.15, 0.5), 0, S * 0.5, S * 0.5, S * 0.8);
    glow.addColorStop(0, rgba(hexToRgb(accent), 0.5));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'source-over';

    /* motif */
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(r.range(-0.35, 0.35));
    ctx.translate(-S / 2, -S / 2);
    motifs[r.pick(MOTIF_NAMES)](ctx, r, S);
    ctx.restore();

    /* grain */
    const dots = 900;
    for (let i = 0; i < dots; i++) {
      const a = r.range(0.01, 0.06);
      ctx.fillStyle = rgba(r.chance(0.5) ? [255, 255, 255] : [0, 0, 0], a);
      ctx.fillRect(r.range(0, S), r.range(0, S), 1.4, 1.4);
    }

    /* top-left specular + vignette */
    const spec = ctx.createRadialGradient(S * 0.22, S * 0.16, 0, S * 0.22, S * 0.16, S * 0.8);
    spec.addColorStop(0, 'rgba(255,255,255,0.3)');
    spec.addColorStop(0.4, 'rgba(255,255,255,0.06)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(0, 0, S, S);

    const vig = ctx.createRadialGradient(S / 2, S * 0.45, S * 0.25, S / 2, S / 2, S * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, S, S);

    this.masters.set(track.id, canvas);
    return canvas;
  }

  /**
   * Paint a master cover into a DOM canvas, sized for the device pixel ratio.
   * Repeated calls with the same track are no-ops.
   */
  paint(canvas, track) {
    if (!track || canvas.__trackId === track.id) return;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || canvas.width || 128));
    const h = Math.max(1, Math.round(rect.height || canvas.height || 128));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const img = track.coverUrl ? this.images.get(track.coverUrl) : null;
    if (img?.complete && img.naturalWidth) {
      const side = Math.min(canvas.width, canvas.height);
      const scale = Math.max(side / img.naturalWidth, side / img.naturalHeight);
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      // keep a touch of the palette so the UI still feels unified
      ctx.fillStyle = rgba(hexToRgb(track.colors?.[0] || '#7c8cff'), 0.1);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.drawImage(this.master(track), 0, 0, canvas.width, canvas.height);
    }
    canvas.__trackId = track.id;
  }

  drop(track) {
    this.masters.delete(track.id);
  }
}

export const art = new ArtRenderer();
