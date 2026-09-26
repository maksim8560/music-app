/* ==========================================================================
   ui/library.js — the track list
   Renders rows, patches state on updates, supports drag-to-reorder and a
   small context menu of actions per track.
   ========================================================================== */

import { el, icon, fmtTime, plural, on } from '../core/dom.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { art } from './artwork.js';
import { GENRES } from '../data/tracks.js';
import { admin } from '../data/admin.js';
import { status as syncStatus, onSyncChange } from '../data/sync.js';
import { toast } from './toast.js';

/** the shared file's read state, as a word and as a sentence */
const syncState = () => syncStatus().state;
const syncMessage = () => syncStatus().message;

const listEl = document.getElementById('track-list');
const countEl = document.getElementById('lib-count');
const headingEl = document.getElementById('lib-heading');
const emptyEl = document.getElementById('empty-state');
const libraryEl = document.getElementById('library');
const rows = new Map();

let dragId = null;

/* ------------------------------ row markup ------------------------------ */
function buildRow(track, index) {
  const liked = player.isLiked(track.id);
  const isCurrent = store.get('currentId') === track.id;

  const canvas = el('canvas', { width: 88, height: 88, 'aria-hidden': 'true' });

  const num = el('span', { class: 'track__num', html: isCurrent && store.get('playing') ? icon('wave', 15) : String(index + 1) });

  const artBox = el('div', { class: 'track__art' },
    canvas,
    el('span', { class: 'art__badge' }),
    num,
  );

  const genre = GENRES[track.genreKey]?.label ?? track.genre;
  const meta = el('div', { class: 'track__meta' },
    el('div', { class: 'track__title', text: track.title }),
    el('div', { class: 'track__sub' },
      el('span', { text: track.artist }),
      el('i', { text: '·' }),
      el('span', { text: track.album }),
      el('i', { text: '·' }),
      el('span', { text: String(track.year) }),
    ),
  );

  const tail = el('div', { class: 'track__tail' },
    el('span', { class: `track__badge${track.source === 'file' ? ' track__badge--local' : ''}`, text: track.source === 'file' ? 'Файл' : genre }),
    el('span', { class: 'track__time', text: track.duration ? fmtTime(track.duration) : '—:—' }),
  );

  const likeBtn = el('button', {
    class: `icon-btn icon-btn--sm${liked ? ' is-on' : ''}`,
    'aria-pressed': liked ? 'true' : 'false',
    'aria-label': liked ? 'Убрать из избранного' : 'В избранное',
    html: icon('heart', 16),
    onclick: (e) => {
      e.stopPropagation();
      const on2 = player.toggleLike(track.id);
      likeBtn.classList.toggle('is-on', on2);
      likeBtn.setAttribute('aria-pressed', String(on2));
    },
  });

  const nextBtn = el('button', {
    class: 'icon-btn icon-btn--sm',
    'aria-label': 'Играть следующим',
    title: 'Играть следующим',
    html: icon('queue', 16),
    onclick: (e) => {
      e.stopPropagation();
      player.playNext(track.id);
    },
  });

  const actions = [likeBtn, nextBtn];
  if (track.source === 'file') {
    actions.push(el('button', {
      class: 'icon-btn icon-btn--sm',
      'aria-label': 'Удалить из библиотеки',
      title: 'Удалить',
      html: icon('trash', 16),
      onclick: (e) => {
        e.stopPropagation();
        player.removeLocal(track.id);
        toast(`«${track.title}» удалён`, 'info');
      },
    }));
  }

  const row = el('li', {
    class: `track${isCurrent ? ' is-current' : ''}`,
    dataset: { id: track.id },
    draggable: 'true',
    tabindex: '0',
    role: 'button',
    'aria-label': `${track.title}, ${track.artist}`,
  },
    el('span', { class: 'track__ripple' }),
    artBox,
    meta,
    tail,
    el('div', { class: 'track__act' }, ...actions),
  );

  row.style.setProperty('--i', index);
  row.__canvas = canvas;
  row.__num = num;
  row.__like = likeBtn;
  row.__index = index;
  return row;
}

/* -------------------------------- render -------------------------------- */
export function renderLibrary() {
  const list = player.visible();
  const frag = document.createDocumentFragment();
  rows.clear();

  list.forEach((track, i) => {
    const row = buildRow(track, i);
    rows.set(track.id, row);
    frag.append(row);
  });

  listEl.replaceChildren(frag);
  /* paint after insertion so the canvases can read their real size */
  for (const [id, row] of rows) art.paint(row.__canvas, player.byId(id));
  listEl.classList.toggle('stagger', true);
  libraryEl.dataset.layout = store.get('view');
  countEl.textContent = plural(list.length, 'трек', 'трека', 'треков');
  headingEl.textContent = headingFor(store.get('filter'), store.get('search'));
  emptyEl.hidden = list.length > 0;
  listEl.hidden = list.length === 0;

  /* Three different reasons to be empty, and the third one used to look like
     the first: a filter that matched nothing, no music at all, and no music
     *because the shared file could not be read*. That last one is what a dead
     network or an exhausted GitHub rate limit looks like, and it was reported
     as "0 треков" with nothing else - which reads as data loss, and sends you
     looking for a problem you do not have. So say which one it is. */
  const filtered = !!(store.get('search') || store.get('filter') !== 'all');
  const shelfEmpty = player.library.length === 0;
  const unreadable = shelfEmpty && syncState() === 'error';
  const text = document.getElementById('empty-text');
  const hint = document.getElementById('empty-hint');
  const reset = document.getElementById('btn-reset');
  if (text) {
    if (unreadable) text.textContent = 'Общий каталог не прочитан';
    else text.textContent = shelfEmpty ? 'Музыки пока нет' : 'Ничего не найдено';
  }
  if (hint) {
    hint.hidden = !shelfEmpty;
    if (unreadable) hint.textContent = syncMessage();
  }
  if (reset) reset.hidden = !filtered;
  /* offering "add music" when the shelf only looks empty would invite someone
     to re-add tracks that are already in the repository */
  document.getElementById('btn-empty-admin').hidden = !shelfEmpty || unreadable;
  document.getElementById('btn-empty-upload').hidden = !shelfEmpty || unreadable;

  document.getElementById('btn-clear-filters').hidden = !filtered;
}

function headingFor(filter, search) {
  if (search) return `Поиск: «${search}»`;
  if (typeof filter === 'string' && filter.startsWith('pl:')) {
    return admin.playlist(filter.slice(3))?.name || 'Плейлист';
  }
  return {
    all: 'Все треки',
    liked: 'Избранное',
    recent: 'Недавнее',
    local: 'Загруженное',
  }[filter] || GENRES[filter]?.label || 'Все треки';
}

/**
 * The empty shelf has to be able to explain itself, which means it has to be
 * redrawn when the answer changes: the file may fail to read after the shelf
 * has already rendered, and the note should appear on its own.
 */
onSyncChange(() => {
  const shelf = document.getElementById('empty-state');
  if (shelf && !shelf.hidden) renderLibrary();
});

/** Patch the rows without a full re-render (current track, likes) */
export function syncLibrary() {
  const cur = store.get('currentId');
  const playing = store.get('playing');
  for (const [id, row] of rows) {
    const isCurrent = id === cur;
    row.classList.toggle('is-current', isCurrent);
    row.__num.innerHTML = isCurrent
      ? (playing ? icon('wave', 15) : icon('pause', 13))
      : String(row.__index + 1);
    const liked = player.isLiked(id);
    row.__like.classList.toggle('is-on', liked);
    row.__like.setAttribute('aria-pressed', String(liked));
  }
}

/* ------------------------------ interaction ----------------------------- */
on(listEl, 'click', (e) => {
  const row = e.target.closest('.track');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('button')) return;
  player.play(id);
});

on(listEl, 'keydown', (e) => {
  const row = e.target.closest('.track');
  if (!row) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    player.play(row.dataset.id);
  }
  if (e.key === 'ArrowDown' && row.nextElementSibling) {
    e.preventDefault();
    row.nextElementSibling.focus();
  }
  if (e.key === 'ArrowUp' && row.previousElementSibling) {
    e.preventDefault();
    row.previousElementSibling.focus();
  }
});

/* pointer ripple, positioned from the pointer */
on(listEl, 'pointerdown', (e) => {
  const row = e.target.closest('.track');
  if (!row) return;
  const rect = row.getBoundingClientRect();
  row.style.setProperty('--rx', `${e.clientX - rect.left}px`);
  row.style.setProperty('--ry', `${e.clientY - rect.top}px`);
});

/* ---------------------------- drag to reorder --------------------------- */
on(listEl, 'dragstart', (e) => {
  const row = e.target.closest('.track');
  if (!row) return;
  dragId = row.dataset.id;
  row.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});

on(listEl, 'dragend', () => {
  dragId = null;
  for (const row of rows.values()) row.classList.remove('is-dragging', 'is-over');
});

on(listEl, 'dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const row = e.target.closest('.track');
  for (const r of rows.values()) r.classList.toggle('is-over', r === row && r.dataset.id !== dragId);
});

on(listEl, 'drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const row = e.target.closest('.track');
  const targetId = row?.dataset.id;
  if (!targetId || targetId === dragId) return;

  const order = [...(store.get('order') || [])];
  const from = order.indexOf(dragId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0) return;
  order.splice(to, 0, order.splice(from, 1)[0]);
  store.set({ order });
  renderLibrary();
});

/* keep art in sync with the viewport (lazy canvases start blank at 0×0) */
on(window, 'resize', () => {
  for (const [id, row] of rows) {
    const track = player.byId(id);
    if (track) art.paint(row.__canvas, track);
  }
});
