/* ==========================================================================
   main.js — composition root
   Wires the store, the audio engine and every view together.
   ========================================================================== */

import { qs, qsa, on, plural } from './core/dom.js';
import { store } from './core/store.js';
import { player } from './core/player.js';
import { engine } from './audio/engine.js';
import { renderLibrary, syncLibrary } from './ui/library.js';
import { renderSidePlaylists, initSidebarPlaylists } from './ui/sidebar.js';
import { renderQueue } from './ui/queue.js';
import { initTransport, syncTrack, syncState, syncVolume, syncLike } from './ui/transport.js';
import { initPalette, open as openPalette, paletteShortcut } from './ui/palette.js';
import { initSettings, applyTheme, openSettingsSheet, openQueueSheet } from './ui/settings.js';
import { initAdmin, openAdmin, isAdminOpen } from './ui/admin.js';
import { initSync, startWatch } from './data/sync.js';
import { initOnline } from './data/online.js';
import { admin } from './data/admin.js';
import { initShortcuts } from './ui/shortcuts.js';
import { createVisualizers } from './ui/visualizer.js';
import { background } from './ui/background.js';
import { art } from './ui/artwork.js';
import { toast } from './ui/toast.js';

/* ==========================================================================
   Batched rendering — several store keys often change in one tick
   ========================================================================== */
const dirty = new Set();
let frameQueued = false;
let frameTimer = 0;

/**
 * How long we trust rAF to actually fire.
 *
 * A window that is occluded, minimised or on another virtual desktop can be
 * refused animation frames indefinitely. The flag below is what stops a second
 * frame from being queued, so a single withheld frame used to leave it set for
 * good and every later update was dropped — the interface looked frozen while
 * the data underneath was correct. The timeout is the safety net; when rAF
 * behaves, it wins the race and cancels this.
 */
const FRAME_FALLBACK_MS = 100;

function invalidate(...keys) {
  keys.forEach((k) => dirty.add(k));
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(flush);
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => {
    if (frameQueued) flush();
  }, FRAME_FALLBACK_MS);
}

function flush() {
  frameQueued = false;
  clearTimeout(frameTimer);
  const keys = new Set(dirty);
  dirty.clear();

  const has = (...list) => list.some((k) => keys.has(k));

  /* Starting a track used to rebuild the whole list. It does not have to: which
     track is current, whether it is playing and what is liked are all things a
     row can be told in place, and `syncLibrary` does exactly that. Rebuilding
     meant every row was destroyed and recreated on each press, which threw away
     hover, focus and the row animations - the list visibly flinched when the
     music started, and the buttons on the row under the cursor flickered. Only
     a change to which rows exist, or to their order, needs the real thing. */
  if (has('order', 'filter', 'search', 'view')) {
    renderLibrary();
  }
  if (has('currentId', 'playing', 'likes')) {
    syncLibrary();
  }
  if (has('queue', 'currentId', 'repeat', 'shuffle', 'order')) {
    renderQueue();
  }
  if (has('currentId')) {
    const track = player.current;
    syncTrack();
    if (track) {
      background.setPalette(track);
      art.preload(track);
    }
  }
  if (has('playing', 'shuffle', 'repeat', 'currentId', 'muted', 'volume')) {
    syncState();
  }
  if (has('volume', 'muted')) syncVolume();
  if (has('likes')) syncLike();
  if (has('settings')) applyTheme();
  if (has('order', 'queue', 'likes', 'currentId', 'filter')) updateCounters();
  /* the admin may have added or removed a playlist since the last frame */
  renderSidePlaylists();
}

/* ==========================================================================
   Counters
   ========================================================================== */
function updateCounters() {
  const likes = qs('#nav-like-count');
  if (likes) likes.textContent = String((store.get('likes') || []).length);
}

/* ==========================================================================
   Navigation, filters and the search field
   ========================================================================== */
const NAV_FILTER = {
  'Сейчас играет': null,
  'Альбомы': 'all',
  'Все треки': 'all',
  'Избранное': 'liked',
};

function initNav() {
  const scroll = qs('#scroll');

  qsa('[data-nav]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const label = item.querySelector('span')?.textContent?.trim();
      qsa('[data-nav]').forEach((n) => n.classList.toggle('is-active', n === item));
      const filter = NAV_FILTER[label];
      if (label === 'Сейчас играет') {
        scroll?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      if (label === 'Альбомы') {
        player.setView('grid');
        player.setFilter('all');
        syncViewButtons('grid');
      } else {
        player.setFilter(filter || 'all');
        if (label === 'Все треки') {
          player.setView('list');
          syncViewButtons('list');
        }
      }
      qs('#library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (window.innerWidth <= 980) document.getElementById('app').dataset.drawer = 'false';
    });
  });

  /* the playlist list and its create button live in ui/sidebar.js */
  initSidebarPlaylists();

  /* list ⇄ grid */
  const segs = qsa('.seg__btn[data-view]');
  const syncViewButtons = (view) => {
    for (const s of segs) s.classList.toggle('is-active', s.dataset.view === view);
  };
  segs.forEach((btn) => btn.addEventListener('click', () => {
    player.setView(btn.dataset.view);
    syncViewButtons(btn.dataset.view);
  }));
  syncViewButtons(store.get('view'));

  /* keep the sidebar in sync with the filter */
  store.on('change', ({ key }) => {
    const keys = Array.isArray(key) ? key : [key];
    if (!keys.includes('filter')) return;
    const filter = store.get('filter');
    qsa('#side-playlists [data-filter]').forEach((b) => b.classList.toggle('is-active', b.dataset.filter === filter));
  });

  renderSidePlaylists();

  /* search */
  const search = qs('#search');
  const clear = qs('#search-clear');
  let timer = 0;
  on(search, 'input', () => {
    clear.hidden = !search.value;
    clearTimeout(timer);
    timer = setTimeout(() => player.setSearch(search.value), 130);
  });
  on(clear, 'click', () => {
    search.value = '';
    clear.hidden = true;
    player.setSearch('');
    search.focus();
  });
  on(search, 'keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      clear.hidden = true;
      player.setSearch('');
      search.blur();
    }
    if (e.key === 'Enter') {
      const first = player.visible()[0];
      if (first) player.play(first.id);
    }
  });

  qs('#btn-clear-filters')?.addEventListener('click', () => {
    search.value = '';
    clear.hidden = true;
    player.setFilter('all');
    player.setSearch('');
  });
  qs('#btn-reset')?.addEventListener('click', () => {
    search.value = '';
    clear.hidden = true;
    player.setFilter('all');
    player.setSearch('');
  });

  /* sidebar rail */
  const app = qs('#app');
  app.dataset.rail = String(store.get('rail'));
  /* the drawer starts closed and says so in the DOM right away, instead of
     only falling out of the stylesheet default on the first toggle */
  app.dataset.drawer = 'false';
  on(qs('#btn-rail'), 'click', () => {
    if (window.innerWidth <= 980) {
      app.dataset.drawer = app.dataset.drawer === 'true' ? 'false' : 'true';
      return;
    }
    const next = !store.get('rail');
    player.setRail(next);
    app.dataset.rail = String(next);
  });
}

/* ==========================================================================
   File import (drag & drop)
   --------------------------------------------------------------------------
   There used to be a "Загрузить" button in the top bar. It was removed: files
   are dropped onto the page or picked from the empty shelf, and a permanent
   button in the header spent space on a door that is already open everywhere
   else. Dropping and the empty shelf still work.
   ========================================================================== */
function initImport() {
  const input = qs('#file-input');
  const drop = qs('#drop');
  let depth = 0;

  /* the empty shelf offers the two doors, right where the eye already is */
  on(qs('#btn-empty-upload'), 'click', () => input.click());
  on(qs('#btn-empty-admin'), 'click', () => openAdmin('music', { expandAdd: true }));

  on(input, 'change', async () => {
    if (input.files?.length) await player.addFiles(input.files);
    input.value = '';
  });

  on(window, 'dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    drop.hidden = false;
  });
  on(window, 'dragover', (e) => {
    if (!drop.hidden) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  on(window, 'dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      drop.hidden = true;
    }
  });
  on(window, 'drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    drop.hidden = true;
    await player.addFiles(e.dataTransfer.files);
  });
}

/* ==========================================================================
   Media Session — hardware / OS media keys
   ========================================================================== */
function initMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const bind = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch { /* unsupported action on this browser */ }
  };
  /* These are *commands*, not toggles. The OS is free to echo an action back
     (media keys, some Bluetooth headsets, the platform reacting to the state
     we just set), and a toggle here would undo the user's own click one beat
     later — play, then straight back to pause. */
  bind('play', () => player.ensurePlaying());
  bind('pause', () => player.ensurePaused());
  bind('previoustrack', () => player.prev());
  bind('nexttrack', () => player.next());
  bind('seekbackward', (d) => player.nudge(-(d?.seekOffset || 10)));
  bind('seekforward', (d) => player.nudge(d?.seekOffset || 10));
  bind('seekto', (d) => d.seekTime != null && player.seek(d.seekTime));
  bind('stop', () => player.ensurePaused());
}

/* ==========================================================================
   Get the audio thread warm on the very first gesture, so the first ▶ is
   instant instead of waiting for the context to spin up.
   ========================================================================== */
function initAudioWarmup() {
  const offPointer = on(window, 'pointerdown', warm, { capture: true });
  const offKey = on(window, 'keydown', warm, { capture: true });
  function warm() {
    offPointer();
    offKey();
    engine.warmup();
  }
}

/* The browser refused to start the context outside a gesture — say so once */
let blockedHinted = false;
let lastBlockedRetry = 0;
function initAutoplayGuard() {
  engine.on('state', (state) => {
    if (state === 'playing') {
      blockedHinted = false;
      return;
    }
    if (state !== 'blocked') return;

    /* A context created at page load can come back blocked even though the
       user is pressing the button right now. Transient activation survives for
       a few seconds, so one immediate retry still counts as user-initiated and
       normally goes through — much better than making them press it twice.
       Rate-limited so a stubborn context can never spin here. */
    if (Date.now() - lastBlockedRetry > 2000) {
      lastBlockedRetry = Date.now();
      player.ensurePlaying();
      return;
    }

    store.set({ playing: false });
    if (blockedHinted) return;
    blockedHinted = true;
    toast('Браузер заблокировал автозапуск — нажмите ▶ ещё раз', 'info', 4000);
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */
function boot() {
  player.init();
  applyTheme();

  /* the play position is written transiently — flush it when the tab goes away */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) store.persistNow();
    else if (dirty.size) {
      frameQueued = false;
      clearTimeout(frameTimer);
      flush();
    }
  });
  window.addEventListener('pagehide', () => store.persistNow());

  background.resize();
  on(window, 'resize', () => background.resize());
  background.start(
    () => (store.get('playing') ? engine.level() : 0),
    () => (store.get('playing') ? engine.air() : 0),
    () => store.get('playing'),
  );

  initTransport();
  initSettings({ onQueueOpen: () => renderQueue() });
  initPalette({ openQueue: openQueueSheet, openSettings: openSettingsSheet });
  initShortcuts();
  initNav();
  initImport();
  initMediaSession();
  initAutoplayGuard();
  initAudioWarmup();
  initAdmin();

  createVisualizers({
    getSpectrum: () => (store.get('playing') ? engine.spectrum() : null),
    isPlaying: () => store.get('playing'),
  });

  store.on('change', ({ key }) => {
    const keys = Array.isArray(key) ? key : [key];
    if (keys.includes('*')) {
      location.reload();
      return;
    }
    invalidate(...keys);
  });

  /* first paint */
  flush();
  renderLibrary();
  renderQueue();
  /* How many people are on the site at this moment. Started with the rest and
     silent until the counter answers: it is the one thing here that genuinely
     cannot be known without someone answering, so it waits rather than guesses.
     No-op until ENDPOINT in data/online.js is filled in. */
  initOnline(plural);
  /* The shared catalogue, if a repository is configured. Started after the
     first paint so a slow or unreachable GitHub never delays the page opening;
     when it lands, reconcile() puts the shelf in place. */
  initSync();
  /* Someone else can save while this tab is open. Watching the file is what
     keeps a phone that has been lying on the table from showing a shelf that
     was replaced ten minutes ago - the check is a conditional request, so a
     minute of polling costs nothing against GitHub's hourly limit. */
  startWatch({
    busy: isAdminOpen,
    onChange: ({ added, total }) => {
      renderSidePlaylists();
      if (added > 0) {
        toast(`Каталог обновился: ${plural(added, 'новый трек', 'новых трека', 'новых треков')}`, 'ok', 4000);
      } else if (added < 0) {
        toast(`Каталог обновился: убрано ${plural(-added, 'трек', 'трека', 'треков')}`, 'info', 4000);
      } else {
        toast(`Каталог обновлён с другого устройства — ${plural(total, 'трек', 'трека', 'треков')}`, 'info', 4000);
      }
    },
  });
  syncTrack();
  syncState();
  updateCounters();

  const track = player.current;
  if (track) {
    background.setPalette(track);
    art.preload(track);
  }

  /* first visit hint */
  if (!localStorage.getItem('sonora.seen')) {
    localStorage.setItem('sonora.seen', '1');
    setTimeout(() => {
      toast(`${paletteShortcut} — поиск и команды · Space — воспроизведение`, 'info', 6000);
    }, 900);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

/* handy for debugging in the console — `background.energy` and
   `background.floor` are the two numbers worth watching when the backdrop
   "does not react" */
window.sonora = { store, player, engine, plural, admin, background };
