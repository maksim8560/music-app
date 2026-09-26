/* ==========================================================================
   data/remote.js — the catalogue as a file in the repository
   ----------------------------------------------------------------------------
   The site is static, so it has no database of its own. When a GitHub token is
   configured the admin document is kept as a JSON file in the repository
   instead of in this browser, and the file is what every device reads on load.
   Refreshing is therefore enough to see what was changed elsewhere.

   What this does and does not buy:
   - it makes the shelf shared: one catalogue, one set of playlists, everywhere
   - the write path is gated by the token, not by the panel's password
   - the panel's password is a convenience lock only. Its hash lives in a public
     file, so a short password is not a secret and must not be treated as one.
     Use a passphrase if it is used at all.
   ========================================================================== */

const CONFIG_KEY = 'sonora.remote.v1';
const API = 'https://api.github.com';

/** Where the catalogue lives out of the box — no setup to see it working. */
const DEFAULTS = {
  repo: 'maksim8560/music-app',
  branch: 'Main',
  path: 'sonora/catalogue.json',
};

const utf8ToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const base64ToUtf8 = (b64) => {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** Where the document lives. Empty until the admin fills it in. */
export function remoteConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { repo: DEFAULTS.repo, branch: DEFAULTS.branch, path: DEFAULTS.path, token: '' };
    const saved = JSON.parse(raw);
    return {
      repo: typeof saved.repo === 'string' ? saved.repo : DEFAULTS.repo,
      branch: saved.branch || DEFAULTS.branch,
      path: saved.path || DEFAULTS.path,
      token: typeof saved.token === 'string' ? saved.token : '',
    };
  } catch {
    return { repo: DEFAULTS.repo, branch: DEFAULTS.branch, path: DEFAULTS.path, token: '' };
  }
}

/**
 * Drop the token but keep where it points.
 *
 * Used when GitHub refuses the stored one. Wiping the whole configuration would
 * throw away the repository and path along with it, and those were not the
 * thing that stopped working - the owner would be re-typing settings that were
 * perfectly correct, on top of the token they actually came for.
 */
export function forgetToken() {
  saveRemoteConfig({ token: '' });
}

export function saveRemoteConfig(patch) {
  const next = { ...remoteConfig(), ...patch };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  return next;
}

/**
 * Reading needs no token at all: a public repository hands out the file to
 * anyone who asks. Only writing needs one. Keeping those apart is the whole
 * difference between "the catalogue shows up on my phone with no setup" and
 * "I have to configure something before I can even see my own music".
 */
export function remoteReadable() {
  return true; // the defaults already point at a repository
}

export function remoteWritable() {
  const c = remoteConfig();
  return Boolean(c.repo && c.token);
}

/** owner/name out of "owner/name" or a full repository URL */
function parseRepo(repo) {
  const clean = String(repo || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('Репозиторий указывается как имя/владелец, например maksim8560/music-app');
  return { owner: parts[parts.length - 2], name: parts[parts.length - 1] };
}

const headers = (token) => {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  /* a token is only attached when there is one: a public file reads fine
     without it, and asking for one we do not have would only invite a 401 */
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
};

/**
 * Anything can come out of a fetch: a network failure, a CORS refusal, or a
 * raw TypeError from the browser when a header holds a character it cannot
 * encode. All of it has to reach the admin as a sentence, not as a stack.
 */
async function request(url, init, what) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (/ISO-8859-1|code point|Failed to execute 'fetch'/i.test(String(err && err.message))) {
      throw new Error('Токен содержит недопустимые символы. Обычный токен — латиница, цифры, дефис и подчёркивание.');
    }
    throw new Error(`${what}: нет связи с GitHub (${String((err && err.message) || err).slice(0, 90)})`);
  }
  return res;
}

/** A token that cannot be a token: catch it before the network does. */
function checkToken(cfg) {
  if (!cfg.token) throw new Error('Введите токен GitHub — без него каталог можно читать, но не записывать.');
  if (!/^[\x21-\x7e]+$/.test(cfg.token)) {
    throw new Error('Токен содержит недопустимые символы. Обычный токен — латиница, цифры, дефис и подчёркивание.');
  }
  if (!cfg.branch.trim()) throw new Error('Укажите ветку.');
  if (!cfg.path.trim()) throw new Error('Укажите путь к файлу.');
}

/**
 * Read the document. Returns { doc, sha, etag, notModified } — sha is what a
 * later write needs, etag is what makes the next read cheap.
 * A missing file is not an error: it just means nothing has been saved yet.
 *
 * Pass the etag from the previous read and GitHub answers 304 when nothing
 * changed. That matters more than it looks: a 304 does not count against the
 * rate limit, so a page may watch the file as often as it likes, while a full
 * read costs one of the 60 requests an hour GitHub allows an anonymous caller.
 */
export async function fetchRemote({ etag = '' } = {}) {
  const cfg = remoteConfig();
  const { owner, name } = parseRepo(cfg.repo);
  if (!cfg.branch.trim()) throw new Error('Укажите ветку.');
  if (!cfg.path.trim()) throw new Error('Укажите путь к файлу.');
  const url = `${API}/repos/${owner}/${name}/contents/${cfg.path}?ref=${encodeURIComponent(cfg.branch)}`;
  const h = headers(cfg.token);
  if (etag) h['If-None-Match'] = etag;
  const res = await request(url, { headers: h, cache: 'no-store' }, 'Чтение каталога');
  if (res.status === 304) return { doc: null, sha: null, etag, notModified: true };
  if (res.status === 404) {
    /* A wrong repository name and a file that was never saved both come back as
       404, and they call for opposite responses: one is a typo to fix, the
       other is an empty shelf waiting to be filled. Guessing "nothing saved
       yet" is the worse of the two - it invites re-adding music that is
       already in the repository. So ask whether the repository itself is there,
       which costs one request and only in this case. */
    const repoRes = await request(`${API}/repos/${owner}/${name}`, { headers: h, cache: 'no-store' }, 'Проверка репозитория');
    if (repoRes.status === 404) {
      throw new Error(`Репозиторий «${cfg.repo}» не найден. Проверьте название — без него каталог прочитать нельзя.`);
    }
    return { doc: null, sha: null, etag: '', notModified: false };
  }
  /* 403 means two very different things, and telling a reader to paste a token
     when the real problem is an exhausted hourly budget wastes their time.
     GitHub says which one it is in the remaining-requests header. */
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
    const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : 0;
    /* an anonymous caller gets 60 an hour for the whole address, so this bites
       a reader on shared wifi; a token raises it to 5000 and is worth saying so
       only when one is actually in use */
    const hint = cfg.token ? '' : ' Токен в панели поднимает лимит и снимает эту проблему.';
    throw new Error(mins
      ? `GitHub временно не отдаёт каталог: закончились запросы на час, лимит обновится через ~${mins} мин.${hint}`
      : `GitHub временно не отдаёт каталог: закончились запросы на час.${hint}`);
  }
  if (res.status === 401 || res.status === 403) {
    /* A stored token that GitHub refuses is a different situation from a
       missing one, and the panel has to be able to tell them apart: a revoked
       token needs a new one typed in, a missing one needs typing in the first
       place. Note that a public file reads fine without any token at all, so
       it is the rejected Authorization header - not the failed read - that
       makes this an answer about the token. */
    const err = new Error(cfg.token
      ? 'GitHub отклонил сохранённый токен — он отозван или истёк.'
      : 'GitHub не пустил. Если репозиторий приватный — вставьте токен, если публичный — проверьте имя и ветку.');
    if (cfg.token) err.auth = true;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const data = await res.json();
  const doc = data.content ? JSON.parse(base64ToUtf8(data.content)) : null;
  /* the header is only readable when GitHub exposes it to the browser; without
     it there is nothing to send back next time, and the caller has to poll
     more rarely instead */
  return { doc, sha: data.sha, etag: res.headers.get('etag') || '', notModified: false };
}

/** Write the document back. `sha` is null for the first save. */
export async function pushRemote(doc, sha) {
  const cfg = remoteConfig();
  const { owner, name } = parseRepo(cfg.repo);
  checkToken(cfg);
  const url = `${API}/repos/${owner}/${name}/contents/${cfg.path}`;
  const body = {
    message: 'Update catalogue from the admin panel',
    content: utf8ToBase64(JSON.stringify(doc, null, 2)),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const res = await request(
    url,
    { method: 'PUT', headers: headers(cfg.token), body: JSON.stringify(body) },
    'Запись каталога',
  );
  if (res.status === 401 || res.status === 403) {
    /* Flagged, not just phrased: a rejected token is a different situation from
       a network hiccup, and it needs a different reply - the panel has to say
       "this token is dead, enter the new one" instead of leaving a line of red
       text in a corner while the button looks like it did nothing. */
    const err = new Error('GitHub не пустил с этим токеном при записи.');
    err.auth = true;
    throw err;
  }
  if (res.status === 409 || res.status === 422) {
    throw new Error('Файл в репозитории изменился, пока вы редактировали. Обновите страницу и повторите.');
  }
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const data = await res.json();
  return { sha: data.content ? data.content.sha : null, commit: data.commit ? data.commit.html_url : null };
}

/** Sanity check before the admin trusts a token: can it see the file? */
export async function checkRemote() {
  const { doc, sha } = await fetchRemote();
  return {
    ok: true,
    exists: !!doc,
    sha,
    tracks: doc ? (doc.custom?.length || 0) : 0,
    playlists: doc ? (doc.playlists?.length || 0) : 0,
  };
}

/**
 * True when GitHub refused the token itself rather than the request.
 *
 * Worth separating: a revoked or expired token does not fix itself, and the
 * owner's next step is to enter the new one. Everything else - a dead network,
 * an exhausted hourly budget - is worth retrying quietly.
 */
export function isAuthError(err) {
  return Boolean(err && err.auth);
}
