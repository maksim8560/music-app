/* ==========================================================================
   core/player.js — playback controller
   Owns the library, the queue, crossfade timing and Media Session metadata.
   The store holds the state; the views subscribe to it.
   ========================================================================== */

import { store } from './store.js';
import { addTask } from './raf.js';
import { engine, secureUrl } from '../audio/engine.js';
import { admin } from '../data/admin.js';
import { makeLocalTrack, isAudioFile, revokeCovers } from '../audio/files.js';
import { art } from '../ui/artwork.js';
import { toast } from '../ui/toast.js';

const LOCAL_PREFIX = 'local:';

class Player {
  #local = [];
  #shuffleBag = [];
  #crossfading = false;
  #mediaThrottle = 0;
  /* what the last play/pause command asked for: true = play, false = pause,
     null = nothing requested yet. Guards against a second trigger undoing us
     while an await is still in flight. */
  #intent = null;

  /* ------------------------------ library ------------------------------ */
  get library() {
    /* admin.library() is the shipped catalogue with the admin's edits, hidden
       tracks removed and their own tracks appended */
    return [...admin.library(), ...this.#local];
  }

  get localTracks() {
    return this.#local;
  }

  byId(id) {
    return this.library.find((t) => t.id === id) || null;
  }

  get current() {
    return this.byId(store.get('currentId'));
  }

  /** Tracks in playlist order (store.order) with everything appended. */
  ordered() {
    const all = this.library;
    const order = store.get('order') || [];
    const seen = new Set();
    const out = [];
    for (const id of order) {
      const t = this.byId(id);
      if (t && !seen.has(id)) {
        out.push(t);
        seen.add(id);
      }
    }
    for (const t of all) if (!seen.has(t.id)) out.push(t);
    return out;
  }

  /* ------------------------------- boot -------------------------------- */
  init() {
    this.reconcile();

    const start = store.get('currentId') ? this.byId(store.get('currentId')) : null;
    if (start) {
      art.preload(start);
      this.#syncMediaSession(start, store.get('position') || 0);
    }

    /* engine wiring */
    engine.on('state', (state) => store.set({ playing: state === 'playing' }));
    engine.on('ended', () => this.#onEnded());

    /* per-frame clock: drives crossfade + position bookkeeping */
    addTask((dt) => this.#tick(dt));
  }

  /**
   * Drop ids the library no longer has and pick up anything new.
   * Called at boot and after every admin change to the catalogue.
   */
  reconcile() {
    const all = this.library;
    const valid = new Set(all.map((t) => t.id));
    const order = (store.get('order') || []).filter((id) => valid.has(id));
    for (const t of all) if (!order.includes(t.id)) order.push(t.id);
    const currentId = valid.has(store.get('currentId')) ? store.get('currentId') : order[0] || null;
    store.set({
      order,
      queue: (store.get('queue') || []).filter((id) => valid.has(id)),
      likes: (store.get('likes') || []).filter((id) => valid.has(id)),
      currentId,
    });
  }

  /* ----------------------------- queries ------------------------------- */
  matches(track, query) {
    if (!query) return true;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [track.title, track.artist, track.album, track.genre, String(track.year)]
      .filter(Boolean)
      .some((field) => field.toLowerCase().includes(q));
  }

  /** Library after filter + search — what the track list shows */
  visible() {
    const { filter, search } = store.state;
    const likes = new Set(store.get('likes') || []);
    let list = this.ordered();

    if (filter === 'liked') list = list.filter((t) => likes.has(t.id));
    else if (filter === 'recent') list = this.recent();
    else if (typeof filter === 'string' && filter.startsWith('pl:')) {
      /* a playlist made in the admin panel, addressed by id */
      const pl = admin.playlist(filter.slice(3));
      const ids = new Set(pl?.trackIds || []);
      list = list.filter((t) => ids.has(t.id));
    } else if (filter && filter !== 'all') list = list.filter((t) => t.genreKey === filter);

    if (search) list = list.filter((t) => this.matches(t, search));
    return list;
  }

  /** The admin playlists a track belongs to — shown as chips on its row. */
  playlistsOf(trackId) {
    return admin.playlistsOf(trackId);
  }

  recent() {
    const ids = store.get('recently') || [];
    return ids.map((id) => this.byId(id)).filter(Boolean);
  }

  /* ----------------------------- playback ------------------------------ */
  async play(trackOrId, { offset = null, fade = 0.6 } = {}) {
    const track = typeof trackOrId === 'string' ? this.byId(trackOrId) : trackOrId;
    if (!track) return;

    /* starting a track is a play command unless the caller just paused us */
    if (this.#intent === null) this.#intent = true;
    let start = offset;
    if (start == null) {
      if (track.id === store.get('currentId') && engine.currentTrack?.id === track.id) {
        start = engine.position;
        if (start > (engine.duration || 0) - 0.4) start = 0;
      } else {
        start = 0;
      }
    }

    /* what was sounding before this attempt, so a failure can put it back */
    const wasId = store.get('currentId');
    const wasPlaying = store.get('playing');

    try {
      /* a local file we already have, or a URL the admin added. A live stream
         is neither: it has no end to buffer, so there is nothing to fetch. */
      if (track.source === 'url' && !track.buffer) {
        store.set({ loading: true });
        await this.#fetchTrack(track);
      } else if (track.source === 'file' && !track.buffer) {
        store.set({ loading: true });
        const bytes = await track.file.arrayBuffer();
        track.buffer = await engine.decode(bytes);
        store.set({ duration: track.buffer.duration });
      }

      store.set({ currentId: track.id, position: start ?? 0, error: null });
      this.#pushRecent(track);
      art.preload(track);
      this.#syncMediaSession(track, start ?? 0);
      await engine.play(track, { offset: start ?? 0, fade });
      store.set({ loading: false });
      /* the context may still be frozen by the autoplay policy — stay honest,
         but never overwrite a pause that was requested while we were starting */
      if (this.#intent !== false) this.#latch(engine.state === 'playing');
    } catch (err) {
      console.error(err);
      /* Put the transport back where it really is. Reading `engine.state` alone
         is not enough: it still described the *previous* track, which is why a
         dead link could leave the button showing "playing" over silence. The
         question is whether the engine is playing the track we just tried. */
      const sounding = engine.currentTrack?.id === track.id;
      store.set({
        loading: false,
        error: String(err.message || err),
        currentId: sounding ? track.id : wasId,
      });
      this.#latch(sounding && engine.state === 'playing');
      if (!sounding && wasPlaying && engine.currentTrack) this.#latch(true);
      toast(
        track.source === 'url'
          ? `Не удалось загрузить ссылку — сервер может не отдавать CORS (${String(err.message || err)})`
          : 'Не удалось декодировать файл',
        'error',
      );
    }
  }

  /**
   * Fetch a URL track, and recognise a live stream on the way.
   *
   * The admin can pick the type by hand, but people paste whatever link they
   * have, and the two kinds need opposite handling. The giveaway is in the
   * headers: a radio answers with audio and *no* `content-length`, because it
   * has no end. Reading its body would wait forever, so instead of hanging we
   * drop the body and hand the URL to the element player.
   */
  async #fetchTrack(track) {
    let res;
    try {
      /* Probe the secure spelling. On an https page an http:// request is
         refused as mixed content, and the console would carry that error even
         though the stream itself goes on to play fine over https. */
      res = await fetch(secureUrl(track.url), { mode: 'cors' });
    } catch (err) {
      /* No CORS means we cannot even read the headers, so we cannot tell a file
         from a radio. Try the element anyway: a stream plays cross-origin just
         fine, and only a real file needs the bytes. */
      if (await this.#tryAsStream(track)) return;
      throw new Error(`сервер не отдал CORS (${String(err.message || err)})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const type = res.headers.get('content-type') || '';
    const length = res.headers.get('content-length');
    const looksLive = /^audio\//i.test(type) && length === null;

    if (looksLive) {
      /* stop the download before it buffers forever */
      try { await res.body?.cancel(); } catch { /* already closed */ }
      await this.#tryAsStream(track);
      return;
    }

    track.buffer = await engine.decode(await res.arrayBuffer());
    track.duration = track.buffer.duration;
    store.set({ duration: track.duration });
  }

  /**
   * Play a track as a live stream. Returns false when the element refuses it,
   * so the caller can report the original reason instead of a vague one.
   */
  async #tryAsStream(track) {
    const ok = await engine.playStream({ ...track, source: 'stream' });
    if (!ok) {
      console.warn('[player] the element refused it as a stream');
      /* Served over https, an http:// stream is mixed content and the browser
         blocks it outright. Say exactly that instead of a bare failure — it is
         the one case the admin cannot fix from here. */
      if (location.protocol === 'https:' && track.url.startsWith('http://')) {
        throw new Error('эфир отдаётся только по http, а сайт открыт по https — браузер блокирует такое смешанное содержимое');
      }
      return false;
    }
    /* remember the finding: next time the transport can say "эфир" up front
       instead of re-discovering it on every single play */
    track.source = 'stream';
    admin.setSource(track.id, 'stream');
    return true;
  }

  /* Media Session handlers are commands, not toggles: the platform is allowed
     to echo an action back, and a toggle would flip the state a second time
     (play → pause) right after the user pressed the button. */
  async ensurePlaying() {
    if (store.get('playing')) return true;
    return this.toggle(true);
  }

  async ensurePaused() {
    if (!store.get('playing')) return true;
    return this.toggle(false);
  }

  /**
   * `force` pins the outcome; without it the state flips.
   *
   * The intent is latched *before* the first await. Everything below is async,
   * so without the latch a second trigger inside the same window would read
   * the pre-await flag, take the same branch and undo us.
   */
  async toggle(force) {
    const want = force === undefined ? !store.get('playing') : !!force;
    this.#intent = want;
    this.#latch(want);

    if (!store.get('currentId')) {
      const first = this.visible()[0] || this.ordered()[0];
      if (first) return this.play(first);
      /* an empty shelf is not an error, but a dead ▶ button is confusing */
      toast('Музыки пока нет — добавьте трек по ссылке в админ-панели', 'info', 5000);
      return;
    }
    if (!engine.voice && !engine.isLive) {
      return this.play(store.get('currentId'), { offset: store.get('position') || 0 });
    }
    if (!want) {
      await engine.pause();
      if (this.#intent !== false) return; /* a newer intent won */
      this.#latch(false);
      store.persistNow();
      return;
    }
    /* a live stream reports no duration, so the "restart at the end" check
       below would always fire and restart the radio on every resume */
    if (!engine.isLive && engine.position >= engine.duration - 0.3) {
      return this.play(store.get('currentId'), { offset: 0 });
    }
    const running = await engine.resume();
    if (this.#intent !== true) return;
    this.#latch(running !== false);
  }

  /** Store write only when it actually changes — the position tick is hot. */
  #latch(value) {
    if (store.get('playing') !== value) store.set({ playing: value });
  }

  /** Manual or automatic advance. */
  async next({ fade = 0.35 } = {}) {
    const next = this.#pickNext();
    if (!next) {
      await engine.pause();
      store.set({ playing: false, position: engine.duration });
      return false;
    }
    this.#crossfading = fade > 0.3;
    await this.play(next, { offset: 0, fade });
    this.#crossfading = false;
    return true;
  }

  async prev() {
    /* Apple Music behaviour: restart the track unless we are near the start */
    if (engine.position > 3.2 && engine.currentTrack) {
      await this.seek(0);
      return true;
    }
    const seq = this.#navigationOrder();
    const cur = store.get('currentId');
    const i = seq.findIndex((t) => t.id === cur);
    const target = i > 0 ? seq[i - 1] : (seq.length > 1 ? seq[seq.length - 1] : null);
    if (!target) return false;
    return this.play(target, { offset: 0, fade: 0.25 });
  }

  async seek(time) {
    const t = Math.max(0, Math.min(time, engine.duration || time));
    store.set({ position: t });
    if (engine.voice) {
      await engine.seek(t);
      this.#updateMediaPosition();
    }
  }

  nudge(seconds) {
    if (!engine.voice) return;
    this.seek(engine.position + seconds);
  }

  /* ------------------------------- queue ------------------------------- */
  playNext(id) {
    const queue = (store.get('queue') || []).filter((x) => x !== id);
    queue.unshift(id);
    store.set({ queue });
    const t = this.byId(id);
    toast(`«${t?.title ?? 'Трек'}» — играет следующим`, 'info');
  }

  enqueue(id) {
    const queue = [...(store.get('queue') || [])];
    if (!queue.includes(id)) queue.push(id);
    store.set({ queue });
    const t = this.byId(id);
    toast(`«${t?.title ?? 'Трек'}» добавлен в очередь`, 'ok');
  }

  clearQueue() {
    store.set({ queue: [] });
  }

  dequeue(id) {
    store.set({ queue: (store.get('queue') || []).filter((x) => x !== id) });
  }

  get queueTracks() {
    return (store.get('queue') || []).map((id) => this.byId(id)).filter(Boolean);
  }

  /* ------------------------------ toggles ------------------------------ */
  isLiked(id) {
    return (store.get('likes') || []).includes(id);
  }

  toggleLike(id) {
    const likes = new Set(store.get('likes') || []);
    const on = likes.has(id);
    if (on) likes.delete(id);
    else likes.add(id);
    store.set({ likes: [...likes] });
    const track = this.byId(id);
    if (track) toast(on ? `Убрано из избранного` : `«${track.title}» в избранном`, on ? 'info' : 'ok');
    return !on;
  }

  toggleShuffle() {
    const on = !store.get('shuffle');
    store.set({ shuffle: on });
    if (on) this.#refillBag();
    return on;
  }

  cycleRepeat() {
    const order = ['off', 'all', 'one'];
    const next = order[(order.indexOf(store.get('repeat')) + 1) % order.length];
    store.set({ repeat: next });
    toast({ off: 'Повтор выключен', all: 'Повтор всей очереди', one: 'Повтор одного трека' }[next], 'info');
    return next;
  }

  setVolume(v) {
    const vol = Math.max(0, Math.min(1, v));
    store.set({ volume: vol, muted: vol === 0 ? store.get('muted') : false });
    engine.setVolume(vol);
    if (vol > 0 && store.get('muted')) {
      store.set({ muted: false });
      engine.setMuted(false);
    }
    this.#updateMediaPosition();
  }

  toggleMute() {
    const muted = !store.get('muted');
    store.set({ muted });
    engine.setMuted(muted);
    return muted;
  }

  setEq(name) {
    store.set({ eq: name });
    engine.setEq(name);
  }

  setFilter(filter) {
    store.set({ filter, search: '' });
  }

  setSearch(text) {
    store.set({ search: text });
  }

  setView(view) {
    store.set({ view });
  }

  setRail(on) {
    store.set({ rail: on });
  }

  /* ---------------------------- local files ---------------------------- */
  async addFiles(fileList) {
    const files = Array.from(fileList).filter(isAudioFile);
    if (!files.length) {
      toast('Поддерживаются аудиофайлы: MP3, WAV, OGG, M4A, FLAC', 'error');
      return [];
    }
    const added = [];
    for (const file of files) {
      const track = await makeLocalTrack(file);
      if (this.#local.some((t) => t.id === track.id)) continue;
      this.#local.push(track);
      added.push(track);
    }
    if (added.length) {
      store.set({ order: [...(store.get('order') || []), ...added.map((t) => t.id)] });
      toast(`Добавлено ${added.length} ${added.length === 1 ? 'трек' : 'трека'}`, 'ok');
    }
    return added;
  }

  removeLocal(id) {
    const track = this.byId(id);
    if (!track?.source) return;
    if (track.coverUrl) URL.revokeObjectURL(track.coverUrl);
    this.#local = this.#local.filter((t) => t.id !== id);
    art.drop(track);
    store.set({
      order: (store.get('order') || []).filter((x) => x !== id),
      queue: (store.get('queue') || []).filter((x) => x !== id),
      likes: (store.get('likes') || []).filter((x) => x !== id),
      currentId: store.get('currentId') === id ? null : store.get('currentId'),
    });
  }

  clearLibrary() {
    revokeCovers(this.#local);
    this.#local = [];
    store.set({ order: this.library.map((t) => t.id), queue: [], likes: [] });
  }

  /* ------------------------------ internals ---------------------------- */
  #navigationOrder() {
    if (!store.get('shuffle')) return this.ordered();
    if (!this.#shuffleBag.length) this.#refillBag();
    return this.#shuffleBag;
  }

  #refillBag() {
    const list = this.ordered();
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    const cur = store.get('currentId');
    this.#shuffleBag = list.filter((t) => t.id !== cur);
  }

  #pickNext() {
    const { queue, repeat, currentId } = store.state;

    if (queue.length) return this.byId(queue[0]);
    if (repeat === 'one' && currentId) return this.byId(currentId);

    const seq = this.#navigationOrder();
    if (!seq.length) return null;
    if (repeat === 'off' && !store.get('shuffle')) {
      const i = seq.findIndex((t) => t.id === currentId);
      if (i >= 0 && i + 1 < seq.length) return seq[i + 1];
      return null; // end of the list
    }
    return seq[0] || null;
  }

  #onEnded() {
    /* ignore the tail of a voice that has already been replaced by a crossfade */
    if (engine.currentTrack && engine.currentTrack.id !== store.get('currentId')) return;
    const next = this.#pickNext();
    if (next && store.get('repeat') === 'one') {
      this.play(next, { offset: 0, fade: 0.3 });
      return;
    }
    if (next) {
      const queue = (store.get('queue') || []).filter((id) => id !== next.id);
      store.set({ queue });
      this.play(next, { offset: 0, fade: 0.4 });
      return;
    }
    engine.pause();
    store.set({ playing: false, position: engine.duration });
  }

  #pushRecent(track) {
    const list = [track.id, ...(store.get('recently') || []).filter((id) => id !== track.id)].slice(0, 12);
    store.set({ recently: list });
  }

  #tick() {
    if (!engine.voice && !engine.isLive) return;
    const pos = engine.position;
    /* transient: the position ticks ~30x/s, no reason to hit localStorage for it */
    store.set(
      { position: Math.round(pos * 10) / 10, duration: engine.duration },
      { transient: true },
    );

    /* crossfade: bring the next voice in while this one finishes. There is no
       "end" to fade out of on a live stream, so it just keeps playing. */
    const cf = Number(store.get('settings')?.crossfade || 0);
    if (cf > 0 && !engine.isLive && engine.state === 'playing' && !this.#crossfading) {
      const remaining = engine.duration - pos;
      if (remaining <= cf + 0.06 && remaining > 0) {
        const next = this.#pickNext();
        if (next && next.id !== engine.currentTrack?.id) {
          this.#crossfading = true;
          const queue = (store.get('queue') || []).filter((id) => id !== next.id);
          store.set({ queue });
          this.play(next, { offset: 0, fade: cf }).finally(() => {
            this.#crossfading = false;
          });
        }
      }
    }

    this.#mediaThrottle -= 1;
    if (this.#mediaThrottle <= 0) {
      this.#mediaThrottle = 10;
      this.#updateMediaPosition();
    }
  }

  /* --------------------------- media session --------------------------- */
  #syncMediaSession(track, position) {
    if (!('mediaSession' in navigator) || !track) return;
    const artwork = [];
    const img = art.masters.get(track.id);
    if (img) {
      try {
        const url = img.toDataURL('image/png');
        artwork.push({ src: url, sizes: `${img.width}x${img.height}`, type: 'image/png' });
      } catch { /* tainted or too big — skip artwork */ }
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork,
      });
      navigator.mediaSession.playbackState = store.get('playing') ? 'playing' : 'paused';
    } catch (err) {
      console.warn('[player] media metadata failed', err);
    }
    this.#updateMediaPosition(position);
  }

  #updateMediaPosition(position) {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const dur = engine.duration;
    if (!dur) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: Math.min(position ?? engine.position, dur),
        playbackRate: 1,
      });
    } catch { /* some browsers require a seek first */ }
  }
}

export const player = new Player();
export { LOCAL_PREFIX };
