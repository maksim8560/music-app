/* ==========================================================================
   data/online.js — «кто сейчас на сайте»
   ========================================================================== */

/**
 * Адрес Worker'а, который считает живые сессии. Подробности — в worker/.
 *
 * Пока адрес пуст, счётчик не запускается, а строка в боковой панели остаётся
 * скрытой. Это осознанно: единственное, что может стоять вместо ответа
 * сервера, — ноль или заведомо выдуманное число, и оба варианта врут. Лучше
 * ничего, чем правдоподобная неправда.
 *
 * Одно замечание о workers.dev. Сертификат для поддомена выдаётся не сразу:
 * сразу после первого деплоя имя отвечает ошибкой TLS, и минуту-две спустя -
 * работает. Это касается и проверки в браузере, и первых запросов с сайта, так
 * что если счётчик молчит сразу после публикации, это ещё не поломка.
 */
const ENDPOINT = 'https://sonora-online.sonora-online.workers.dev';

/** как часто показываем себя. Тот же интервал, что и в Worker'е, — если
    расходиться, то либо засчитаем ушедшего человека, либо перепишем счётчик
    впустую; ответ сервера со своим `ping` предпочтительнее нашего */
const PING_MS = 30_000;

/** сколько ждать ответа, прежде чем признать, что его не будет. Плохая связь
    не должна оставлять строку в состоянии «сейчас считаем...» навсегда */
const TIMEOUT_MS = 4000;

/** после стольких минут молчания число перестаёт быть правдой и прячется */
const STALE_MS = 5 * 60_000;

const KEY = 'sonora.session';
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

/**
 * Идентификатор сессии — вкладки, а не человека.
 *
 * sessionStorage, а не случайное число на каждую загрузку: перезагрузка
 * страницы не должна превращать одного человека в двух, иначе счётчик растёт
 * от каждого F5. Вторая вкладка — уже другой ключ, и это честно: она и правда
 * ещё одна сессия.
 */
function sessionId() {
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    /* приватный режим или отключённое хранилище: идентификатор не переживёт
       перезагрузку, но переживёт текущую страницу — для счётчика хватит */
    return crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function ping(id) {
  const ctrl = new AbortController();
  /* прерываем самому: иначе зависший ответ держит соединение до сетевого
     таймаута браузера, который бывает и две минуты */
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}?id=${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`статус ${res.status}`);
    const data = await res.json();
    const n = Number(data?.online);
    if (!Number.isInteger(n) || n < 0) throw new Error('в ответе нет числа');
    return n;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Показать, сколько сессий на сайте.
 *
 * Число появляется только после первого ответа сервера и исчезает, если ответы
 * прекратились надолго. Короткий перебой не стирает его: мигающая надпись
 * «сейчас на сайте» после одной неудачной попытки хуже, чем число, оставшееся
 * на пару секунд прежним.
 *
 * Пинги идут, пока вкладка видима. Считать человека, закрывшего вкладку, —
 * нечестно, а закрытая вкладка всё равно получает таймеры браузера урезанными.
 * Возвращение на вкладку сразу даёт новый пинг, чтобы вчерашний не учитывался.
 */
export function initOnline(plural) {
  if (!ENDPOINT) return;

  const row = document.getElementById('online');
  const text = document.getElementById('online-text');
  if (!row || !text) return;

  const id = sessionId();
  /* сервер отвергает всё, что не похоже на идентификатор, но и мусор ему
     слать незачем */
  if (!ID_RE.test(id)) return;

  let timer = 0;
  let lastOk = 0;

  const show = (n) => {
    text.textContent = plural(n, 'человек', 'человека', 'человек');
    row.title = `Сейчас на сайте: ${n}. Обновляется каждые ${PING_MS / 1000} секунд.`;
    row.hidden = false;
  };

  const tick = async () => {
    try {
      const n = await ping(id);
      lastOk = Date.now();
      show(n);
    } catch {
      /* не показываем ничего нового; старое число уходит само, когда протухнет */
      if (lastOk && Date.now() - lastOk > STALE_MS) row.hidden = true;
    }
  };

  const start = () => {
    if (timer) return;
    tick();
    timer = setInterval(tick, PING_MS);
  };
  const stop = () => {
    clearInterval(timer);
    timer = 0;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });

  /* на всякий случай: страницу могли открыть в фоновой вкладке, и первый пинг
     отложился бы до возврата */
  if (document.hidden) stop();
  else start();
}
