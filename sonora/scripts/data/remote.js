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
    if (!raw) return { repo: '', branch: 'Main', path: 'sonora/catalogue.json', token: '' };
    const saved = JSON.parse(raw);
    return {
      repo: typeof saved.repo === 'string' ? saved.repo : '',
      branch: saved.branch || 'Main',
      path: saved.path || 'sonora/catalogue.json',
      token: typeof saved.token === 'string' ? saved.token : '',
    };
  } catch {
    return { repo: '', branch: 'Main', path: 'sonora/catalogue.json', token: '' };
  }
}

export function saveRemoteConfig(patch) {
  const next = { ...remoteConfig(), ...patch };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function remoteEnabled() {
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

const headers = (token) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
});

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
  if (!cfg.token) throw new Error('Введите токен GitHub.');
  if (!/^[\x21-\x7e]+$/.test(cfg.token)) {
    throw new Error('Токен содержит недопустимые символы. Обычный токен — латиница, цифры, дефис и подчёркивание.');
  }
  if (!cfg.branch.trim()) throw new Error('Укажите ветку.');
  if (!cfg.path.trim()) throw new Error('Укажите путь к файлу.');
}

/**
 * Read the document. Returns { doc, sha } — sha is what a later write needs.
 * A missing file is not an error: it just means nothing has been saved yet.
 */
export async function fetchRemote() {
  const cfg = remoteConfig();
  const { owner, name } = parseRepo(cfg.repo);
  checkToken(cfg);
  const url = `${API}/repos/${owner}/${name}/contents/${cfg.path}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await request(url, { headers: headers(cfg.token), cache: 'no-store' }, 'Чтение каталога');
  if (res.status === 404) return { doc: null, sha: null };
  if (res.status === 401 || res.status === 403) {
    throw new Error('GitHub не пустил с этим токеном. Проверьте, что он сохранён и что у него есть доступ к репозиторию.');
  }
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const data = await res.json();
  const doc = data.content ? JSON.parse(base64ToUtf8(data.content)) : null;
  return { doc, sha: data.sha };
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
    throw new Error('GitHub не пустил с этим токеном при записи.');
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
