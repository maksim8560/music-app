/* ==========================================================================
   ui/linkprobe.js — что на самом деле лежит по ссылке
   ========================================================================== */

/**
 * Разобраться в чужой ссылке, чтобы не сохранять нерабочую запись.
 *
 * Зачем это. Форма добавления принимала любой адрес и верила ему на слово: стоило
 * вписать страницу стримингового сервиса, запись проходила, сохранялась и
 * молча не играла — а понять, почему, можно было только догадкой. Здесь адрес
 * один раз проверяется по-настоящему, и результат показывается словами.
 *
 * Проверка идёт в два шага, и разница между ними и есть весь смысл.
 *
 * Первым идёт запрос без CORS — он не скажет ничего о содержимом, зато скажет,
 * жив ли хост. Вторым — обычный запрос с чтением тела: если он прошёл, хост
 * разрешает читать файл, и браузер отдаст нам заголовки. Раз так, то различие
 * между «хост не отвечает» и «хост отвечает, но читать запрещает» получается
 * определить, хотя заголовок Access-Control-Allow-Origin из JavaScript не виден
 * никогда — видно только, разрешил браузер чтение или нет.
 *
 * Про стриминговые сервисы. Ссылка на трек Яндекс Музыки, Spotify или Apple
 * Music — это веб-страница, а не аудио: сам звук отдаётся только их собственному
 * плееру, и вытащить его можно лишь повторив защищённые запросы этого плеера.
 * Мы этого не делаем и говорим почему прямо, вместо того чтобы сохранить
 * ссылку, которая не заработает никогда.
 */

/** Сколько ждать ответа, прежде чем считать хост мёртвым */
const HEAD_TIMEOUT = 4000;
const GET_TIMEOUT = 7000;

/** Сколько байт в начале файла читаем: хватает на ID3-тег почти всегда */
const HEAD_BYTES = 64 * 1024;

/**
 * Страницы стриминговых сервисов: узнаём по домену, чтобы объяснение было
 * конкретным, а не «какая-то страница».
 */
const STREAMING_PAGES = [
  [/(^|\.)music\.yandex\.(ru|com|by|kz|uz)/i, 'Яндекс Музыка'],
  [/(^|\.)open\.spotify\.com/i, 'Spotify'],
  [/(^|\.)music\.apple\.com/i, 'Apple Music'],
  [/(^|\.)deezer\.com/i, 'Deezer'],
  [/(^|\.)music\.vk\.com/i, 'VK Музыка'],
  [/(^|\.)zvuk\.com/i, 'Звук'],
  [/(^|\.)youtube\.com|youtu\.be/i, 'YouTube'],
  [/(^|\.)soundcloud\.com/i, 'SoundCloud'],
];

const fail = (note) => ({ ok: false, note });

/**
 * Проверить ссылку.
 *
 * Возвращает либо `{ ok: false, note }` с объяснением, что не так, либо
 * `{ ok: true, kind, cors, duration, tags, note }`, где `kind` — 'file' или
 * 'stream'. Никогда не бросает: любая ошибка превращается в строку для человека.
 */
export async function probeLink(raw) {
  const url = (raw || '').trim();
  if (!url) return fail('Вставьте адрес — и я проверю, что по нему отдаётся.');
  if (!/^https?:\/\//i.test(url)) return fail('Нужен полный адрес, начиная с http:// или https://');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail('Адрес не разбирается. Похоже, в нём опечатка.');
  }
  if (!parsed.hostname.includes('.')) return fail('В адресе нет домена.');

  /* --- шаг 1: хост жив вообще? --- */
  const live = await reachable(url);
  if (!live) {
    return fail('Хост не отвечает. Проверьте адрес — опечатка, или сайт лежит, или сервер не пускает запросы из браузера.');
  }

  /* --- шаг 2: можно ли читать? --- */
  let res;
  let bytes = new Uint8Array(0);
  try {
    const got = await readHead(url, HEAD_BYTES);
    res = got.res;
    bytes = got.bytes;
  } catch {
    return {
      ok: false,
      cors: false,
      note: 'Хост отвечает, но отдавать файл в браузер не разрешает — нет заголовка CORS. '
        + 'Само аудио через плеер, возможно, заиграет, но плеер не сможет его скачать и разобрать, '
        + 'а спектрограмма останется немой.',
    };
  }

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const range = res.headers.get('content-range');
  const length = res.headers.get('content-length');
  /* Icecast отдаёт поток без длины, и это главный признак прямого эфира */
  const seekable = length != null || range != null;

  /* --- шаг 3: это вообще аудио? --- */
  if (/^(text\/html|application\/xhtml)/.test(type)) {
    const known = STREAMING_PAGES.find(([re]) => re.test(parsed.hostname));
    if (known) {
      return fail(
        `${known[1]} — это страница, а не аудиофайл. Само аудио отдаётся только их собственному `
        + `плееру, и достать его можно лишь повторив защищённые запросы этого плеера — мы этого `
        + `не делаем. Нужен прямой адрес файла или потока: своя музыка, общественное достояние `
        + `или то, что отдаётся по прямой ссылке.`,
      );
    }
    return fail(
      'По ссылке отдаётся веб-страница, а не аудио. Нужен прямой адрес файла (.mp3, .m4a, .ogg, .flac) '
      + 'или потока станции.',
    );
  }

  if (/(mpegurl|m3u8)/.test(type) || /\.m3u8(\?|#|$)/i.test(parsed.pathname)) {
    return fail(
      'Это список плейлиста HLS (.m3u8), а не сам звук. Такие потоки играет только Safari, '
      + 'остальным браузерам нужен плеер, который их собирает. Возьмите прямую ссылку на поток или файл.',
    );
  }

  const isAudio = type.startsWith('audio/')
    || /^(application\/(ogg|octet-stream)|binary)/.test(type);
  if (!isAudio) {
    return fail(
      type
        ? `Сервер отдаёт «${type}» — это не аудио. Проверьте, что адрес ведёт на сам файл, а не на страницу с плеером.`
        : 'Сервер не сказал, что это за данные, и аудио среди них не разобралось. Скорее всего, адрес ведёт не на файл.',
    );
  }

  /* --- шаг 4: файл или поток? --- */
  let kind = seekable ? 'file' : 'stream';
  let duration = null;
  let tags = null;

  if (kind === 'file') {
    const dur = await durationOf(url);
    /* Поток, который ответил длиной, но оказался бесконечным, — это всё равно
       поток: такой выдаёт любой сервер, отдающий файл частями. */
    if (dur === Infinity) kind = 'stream';
    else if (dur != null) duration = dur;

    if (kind === 'file') {
      tags = await readTags(url, bytes);
      if (tags && !tags.title) {
        /* Тег есть, названия в нём нет — значит файл без названия, и придумывать
           его нельзя: id у трека всё равно останется единственным ориентиром. */
      }
    }
  }

  const what = kind === 'stream' ? 'Поток станции — прямой эфир' : 'Аудиофайл';
  const bits = [what];
  if (duration != null) bits.push(`длительность ${Math.round(duration / 60)} мин ${Math.round(duration % 60)} с`);
  bits.push('CORS в порядке — спектрограмма будет работать');

  return {
    ok: true,
    kind,
    cors: true,
    duration,
    tags,
    type,
    note: `${bits.join(' · ')}.`,
  };
}

/* ------------------------------- запросы -------------------------------- */

/**
 * Жив ли хост: запрос, который не спотыкается о CORS.
 *
 * Сначала был HEAD, и это была ошибка. Прямой эфир на HEAD не отвечает — сервер
 * держит соединение открытым и ждёт, когда его попросят закрыть, — и станция,
 * которая работает сама, спокойно объявлялась мёртвой. Теперь это запрос первого
 * байта без чтения тела: заголовки приходят сразу, а тело мы обрываем сами,
 * поэтому соединение не остаётся висеть.
 */
async function reachable(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT);
  try {
    await fetch(url, {
      mode: 'no-cors',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    /* тело ответа при no-cors недоступно, закрыть его иначе нечем */
    ctrl.abort();
  }
}

/**
 * Прочитать начало файла.
 *
 * Тело читается одной порцией и сразу отменяется: если сервер проигнорировал
 * Range и прислал целый файл, а это может быть и поток на несколько часов,
 * читать его до конца не нужно и нельзя.
 */
async function readHead(url, max) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GET_TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${max}` },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`статус ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return { res, bytes: new Uint8Array(0) };
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return { res, bytes: value || new Uint8Array(0) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Длительность и, попутно, признак прямого эфира.
 *
 * У потока длительность бесконечна — это и есть способ отличить эфир от файла
 * независимо от того, что написал сервер в заголовках. `crossOrigin` обязателен:
 * без него браузер отдаст время файла, даже когда читать его не разрешено, и мы
 * приняли бы за рабочий вариант тот, который потом не скачается.
 *
 * `Infinity` возвращается как есть, а не как ошибка: это полезное значение.
 */
function durationOf(url) {
  return new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      try { audio.load(); } catch { /* уже освобождён */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), HEAD_TIMEOUT + 2000);
    audio.crossOrigin = 'anonymous';
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      const d = audio.duration;
      finish(Number.isFinite(d) && d > 0 ? d : Infinity);
    });
    audio.addEventListener('error', () => finish(null));
    audio.src = url;
  });
}

/* ------------------------------ ID3-теги -------------------------------- */

/**
 * Прочитать название, исполнителя и альбом из ID3v2.
 *
 * Тег лежит в самом начале файла, поэтому он уже в той первой порции, что мы
 * прочитали, — отдельный запрос нужен только когда тег длиннее порции.
 */
async function readTags(url, head) {
  let bytes = head;
  try {
    const tag = parseId3(bytes);
    if (tag) return tag;
    if (bytes.length < 10) return null;
    /* объявленный размер тега больше того, что уже прочитали */
    const size = syncsafe(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 6);
    const total = 10 + size;
    if (total <= bytes.length || size <= 0 || total > 2 * 1024 * 1024) return null;
    const got = await readHead(url, total - 1);
    bytes = got.bytes;
  } catch {
    return null;
  }
  return parseId3(bytes);
}

/** размер ID3v2 записан четырьмя байтами, в каждом старший бит — ноль */
function syncsafe(dv, at) {
  return ((dv.getUint8(at) & 0x7f) << 21)
    | ((dv.getUint8(at + 1) & 0x7f) << 14)
    | ((dv.getUint8(at + 2) & 0x7f) << 7)
    | (dv.getUint8(at + 3) & 0x7f);
}

const ENCODINGS = ['iso-8859-1', 'utf-16', 'utf-16be', 'utf-8'];

/** названия кадров: в ID3v2.2 трёхбуквенные, дальше четырёхбуквенные */
const FRAMES_22 = { TT2: 'title', TP1: 'artist', TAL: 'album' };
const FRAMES_24 = { TIT2: 'title', TPE1: 'artist', TALB: 'album' };

function parseId3(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // "ID3"

  const major = bytes[3];
  const flags = bytes[5];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = syncsafe(dv, 6);
  const end = Math.min(bytes.length, 10 + size);
  if (end <= 10) return null;

  const short = major <= 2;
  const idLen = short ? 3 : 4;
  const sizeLen = short ? 3 : 4;
  /* в 2.2 заголовок кадра — это имя и размер, а начиная с 2.3 добавляются два
     байта флагов. Без них данные читаются со сдвигом, и русское название
     приходит latin-1 мусором с чужой буквой впереди. */
  const flagLen = short ? 0 : 2;
  const wanted = short ? FRAMES_22 : FRAMES_24;

  let at = 10;
  /* расширенный заголовок пропускаем, если он есть */
  if (flags & 0x40 && end - at >= 4) {
    at += major >= 4 ? 4 + syncsafe(dv, at) : 4 + dv.getUint32(at);
  }

  const out = {};
  /* потолок на число кадров: не даём зациклиться на мусоре вместо тега */
  for (let guard = 0; guard < 200 && at + idLen + sizeLen + flagLen <= end; guard++) {
    const id = String.fromCharCode(...bytes.subarray(at, at + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    let frameSize;
    if (short) frameSize = (bytes[at + 3] << 16) | (bytes[at + 4] << 8) | bytes[at + 5];
    else if (major >= 4) frameSize = syncsafe(dv, at + 4);
    else frameSize = dv.getUint32(at + 4);

    const from = at + idLen + sizeLen + flagLen;
    if (frameSize <= 0 || from >= end) break;

    const field = wanted[id];
    if (field && !out[field]) {
      const text = decodeText(bytes.subarray(from, Math.min(from + frameSize, end)));
      if (text) out[field] = text;
    }
    at = from + frameSize;
  }

  /* заодно вычищаем мусор, который любят писать в теги */
  for (const key of Object.keys(out)) out[key] = out[key].replace(/\0/g, '').trim().slice(0, 200);
  return Object.keys(out).length ? out : null;
}

function decodeText(slice) {
  if (slice.length < 2) return '';
  const enc = ENCODINGS[slice[0]] || 'utf-8';
  try {
    return new TextDecoder(enc).decode(slice.subarray(1)).replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}
