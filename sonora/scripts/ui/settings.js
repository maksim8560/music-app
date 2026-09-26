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

export function toggleTheme() {
  const next = store.get('settings').theme === 'dark' ? 'light' : 'dark';
  store.patchSettings({ theme: next });
  applyTheme();
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
