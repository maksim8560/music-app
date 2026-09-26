/* ==========================================================================
   ui/sheet.js — modal sheets with a focus trap
   ========================================================================== */

import { on, qsa } from '../core/dom.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function openSheet(node) {
  node.hidden = false;
  document.body.dataset.sheet = 'open';
  const first = qsa(FOCUSABLE, node).find((n) => n.offsetParent !== null);
  first?.focus();
  node.__restore = document.activeElement;
}

export function closeSheet(node) {
  node.hidden = true;
  if (!document.querySelector('.sheet:not([hidden]), .palette:not([hidden])')) {
    delete document.body.dataset.sheet;
  }
  node.__restore?.focus?.();
}

export function isSheetOpen(node) {
  return !node.hidden;
}

/** Click on the backdrop or any [data-close] closes the sheet */
export function initSheet(node) {
  on(node, 'click', (e) => {
    if (e.target.closest('[data-close]')) closeSheet(node);
  });
  on(node, 'keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = qsa(FOCUSABLE, node).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}
