/* ==========================================================================
   core/dom.js — tiny DOM + math helpers used across the app
   ========================================================================== */

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * Hyperscript helper.
 * el('div', { class: 'x', onclick: fn }, 'text', el('span'))
 */
export function el(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Build an <svg><use href="#i-name"/></svg> string */
export const icon = (name, size = 18) =>
  `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/** Create a canvas already sized for the device pixel ratio */
export function hidpiCanvas(canvas, cssW, cssH, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Observe an element's box and call back with { width, height } in CSS px */
export function onResize(target, cb) {
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const r = e.contentRect;
      if (r.width > 0 && r.height > 0) cb(r.width, r.height);
    }
  });
  ro.observe(target);
  return () => ro.disconnect();
}

/* ------------------------------- math ----------------------------------- */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

/** Frame-rate independent exponential smoothing */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/* ------------------------------ format ---------------------------------- */
/** 0:07 / 12:34 / 1:02:03 */
export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/** Long form for the palette: «4 трека» */
export function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/* ----------------------------- listeners -------------------------------- */
/**
 * Add a listener, passive by default (best for scroll/touch).
 *
 * `submit` and `beforeunload` must stay non-passive: `preventDefault()` is
 * ignored inside a passive handler, so a passive submit listener could never
 * stop the browser from navigating.
 */
export function on(target, type, handler, opts) {
  const options = typeof opts === 'object' ? opts : { passive: type !== 'mouseenter' && type !== 'mouseleave' && type !== 'focus' && type !== 'blur' && type !== 'keydown' && type !== 'keyup' && type !== 'submit' && type !== 'beforeunload' };
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Trailing-edge throttle driven by the shared rAF ticker */
export function throttleFrame(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a CSS custom property (trimmed) from :root */
export function cssVar(name, root = document.documentElement) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/** Escape for innerHTML interpolation */
export const esc = (str) =>
  String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Fuzzy subsequence match. Returns { score, marks } or null */
export function fuzzy(needle, haystack) {
  if (!needle) return { score: 0, marks: [] };
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (!h) return null;
  if (h === n) return { score: 1000, marks: [...Array(h.length).keys()] };

  const marks = [];
  let score = 0;
  let hi = 0;
  let streak = 0;

  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    marks.push(found);
    // reward: start of string, start of word, consecutive hits
    if (found === 0) score += 24;
    else if (/[\s\-–—/(]/.test(h[found - 1])) score += 14;
    streak = found === hi ? streak + 1 : 0;
    score += 6 + streak * 4;
    score -= Math.min(found - hi, 8);
    hi = found + 1;
  }
  score -= (h.length - n.length) * 0.12;
  return { score, marks: marks.sort((a, b) => a - b) };
}
