/* ==========================================================================
   ui/queue.js — "up next" panel and queue sheet
   Shows the explicit queue first, then the tracks that will follow naturally.
   ========================================================================== */

import { el, icon, fmtTime, plural, on } from '../core/dom.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { art } from './artwork.js';

const panelList = document.getElementById('queue-list');
const sheetList = document.getElementById('sheet-queue-list');
const panelEmpty = document.getElementById('queue-empty');
const sheetEmpty = document.getElementById('sheet-queue-empty');
const hint = document.getElementById('queue-hint');
const badge = document.getElementById('queue-badge');

/** Explicit queue + the natural continuation of the playlist */
export function upcoming(limit = 6) {
  const queued = player.queueTracks;
  const seen = new Set(queued.map((t) => t.id));
  const out = [];
  const ordered = player.ordered();
  const cur = store.get('currentId');

  if (store.get('repeat') === 'one') {
    const same = player.byId(cur);
    if (same) out.push(same);
  }

  const idx = ordered.findIndex((t) => t.id === cur);
  if (idx >= 0) {
    for (let step = 1; step <= ordered.length && out.length < limit; step++) {
      if (step > 1 && store.get('repeat') === 'off') break;
      const t = ordered[(idx + step) % ordered.length];
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return [...queued, ...out];
}

function row(track, kind, index) {
  const canvas = el('canvas', { width: 56, height: 56, 'aria-hidden': 'true' });
  const node = el('li', {
    class: `queue__item${kind === 'queued' ? '' : ' is-next'}`,
    dataset: { id: track.id },
    tabindex: '0',
    role: 'button',
    'aria-label': `${track.title} — ${track.artist}`,
  },
    el('span', { class: 'queue__item-idx', text: kind === 'queued' ? '•' : String(index + 1) }),
    el('div', { class: 'queue__item-art-wrap' }, el('div', { class: 'queue__item-art' }, canvas)),
    el('div', { class: 'queue__item-main' },
      el('div', { class: 'queue__item-title', text: track.title }),
      el('div', { class: 'queue__item-sub', text: track.artist }),
    ),
    el('span', { class: 'queue__item-time', text: track.duration ? fmtTime(track.duration) : '—:—' }),
  );

  if (kind === 'queued') {
    node.append(el('button', {
      class: 'icon-btn icon-btn--sm',
      'aria-label': 'Убрать из очереди',
      title: 'Убрать',
      html: icon('close', 14),
      onclick: (e) => {
        e.stopPropagation();
        player.dequeue(track.id);
      },
    }));
  }
  node.__canvas = canvas;
  node.__track = track;
  return node;
}

function fill(listEl, emptyEl, items) {
  if (!items.length) {
    listEl.replaceChildren();
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    const node = row(item.track, item.kind, i);
    frag.append(node);
  });
  listEl.replaceChildren(frag);
  for (const node of listEl.children) art.paint(node.__canvas, node.__track);
}

export function renderQueue() {
  const queued = player.queueTracks;
  const natural = upcoming(6).filter((t) => !queued.some((q) => q.id === t.id));
  const items = [
    ...queued.map((track) => ({ track, kind: 'queued' })),
    ...natural.slice(0, Math.max(0, 6 - queued.length)).map((track) => ({ track, kind: 'next' })),
  ];

  fill(panelList, panelEmpty, items);
  fill(sheetList, sheetEmpty, queued.length ? items : items.slice(0, 8));

  hint.textContent = queued.length
    ? plural(queued.length, 'трек в очереди', 'трека в очереди', 'треков в очереди')
    : 'по порядку';
  badge.hidden = !queued.length;
  badge.textContent = String(queued.length);
}

for (const host of [panelList, sheetList]) {
  on(host, 'click', (e) => {
    const item = e.target.closest('.queue__item');
    if (!item || e.target.closest('button')) return;
    player.play(item.dataset.id);
  });
  on(host, 'keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target.closest('.queue__item');
    if (!item) return;
    e.preventDefault();
    player.play(item.dataset.id);
  });
}
