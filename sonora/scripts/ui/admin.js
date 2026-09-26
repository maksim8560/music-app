/* ==========================================================================
   ui/admin.js — sign-in gate and the admin panel
   ----------------------------------------------------------------------------
   The button lives at the top right. Until a password is set the panel asks
   for one; after that it opens straight into the settings.

   Sections:
     Сайт    — name, tagline, description, accent, background image
     Музыка  — edit / hide / reseed every track, add generative ones, add by
               URL, export and import the whole configuration
     Пароль  — change the password, sign out

   Everything is stored in this browser only. There is no server, so the
   password is a local lock, not a security boundary.
   ========================================================================== */

import { on, qs, qsa, plural } from '../core/dom.js';
import { store } from '../core/store.js';
import { player } from '../core/player.js';
import { admin, PLAYLIST_ICONS } from '../data/admin.js';
import { remoteConfig, saveRemoteConfig } from '../data/remote.js';
import { onSyncChange, syncNow, testSync, disableSync, markDirty } from '../data/sync.js';
import { remoteWritable } from '../data/remote.js';
import { GENRES } from '../data/tracks.js';
import { SCALES } from '../audio/synth.js';
import { openSheet, closeSheet, initSheet } from './sheet.js';
import { art } from './artwork.js';
import { toast } from './toast.js';
import { applyTheme } from './settings.js';
import { renderSidePlaylists } from './sidebar.js';

const SCALE_LABELS = {
  minor: 'До минор',
  dorian: 'Дорийский',
  lydian: 'Лидийский',
  major: 'До мажор',
  majorPent: 'Мажорный пентатоник',
  minorPent: 'Минорный пентатоник',
};

let root = null;
let open = false;
/* ------------------------------- helpers -------------------------------- */

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) on(node, k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

const field = (label, control, hint) =>
  el('label', { class: 'adm-field' }, [
    el('span', { class: 'adm-field__label', text: label }),
    control,
    hint ? el('small', { class: 'adm-field__hint', text: hint }) : null,
  ]);

const input = (value, onInput, attrs = {}) =>
  el('input', { value: value ?? '', ...attrs, oninput: (e) => onInput(e.target.value, e) });

const numberInput = (value, onInput, attrs = {}) =>
  el('input', { type: 'number', value: value ?? '', ...attrs, oninput: (e) => onInput(e.target.value, e) });

const select = (value, options, onChange) =>
  el('select', { onchange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => el('option', { value: v, selected: v === value, text })));

const button = (text, onClick, cls = 'ghost-btn') =>
  el('button', { class: cls, type: 'button', onclick: onClick, text });

const icon = (name, size = 16) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

/** Every catalogue change goes through here so the player stays in step. */
function catalogueChanged(message) {
  player.reconcile();
  /* with a repository configured this is what makes the change reach every
     other device — one debounced write per burst of edits */
  markDirty();
  if (message) toast(message, 'ok');
}

/* ------------------------------- badge --------------------------------- */

function setBadge(state) {
  const badge = qs('#adm-badge');
  if (!badge) return;
  badge.setAttribute('data-state', state);
  badge.textContent = state === 'on' ? 'вход' : 'закрыто';
}

/* -------------------------------- login --------------------------------- */

function buildGate() {
  const inputPw = el('input', { type: 'password', id: 'adm-pass', autocomplete: 'current-password', placeholder: '••••••' });
  const confirm = el('input', { type: 'password', id: 'adm-pass2', autocomplete: 'new-password', placeholder: '••••••' });
  const error = el('p', { class: 'adm-error', role: 'alert' });

  const submit = async (e) => {
    e?.preventDefault();
    error.textContent = '';
    const value = inputPw.value;
    if (!value) {
      error.textContent = 'Введите пароль';
      inputPw.focus();
      return;
    }
    try {
      const first = !admin.hasPassword;
      if (first) {
        if (value.length < 4) throw new Error('Пароль от 4 символов');
        if (value !== confirm.value) throw new Error('Пароли не совпадают');
        await admin.setup(value);
        toast('Пароль задан', 'ok');
      } else {
        const good = await admin.login(value);
        if (!good) throw new Error('Неверный пароль');
      }
      showPanel();
    } catch (err) {
      error.textContent = String(err.message || err);
      inputPw.select();
    }
  };

  const form = el('form', { class: 'adm-gate', onsubmit: submit }, [
    el('p', { class: 'adm-gate__lead', text: admin.hasPassword
      ? 'Введите пароль, чтобы открыть настройки сайта и музыки.'
      : 'Первый вход — задайте пароль. Он хранится только в этом браузере.' }),
    field('Пароль', inputPw),
    admin.hasPassword ? null : field('Ещё раз', confirm),
    error,
    el('div', { class: 'adm-gate__row' }, [
      el('button', { class: 'primary-btn', type: 'submit', text: admin.hasPassword ? 'Войти' : 'Задать пароль и войти' }),
      button('Отмена', () => close(), 'ghost-btn'),
    ]),
    el('p', { class: 'adm-note', text: 'Пароль защищает панель от случайного открытия, а не от того, у кого есть доступ к файлам. Каталог виден всем, кто читает репозиторий, поэтому ставьте длинную фразу.' }),
  ]);

  return form;
}

/* --------------------------------- site --------------------------------- */

function applySite() {
  const site = admin.site;
  const name = (site.name || '').trim() || 'Sonora';
  document.title = site.tagline ? `${name} — ${site.tagline}` : name;
  const brandName = qs('.brand__text b');
  const brandTag = qs('.brand__text em');
  if (brandName) brandName.textContent = name;
  if (brandTag) brandTag.textContent = site.tagline || '';
  const desc = qs('meta[name="description"]');
  if (desc && site.description) desc.setAttribute('content', site.description);

  const stage = document.getElementById('bg-image');
  if (stage) {
    stage.style.backgroundImage = site.background ? `url("${CSS.escape ? site.background.replace(/"/g, '\\"') : site.background}")` : '';
    stage.dataset.on = site.background ? 'true' : '';
  }

  /* The accent lives in two stores: here and in the player's own settings. Only
     the form used to tie them together, so a value written anywhere else — or a
     reload — left the page showing whatever the player remembered instead of
     what the admin chose. The admin layer wins whenever it has an opinion. */
  if (site.accent && store.get('settings')?.accent !== site.accent) {
    store.patchSettings({ accent: site.accent });
    applyTheme();
  }
}

function buildSite() {
  const site = admin.site;
  const accents = [['', 'Как в плеере'], ...['aurora', 'Aurora'], ['ember', 'Ember'], ['mint', 'Mint'], ['mono', 'Mono'].map((a) => [a, a])];

  /* Same contract as the track editor: the fields hold a draft and «Сохранить»
     commits it, so a half-typed name never becomes the title of the site. */
  const draft = {};
  const saveBtn = el('button', { class: 'primary-btn', type: 'button', text: 'Сохранить', disabled: true });
  const refresh = () => { saveBtn.disabled = !Object.keys(draft).length; };
  const set = (k, v) => { draft[k] = v; refresh(); };
  saveBtn.addEventListener('click', () => {
    if (!Object.keys(draft).length) return;
    admin.updateSite({ ...draft });
    for (const k of Object.keys(draft)) delete draft[k];
    refresh();
    applySite();
    toast('Настройки сайта сохранены', 'ok', 2500);
  });

  const grid = el('div', { class: 'adm-grid' }, [
    field('Имя страницы', input(site.name, (v) => set('name', v), { maxlength: '40' }), 'Показывается в шапке и во вкладке браузера.'),
    field('Подпись', input(site.tagline, (v) => set('tagline', v), { maxlength: '40' }), 'Например: Glass Edition.'),
    field('Описание', input(site.description, (v) => set('description', v), { maxlength: '180' }),
      'Попадает в meta description — для поисковиков и предпросмотра ссылки.'),
    field('Акцент', select(site.accent, accents, (v) => set('accent', v)), 'Пусто — оставить акцент, выбранный в настройках плеера.'),
    field('Фоновая картинка (URL)', input(site.background, (v) => set('background', v), { placeholder: 'https://…/photo.jpg' }), 'Ссылка на изображение. Показывается затемнённым поверх живого фона.'),
  ]);

  return el('div', { class: 'adm-stack' }, [
    grid,
    el('div', { class: 'adm-add__row' }, [saveBtn]),
  ]);
}

/* -------------------------------- music --------------------------------- */

/* The add forms live above the track list, and every edit rebuilds that list —
   so "are the forms open?" has to be a variable, not DOM state, or signing in
   after the first click would quietly fold them away again. */
let addFormOpen = false;

function trackRow(track) {
  const custom = !!track.custom;
  const isStream = track.source === 'stream';
  const isUrl = track.source === 'url' || isStream;

  /**
   * Edits are collected here and committed by «Сохранить».
   *
   * Writing through on every keystroke meant a half-typed word was already
   * saved, and every letter cost a store write, a reconcile and a library
   * repaint. Now the row owns a draft: nothing reaches the player or
   * localStorage until the button is pressed, and «Сбросить» throws the draft
   * away instead of half-applying it.
   */
  const draft = {};
  const dirty = () => Object.keys(draft).length > 0;

  const titleEl = el('b', { text: track.title });
  const idEl = el('small', { text: `${track.artist} · ${track.id}` });
  const tagsEl = el('div', { class: 'adm-track__tags' });
  const paintTags = () => {
    tagsEl.replaceChildren();
    if (custom) tagsEl.append(el('span', { class: 'adm-tag adm-tag--own', text: 'своя' }));
    if (isStream) tagsEl.append(el('span', { class: 'adm-tag adm-tag--url', text: 'радио' }));
    else if (isUrl) tagsEl.append(el('span', { class: 'adm-tag adm-tag--url', text: 'ссылка' }));
    if (admin.isEdited(track.id)) tagsEl.append(el('span', { class: 'adm-tag', text: 'изменён' }));
    if (dirty()) tagsEl.append(el('span', { class: 'adm-tag adm-tag--dirty', text: 'не сохранено' }));
  };
  paintTags();

  const saveBtn = el('button', { class: 'primary-btn primary-btn--sm', type: 'button', text: 'Сохранить', disabled: true });
  const refreshSave = () => {
    saveBtn.disabled = !dirty();
    paintTags();
  };
  const set = (key, value) => {
    draft[key] = value;
    refreshSave();
  };

  saveBtn.addEventListener('click', () => {
    if (!dirty()) return;
    admin.updateTrack(track.id, { ...draft });
    for (const k of Object.keys(draft)) delete draft[k];
    titleEl.textContent = track.title;
    idEl.textContent = `${track.artist} · ${track.id}`;
    fillCover();
    refreshSave();
    catalogueChanged(`«${track.title}» сохранён`);
  });
  saveBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  });

  const discard = () => {
    if (!dirty()) {
      admin.resetTrack(track.id);
      renderMusic();
      catalogueChanged('Трек возвращён к исходному');
      return;
    }
    for (const k of Object.keys(draft)) delete draft[k];
    renderMusic();
    toast('Правки отменены', 'info', 2000);
  };

  const head = el('div', { class: 'adm-track__head' }, [
    el('span', { class: `adm-dot adm-dot--${track.genreKey || 'local'}` }),
    el('div', { class: 'adm-track__id' }, [titleEl, idEl]),
    tagsEl,
    button('Сбросить', discard, 'ghost-btn ghost-btn--sm'),
  ]);

  const controls = [
    field('Название', input(track.title, (v) => set('title', v), { maxlength: '60' })),
    field('Исполнитель', input(track.artist, (v) => set('artist', v), { maxlength: '60' })),
    field('Альбом', input(track.album, (v) => set('album', v), { maxlength: '60' })),
    field('Год', numberInput(track.year, (v) => set('year', Number(v) || 0), { min: '1900', max: '2999' })),
    field('Жанр', select(track.genreKey, Object.entries(GENRES).map(([k, g]) => [k, g.label]), (v) => {
      draft.genreKey = v;
      draft.genre = GENRES[v]?.label || v;
      refreshSave();
    })),
  ];

  const music = [
    field('Длительность, с', numberInput(track.duration, (v) => set('duration', Number(v) || 0), { min: '20', max: '3600' })),
    field('Темп, BPM', numberInput(track.bpm, (v) => set('bpm', Number(v) || 0), { min: '40', max: '200' })),
    field('Тоника (MIDI)', numberInput(track.root, (v) => set('root', Number(v) || 0), { min: '24', max: '84' })),
    field('Гамма', select(track.scale, Object.entries(SCALE_LABELS), (v) => set('scale', v))),
  ];

  const actions = el('div', { class: 'adm-track__actions' }, [
    saveBtn,
    button('▶', () => player.play(track.id), 'ghost-btn ghost-btn--sm'),
    isUrl || isStream ? null : button('Перегенерировать', () => {
      admin.reseed(track.id);
      renderMusic();
      catalogueChanged('Новый вариант — та же настройка, другая музыка');
    }, 'ghost-btn ghost-btn--sm'),
    button(admin.isHidden(track.id) ? 'Вернуть' : 'Скрыть', () => {
      const shown = admin.toggleHidden(track.id);
      renderMusic();
      catalogueChanged(shown ? 'Трек вернулся в список' : 'Трек скрыт из плеера');
    }, 'ghost-btn ghost-btn--sm'),
    custom ? button('Удалить', () => {
      if (dirty() && !confirm('Есть несохранённые правки — они пропадут. Удалить трек?')) return;
      admin.removeCustom(track.id);
      renderMusic();
      catalogueChanged('Трек удалён');
    }, 'ghost-btn ghost-btn--sm ghost-btn--danger') : null,
  ]);

  /* the cover the player will actually show: the uploaded one, or the
     procedural art that gets drawn from the id. The preview follows the field
     while typing — it is feedback, not a save. */
  const coverBox = el('div', { class: 'adm-cover' }, []);
  const fillCover = (override) => {
    const url = override !== undefined ? override : track.coverUrl;
    coverBox.replaceChildren();
    if (url) {
      const img = el('img', { src: url, alt: '', loading: 'lazy' });
      img.addEventListener('error', () => coverBox.replaceChildren(
        el('span', { text: 'не загрузилась' }),
      ));
      coverBox.append(img);
    } else {
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 96;
      c.className = 'adm-cover__gen';
      coverBox.append(c, el('span', { text: 'рисуется по id' }));
      art.paint(c, track);
    }
  };
  fillCover();

  const coverField = el('div', { class: 'adm-grid adm-grid--split' }, [
    field('Описание', el('textarea', {
      rows: '3', maxlength: '400',
      oninput: (e) => set('blurb', e.target.value),
    }), 'Показывается в списке и в карточке трека.'),
    field('Ссылка на обложку', input(track.coverUrl, (v) => {
      set('coverUrl', v);
      const ok = /^https?:\/\/\S+$/i.test(v.trim()) || /^data:image\//i.test(v.trim());
      fillCover(ok ? v.trim() : '');
    }, { placeholder: 'https://…/cover.jpg' })),
  ]);
  coverField.querySelector('textarea').value = track.blurb || '';

  return el('div', { class: 'adm-track' }, [
    head,
    el('div', { class: 'adm-grid adm-grid--tight' }, controls),
    isUrl ? el('div', { class: 'adm-url' }, [el('code', { text: track.url })]) : null,
    /* tempo, key and mode only mean anything to the synthesiser */
    track.source === 'gen' ? el('div', { class: 'adm-grid adm-grid--tight' }, music) : null,
    coverField,
    el('div', { class: 'adm-cover-row' }, [coverBox]),
    actions,
  ]);
}
function addUrlForm() {
  const draft = { url: '', title: '', artist: '', album: '', blurb: '', cover: '', genreKey: 'local', kind: 'file' };
  const error = el('p', { class: 'adm-error', role: 'alert' });
  const hint = el('p', { class: 'adm-note' });
  const preview = el('div', { class: 'adm-cover adm-cover--preview' }, [el('span', { text: 'обложки нет' })]);

  const KIND_NOTES = {
    file: 'Файл скачивается целиком и декодируется. Нужен CORS — без него браузер не отдаст байты. Длительность подставится сама.',
    stream: 'Радио играет напрямую, без скачивания: работает с любого домена, но у потока нет длины — перемотка отключена, а спектрограмма молчит.',
  };
  const genreField = el('div', { class: 'adm-field' }, [
    el('span', { class: 'adm-field__label', text: 'Жанр' }),
    select(draft.genreKey, Object.entries(GENRES).map(([k, g]) => [k, g.label]), (v) => { draft.genreKey = v; }),
  ]);

  const setPreview = (value) => {
    preview.replaceChildren();
    const ok = /^https?:\/\/\S+$/i.test(value.trim()) || /^data:image\//i.test(value.trim());
    if (!ok) {
      preview.append(el('span', { text: 'обложки нет' }));
      return;
    }
    const img = el('img', { src: value.trim(), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => {
      preview.replaceChildren(el('span', { text: 'не загрузилась' }));
    });
    preview.append(img);
  };

  const applyKind = (value) => {
    draft.kind = value;
    hint.textContent = KIND_NOTES[value];
    /* genre only means something for a file; a stream is always "Радио" */
    genreField.hidden = value === 'stream';
  };
  applyKind('file');

  return el('div', { class: 'adm-add' }, [
    el('h3', { text: 'Трек по прямой ссылке' }),
    el('div', { class: 'adm-grid adm-grid--one' }, [
      field('Что это', select('file', [
        ['file', 'Аудиофайл — mp3, flac, wav, ogg, m4a'],
        ['stream', 'Радио — прямой эфир, поток не кончается'],
      ], applyKind), 'Радио играет с любого домена. Файл должен отдаваться с CORS.'),
      field('Ссылка', input(draft.url, (v) => { draft.url = v; }, { placeholder: 'https://example.com/track.mp3' })),
    ]),
    hint,
    el('div', { class: 'adm-grid adm-grid--tight' }, [
      field('Название', input(draft.title, (v) => { draft.title = v; }, { maxlength: '60' })),
      field('Исполнитель', input(draft.artist, (v) => { draft.artist = v; }, { maxlength: '60' })),
      field('Альбом', input(draft.album, (v) => { draft.album = v; }, { maxlength: '60' })),
      genreField,
    ]),
    el('div', { class: 'adm-grid adm-grid--split' }, [
      field('Описание', el('textarea', {
        rows: '3', maxlength: '400', placeholder: 'Пара слов о треке',
        oninput: (e) => { draft.blurb = e.target.value; },
      })),
      field('Ссылка на обложку', input(draft.cover, (v) => { draft.cover = v; setPreview(v); }, { placeholder: 'https://…/cover.jpg' }),
        'Картинка квадратная, от 400×400. Без неё обложка рисуется по id.'),
    ]),
    preview,
    error,
    el('div', { class: 'adm-add__row' }, [
      el('button', { class: 'primary-btn', type: 'button', text: 'Добавить', onclick: () => {
        error.textContent = '';
        try {
          const t = admin.addUrl(draft);
          renderMusic();
          catalogueChanged(`«${t.title}» добавлен${t.source === 'stream' ? ' — радио' : ''}`);
        } catch (err) {
          error.textContent = String(err.message || err);
        }
      } }),
    ]),
  ]);
}

function renderMusic() {
  const host = qs('#adm-music');
  if (!host) return;
  host.replaceChildren();
  const tracks = admin.library();
  const list = el('div', { class: 'adm-tracks' }, tracks.map(trackRow));
  host.append(
    el('div', { class: 'adm-toolbar' }, [
      button('Добавить трек', () => {
        addFormOpen = !addFormOpen;
        renderMusic();
        if (addFormOpen) qs('#adm-extra')?.scrollIntoView({ block: 'nearest' });
      }, 'primary-btn'),
      button('Экспорт', () => {
        const blob = new Blob([admin.export()], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: 'sonora-admin.json' });
        document.body.append(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }, 'ghost-btn'),
      button('Импорт', () => qs('#adm-import-file')?.click(), 'ghost-btn'),
      button(admin.isEmpty ? 'Каталог пуст' : 'Очистить полку', () => {
        if (!admin.isEmpty && !confirm('Удалить все треки и правки? Каталог станет пустым.')) return;
        admin.resetCatalogue();
        renderMusic();
        catalogueChanged('Полка очищена — добавьте музыку по ссылке');
      }, 'ghost-btn ghost-btn--danger'),
      el('input', { type: 'file', id: 'adm-import-file', accept: 'application/json,.json', hidden: true,
        onchange: async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try {
            admin.import(await file.text());
            applySite();
            renderMusic();
            catalogueChanged('Настройки импортированы');
          } catch (err) {
            toast(`Импорт не удался: ${String(err.message || err)}`, 'error');
          }
        } }),
    ]),
    el('div', { class: 'adm-extra adm-grid--wide', id: 'adm-extra', hidden: !addFormOpen }, [addUrlForm()]),
    list,
  );
}

/* ------------------------------- playlists ------------------------------- */

/** A row of the sprite glyphs a playlist may carry; the chosen one is marked. */
function iconPicker(current, onPick) {
  const wrap = el('div', { class: 'adm-icons', role: 'radiogroup', 'aria-label': 'Иконка плейлиста' });
  for (const name of PLAYLIST_ICONS) {
    const b = el('button', {
      class: `adm-icons__item${name === current ? ' is-active' : ''}`,
      type: 'button',
      role: 'radio',
      'aria-checked': name === current ? 'true' : 'false',
      title: name,
      onclick: () => {
        onPick(name);
        for (const other of wrap.children) {
          const on = other === b;
          other.classList.toggle('is-active', on);
          other.setAttribute('aria-checked', String(on));
        }
      },
    });
    b.append(icon(name, 17));
    wrap.append(b);
  }
  return wrap;
}

/**
 * Create, rename, delete — and fill. Every playlist shows the whole shelf as
 * checkboxes, so filling one does not mean hunting for the right row first.
 */
function buildPlaylists() {
  const draft = { name: '', icon: 'note' };
  const error = el('p', { class: 'adm-error', role: 'alert' });
  const tracks = admin.library();

  const create = el('div', { class: 'adm-add' }, [
    el('h3', { text: 'Новый плейлист' }),
    el('p', { class: 'adm-note', text: 'Создать его можно и прямо в боковом меню — кнопкой «Создать плейлист». Здесь же выбирается иконка.' }),
    el('div', { class: 'adm-grid adm-grid--one' }, [
      field('Название', input(draft.name, (v) => { draft.name = v; }, { placeholder: 'Для дороги', maxlength: '40' })),
      field('Иконка', iconPicker(draft.icon, (v) => { draft.icon = v; })),
    ]),
    error,
    el('div', { class: 'adm-add__row' }, [
      el('button', { class: 'primary-btn', type: 'button', text: 'Создать', onclick: () => {
        error.textContent = '';
        try {
          admin.addPlaylist(draft.name, draft.icon);
          renderPlaylists();
          renderSidePlaylists();
          catalogueChanged();
        } catch (err) {
          error.textContent = String(err.message || err);
        }
      } }),
    ]),
  ]);

  const list = admin.playlists.map((pl) => {
    const name = el('input', { class: 'adm-pl-name', value: pl.name, maxlength: '40' });
    name.addEventListener('input', () => admin.renamePlaylist(pl.id, name.value));
    name.addEventListener('change', () => {
      renderSidePlaylists();
      catalogueChanged();
    });

    const items = tracks.length
      ? tracks.map((t) => {
        const box = el('input', { type: 'checkbox', checked: pl.trackIds.includes(t.id) });
        box.addEventListener('change', () => {
          admin.toggleInPlaylist(pl.id, t.id);
          count.textContent = countFor(pl.id);
          renderSidePlaylists();
          catalogueChanged();
        });
        return el('label', { class: 'adm-pl__track' }, [
          box,
          el('span', { class: 'adm-pl__title', text: t.title }),
          el('small', { text: t.artist }),
        ]);
      })
      : [el('p', { class: 'adm-note', text: 'Треков пока нет — добавьте их на вкладке «Музыка».' })];

    const count = el('span', { class: 'adm-pl__count' });
    const countFor = (id) => {
      const n = admin.playlist(id)?.trackIds.length || 0;
      /* plural() already renders the number with the word */
      return n ? plural(n, 'трек', 'трека', 'треков') : 'пусто';
    };
    count.textContent = countFor(pl.id);

    return el('div', { class: 'adm-pl' }, [
      el('div', { class: 'adm-pl__head' }, [
        name,
        count,
        el('div', { class: 'adm-pl__tools' }, [
          button('Показать', () => {
            player.setFilter(`pl:${pl.id}`);
            close();
            toast(`Открыт плейлист «${admin.playlist(pl.id)?.name || pl.name}»`, 'info', 3000);
          }, 'ghost-btn ghost-btn--sm'),
          button('Удалить', () => {
            if (!confirm(`Удалить плейлист «${pl.name}»? Сами треки останутся на полке.`)) return;
            admin.removePlaylist(pl.id);
            if (store.get('filter') === `pl:${pl.id}`) player.setFilter('all');
            renderPlaylists();
            renderSidePlaylists();
            catalogueChanged();
          }, 'ghost-btn ghost-btn--sm ghost-btn--danger'),
        ]),
      ]),
      el('div', { class: 'adm-pl__tracks' }, items),
    ]);
  });

  return el('div', { class: 'adm-stack' }, [
    create,
    list.length
      ? el('div', { class: 'adm-tracks' }, list)
      : el('p', { class: 'adm-note', text: 'Плейлистов пока нет. Создайте первый — он появится в боковом меню.' }),
  ]);
}

/* ------------------------------- sync ------------------------------------ */

/**
 * Where the catalogue lives.
 *
 * With a token configured the whole document becomes a file in the repository,
 * and any other device picks it up on reload. Without one, everything stays in
 * this browser — which is the honest default, and the reason a change made on
 * a phone used to vanish when you came back to the desktop.
 */
function buildSync() {
  const cfg = remoteConfig();
  const draft = { repo: cfg.repo, branch: cfg.branch, path: cfg.path, token: cfg.token };
  const error = el('p', { class: 'adm-error', role: 'alert' });
  const statusLine = el('p', { class: 'adm-sync__status' });
  const paint = (s) => {
    statusLine.dataset.state = s.state;
    const map = {
      off: 'Отключено: каталог и плейлисты хранятся только в этом браузере.',
      readonly: s.message,
      idle: s.message,
      loading: s.message,
      saving: s.message,
      saved: s.message,
      error: s.message,
    };
    statusLine.textContent = map[s.state] || '';
  };
  const off = onSyncChange(paint);

  const set = (k, v) => { draft[k] = v; };
  const hasToken = Boolean(draft.token);

  return el('div', { class: 'adm-stack' }, [
    el('div', { class: 'adm-add' }, [
      el('h3', { text: 'Где хранится каталог' }),
      el('p', { class: 'adm-note', text: 'Каталог лежит файлом в репозитории и читается оттуда при каждой загрузке страницы — на любом устройстве, без входа и без настройки. Настройки ниже нужны только для записи: чтобы панель могла сохранять.' }),
      el('div', { class: 'adm-grid adm-grid--one' }, [
        field('Репозиторий', input(draft.repo, (v) => set('repo', v), { placeholder: 'maksim8560/music-app' })),
        field('Ветка', input(draft.branch, (v) => set('branch', v), { placeholder: 'Main' })),
        field('Путь к файлу', input(draft.path, (v) => set('path', v), { placeholder: 'sonora/catalogue.json' })),
        field('Токен (только для записи)', input(draft.token, (v) => set('token', v.trim()), { type: 'password', placeholder: 'github_pat_…' }),
          'Тонкий токен (fine-grained): доступ только к этому репозиторию и только на чтение и запись содержимого. Хранится в этом браузере, в файл не попадает.'),
      ]),
      error,
      el('div', { class: 'adm-add__row' }, [
        el('button', { class: 'primary-btn', type: 'button', text: 'Сохранить и проверить', onclick: async () => {
          error.textContent = '';
          saveRemoteConfig({ ...draft });
          const ok = await testSync();
          if (ok) {
            renderSync();
            catalogueChanged(remoteWritable() ? 'Запись включена' : 'Проверено: каталог читается');
          }
        } }),
        el('button', { class: 'ghost-btn', type: 'button', text: 'Сохранить сейчас', onclick: async () => {
          saveRemoteConfig({ ...draft });
          await syncNow();
        } }),
        el('button', { class: 'ghost-btn ghost-btn--danger', type: 'button', text: 'Забыть токен', onclick: () => {
          disableSync();
          renderSync();
        } }),
      ]),
      statusLine,
      el('details', { class: 'adm-details' }, [
        el('summary', { text: 'Как получить токен' }),
        el('ol', {}, [
          el('li', { text: 'Откройте github.com/settings/personal-access-tokens/new и создайте тонкий токен (fine-grained).' }),
          el('li', { text: 'В поле Repository выберите только maksim8560/music-app.' }),
          el('li', { text: 'Разрешения Repository permissions → Contents: Read and write. Больше ничего трогать не нужно.' }),
          el('li', { text: 'Задайте короткий срок действия и вставьте токен в поле выше.' }),
        ]),
        el('p', { class: 'adm-note', text: 'Токен даёт доступ к репозиторию от вашего имени. Держите его в тайне и не присылайте никому в переписке.' }),
      ]),
    ]),

    el('div', { class: 'adm-add adm-warn' }, [
      el('h3', { text: 'Про пароль — коротко' }),
      el('p', { text: 'Пароль панели хранится как хеш с солью, и файл лежит в публичном репозитории — значит этот хеш видят все, кто читает репозиторий. Короткий пароль из шести цифр перебирается за секунды, поэтому ставьте длинную фразу: её роль не в том, чтобы остановить взлом, а в том, чтобы никто не открыл панель случайно.' }),
      el('p', { text: 'Запись защищает токен: пока он есть только у вас, изменить каталог может только он.' }),
    ]),
  ]);
}

/* -------------------------------- password ------------------------------- */

function buildPassword() {
  const cur = el('input', { type: 'password', autocomplete: 'current-password' });
  const next = el('input', { type: 'password', autocomplete: 'new-password' });
  const again = el('input', { type: 'password', autocomplete: 'new-password' });
  const error = el('p', { class: 'adm-error', role: 'alert' });

  return el('div', { class: 'adm-grid adm-grid--one' }, [
    field('Текущий пароль', cur),
    field('Новый пароль', next),
    field('Новый пароль ещё раз', again),
    error,
    el('div', { class: 'adm-add__row' }, [
      el('button', { class: 'primary-btn', type: 'button', text: 'Сменить пароль', onclick: async () => {
        error.textContent = '';
        if (next.value !== again.value) {
          error.textContent = 'Новые пароли не совпадают';
          return;
        }
        try {
          await admin.changePassword(cur.value, next.value);
          cur.value = next.value = again.value = '';
          toast('Пароль изменён', 'ok');
        } catch (err) {
          error.textContent = String(err.message || err);
        }
      } }),
      button('Выйти', () => {
        admin.logout();
        showGate();
        toast('Вы вышли из панели', 'info');
      }),
    ]),
    el('p', { class: 'adm-note', text: 'Пароль хранится в этом браузере как хеш с солью. Забытый пароль сбрасывается только вместе с настройками — восстановить его нельзя.' }),
  ]);
}

/* --------------------------------- shell -------------------------------- */

const TABS = [
  ['site', 'Сайт'],
  ['music', 'Музыка'],
  ['playlists', 'Плейлисты'],
  ['sync', 'Синхронизация'],
  ['password', 'Пароль'],
];

function showGate() {
  const gate = qs('#adm-gate');
  const body = qs('#adm-body');
  gate.replaceChildren(buildGate());
  gate.hidden = false;
  body.hidden = true;
  setBadge('off');
}

function showPanel() {
  const gate = qs('#adm-gate');
  const body = qs('#adm-body');
  gate.hidden = true;
  gate.replaceChildren();
  body.hidden = false;
  setBadge('on');
  renderSite();
  renderMusic();
  renderPlaylists();
  renderSync();
  renderPassword();
  /* the add form may have been asked for before the password was typed */
  if (pendingExpand) {
    pendingExpand = false;
    expandAddForm();
  }
}

let pendingExpand = false;

function expandAddForm() {
  const extra = qs('#adm-extra');
  if (!extra) return false;
  extra.hidden = false;
  extra.scrollIntoView({ block: 'nearest' });
  extra.querySelector('input')?.focus();
  return true;
}
let passwordHost = null;
const renderPassword = () => {
  /* looked up per call: the hosts only exist once the panel is in the DOM */
  const host = passwordHost || qs('#adm-password');
  if (host) host.replaceChildren(buildPassword());
};

const renderSite = () => {
  const host = qs('#adm-site');
  if (host) host.replaceChildren(buildSite());
};

const renderPlaylists = () => {
  const host = qs('#adm-playlists');
  if (host) host.replaceChildren(buildPlaylists());
};

const renderSync = () => {
  const host = qs('#adm-sync');
  if (host) host.replaceChildren(buildSync());
};

function switchTab(name) {
  for (const btn of qsa('#adm-tabs button')) {
    btn.classList.toggle('is-active', btn.dataset.tab === name);
  }
  for (const sec of qsa('#adm-sections > section')) {
    sec.hidden = sec.dataset.tab !== name;
  }
  if (name === 'site') renderSite();
  if (name === 'music') renderMusic();
  if (name === 'playlists') renderPlaylists();
  if (name === 'sync') renderSync();
  if (name === 'password') renderPassword();
}

export function close() {
  if (!root) return;
  closeSheet(root);
  open = false;
  qs('#btn-admin')?.setAttribute('aria-expanded', 'false');
}

export function openAdmin(tab = 'site', { expandAdd = false } = {}) {
  if (!root) return;
  open = true;
  qs('#btn-admin')?.setAttribute('aria-expanded', 'true');
  if (admin.authed) showPanel();
  else showGate();
  openSheet(root);
  switchTab(tab);
  if (expandAdd) {
    addFormOpen = true;
    if (expandAddForm()) pendingExpand = false;
  }
}

function build() {
  root = el('div', { class: 'sheet sheet--admin', id: 'admin-sheet', hidden: true }, [
    el('div', { class: 'sheet__backdrop', 'data-close': true }),
    el('div', { class: 'sheet__panel sheet__panel--admin glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Админ-панель' }, [
      el('div', { class: 'sheet__head' }, [
        el('h2', {}, [icon('sliders', 18), document.createTextNode(' Админ-панель')]),
        el('div', { class: 'sheet__head-tools' }, [
          el('span', { class: 'adm-badge', id: 'adm-badge', 'data-state': 'off', text: 'закрыто' }),
          el('button', { class: 'icon-btn icon-btn--sm', 'data-close': true, 'aria-label': 'Закрыть' }, [icon('close', 18)]),
        ]),
      ]),
      el('div', { class: 'adm-gate-host', id: 'adm-gate' }),
      el('div', { id: 'adm-body', hidden: true }, [
        el('div', { class: 'adm-tabs', id: 'adm-tabs', role: 'tablist' },
          TABS.map(([key, label]) => el('button', {
            class: 'adm-tab', type: 'button', role: 'tab', 'data-tab': key,
            onclick: () => switchTab(key), text: label,
          }))),
        el('div', { class: 'adm-sections', id: 'adm-sections' }, [
          el('section', { 'data-tab': 'site' }, [el('div', { class: 'adm-section__body', id: 'adm-site' })]),
          el('section', { 'data-tab': 'music', hidden: true }, [el('div', { id: 'adm-music' })]),
          el('section', { 'data-tab': 'playlists', hidden: true }, [el('div', { id: 'adm-playlists' })]),
          el('section', { 'data-tab': 'sync', hidden: true }, [el('div', { id: 'adm-sync' })]),
          el('section', { 'data-tab': 'password', hidden: true }, [el('div', { id: 'adm-password' })]),
        ]),
      ]),
    ]),
  ]);
  document.body.append(root);
  initSheet(root);
  on(root, 'click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  on(document, 'keydown', (e) => {
    /* the palette owns Escape while it is open */
    if (e.key !== 'Escape' || !open) return;
    if (!document.getElementById('palette')?.hidden) return;
    close();
  });
}

export function initAdmin() {
  build();
  on(qs('#btn-admin'), 'click', () => (open ? close() : openAdmin()));
  applySite();
  /* keep the badge honest if the session is already open */
  setBadge(admin.authed ? 'on' : 'off');
}

export { applySite as applyAdminSite };
