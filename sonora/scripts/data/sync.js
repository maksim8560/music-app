/* ==========================================================================
   data/sync.js — keep the document in the repository
   ----------------------------------------------------------------------------
   The admin layer stays the model. This only decides where the model is
   written: this browser's localStorage by default, and — once a token is
   configured — a JSON file in the repository, which is what every other device
   reads when it loads the page.

   Writes are debounced so a burst of edits costs one commit, and the status is
   reported honestly: a failed write leaves the change in this browser and says
   so, rather than pretending it reached everyone.
   ========================================================================== */

import { admin } from './admin.js';
import { remoteReadable, remoteWritable, remoteConfig, fetchRemote, pushRemote, checkRemote } from './remote.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';

const listeners = new Set();

let state = 'off';   // off | idle | loading | saving | saved | error
let message = '';
let sha = null;
let timer = 0;
let inFlight = null;

const emit = () => {
  for (const fn of listeners) {
    try { fn(status()); } catch (err) { console.error('[sync] listener failed', err); }
  }
};

const set = (next, text = '') => {
  state = next;
  message = text;
  emit();
};

export function status() {
  return { state, message, enabled: remoteWritable(), readable: remoteReadable(), repo: remoteConfig().repo };
}

export function onSyncChange(fn) {
  listeners.add(fn);
  fn(status());
  return () => listeners.delete(fn);
}

/**
 * Load the file at startup. A failure here is not fatal: the browser keeps
 * whatever it has and the panel offers to try again, because a site that will
 * not open at all because a repository is unreachable helps nobody.
 */
export async function initSync() {
  if (!remoteReadable()) {
    set('off');
    return;
  }
  set('loading', 'Читаю каталог…');
  try {
    const { doc, sha: fileSha } = await fetchRemote();
    sha = fileSha;
    if (doc) {
      admin.load(doc);
      player.reconcile();
      set(remoteWritable() ? 'idle' : 'readonly', 'Каталог взят из репозитория');
    } else {
      set('readonly', 'Файла каталога ещё нет — он появится, как только вы сохраните его из панели');
    }
  } catch (err) {
    /* A catalogue we could not read must never stop the page from opening:
       the browser's own copy, if any, is still shown. */
    set('error', String(err.message || err));
  }
}

/** Called after anything the admin commits. One write per burst of edits. */
export function markDirty() {
  if (!remoteWritable()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { syncNow(); }, 1200);
}

export async function syncNow() {
  if (!remoteWritable()) {
    set(remoteReadable() ? 'readonly' : 'off', 'Токен не задан: каталог читается, но записать его отсюда нельзя');
    return false;
  }
  /* never run two writes at once: the second would race the first and lose */
  if (inFlight) return inFlight;
  clearTimeout(timer);

  const run = (async () => {
    set('saving', 'Сохраняю в репозиторий…');
    try {
      const result = await pushRemote(admin.document(), sha);
      sha = result.sha || sha;
      set('saved', result.commit ? 'Сохранено — сайт обновится через минуту' : 'Сохранено');
      return true;
    } catch (err) {
      set('error', String(err.message || err));
      return false;
    } finally {
      inFlight = null;
    }
  })();

  inFlight = run;
  return run;
}

/** Verify the token before the admin relies on it. */
export async function testSync() {
  set('loading', 'Проверяю доступ…');
  try {
    const info = await checkRemote();
    sha = info.sha;
    set('idle', info.exists
      ? `Файл найден: ${info.tracks} треков, ${info.playlists} плейлистов`
      : 'Доступ есть, файл ещё не создан');
    return true;
  } catch (err) {
    set('error', String(err.message || err));
    return false;
  }
}

/** Forget the token. Reading keeps working: a public file needs none. */
export function disableSync() {
  clearTimeout(timer);
  sha = null;
  localStorage.removeItem('sonora.remote.v1');
  set(remoteReadable() ? 'readonly' : 'off', 'Токен удалён: каталог читается, запись из браузера отключена');
}

/* the play state is the one thing worth keeping out of the shared document */
export const isShared = () => remoteReadable();
