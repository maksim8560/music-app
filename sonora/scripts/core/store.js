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
  queue: [],
  /* library meta */
  likes: [],
  recently: [],
  /* interface */
  rail: false,
  /* Компактный режим: панель уезжает в значки, обложка уменьшается, из панели
     уходят подписи, которые приходилось читать вскользь. Включается кнопкой в
     шапке и запоминается. */
  compact: false,
  settings: {
    theme: 'dark',
    accent: 'aurora',
    crossfade: 2,
    motion: false,
    /* Фон по умолчанию не слушает музыку. Раньше стояло true, и это плохое
       значение по умолчанию: человек, открывший сайт, получал пульсирующий
       экран, ничего об этом не зная и не спрашивая. Для кого-то это просто
       лишнее движение, а для человека со светочувствительной эпилепсией —
       реальная опасность, и последствия не обязаны быть заметными сразу.
       Включить можно, но только осознанно: при включении спрашиваем. */
    reactive: false,
    /* Прошло ли согласие. По нему же отличаем «выбрал сам» от «досталось
       прежним умолчанием» — иначе переносом ниже нельзя отделить одно от
       другого, и пришлось бы выбирать между сбросом чужого выбора и оставлением
       опасного включённым по умолчанию. */
    reactiveAck: false,
  },
};

function load() {
  let state;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const saved = JSON.parse(raw);
    state = {
      ...structuredClone(DEFAULTS),
      ...saved,
      settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }

  /* Одноразовый перенос. У человека в хранилище лежит `reactive: true` — но
     поставил его не он, а прежнее умолчание, и отличить одно от другого нечем:
     согласия на движение он не давал, потому что его не спрашивали.

     Поэтому «включено, но согласия нет» читается как «досталось по умолчанию»
     и выключается один раз. Кто включит заново, тот уже спросит подтверждения
     и запишет `reactiveAck` — и его выбор больше не трогаем. Идемпотентно:
     после переноса `reactive` уже false, и на следующей загрузке условие не
     выполняется. */
  if (state.settings.reactive && !state.settings.reactiveAck) {
    state.settings.reactive = false;
  }
  return state;
}

/** Keys that survive a reload. */
const PERSIST = [
  'order', 'filter', 'view', 'currentId', 'position', 'volume', 'muted',
  'shuffle', 'repeat', 'queue', 'likes', 'recently', 'rail', 'compact', 'settings',
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
