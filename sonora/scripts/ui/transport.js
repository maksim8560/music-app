/* ==========================================================================
   ui/transport.js — hero panel + bottom bar
   Owns every playback control, the two seek sliders, the volume and the
   per-frame clock that keeps the interface in sync with the audio engine.
   ========================================================================== */

import { on, fmtTime, clamp } from '../core/dom.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { engine } from '../audio/engine.js';
import { art } from './artwork.js';
import { addTask } from '../core/raf.js';
const $ = (id) => document.getElementById(id);

const dom = {
  app: $('app'),
  heroArt: $('hero-art'),
  barArt: $('bar-art'),
  heroArtPlay: $('hero-art-play'),
  title: $('hero-title'),
  artist: $('hero-artist'),
  meta: $('hero-meta'),
  note: $('hero-note'),
  badge: $('hero-badge'),
  quality: $('hero-quality'),
  ring: $('ring-fg'),
  heroSeek: $('hero-progress'),
  heroSeekWrap: $('hero-seek'),
  heroOnair: $('hero-onair'),
  barSeekWrap: document.querySelector('.playbar__progress'),
  heroCur: $('hero-current'),
  heroDur: $('hero-duration'),
  barSeek: $('bar-progress'),
  barCur: $('bar-current'),
  barDur: $('bar-duration'),
  barProgress: document.querySelector('.playbar__progress'),
  play: $('btn-play'),
  barPlay: $('btn-bar-play'),
  prev: $('btn-prev'),
  next: $('btn-next'),
  barPrev: $('btn-bar-prev'),
  barNext: $('btn-bar-next'),
  shuffle: $('btn-shuffle'),
  barShuffle: $('btn-bar-shuffle'),
  repeat: $('btn-repeat'),
  barRepeat: $('btn-bar-repeat'),
  like: $('btn-like'),
  barLike: $('btn-bar-like'),
  volume: $('volume'),
  mute: $('btn-mute'),
  playbar: $('playbar'),
  chips: $('hero-chips'),
};

const RING_LEN = 292.2;
let scrubbing = false;
/* last painted progress step (0..500) and badge label — the clock runs every frame */
let lastStep = -1;
let lastTrack = null;
let lastLive = false;
let badgeLabel = '';
const badgeSpan = document.querySelector('#hero-badge span');

/* ==========================================================================
   Track metadata
   ========================================================================== */
function swapText(node, value) {
  if (node.textContent === value) return;
  node.textContent = value;
  node.classList.remove('swap');
  void node.offsetWidth; // restart the animation
  node.classList.add('swap');
}

export function syncTrack() {
  const track = player.current;
  if (!track) {
    const empty = player.library.length === 0;
    swapText(dom.title, empty ? 'Музыки пока нет' : 'Ничего не выбрано');
    swapText(dom.artist, empty ? 'Добавьте трек по ссылке' : 'Выберите трек в списке');
    dom.note.textContent = empty
      ? 'Откройте админ-панель (слайдеры справа сверху) и добавьте прямую ссылку на аудиофайл — с описанием и обложкой.'
      : 'Нажмите ⌘K, чтобы найти что-нибудь по вкусу.';
    dom.note.hidden = false;
    dom.quality.textContent = '—';
    return;
  }

  swapText(dom.title, track.title);
  swapText(dom.artist, track.artist);
  dom.meta.textContent = `${track.album} · ${track.year}`;
  dom.note.textContent = track.blurb || '';
  /* no description — leave no empty paragraph behind the title */
  dom.note.hidden = !track.blurb;

  dom.badge.querySelector('span').textContent = store.get('playing') ? 'Сейчас играет' : 'Пауза';

  art.paint(dom.heroArt, track);
  art.paint(dom.barArt, track);

  updateQuality(track);
  syncLike();
  dom.ring.style.strokeDashoffset = String(RING_LEN);
}

function updateQuality(track) {
  if (track.source === 'stream') {
    /* nothing is decoded and no graph is involved — do not invent a number */
    dom.quality.textContent = 'прямой эфир';
  } else if (track.source === 'file') {
    if (track.buffer && track.buffer.duration) {
      const kbps = Math.round((track.size * 8) / track.buffer.duration / 1000);
      dom.quality.textContent = `${kbps} кбит/с · ${track.buffer.numberOfChannels === 1 ? 'моно' : 'стерео'}`;
    } else {
      dom.quality.textContent = 'декодирование…';
    }
  } else {
    const khz = engine.ctx ? Math.round(engine.ctx.sampleRate / 1000) : 48;
    dom.quality.textContent = `${khz} кГц · live`;
  }
}

/* ==========================================================================
   Playing state
   ========================================================================== */
export function syncState() {
  const playing = store.get('playing');
  const shuffle = store.get('shuffle');
  const repeat = store.get('repeat');

  for (const btn of [dom.play, dom.barPlay]) {
    btn.classList.toggle('is-playing', playing);
    btn.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
  }
  /* The button on the artwork had its triangle baked into the markup, so it
     kept inviting you to start a track that was already running. */
  dom.heroArtPlay.classList.toggle('is-playing', playing);
  dom.heroArtPlay.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
  dom.heroArtPlay.querySelector('use')?.setAttribute('href', playing ? '#i-pause' : '#i-play');
  dom.app.classList.toggle('is-playing', playing);
  dom.app.classList.toggle('is-paused', !playing);
  dom.playbar.dataset.idle = String(!store.get('currentId'));

  for (const btn of [dom.shuffle, dom.barShuffle]) {
    btn.setAttribute('aria-pressed', String(shuffle));
    btn.setAttribute('aria-label', shuffle ? 'Перемешать включён' : 'Перемешать');
  }
  for (const btn of [dom.repeat, dom.barRepeat]) {
    btn.classList.toggle('is-one', repeat === 'one');
    btn.setAttribute('aria-label', { off: 'Повтор выключен', all: 'Повтор всей очереди', one: 'Повтор трека' }[repeat]);
    btn.setAttribute('aria-pressed', String(repeat !== 'off'));
    btn.querySelector('use')?.setAttribute('href', repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
  }
  syncLike();
  syncVolume();
}

function syncLike() {
  const on = player.isLiked(store.get('currentId'));
  for (const btn of [dom.like, dom.barLike]) {
    if (!btn) continue;
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
  }
}

export function syncVolume() {
  const vol = store.get('volume');
  const muted = store.get('muted');
  const pct = Math.round(vol * 100);
  dom.volume.value = String(pct);
  dom.volume.style.setProperty('--fill', `${pct}%`);
  dom.mute.setAttribute('aria-label', muted ? 'Включить звук' : 'Без звука');
  const use = dom.mute.querySelector('use');
  use?.setAttribute('href', muted || vol === 0 ? '#i-mute' : vol < 0.5 ? '#i-volume-low' : '#i-volume');
}

/* ==========================================================================
   Clock
   ========================================================================== */
function updateClock() {
  /* A live stream has no length and nowhere to seek to, so the scrubber is not
     disabled — it is removed. A greyed-out slider still invites a drag that can
     only do nothing, and 0:00 beside a running clock just reads as broken. */
  const live = engine.isLive;
  const duration = live ? 0 : (engine.duration || store.get('duration') || 0);
  const raw = engine.voice || engine.isLive ? engine.position : store.get('position') || 0;
  const pos = clamp(raw, 0, duration || 0);

  if (lastLive !== live) {
    lastLive = live;
    /* the whole scrubber goes, wrappers included — an empty gap would look
       like something failed to load, so the "on air" chip takes its place
       right above the title, where the eye already is */
    dom.heroSeek.hidden = live;
    dom.barSeek.hidden = live;
    dom.heroSeekWrap?.toggleAttribute('hidden', live);
    dom.barSeekWrap?.toggleAttribute('hidden', live);
    dom.heroOnair?.toggleAttribute('hidden', !live);
    /* a live edge has no meaningful elapsed time either — a clock frozen near
       0:00 next to a running track is just noise */
    dom.barCur?.toggleAttribute('hidden', live);
    dom.playbar?.classList.toggle('is-live', live);
    lastStep = -1;
  }

  /* a new track (or a new duration) invalidates the cached paint */
  if (player.current !== lastTrack) {
    lastTrack = player.current;
    lastStep = -1;
  }

  if (!scrubbing) {
    /* quantised to 0.2% so the range inputs and the SVG ring are not
       invalidated on every single frame */
    const pct = duration ? pos / duration : 0;
    const step = Math.round(pct * 500);
    if (step !== lastStep) {
      lastStep = step;
      const v = String(step * 2);
      const fill = `${(step * 2) / 10}%`;
      dom.heroSeek.value = v;
      dom.barSeek.value = v;
      dom.heroSeek.style.setProperty('--fill', fill);
      dom.barSeek.style.setProperty('--fill', fill);
      dom.barProgress?.style.setProperty('--progress', fill);
      dom.ring.style.strokeDashoffset = String(RING_LEN * (1 - (step * 2) / 1000));
    }
  }

  const cur = fmtTime(pos);
  const dur = live ? 'эфир' : fmtTime(duration);
  if (dom.heroCur.textContent !== cur) {
    dom.heroCur.textContent = cur;
    dom.heroCur.dateTime = `PT${Math.round(pos)}S`;
  }
  if (dom.barCur.textContent !== cur) {
    dom.barCur.textContent = cur;
    dom.barCur.dateTime = `PT${Math.round(pos)}S`;
  }
  if (dom.heroDur.textContent !== dur) {
    dom.heroDur.textContent = dur;
    dom.barDur.textContent = dur;
    dom.heroDur.dateTime = live ? '' : `PT${Math.round(duration)}S`;
    dom.barDur.dateTime = live ? '' : `PT${Math.round(duration)}S`;
  }

  /* the hero badge says what it is doing, since there is no genre to fall back
     to when it is not playing */
  const track = player.current;
  if (track) {
    const label = store.get('playing') ? 'Сейчас играет' : 'Пауза';
    if (badgeLabel !== label) {
      badgeLabel = label;
      badgeSpan.textContent = label;
    }
  }

  if (store.get('currentId') && player.current?.source === 'file' && player.current.buffer) {
    const t = player.current;
    if (!t.__qualityShown) {
      t.__qualityShown = true;
      updateQuality(t);
    }
  }
}

/* ==========================================================================
   Wiring
   ========================================================================== */
function bindSeek(input, onCommit) {
  on(input, 'pointerdown', () => { scrubbing = true; });
  on(input, 'input', () => {
    scrubbing = true;
    const duration = engine.duration || store.get('duration') || 0;
    const t = (Number(input.value) / 1000) * duration;
    const label = fmtTime(t);
    if (input === dom.heroSeek) {
      dom.heroCur.textContent = label;
      dom.ring.style.strokeDashoffset = String(RING_LEN * (1 - Number(input.value) / 1000));
    } else {
      dom.barCur.textContent = label;
      dom.barProgress?.style.setProperty('--progress', `${Number(input.value) / 10}%`);
    }
  });
  const commit = () => {
    const duration = engine.duration || store.get('duration') || 0;
    const t = (Number(input.value) / 1000) * duration;
    scrubbing = false;
    onCommit(t);
  };
  on(input, 'change', commit);
  on(input, 'pointerup', commit);
  on(input, 'blur', () => { scrubbing = false; });
}

export function initTransport() {
  /* --- buttons --- */
  const togglePlay = () => player.toggle();
  dom.play.addEventListener('click', togglePlay);
  dom.barPlay.addEventListener('click', togglePlay);
  dom.heroArtPlay.addEventListener('click', togglePlay);

  dom.next.addEventListener('click', () => player.next());
  dom.barNext.addEventListener('click', () => player.next());
  dom.prev.addEventListener('click', () => player.prev());
  dom.barPrev.addEventListener('click', () => player.prev());

  const shuffle = () => player.toggleShuffle();
  dom.shuffle.addEventListener('click', shuffle);
  dom.barShuffle.addEventListener('click', shuffle);

  const repeat = () => player.cycleRepeat();
  dom.repeat.addEventListener('click', repeat);
  dom.barRepeat.addEventListener('click', repeat);

  const like = () => player.toggleLike(store.get('currentId'));
  dom.like.addEventListener('click', like);
  dom.barLike.addEventListener('click', like);

  /* --- seek --- */
  bindSeek(dom.heroSeek, (t) => player.seek(t));
  bindSeek(dom.barSeek, (t) => player.seek(t));

  /* --- volume --- */
  on(dom.volume, 'input', () => player.setVolume(Number(dom.volume.value) / 100));
  dom.mute.addEventListener('click', () => player.toggleMute());

  /* --- volume wheel over the play bar (nice desktop touch) */
  on(dom.playbar, 'wheel', (e) => {
    if (!e.ctrlKey && Math.abs(e.deltaY) < 2) return;
    if (e.target.closest('.track')) return;
    e.preventDefault();
    player.setVolume(store.get('volume') - e.deltaY * 0.0016);
  }, { passive: false });

  /* --- EQ chips --- */
  dom.chips?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-eq]');
    if (!chip) return;
    player.setEq(chip.dataset.eq);
    for (const c of dom.chips.querySelectorAll('[data-eq]')) c.classList.toggle('is-active', c === chip);
  });

  /* --- initial paint --- */
  const eq = store.get('eq');
  for (const c of dom.chips?.querySelectorAll('[data-eq]') || []) {
    c.classList.toggle('is-active', c.dataset.eq === eq);
  }
  engine.setEq(eq);

  /* --- clock --- */
  addTask(updateClock);
}

/* Exposed so other views can force a repaint of shared UI state */
export { dom as transportDom, updateQuality, syncLike };
