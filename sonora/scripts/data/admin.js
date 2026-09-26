/* ==========================================================================
   data/admin.js — the admin layer over the catalogue
   ----------------------------------------------------------------------------
   Keeps everything the admin changes in one place and merges it over the
   shipped CATALOG, so `player.library()` returns "what the admin made it".

   Storage is localStorage, and so is the password. This is a local lock on
   the settings UI — the same machine, the same browser profile, no server.
   It is deliberately not a security boundary and the panel says so.
   ========================================================================== */

import { CATALOG, GENRES } from './tracks.js';

const KEY = 'sonora.admin.v1';
const SESSION_KEY = 'sonora.admin.session';

/** Glyphs a playlist may carry — all of them already in the sprite. */
export const PLAYLIST_ICONS = ['note', 'disc', 'wave', 'heart', 'queue', 'spark', 'list', 'grid'];

/** See setup(): the hash is public, so short passwords are no protection. */
export const MIN_PASSWORD = 8;

/** Fields an admin may override on a shipped track. */
const EDITABLE = [
  'title', 'artist', 'album', 'year', 'genre', 'genreKey',
  'duration', 'bpm', 'root', 'scale', 'blurb', 'mood', 'seed', 'colors',
  'coverUrl', 'url',
];

/** Accept only a real http(s) image link; anything else means "no cover". */
function cleanImage(value) {
  const raw = (value || '').trim();
  if (!raw) return '';
  if (/^data:image\//i.test(raw)) return raw;
  if (!/^https?:\/\/\S+$/i.test(raw)) throw new Error('Ссылка на картинку должна быть http:// или https://');
  return raw;
}

/**
 * The same check without the throw, for the live editor: the field fires on
 * every keystroke, so a half-typed "htt" must not raise — it just means "no
 * cover yet" and the image comes back as soon as the link is valid.
 */
function safeImage(value) {
  try {
    return cleanImage(value);
  } catch {
    return '';
  }
}

const DEFAULTS = () => ({
  version: 1,
  /* null until the first visit sets a password */
  auth: null,
  site: {
    name: 'Sonora',
    tagline: 'Glass Edition',
    description: '',
    accent: '',
    background: '',
  },
  /* trackId -> { field: value } layered on top of the shipped catalogue */
  overrides: {},
  /* shipped ids the admin switched off */
  hidden: [],
  /* tracks the admin added, by hand or by URL */
  custom: [],
  /* the admin's own playlists: [{ id, name, trackIds }] */
  playlists: [],
  updatedAt: 0,
});

/** Older saves have no playlists; keep the shape honest on the way in. */
function normalisePlaylists(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      id: String(p.id || ''),
      name: String(p.name || 'Без названия'),
      icon: PLAYLIST_ICONS.includes(p.icon) ? p.icon : 'note',
      trackIds: Array.isArray(p.trackIds) ? p.trackIds.filter((x) => typeof x === 'string') : [],
    }))
    .filter((p) => p.id);
}

/* ------------------------------ persistence ------------------------------- */

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS();
    const saved = JSON.parse(raw);
    const base = DEFAULTS();
    return {
      ...base,
      ...saved,
      site: { ...base.site, ...(saved.site || {}) },
      overrides: saved.overrides || {},
      hidden: Array.isArray(saved.hidden) ? saved.hidden : [],
      custom: Array.isArray(saved.custom) ? saved.custom : [],
      playlists: normalisePlaylists(saved.playlists),
    };
  } catch {
    return DEFAULTS();
  }
}

function write(state) {
  state.updatedAt = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[admin] не удалось сохранить настройки', err);
    return false;
  }
  return true;
}

/* ------------------------------- password -------------------------------- */

/** Salt + digest. SHA-256 when SubtleCrypto is reachable, a weak fallback otherwise. */
async function digest(algo, salt, password) {
  const text = `${algo}:${salt}:${password}`;
  if (algo === 'sha256' && globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  /* No SubtleCrypto (insecure context). Two FNV-style mixes — enough to keep a
     shoulder-surfer out, which is all this lock is ever for. */
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ Math.imul(c + i, 2246822519), 3266489917) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

const randomSalt = () => {
  const buf = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const bestAlgo = () => (globalThis.crypto?.subtle ? 'sha256' : 'weak');

async function makeAuth(password) {
  const algo = bestAlgo();
  const salt = randomSalt();
  return { algo, salt, hash: await digest(algo, salt, password) };
}

/* --------------------------------- admin --------------------------------- */

class Admin {
  #state = read();
  #authed = false;

  constructor() {
    /* a reload inside the same tab keeps you signed in; closing the tab does not */
    try {
      this.#authed = sessionStorage.getItem(SESSION_KEY) === '1';
    } catch { /* private mode */ }
  }

  get state() { return this.#state; }
  get authed() { return this.#authed; }
  get hasPassword() { return !!this.#state.auth; }
  get isEmpty() {
    const s = this.#state;
    return !s.custom.length && !s.hidden.length && !Object.keys(s.overrides).length;
  }

  /* ------------------------------ auth ---------------------------------- */

  /** First visit: set the password. Returns false if one already exists. */
  async setup(password) {
    if (this.hasPassword) return false;
    /* The hash ends up in a file anyone can read, so a four-character password
       is not a secret at all. Eight is the floor here and a phrase is what
       actually makes sense. */
    if (!password || password.length < MIN_PASSWORD) {
      throw new Error(`Пароль от ${MIN_PASSWORD} символов — лучше длинная фраза`);
    }
    this.#state.auth = await makeAuth(password);
    write(this.#state);
    this.#authed = true;
    this.#markSession();
    return true;
  }

  async login(password) {
    const auth = this.#state.auth;
    if (!auth) return this.setup(password);
    const got = await digest(auth.algo, auth.salt, password || '');
    if (got !== auth.hash) return false;
    this.#authed = true;
    this.#markSession();
    return true;
  }

  async changePassword(current, next) {
    if (!(await this.login(current))) throw new Error('Текущий пароль не подходит');
    if (!next || next.length < MIN_PASSWORD) throw new Error(`Новый пароль от ${MIN_PASSWORD} символов — лучше длинная фраза`);
    this.#state.auth = await makeAuth(next);
    write(this.#state);
    return true;
  }

  logout() {
    this.#authed = false;
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  /**
   * The token already proved who this is, and a token owner has no need of a
   * second password. Called after a token check so the panel can be opened
   * without one, and so "первый в браузере" stops being a thing.
   */
  markAuthed() {
    this.#authed = true;
    this.#markSession();
  }

  #markSession() {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
  }

  /* ------------------------------- site --------------------------------- */

  get site() { return this.#state.site; }

  updateSite(patch) {
    this.#state.site = { ...this.#state.site, ...patch };
    write(this.#state);
    return this.#state.site;
  }

  /* ------------------------------ catalogue ------------------------------ */

  /** CATALOG with the admin's overrides applied, minus hidden, plus custom. */
  library() {
    const st = this.#state;
    const out = [];
    for (const track of CATALOG) {
      if (st.hidden.includes(track.id)) continue;
      const patch = st.overrides[track.id];
      out.push(patch ? { ...track, ...patch, id: track.id, edited: true } : track);
    }
    for (const track of st.custom) out.push(track);
    return out;
  }

  isEdited(id) { return !!this.#state.overrides[id]; }
  isHidden(id) { return this.#state.hidden.includes(id); }

  updateTrack(id, patch) {
    const clean = {};
    for (const key of EDITABLE) {
      if (key in patch && patch[key] !== undefined && patch[key] !== null) clean[key] = patch[key];
    }
    if (clean.genreKey && !GENRES[clean.genreKey]) delete clean.genreKey;
    if ('coverUrl' in clean) clean.coverUrl = safeImage(clean.coverUrl);
    const custom = this.#state.custom.find((t) => t.id === id);
    if (custom) {
      Object.assign(custom, clean);
    } else {
      this.#state.overrides[id] = { ...(this.#state.overrides[id] || {}), ...clean };
    }
    write(this.#state);
    return this.library();
  }

  /** A different seed is a different piece of music from the same settings. */
  reseed(id) {
    const custom = this.#state.custom.find((t) => t.id === id);
    const seed = randomSalt();
    if (custom) custom.seed = seed;
    else this.#state.overrides[id] = { ...(this.#state.overrides[id] || {}), seed };
    write(this.#state);
    return seed;
  }

  resetTrack(id) {
    delete this.#state.overrides[id];
    this.#state.hidden = this.#state.hidden.filter((x) => x !== id);
    write(this.#state);
    return this.library();
  }

  toggleHidden(id) {
    const hidden = new Set(this.#state.hidden);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    this.#state.hidden = [...hidden];
    write(this.#state);
    return !hidden.has(id);
  }

  /* ------------------------------- adding ------------------------------- */

  #nextId(prefix) {
    let n = 1;
    const taken = new Set([...CATALOG.map((t) => t.id), ...this.#state.custom.map((t) => t.id)]);
    while (taken.has(`${prefix}-${n}`)) n++;
    return `${prefix}-${n}`;
  }

  /** A hand-built generative track, modelled on the shipped ones. */
  addGenerative(partial = {}) {
    const id = this.#nextId('admin');
    const genreKey = GENRES[partial.genreKey] ? partial.genreKey : 'ambient';
    const track = {
      id,
      title: partial.title?.trim() || 'Без названия',
      artist: partial.artist?.trim() || 'Неизвестный исполнитель',
      album: partial.album?.trim() || 'Своя подборка',
      year: Number(partial.year) || new Date().getFullYear(),
      genre: partial.genre?.trim() || GENRES[genreKey].label,
      genreKey,
      duration: clampNum(partial.duration, 60, 3600, 210),
      bpm: clampNum(partial.bpm, 40, 200, 84),
      root: clampNum(partial.root, 24, 84, 45),
      scale: partial.scale || 'minorPent',
      colors: partial.colors?.length === 2 ? partial.colors : ['#5b6bff', '#b04aff'],
      blurb: partial.blurb?.trim() || 'Добавлено из админ-панели.',
      coverUrl: cleanImage(partial.cover),
      mood: { brightness: 0.42, density: 0.44, drums: 0.24, reverb: 0.66, bass: 0.5, lead: 0.3, pluck: 0.38 },
      seed: randomSalt(),
      source: 'gen',
      custom: true,
    };
    if (!track.coverUrl) delete track.coverUrl;
    this.#state.custom.push(track);
    write(this.#state);
    return track;
  }

  /**
   * A track played from a direct link to an audio file, or a live radio stream.
   *
   * `kind: 'file'` is downloaded and decoded, which needs CORS. `kind: 'stream'`
   * is endless, so it can never be downloaded — it plays through an <audio>
   * element instead, which works cross-origin but has no length to seek in.
   */
  addUrl({ url, title, artist, album, blurb, cover, genreKey = 'local', kind = 'file' }) {
    const clean = (url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(clean)) throw new Error('Нужна ссылка http:// или https://');
    const live = kind === 'stream';
    const track = {
      id: this.#nextId(live ? 'radio' : 'url'),
      title: title?.trim() || clean.split('/').pop()?.split('?')[0] || (live ? 'Радио' : 'Поток'),
      artist: artist?.trim() || (live ? 'Радио' : 'По ссылке'),
      album: album?.trim() || (live ? 'Эфир' : 'Ссылки'),
      year: new Date().getFullYear(),
      genre: live ? 'Радио' : (GENRES[genreKey]?.label || GENRES.local.label),
      genreKey: live ? 'local' : (GENRES[genreKey] ? genreKey : 'local'),
      /* 0 until a file is fetched and decoded — the clock fills in then. A
         stream has no length at all, and 0 is how the transport reads that. */
      duration: 0,
      colors: live ? ['#ff7a6b', '#ffc46b'] : ['#2f8cff', '#63f5d2'],
      /* the raw link is not a description: as a fallback it would end up under
         the title, where a stream of text tells the reader nothing */
      blurb: blurb?.trim() || '',
      coverUrl: cleanImage(cover),
      url: clean,
      source: live ? 'stream' : 'url',
      custom: true,
    };
    if (!track.coverUrl) delete track.coverUrl;
    this.#state.custom.push(track);
    write(this.#state);
    return track;
  }

  removeCustom(id) {
    this.#state.custom = this.#state.custom.filter((t) => t.id !== id);
    /* a deleted track must not leave a hole in someone's playlist */
    for (const pl of this.#state.playlists) {
      pl.trackIds = pl.trackIds.filter((x) => x !== id);
    }
    write(this.#state);
    return this.library();
  }

  /* ------------------------------ playlists ----------------------------- */

  get playlists() {
    return this.#state.playlists;
  }

  /** The filter value a playlist is addressed by inside the player. */
  static filterOf(id) {
    return `pl:${id}`;
  }

  playlist(id) {
    return this.#state.playlists.find((p) => p.id === id) || null;
  }

  /** Ids of the playlists a track belongs to. */
  playlistsOf(trackId) {
    return this.#state.playlists.filter((p) => p.trackIds.includes(trackId)).map((p) => p.id);
  }

  #nextPlaylistId() {
    let n = 1;
    const taken = new Set(this.#state.playlists.map((p) => p.id));
    while (taken.has(`pl-${n}`)) n++;
    return `pl-${n}`;
  }

  addPlaylist(name, icon = 'note') {
    const clean = (name || '').trim();
    if (!clean) throw new Error('Дайте плейлисту название');
    const playlist = {
      id: this.#nextPlaylistId(),
      name: clean.slice(0, 40),
      icon: PLAYLIST_ICONS.includes(icon) ? icon : 'note',
      trackIds: [],
    };
    this.#state.playlists.push(playlist);
    write(this.#state);
    return playlist;
  }

  setPlaylistIcon(id, icon) {
    const pl = this.playlist(id);
    if (!pl || !PLAYLIST_ICONS.includes(icon)) return null;
    pl.icon = icon;
    write(this.#state);
    return pl;
  }

  renamePlaylist(id, name) {
    const pl = this.playlist(id);
    const clean = (name || '').trim();
    if (!pl || !clean) return null;
    pl.name = clean.slice(0, 40);
    write(this.#state);
    return pl;
  }

  removePlaylist(id) {
    this.#state.playlists = this.#state.playlists.filter((p) => p.id !== id);
    write(this.#state);
    return this.#state.playlists;
  }

  /** Put a track in a playlist, or take it out. @returns {boolean} now in it */
  setInPlaylist(playlistId, trackId, on) {
    const pl = this.playlist(playlistId);
    if (!pl) return false;
    const has = pl.trackIds.includes(trackId);
    if (on && !has) pl.trackIds.push(trackId);
    else if (!on && has) pl.trackIds = pl.trackIds.filter((x) => x !== trackId);
    else return has;
    write(this.#state);
    return on;
  }

  toggleInPlaylist(playlistId, trackId) {
    const pl = this.playlist(playlistId);
    if (!pl) return false;
    return this.setInPlaylist(playlistId, trackId, !pl.trackIds.includes(trackId));
  }

  /** Track ids that no longer exist, dropped from every playlist. */
  prunePlaylists() {
    const valid = new Set(this.library().map((t) => t.id));
    for (const pl of this.#state.playlists) {
      pl.trackIds = pl.trackIds.filter((id) => valid.has(id));
    }
    write(this.#state);
  }

  /**
   * Record how a track actually plays. The player discovers this at runtime
   * (a link with no content-length is a radio, whatever the form said), and the
   * finding is worth keeping: next time the transport can show «эфир» and skip
   * the probe entirely.
   */
  setSource(id, source) {
    const custom = this.#state.custom.find((t) => t.id === id);
    if (custom) {
      if (custom.source === source) return;
      custom.source = source;
      if (source === 'stream') {
        custom.genre = GENRES.local.label;
        custom.genreKey = 'local';
        custom.duration = 0;
      }
      write(this.#state);
    }
  }

  /* --------------------------- import / export -------------------------- */

  /**
   * The whole document, minus the password.
   *
   * This is what gets written to `catalogue.json` in the repository, so it has
   * to be the complete state and nothing more: no token, no session, no
   * password. The token lives in this browser only, never in the file.
   */
  document() {
    const { auth, ...rest } = this.#state;
    return { version: 1, ...rest, exportedAt: new Date().toISOString() };
  }

  /** Adopt a document wholesale — used when the file in the repo is newer. */
  load(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('Файл не похож на настройки Sonora');
    this.#state = {
      ...DEFAULTS(),
      ...doc,
      site: { ...DEFAULTS().site, ...(doc.site || {}) },
      overrides: doc.overrides && typeof doc.overrides === 'object' ? doc.overrides : {},
      hidden: Array.isArray(doc.hidden) ? doc.hidden.filter((x) => typeof x === 'string') : [],
      custom: Array.isArray(doc.custom) ? doc.custom.filter((t) => t && typeof t.id === 'string') : [],
      playlists: normalisePlaylists(doc.playlists),
      auth: this.#state.auth,
    };
    this.prunePlaylists();
    write(this.#state);
    return this.library();
  }

  export() {
    return JSON.stringify(this.document(), null, 2);
  }

  /** Merge an exported file. The password never travels with it. */
  import(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || typeof data !== 'object') throw new Error('Это не похоже на настройки Sonora');
    const incoming = {
      site: data.site,
      overrides: data.overrides,
      hidden: data.hidden,
      custom: data.custom,
      playlists: data.playlists,
    };
    if (Array.isArray(incoming.custom)) {
      for (const t of incoming.custom) if (!t || typeof t.id !== 'string') throw new Error('Повреждённый список треков');
    }
    this.#state = {
      ...this.#state,
      site: { ...this.#state.site, ...(incoming.site || {}) },
      overrides: incoming.overrides && typeof incoming.overrides === 'object' ? incoming.overrides : {},
      hidden: Array.isArray(incoming.hidden) ? incoming.hidden.filter((x) => typeof x === 'string') : [],
      custom: (incoming.custom || []).filter((t) => t && typeof t.id === 'string'),
      playlists: normalisePlaylists(incoming.playlists),
    };
    /* imported ids may not match what is actually on the shelf */
    this.prunePlaylists();
    write(this.#state);
    return this.library();
  }

  /** Back to the shipped catalogue. The password stays. */
  resetCatalogue() {
    this.#state.overrides = {};
    this.#state.hidden = [];
    this.#state.custom = [];
    this.#state.playlists = [];
    write(this.#state);
    return this.library();
  }
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const admin = new Admin();
