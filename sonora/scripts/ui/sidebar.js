/* ==========================================================================
   ui/sidebar.js — the playlist list in the sidebar rail
   The built-in entries (all, genres) live in the markup; the admin's own
   playlists are rendered on top of them from the admin layer.
   ========================================================================== */

import { qs, qsa } from '../core/dom.js';
import { store } from '../core/store.js';
import { admin } from '../data/admin.js';

let signature = '';

export function renderSidePlaylists() {
  const list = qs('#side-playlists');
  if (!list) return;

  const mine = admin.playlists.map((p) => ({
    id: p.id,
    name: p.name,
    count: p.trackIds.length,
  }));
  const sig = JSON.stringify(mine);
  if (sig === signature) return;
  signature = sig;

  for (const li of [...list.children]) {
    if (li.dataset.own) li.remove();
  }

  const filter = store.get('filter');
  for (const p of mine) {
    const li = document.createElement('li');
    li.dataset.own = '1';

    const btn = document.createElement('button');
    btn.className = 'side-list__item';
    btn.dataset.filter = `pl:${p.id}`;
    if (filter === `pl:${p.id}`) btn.classList.add('is-active');
    btn.append(icon('queue'));
    btn.append(document.createTextNode(p.name));
    if (p.count) {
      const em = document.createElement('em');
      em.textContent = String(p.count);
      btn.append(em);
    }
    li.append(btn);
    list.append(li);
  }

  /* the genre dots are styled per data-dot; the admin's entries get their own */
  for (const b of qsa('#side-playlists [data-filter^="pl:"]')) {
    b.classList.add('side-list__item--own');
  }
}

/** Small inline glyph, kept local so this module has no drawing dependency. */
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
