/* ==========================================================================
   ui/palette.js — ⌘K command palette
   Fuzzy search across tracks, artists, albums and app actions.
   ========================================================================== */

import { el, icon, fuzzy, esc, on } from '../core/dom.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { art } from './artwork.js';
import { GENRES } from '../data/tracks.js';

const root = document.getElementById('palette');
const input = document.getElementById('palette-input');
const list = document.getElementById('palette-list');

let items = [];
let active = 0;
let lastFocus = null;

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const actions = () => [
  { id: 'play', title: store.get('playing') ? 'Пауза' : 'Воспроизвести', icon: store.get('playing') ? 'pause' : 'play', run: () => player.toggle() },
  { id: 'next', title: 'Следующий трек', icon: 'next', hint: 'L', run: () => player.next() },
  { id: 'prev', title: 'Предыдущий трек', icon: 'prev', hint: 'K', run: () => player.prev() },
  { id: 'shuffle', title: store.get('shuffle') ? 'Выключить перемешивание' : 'Перемешать', icon: 'shuffle', hint: 'S', run: () => player.toggleShuffle() },
  { id: 'repeat', title: `Повтор: ${ { off: 'выкл', all: 'все', one: 'трек' }[store.get('repeat')] }`, icon: 'repeat', hint: 'R', run: () => player.cycleRepeat() },
  { id: 'like', title: player.isLiked(store.get('currentId')) ? 'Убрать из избранного' : 'В избранное', icon: 'heart', hint: '⇧L', run: () => player.toggleLike(store.get('currentId')) },
  { id: 'queue', title: 'Очередь воспроизведения', icon: 'queue', hint: 'Q', run: () => openQueueSheet() },
  { id: 'clear-queue', title: 'Очистить очередь', icon: 'trash', run: () => player.clearQueue() },
  { id: 'import', title: 'Загрузить аудиофайлы…', icon: 'upload', run: () => document.getElementById('file-input').click() },
  { id: 'liked', title: 'Фильтр: избранное', icon: 'heart', run: () => player.setFilter('liked') },
  { id: 'recent', title: 'Фильтр: недавнее', icon: 'note', run: () => player.setFilter('recent') },
  ...Object.entries(GENRES).map(([key, g]) => ({
    id: `filter-${key}`,
    title: `Фильтр: ${g.label.toLowerCase()}`,
    icon: 'disc',
    run: () => player.setFilter(key),
  })),
  { id: 'all', title: 'Фильтр: все треки', icon: 'grid', run: () => player.setFilter('all') },
  { id: 'settings', title: 'Настройки звука и интерфейса', icon: 'sliders', hint: ',', run: () => openSettingsSheet() },
  { id: 'theme', title: 'Сменить тему', icon: document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', run: () => document.getElementById('btn-theme').click() },
];

let openQueueSheet = () => {};
let openSettingsSheet = () => {};

/* ------------------------------ rendering ------------------------------- */
function scoreTrack(track, q) {
  const title = fuzzy(q, track.title);
  const artist = fuzzy(q, track.artist);
  const album = fuzzy(q, track.album || '');
  const best = [title, artist, album].filter(Boolean).sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  return { score: best.score + 6, marks: best === title ? best.marks : [], sub: `${track.artist} · ${track.album || ''}` };
}

function highlight(text, marks) {
  if (!marks?.length) return esc(text);
  const set = new Set(marks);
  let out = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const on = set.has(i);
    if (on && !open) { out += '<mark>'; open = true; }
    if (!on && open) { out += '</mark>'; open = false; }
    out += esc(text[i]);
  }
  if (open) out += '</mark>';
  return out;
}

function render() {
  const q = input.value.trim();
  const results = [];

  for (const action of actions()) {
    if (q) {
      const m = fuzzy(q, action.title);
      if (!m) continue;
      results.push({ kind: 'action', title: action.title, marks: m.marks, icon: action.icon, hint: action.hint, run: action.run });
    } else {
      results.push({ kind: 'action', title: action.title, marks: [], icon: action.icon, hint: action.hint, run: action.run });
    }
  }

  if (q) {
    for (const track of player.ordered()) {
      const s = scoreTrack(track, q);
      if (!s) continue;
      results.push({
        kind: 'track',
        track,
        title: track.title,
        marks: s.marks,
        sub: s.sub,
        run: () => player.play(track.id),
      });
    }
  } else {
    for (const track of player.recent().slice(0, 5)) {
      results.push({ kind: 'track', track, title: track.title, sub: `${track.artist} · недавнее`, run: () => player.play(track.id) });
    }
  }

  results.sort((a, b) => (a.kind === b.kind ? (b.score || 0) - (a.score || 0) : a.kind === 'track' ? 1 : -1));
  items = results.slice(0, 40);
  active = 0;

  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    const node = el('li', {
      class: 'palette__item',
      dataset: { active: String(i === 0), index: String(i) },
      role: 'option',
      'aria-selected': String(i === 0),
    });
    if (item.kind === 'track') {
      const canvas = el('canvas', { width: 68, height: 68 });
      node.append(el('div', { class: 'palette__item-art' }, canvas));
      queueMicrotask(() => art.paint(canvas, item.track));
    } else {
      node.append(el('div', { class: 'palette__item-icon', html: icon(item.icon, 17) }));
    }
    node.append(
      el('div', { class: 'palette__item-main' },
        el('div', { class: 'palette__item-title', html: highlight(item.title, item.marks) }),
        item.sub ? el('div', { class: 'palette__item-sub', text: item.sub }) : null,
      ),
      el('span', { class: 'palette__item-kind', text: item.hint || item.kind }),
    );
    frag.append(node);
  });

  list.replaceChildren(frag);
  if (!items.length) {
    list.append(el('li', { class: 'palette__item', dataset: { active: 'false' } },
      el('div', { class: 'palette__item-icon', html: icon('search', 17) }),
      el('div', { class: 'palette__item-main' }, el('div', { class: 'palette__item-title', text: 'Ничего не найдено' })),
    ));
  }
}

function move(delta) {
  if (!items.length) return;
  active = (active + delta + items.length) % items.length;
  for (const node of list.children) {
    const on_ = Number(node.dataset.index) === active;
    node.dataset.active = String(on_);
    if (node.hasAttribute('aria-selected')) node.setAttribute('aria-selected', String(on_));
    if (on_) node.scrollIntoView({ block: 'nearest' });
  }
}

function run() {
  const item = items[active];
  if (!item) return;
  close();
  item.run();
}

export function open() {
  lastFocus = document.activeElement;
  root.hidden = false;
  input.value = '';
  render();
  input.focus();
}

export function close() {
  if (root.hidden) return;
  root.hidden = true;
  lastFocus?.focus?.();
}

export function toggle() {
  root.hidden ? open() : close();
}

export function initPalette(hooks = {}) {
  openQueueSheet = hooks.openQueue || openQueueSheet;
  openSettingsSheet = hooks.openSettings || openSettingsSheet;

  on(input, 'input', render);
  on(list, 'click', (e) => {
    const node = e.target.closest('.palette__item');
    if (!node) return;
    const i = Number(node.dataset.index);
    if (Number.isNaN(i)) return;
    active = i;
    run();
  });
  on(root, 'click', (e) => {
    if (e.target.closest('[data-close-palette]')) close();
  });
  on(document, 'keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
}

export const paletteShortcut = IS_MAC ? '⌘K' : 'Ctrl K';
