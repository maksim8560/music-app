/* ==========================================================================
   ui/sidebar.js — the playlist list in the sidebar rail
   The admin's own playlists, and a button to make another one without leaving
   the page. Nothing here is built in: the section is empty until the admin
   creates something.
   ========================================================================== */

import { qs } from '../core/dom.js';
import { store } from '../core/store.js';
import { admin } from '../data/admin.js';
import { player } from '../core/player.js';
import { markDirty } from '../data/sync.js';
import { toast } from './toast.js';

let signature = '';

const svgIcon = (name, size = 14) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

export function renderSidePlaylists() {
  const list = qs('#side-playlists');
  if (!list) return;

  const mine = admin.playlists.map((p) => ({
    id: p.id,
    name: p.name,
    icon: p.icon || 'note',
    count: p.trackIds.length,
  }));
  const sig = JSON.stringify(mine);
  if (sig === signature) return;
  signature = sig;

  list.replaceChildren();
  const filter = store.get('filter');

  if (!mine.length) {
    const li = document.createElement('li');
    li.className = 'side-list__empty';
    li.textContent = 'Пока пусто';
    list.append(li);
    return;
  }

  for (const p of mine) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'side-list__item side-list__item--own';
    btn.dataset.filter = `pl:${p.id}`;
    if (filter === `pl:${p.id}`) btn.classList.add('is-active');
    btn.append(svgIcon(p.icon));
    /* the name lives in a span so the collapsed rail can hide it: a bare text
       node has no selector, and the overflow it caused is what made the rail
       look broken */
    const name = document.createElement('span');
    name.className = 'side-list__name';
    name.textContent = p.name;
    btn.append(name);
    if (p.count) {
      const em = document.createElement('em');
      em.textContent = String(p.count);
      btn.append(em);
    }
    li.append(btn);
    list.append(li);
  }
}

/**
 * Create a playlist from the rail. The name field appears in place rather than
 * in a `prompt()`, so it can be cancelled with Escape and needs no dialog.
 */
export function initSidebarPlaylists() {
  const list = qs('#side-playlists');
  const add = qs('#btn-side-add-playlist');
  if (!list || !add) return;

  let editor = null;

  const closeEditor = () => {
    editor?.remove();
    editor = null;
  };

  const openEditor = () => {
    if (editor) { editor.querySelector('input')?.focus(); return; }
    /* A name typed into a 78px rail is a name nobody can read. Widen the panel
       first, then put the cursor in the field. */
    if (store.get('rail')) {
      player.setRail(false);
      qs('.app')?.setAttribute('data-rail', 'false');
    }
    const li = document.createElement('li');
    li.className = 'side-list__new';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = 'Название плейлиста';
    input.setAttribute('aria-label', 'Название плейлиста');
    const commit = () => {
      const name = input.value.trim();
      if (!name) { closeEditor(); return; }
      try {
        admin.addPlaylist(name);
        closeEditor();
        renderSidePlaylists();
        player.reconcile();
        markDirty();
        toast(`Плейлист «${name}» создан — наполните его в админ-панели`, 'ok', 4000);
      } catch (err) {
        toast(String(err.message || err), 'error');
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
    });
    input.addEventListener('blur', () => {
      /* let Enter land first */
      setTimeout(() => { if (input.value.trim()) commit(); else closeEditor(); }, 120);
    });
    li.append(input);
    list.append(li);
    editor = li;
    input.focus();
  };

  add.addEventListener('click', openEditor);

  /* clicking a playlist filters by it; the list is delegated because these
     entries are re-rendered whenever the set changes */
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (btn) player.setFilter(btn.dataset.filter);
  });
}
