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
  light: { in: '#ffffff', mid: '#eef0f8', out: 'rgba(255,255,255,0)', ripple: 'rgba(255,255,255,0.55)' },
  dark: { in: '#0a0a12', mid: '#10101c', out: 'rgba(10,10,18,0)', ripple: 'rgba(190,196,255,0.42)' },
};

let washTimer = 0;
let washClear = 0;

/**
 * The wave the page changes colour in.
 *
 * It always opens in the middle of the viewport. A wave that started at the
 * button was a decoration attached to a control: it drew a spotlight where the
 * finger was while the actual change still happened everywhere at once, and on
 * a wide screen the front never even reached the far side before it faded.
 * Starting from the middle means the front travels the same distance in every
 * direction, so the whole page is crossed.
 *
 * The real theme is swapped partway through, while the front is still out over
 * the content, and the registered colour tokens keep easing afterwards - that
 * is what carries the change out to the edges and settles it, rather than the
 * page landing on the new theme in one step.
 */
function runThemeWash(next) {
  const wash = document.getElementById('theme-wash');
  if (!wash) return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;

  const palette = WASH[next] || WASH.dark;
  const x = Math.round(window.innerWidth / 2);
  const y = Math.round(window.innerHeight / 2);
  wash.style.setProperty('--wash-x', `${x}px`);
  wash.style.setProperty('--wash-y', `${y}px`);
  wash.style.setProperty('--wash-in', palette.in);
  wash.style.setProperty('--wash-mid', palette.mid);
  wash.style.setProperty('--wash-out', palette.out);
  wash.style.setProperty('--wash-ripple', palette.ripple);

  clearTimeout(washTimer);
  clearTimeout(washClear);
  /* restart the animation even if it was mid-flight */
  wash.removeAttribute('data-run');
  wash.style.opacity = '';
  void wash.offsetWidth;
  wash.setAttribute('data-run', '');

  /* the front is about a third of the way across the page at this point */
  washTimer = setTimeout(() => {
    store.patchSettings({ theme: next });
    applyTheme();
    washClear = setTimeout(() => {
      wash.removeAttribute('data-run');
      /* The animation is what ends the wash, so if it never runs - a hidden tab
         where the compositor has stopped advancing frames, a browser that
         dropped the keyframes - the overlay would sit on the page at nearly full
         opacity. Clearing it here as well means the worst case is a brief
         missing transition rather than an unusable page. */
      wash.style.opacity = '0';
    }, 1250);
  }, 420);
  return true;
}

export function toggleTheme() {
  const next = store.get('settings').theme === 'dark' ? 'light' : 'dark';
  /* no wash available, or motion is unwelcome - fall back to the plain switch
     rather than swallowing the click */
  if (!runThemeWash(next)) {
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

  /* the wave opens from the middle of the page, not from the button, so the
     click position is not passed on */
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
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
