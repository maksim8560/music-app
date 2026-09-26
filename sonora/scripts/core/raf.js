/* ==========================================================================
   core/raf.js — one rAF loop for the whole app
   Avoids dozens of independent animation frames competing for the GPU.
   ========================================================================== */

const tasks = new Set();
let running = false;
let last = 0;
let frameQueued = false;
let guard = 0;

/**
 * How long we wait for a real animation frame before driving the loop by hand.
 *
 * `requestAnimationFrame` is not a promise. A window that is occluded,
 * minimised, on another virtual desktop or in a power-saving mode can be
 * refused frames indefinitely, and a chain built only from rAF then stops for
 * good — no clock, no visualizers, no reactive background, until the tab is
 * touched. That is a silent freeze of half the interface.
 *
 * So every frame is requested both ways. When rAF behaves it wins the race and
 * cancels the timer; when it does not, the timer keeps the loop alive at a
 * modest rate instead of stopping dead.
 */
const GUARD_MS = 200;

/** Register a per-frame callback. cb(dt, now). Returns an unsubscribe fn. */
export function addTask(fn) {
  tasks.add(fn);
  if (!running) {
    running = true;
    last = performance.now();
    schedule();
  }
  return () => tasks.delete(fn);
}

function schedule() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(onFrame);
  clearTimeout(guard);
  guard = setTimeout(onGuard, GUARD_MS);
}

function onFrame(now) {
  clearTimeout(guard);
  frameQueued = false;
  step(now);
  if (running) schedule();
}

function onGuard() {
  if (!frameQueued) return; /* the real frame got there first */
  frameQueued = false;
  step(performance.now());
  if (running) schedule();
}

function step(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  for (const fn of tasks) {
    try {
      fn(dt, now);
    } catch (err) {
      console.error('[raf] task failed', err);
      tasks.delete(fn);
    }
  }
  if (!tasks.size) running = false;
}

/** Stop everything when the tab is hidden to save battery */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) last = performance.now();
});

export const isVisible = () => !document.hidden;
