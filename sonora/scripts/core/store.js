/* ==========================================================================
   core/store.js — single source of truth + localStorage persistence
   ========================================================================== */

const KEY = 'sonora.v1';

const DEFAULTS = {
  /* library */
  order: [],
  filter: 'all',
  search: '',
  view: 'list',
  /* playback */
  currentId: null,
  position: 0,
  duration: 0,
  playing: false,
  loading: false,
  error: null,
  volume: 0.72,
  muted: false,
  shuffle: false,
  repeat: 'all',
  eq: 'warm',
  queue: [],
  /* library meta */
  likes: [],
  recently: [],
  /* interface */
  rail: false,
  settings: {
    theme: 'dark',
    accent: 'aurora',
    crossfade: 2,
    motion: false,
    reactive: true,
  },
};

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const saved = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...saved,
      settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/** Keys that survive a reload. */
const PERSIST = [
  'order', 'filter', 'view', 'currentId', 'position', 'volume', 'muted',
  'shuffle', 'repeat', 'eq', 'queue', 'likes', 'recently', 'rail', 'settings',
];

class Store {
  #state;
  #listeners = new Map();
  #saveTimer = 0;

  constructor() {
    this.#state = load();
  }

  get state() {
    return this.#state;
  }

  get(key) {
    return this.#state[key];
  }

  /* ----------------------------- events ------------------------------- */
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this.#listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload, this.#state);
      } catch (err) {
        console.error(`[store] listener for "${event}" failed`, err);
      }
    });
    if (event !== 'change') this.emit('change', { key: event, value: payload });
  }

  /* ----------------------------- mutation ----------------------------- */
  /**
   * @param patch       keys to write
   * @param silent      skip the change event
   * @param transient   skip the disk write — for values that tick every frame
   *                    (position). Call persistNow() when it actually matters.
   */
  set(patch, { silent = false, transient = false } = {}) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (this.#state[k] === v) continue;
      this.#state[k] = v;
      changed.push(k);
    }
    if (!changed.length) return;
    if (!transient) this.#persist();
    if (!silent) this.emit('change', { key: changed.length === 1 ? changed[0] : changed, value: patch });
  }

  /** Mutate a nested object (settings) */
  patchSettings(patch) {
    this.set({ settings: { ...this.#state.settings, ...patch } });
  }

  reset() {
    localStorage.removeItem(KEY);
    this.#state = structuredClone(DEFAULTS);
    this.emit('change', { key: '*', value: null });
    this.emit('reset');
  }

  /* --------------------------- persistence ---------------------------- */
  #persist() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.persistNow(), 400);
  }

  /** Write immediately — cancels the debounce */
  persistNow() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = 0;
    try {
      const out = {};
      for (const k of PERSIST) out[k] = this.#state[k];
      localStorage.setItem(KEY, JSON.stringify(out));
    } catch (err) {
      console.warn('[store] persist failed', err);
    }
  }
}

export const store = new Store();
