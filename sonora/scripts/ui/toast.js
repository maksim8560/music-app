/* ==========================================================================
   ui/toast.js — transient status messages
   ========================================================================== */

import { el, icon } from '../core/dom.js';

const HOST = document.getElementById('toasts');
const MAX = 3;

const ICONS = { ok: 'check', error: 'close', info: 'spark' };

export function toast(message, kind = 'info', ms = 2800) {
  if (!HOST) return;
  while (HOST.children.length >= MAX) HOST.firstElementChild.remove();

  const node = el('div', { class: 'toast', dataset: { kind }, role: 'status' },
    el('span', { class: 'toast__icon', html: icon(ICONS[kind] || 'spark', 16) }),
    el('span', { text: message }),
  );
  HOST.append(node);

  const remove = () => {
    node.classList.add('is-out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };
  setTimeout(remove, ms);
  node.addEventListener('click', remove);
}
