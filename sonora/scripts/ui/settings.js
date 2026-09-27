/* ==========================================================================
   ui/settings.js — theme, accent, mixer settings, modal sheets
   ========================================================================== */

import { on } from '../core/dom.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { engine } from '../audio/engine.js';
import { openSheet, closeSheet, initSheet } from './sheet.js';
import { toast } from './toast.js';
import { background } from './background.js';

const settingsSheet = document.getElementById('settings-sheet');
const queueSheet = document.getElementById('queue-sheet');
const themeMeta = document.querySelector('meta[name="theme-color"]');

export const openSettingsSheet = () => openSheet(settingsSheet);
export const openQueueSheet = () => openSheet(queueSheet);

/* ------------------------------- theming -------------------------------- */
export function applyTheme() {
  const { theme, accent, motion, reactive } = store.state.settings;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = accent;
  root.dataset.motion = motion ? 'on' : 'off';

  const base = theme === 'dark' ? '#06060a' : '#e8eaf2';
  themeMeta?.setAttribute('content', base);
  background.setThemeBase(base);
  background.reactive = reactive;

  const btn = document.getElementById('btn-theme');
  btn.querySelector('use')?.setAttribute('href', theme === 'dark' ? '#i-moon' : '#i-sun');
  btn.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
}

/** the palette a wash should carry for a given theme */
const WASH = {
  light: { in: '#ffffff', mid: '#eef0f8', out: 'rgba(255,255,255,0)' },
  dark: { in: '#0a0a12', mid: '#10101c', out: 'rgba(10,10,18,0)' },
};

let washTimer = 0;

/**
 * Spread the new theme across the page from a point, then let it dissipate.
 *
 * The real theme is swapped a third of the way through, while the disc is
 * opaque and covering most of the viewport, so what the eye sees is the colour
 * arriving and thinning rather than a cut. Called with no point - the keyboard
 * shortcut - the change comes from the middle of the page, which reads better
 * than an arbitrary corner nobody was looking at.
 */
function runThemeWash(next, x, y) {
  const wash = document.getElementById('theme-wash');
  if (!wash) return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;

  const palette = WASH[next] || WASH.dark;
  wash.style.setProperty('--wash-x', `${Math.round(x)}px`);
  wash.style.setProperty('--wash-y', `${Math.round(y)}px`);
  wash.style.setProperty('--wash-in', palette.in);
  wash.style.setProperty('--wash-mid', palette.mid);
  wash.style.setProperty('--wash-out', palette.out);

  clearTimeout(washTimer);
  /* restart the animation even if it was mid-flight */
  wash.removeAttribute('data-run');
  void wash.offsetWidth;
  wash.setAttribute('data-run', '');

  washTimer = setTimeout(() => {
    store.patchSettings({ theme: next });
    applyTheme();
    setTimeout(() => wash.removeAttribute('data-run'), 900);
  }, 300);
  return true;
}

export function toggleTheme(at) {
  const next = store.get('settings').theme === 'dark' ? 'light' : 'dark';
  const x = at && at.clientX ? at.clientX : window.innerWidth / 2;
  const y = at && at.clientY ? at.clientY : window.innerHeight / 2;
  /* no wash available - fall back to the plain switch rather than swallowing it */
  if (!runThemeWash(next, x, y)) {
    store.patchSettings({ theme: next });
    applyTheme();
  }
}

/* -------------------------------- init ---------------------------------- */
export function initSettings(hooks = {}) {
  initSheet(settingsSheet);
  initSheet(queueSheet);

  const crossfade = document.getElementById('set-crossfade');
  const crossfadeVal = document.getElementById('val-crossfade');
  const volume = document.getElementById('set-volume');
  const volumeVal = document.getElementById('val-volume');
  const motion = document.getElementById('set-motion');
  const reactive = document.getElementById('set-reactive');
  const accents = document.getElementById('accents');

  /* seed from state */
  const s = store.state.settings;
  crossfade.value = String(s.crossfade);
  crossfadeVal.textContent = `${Number(s.crossfade).toFixed(1).replace('.0', '')} с`;
  crossfade.style.setProperty('--fill', `${(s.crossfade / 8) * 100}%`);
  volume.value = String(Math.round(store.get('volume') * 100));
  volumeVal.textContent = `${Math.round(store.get('volume') * 100)}%`;
  volume.style.setProperty('--fill', `${store.get('volume') * 100}%`);
  motion.setAttribute('aria-checked', String(s.motion));
  reactive.setAttribute('aria-checked', String(s.reactive));
  for (const b of accents.querySelectorAll('.accent')) {
    b.classList.toggle('is-active', b.dataset.accent === s.accent);
  }

  on(crossfade, 'input', () => {
    const v = Number(crossfade.value);
    store.patchSettings({ crossfade: v });
    crossfadeVal.textContent = `${v.toFixed(1).replace('.0', '')} с`;
    crossfade.style.setProperty('--fill', `${(v / 8) * 100}%`);
  });

  on(volume, 'input', () => {
    const v = Number(volume.value);
    player.setVolume(v / 100);
    volumeVal.textContent = `${v}%`;
    volume.style.setProperty('--fill', `${v}%`);
  });

  on(motion, 'click', () => {
    const next = !store.get('settings').motion;
    store.patchSettings({ motion: next });
    motion.setAttribute('aria-checked', String(next));
    applyTheme();
  });

  on(reactive, 'click', () => {
    const next = !store.get('settings').reactive;
    store.patchSettings({ reactive: next });
    reactive.setAttribute('aria-checked', String(next));
    applyTheme();
  });

  on(accents, 'click', (e) => {
    const btn = e.target.closest('.accent');
    if (!btn) return;
    store.patchSettings({ accent: btn.dataset.accent });
    for (const b of accents.querySelectorAll('.accent')) b.classList.toggle('is-active', b === btn);
    applyTheme();
  });

  on(document.getElementById('set-reset'), 'click', () => {
    if (!confirm('Сбросить прогресс: очередь, избранное и настройки?')) return;
    store.reset();
    toast('Настройки сброшены', 'ok');
    setTimeout(() => location.reload(), 400);
  });

  /* the click is passed on so the wash opens where the finger was, not from
     the middle of the page */
  document.getElementById('btn-theme').addEventListener('click', (e) => toggleTheme(e));
  document.getElementById('btn-queue').addEventListener('click', () => {
    if (queueSheet.hidden) openQueueSheet();
    else closeSheet(queueSheet);
    hooks.onQueueOpen?.();
  });
  document.getElementById('btn-settings').addEventListener('click', openSettingsSheet);
  document.getElementById('btn-queue-clear').addEventListener('click', () => {
    player.clearQueue();
    toast('Очередь очищена', 'info');
  });

  /* first interaction unlocks the audio context where possible */
  const unlock = () => {
    if (engine.ctx?.state === 'suspended') engine.resume();
  };
  on(document, 'pointerdown', unlock);
  on(document, 'keydown', unlock);
}
