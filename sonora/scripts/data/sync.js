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
import { remoteReadable, remoteWritable, remoteConfig, fetchRemote, pushRemote, checkRemote, isAuthError, forgetToken } from './remote.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';

const listeners = new Set();

let state = 'off';   // off | idle | loading | saving | saved | error
let message = '';
/** true when the last failure was the token itself, not the network */
let authFailed = false;
let sha = null;
let timer = 0;
let inFlight = null;
/** this browser holds tracks the shared file does not — never let a file win silently */
let pendingPublish = false;
/** ETag of the last read, so the watcher's next question costs nothing */
let watchEtag = '';

const emit = () => {
  for (const fn of listeners) {
    try { fn(status()); } catch (err) { console.error('[sync] listener failed', err); }
  }
};

const set = (next, text = '') => {
  state = next;
  message = text;
  if (next !== 'error') authFailed = false;
  emit();
};

/** Record a failure, remembering whether it was the token's fault. */
const fail = (err) => {
  authFailed = isAuthError(err);
  set('error', String((err && err.message) || err));
};

export function status() {
  return {
    state,
    message,
    /* the panel needs this to tell a dead token from a dead network: the first
       needs a new token typed in, the second only needs patience */
    auth: authFailed,
    enabled: remoteWritable(),
    readable: remoteReadable(),
    repo: remoteConfig().repo,
  };
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
    const { doc, sha: fileSha, etag } = await fetchRemote();
    sha = fileSha;
    watchEtag = etag;
    if (!doc) {
      pendingPublish = admin.library().length > 0;
      set(pendingPublish ? 'diverged' : 'readonly',
        pendingPublish
          ? 'Файла каталога нет, а в этом браузере есть треки — их можно записать в файл'
          : 'Файла каталога ещё нет — он появится, как только вы сохраните его из панели');
      return;
    }

    const local = admin.library().length;
    const shared = (doc.custom || []).length;

    /* Merge, never replace: the file wins on the tracks it mentions, and the
       ones it does not are kept and flagged. An empty or behind file used to
       delete a shelf outright, which is how tracks added before the token
       existed disappeared on reload. */
    const { added } = admin.load(doc);
    player.reconcile();
    const kept = admin.library().length - shared;
    pendingPublish = kept > 0;

    if (shared === 0 && local > 0) {
      set('diverged', `В файле каталога пусто, а в этом браузере ${local} — они не стираются, но пока не видны другим. Запишите их в файл.`);
      return;
    }
    set(remoteWritable() ? 'idle' : 'readonly',
      pendingPublish
        ? `Каталог взят из репозитория${added ? `, добавлено оттуда: ${added}` : ''}. Здесь есть ещё ${kept} — они только в этом браузере.`
        : 'Каталог взят из репозитория');
  } catch (err) {
    /* A catalogue we could not read must never stop the page from opening:
       the browser's own copy, if any, is still shown. */
    fail(err);
  }
}

/** True when this browser holds tracks the shared file does not. */
export function hasLocalOnly() {
  return pendingPublish;
}

/* ==========================================================================
   Watching the file
   --------------------------------------------------------------------------
   Saving in the panel writes a file in the repository. Everyone else finds out
   the next time they load the page - which is the whole problem: a phone left
   open on the table keeps showing yesterday's shelf.

   So the page asks the file whether it changed, on a timer and again whenever
   the tab comes back to the front. The question is a conditional request
   carrying the ETag from the last read, and GitHub answers 304 without spending
   any of the anonymous caller's hourly requests. That is what makes watching
   affordable: a minute of polling costs nothing, while a full read every
   minute would use the whole hourly budget in an hour.

   When the answer is "yes" the file is merged exactly the way startup merges
   it, so a device never loses its own unsaved tracks to somebody else's edit.
   ========================================================================== */

/** with a usable ETag a 304 is free, so we can be quick about it */
const WATCH_FAST = 60_000;
/** without one every check is a full read, and the budget is 60 an hour */
const WATCH_SLOW = 5 * 60_000;
/** the ceiling on backing off, reached after a few fruitless attempts */
const WATCH_MAX_BACKOFF = 15 * 60_000;

let watchTimer = 0;
let watchBusy = false;
let watching = false;
let watchFails = 0;
let onRemoteChange = null;
let isPanelBusy = null;

async function poll() {
  if (watchBusy || inFlight) return;
  /* never redraw the panel under the admin's hands */
  if (isPanelBusy && isPanelBusy()) return;
  watchBusy = true;
  try {
    const res = await fetchRemote({ etag: watchEtag });
    watchFails = 0;
    if (res.notModified) return;
    watchEtag = res.etag;
    if (!res.doc || res.sha === sha) return;

    sha = res.sha;
    const before = admin.library().length;
    admin.load(res.doc);
    player.reconcile();
    const after = admin.library().length;
    /* the merge keeps whatever this device had, so the "only here" warning is
       not this event's business - it belongs to the next full load */
    if (onRemoteChange) onRemoteChange({ added: after - before, total: after });
  } catch (err) {
    /* A stored token that GitHub refuses means the owner revoked it, or it
       expired. Drop it here rather than waiting for someone to click the admin
       button: the point of revoking is that the thing stops working, and a
       dead secret left sitting in a browser is only dead because nothing
       happened to try it. Reading carries on regardless - a public file needs
       no token - so the music does not stop, only the writing does. */
    if (isAuthError(err)) {
      forgetToken();
      set('readonly', 'Токен отозван или истёк — он удалён из этого браузера. Каталог читается, запись из него больше невозможна.');
      return;
    }
    /* GitHub allows an anonymous caller 60 reads an hour, per IP, and that
       budget is shared by everyone behind the same address. Once it is gone
       every check fails until the hour rolls over, so asking again every
       minute accomplishes nothing but traffic. Back off instead, and let the
       next successful check - or the tab coming back to the front - pick it
       up. */
    watchFails++;
    if (watchFails === 1) console.warn('[sync] не удалось проверить файл каталога', err);
  } finally {
    watchBusy = false;
  }
}

/** how long to wait before the next check, given how the last ones went */
function watchDelay() {
  const base = watchEtag ? WATCH_FAST : WATCH_SLOW;
  if (!watchFails) return base;
  return Math.min(base * 2 ** watchFails, WATCH_MAX_BACKOFF);
}

/**
 * Start watching. `isBusy` should tell whether the admin panel is open with
 * unsaved edits; `onChange` hears about a catalogue that changed elsewhere.
 */
export function startWatch({ busy, onChange } = {}) {
  if (watching) return;
  watching = true;
  isPanelBusy = busy || null;
  onRemoteChange = onChange || null;

  const tick = () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(async () => {
      await poll();
      tick();
    }, watchDelay());
  };
  tick();

  /* coming back to the tab is the moment staleness is visible, so ask at once
     instead of making someone wait out the rest of the interval */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    /* a rate-limited hour is not fixed by refreshing, so ask at once only
       while the last check actually got an answer */
    if (!watchFails) poll();
  });
  window.addEventListener('online', () => poll());
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
      pendingPublish = false;
      set('saved', result.commit ? 'Сохранено — сайт обновится через минуту' : 'Сохранено');
      return true;
    } catch (err) {
      fail(err);
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
    fail(err);
    return false;
  }
}

/**
 * Is the token that is stored here still accepted?
 *
 * Worth asking before the panel opens, because a token that has been revoked
 * is indistinguishable from a working one until something is written: the
 * panel opens, the shelf is there, and the save quietly does nothing. The
 * check is nearly free - the file is read anyway - and GitHub rejects an
 * invalid Authorization header even on a public file, which is what makes the
 * answer trustworthy rather than "the read worked, so the token is fine".
 */
export async function verifyToken() {
  if (!remoteWritable()) return false;
  const ok = await testSync();
  /* a dead network says nothing about the token, so only a refusal counts */
  return ok || !authFailed;
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
