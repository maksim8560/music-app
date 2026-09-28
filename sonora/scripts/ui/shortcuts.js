/* ==========================================================================
   ui/shortcuts.js — global keyboard control
   ========================================================================== */

import { store } from '../core/store.js';
import { player } from '../core/player.js';
import * as palette from './palette.js';
import { openSettingsSheet, openQueueSheet, toggleTheme } from './settings.js';
import { closeSheet } from './sheet.js';
import { toast } from './toast.js';

const settingsSheet = document.getElementById('settings-sheet');
const queueSheet = document.getElementById('queue-sheet');
/* Панель предупреждения о светочувствительности: открывается поверх настроек,
   поэтому и закрываться должна первой. */
const reactiveSheet = document.getElementById('reactive-sheet');

const isTyping = (el) =>
  el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

export function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    /* the palette handles its own keys while it is open */
    if (!document.getElementById('palette').hidden) return;

    /* ⌘K / Ctrl+K — command palette */
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.toggle();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(document.activeElement)) return;
    /* auto-repeat is for typing, not for transport commands: holding Space
       would otherwise toggle play/pause dozens of times a second */
    if (e.repeat) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        if (document.activeElement?.tagName === 'BUTTON') return;
        e.preventDefault();
        player.toggle();
        break;

      case 'ArrowRight':
        e.preventDefault();
        player.nudge(e.shiftKey ? 30 : 10);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        player.nudge(e.shiftKey ? -30 : -10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        player.setVolume(store.get('volume') + 0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        player.setVolume(store.get('volume') - 0.05);
        break;

      case 'k':
      case 'K':
        e.preventDefault();
        player.prev();
        break;
      case 'l':
      case 'L':
        e.preventDefault();
        if (e.shiftKey) player.toggleLike(store.get('currentId'));
        else player.next();
        break;
      case 'j':
      case 'J':
        e.preventDefault();
        player.nudge(-15);
        break;

      case 'm':
      case 'M':
        player.toggleMute();
        break;
      case 's':
      case 'S':
        player.toggleShuffle();
        break;
      case 'r':
      case 'R':
        player.cycleRepeat();
        break;
      case 'f':
      case 'F':
        player.toggleLike(store.get('currentId'));
        break;
      case 'q':
      case 'Q':
        queueSheet.hidden ? openQueueSheet() : closeSheet(queueSheet);
        break;
      case ',':
        e.preventDefault();
        settingsSheet.hidden ? openSettingsSheet() : closeSheet(settingsSheet);
        break;
      case 't':
      case 'T':
        toggleTheme();
        break;
      case '/':
        e.preventDefault();
        document.getElementById('search').focus();
        break;
      case '?':
        toast('Space — пауза · ←/→ — перемотка · K/L — треки · ⌘K — поиск · S — shuffle', 'info', 6000);
        break;
      case 'Escape':
        /* Предупреждение закрываем первым: оно открывается поверх панели
           настроек, и если не учесть этого, Escape закрывал бы нижнюю панель,
           а диалог остался бы висеть без видимого выхода. */
        if (!reactiveSheet.hidden) {
          closeSheet(reactiveSheet);
          break;
        }
        if (!settingsSheet.hidden) closeSheet(settingsSheet);
        if (!queueSheet.hidden) closeSheet(queueSheet);
        /* an open sheet (including the admin panel) already handles Escape —
           don't also yank the focus out of whatever field is being typed in */
        if (document.body.dataset.sheet !== 'open') document.activeElement?.blur?.();
        break;

      default:
        if (/^[1-9]$/.test(e.key)) {
          const list = player.visible();
          const track = list[Number(e.key) - 1];
          if (track) {
            e.preventDefault();
            player.play(track.id);
          }
        }
    }
  });
}
