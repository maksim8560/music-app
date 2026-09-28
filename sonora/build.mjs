/* ==========================================================================
   build.mjs — собирает самодостаточный HTML одним файлом
   ----------------------------------------------------------------------------
   Без зависимостей. Склеивает граф ES-модулей в один <script>, инлайнит все
   CSS и favicon. Импорт/экспорт в этом проекте простые (только именованные,
   без default и без export *), поэтому достаточно лексической обработки.

   Запуск:  node build.mjs
   Выход :  dist/sonora.html   — открывается двойным кликом, без сервера
   ========================================================================== */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(ROOT, 'scripts/main.js');
const p = (...s) => resolve(ROOT, ...s);

/* ----------------------------- 1. проверка синтаксиса -------------------- */
const jsFiles = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = p(dir, e);
    if (statSync(full).isDirectory()) walk(full);
    else if (e.endsWith('.js')) jsFiles.push(full);
  }
})(resolve(ROOT, 'scripts'));

for (const f of jsFiles) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
}
console.log(`✓ синтаксис в порядке: ${jsFiles.length} модулей`);

/* ---------------------- 1a. проверка кодировки исходников ----------------- */
/* Text in this project is Russian, and at some point it was written back out
   through the wrong codepage: the bytes were correct UTF-8, but read as CP1251
   on the way through a shell, so every affected line shipped as letter pairs
   that mean nothing. Nothing above notices - the file is still valid UTF-8, it
   still parses, and the only symptom is a toast that reads as noise to the one
   person it is written for.

   The damage turns the first letter of nearly every syllable into a capital,
   so a damaged line has an absurd density of them, where ordinary Russian keeps
   capitals to a sentence start or an acronym. Lines too short to judge are
   skipped, because three letters cannot tell a language from a mistake. The
   unambiguous leftovers - a capital in front of a guillemet, the two bytes of a
   mangled em-dash - count on their own.

   No example of the damage is written out in this comment on purpose: a literal
   sample would trip the very check that contains it. */
const textFiles = [
  ...jsFiles,
  ...['index.html', 'build.mjs'],
  /* the Worker is not part of the bundle, but it is read by a person, so its
     Russian comments get the same check as everything else */
  ...readdirSync(p('worker')).filter((f) => f.endsWith('.js')).map((f) => p('worker', f)),
  ...readdirSync(p('styles')).filter((f) => f.endsWith('.css')).map((f) => p('styles', f)),
];

/* A capital in front of a guillemet, or the two bytes of a mangled em-dash, are
   unambiguous. Everything else is judged by shape: this damage turns the first
   letter of nearly every syllable into a capital, so the line ends up with an
   absurd density of them. Ordinary Russian capitals are sparse - a sentence
   start, an acronym - and a short line is not judged at all, because three
   letters in a row cannot tell a language from a mistake. */
const STRONG = /[А-ЯЁ][«»»]|[А-Я]Ђ/u;
const damaged = (line) => {
  if (STRONG.test(line)) return true;
  const letters = line.match(/[А-Яа-яЁё]/g);
  if (!letters || letters.length < 12) return false;
  const caps = line.match(/[А-ЯЁ]/g);
  return Boolean(caps) && caps.length / letters.length >= 0.22;
};

const mojibake = [];
for (const f of textFiles) {
  const src = readFileSync(f, 'utf8');
  src.split('\n').forEach((line, i) => {
    if (damaged(line)) mojibake.push(`${relative(ROOT, f).replace(/\\/g, '/')}:${i + 1}`);
  });
}
if (mojibake.length) {
  console.error('✗ текст прочитан не в той кодировке (UTF-8, прочитанный как CP1251):');
  for (const where of mojibake.slice(0, 20)) console.error(`   ${where}`);
  if (mojibake.length > 20) console.error(`   …и ещё ${mojibake.length - 20}`);
  process.exit(1);
}
console.log(`✓ кодировка в порядке: ${textFiles.length} файлов`);

/* ----------------------------- 2. граф модулей --------------------------- */
const IMPORT_RE = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const IMPORT_NS_RE = /^[ \t]*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\};?[ \t]*$/gm;
const EXPORT_DECL_RE = /^([ \t]*)export\s+(const|let|var|function\*?|class|async function)\s+([A-Za-z_$][\w$]*)/gm;

const modules = new Map(); // abs path -> { code, exports: [[exported, local]], deps }

/** ключ модуля в бандле: путь от корня проекта, всегда со слешами */
const modId = (file) => relative(ROOT, file).replace(/\\/g, '/');

function loadModule(file) {
  if (modules.has(file)) return modules.get(file);
  const src = readFileSync(file, 'utf8');
  const mod = { code: src, exports: [], deps: [] };
  modules.set(file, mod);

  /* import { a, b as c } from './x.js' → const { a, b: c } = require(id) */
  mod.code = mod.code.replace(IMPORT_RE, (_all, names, spec) => {
    const dep = resolve(dirname(file), spec);
    mod.deps.push(dep);
    const pairs = splitList(names).map((n) => {
      const [imported, local = imported] = n.split(/\s+as\s+/).map((s) => s.trim());
      return `${imported}: ${local}`;
    });
    return `const { ${pairs.join(', ')} } = __req(${JSON.stringify(modId(dep))});`;
  });

  /* import * as ns from './x.js' → const ns = __req(id) */
  mod.code = mod.code.replace(IMPORT_NS_RE, (_all, ns, spec) => {
    const dep = resolve(dirname(file), spec);
    mod.deps.push(dep);
    return `const ${ns} = __req(${JSON.stringify(modId(dep))});`;
  });

  /* export { a as b, c }; */
  mod.code = mod.code.replace(EXPORT_LIST_RE, (_all, names) => {
    for (const n of splitList(names)) {
      const [local, exported = local] = n.split(/\s+as\s+/).map((s) => s.trim());
      mod.exports.push([exported, local]);
    }
    return '';
  });

  /* export const/function/class/async function name */
  mod.code = mod.code.replace(EXPORT_DECL_RE, (_all, indent, kind, name) => {
    mod.exports.push([name, name]);
    return `${indent}${kind} ${name}`;
  });

  /* страховка: если остался необробтанный import/export — падаем громко */
  const leftover = mod.code.match(/^[ \t]*(import|export)\s/m);
  if (leftover) throw new Error(`${relative(ROOT, file)}: необработанный ${leftover[0].trim()}`);

  return mod;
}

/** "a, b as c" → ["a", "b as c"] */
function splitList(s) {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

loadModule(ENTRY);
for (const m of modules.values()) for (const d of m.deps) loadModule(d);

/* ---------------------------- 2a. проверка экспортов --------------------- */
/* `node --check` only looks at syntax, so a module could import a name that no
   longer exists and the build would happily ship a page that dies on load with
   "does not provide an export named ...". Every module is in the graph by now,
   so the check is a comparison of each import against the target's exports. */
const NAME_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const missingExports = [];
for (const file of modules.keys()) {
  const src = readFileSync(file, 'utf8');
  let hit;
  NAME_IMPORT_RE.lastIndex = 0;
  while ((hit = NAME_IMPORT_RE.exec(src))) {
    const targetPath = resolve(dirname(file), hit[2]);
    const target = modules.get(targetPath);
    if (!target) continue; // bare specifier, or a file outside scripts/
    const have = new Set(target.exports.map(([name]) => name));
    for (const entry of splitList(hit[1])) {
      const wanted = entry.split(/\s+as\s+/)[0].trim();
      if (!have.has(wanted)) {
        missingExports.push(`${modId(file)} импортирует «${wanted}», а в ${modId(targetPath)} такого экспорта нет`);
      }
    }
  }
}
if (missingExports.length) {
  console.error('✗ несовпадающие экспорты:');
  for (const line of missingExports) console.error(`   ${line}`);
  process.exit(1);
}
console.log('✓ экспорты совпадают');

/* ------------------- 2b. проверка «вызвано, но не импортировано» ------------ */
/* The check above only looks at what is written in an `import`. A bare call to
   a name another module exports - `status()` with no import - passes every
   other gate here and dies at runtime, in the one branch nobody exercises by
   hand: the error path of a form. So: take every name the project exports,
   and if a module calls one it did not import and did not define, say so. */
const GLOBALS = new Set([
  'window', 'document', 'console', 'globalThis', 'localStorage', 'sessionStorage',
  'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'alert',
  'confirm', 'prompt', 'Blob', 'URL', 'Audio', 'Image', 'ImageData', 'AudioContext',
  'CustomEvent', 'Event', 'EventTarget', 'Map', 'Set', 'WeakMap', 'Promise', 'Proxy',
  'Reflect', 'Symbol', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Error', 'RegExp', 'Intl', 'TextEncoder', 'TextDecoder', 'crypto',
  'performance', 'navigator', 'location', 'history', 'matchMedia', 'getComputedStyle',
  'requestIdleCallback', 'structuredClone', 'parseInt', 'parseFloat', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'fetchRemote', 'require', 'undefined',
]);

const projectExports = new Map(); // name -> module that exports it
for (const [file, mod] of modules) {
  for (const [name] of mod.exports) {
    if (!projectExports.has(name)) projectExports.set(name, modId(file));
  }
}

/* объявления этого модуля: function/const/let/var/class + параметры + локальные */
function declaredNames(src) {
  const out = new Set();
  const push = (s) => {
    for (const n of String(s || '').split(',')) {
      const id = n.split(/[:=]/)[0].replace(/\s*=.*$/, '').trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(id)) out.add(id);
    }
  };
  for (const m of src.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([^;=]+)/g)) push(m[1]);
  /* параметры функций: хватает грубого разбора, имена изолированы запятыми */
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) push(m[1]);
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+([^;]+);/g)) push(m[1]);
  return out;
}

/**
 * Комментарии, строки и регулярные выражения. Проверка имён бессмысленна по сырому
 * тексту: в этом проекте слова вроде «on» или «status» встречаются в прозе чаще,
 * чем в коде. Регулярка ленивая, поэтому состояние кавычек достаточно.
 *
 * Регулярные выражения пришлось вырезать тоже. Домен в шаблоне — это буквально
 * текст, а не обращение к чему-либо: `/open\.spotify\.com/` не вызывает
 * функцию `open`, и проверка объявлений приняла его именно за вызов. Понять, где
 * `/` начинает регулярку, а где делит, можно только по предыдущему знаку —
 * применяем обычное для этого правило: регулярка начинается там, где перед ней
 * может стоять значение, а не после.
 */
function stripNoise(src) {
  let out = '';
  let i = 0;

  /* Последний значащий символ и хвост из букв держим на ходу, а не ищем по
     всему накопленному тексту: делать это на каждой косой черте значило бы
     перечитывать вывод целиком и на файлах в сотни килобайт съедало бы всю
     память процесса. */
  let prev = '';
  let word = '';
  const emit = (text) => {
    out += text;
    for (const c of text) {
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') continue;
      prev = c;
      if (/[A-Za-z_$]/.test(c)) word += c;
      else word = '';
    }
  };

  /* строки import и export {...} убираем: там перечислены чужие имена, и
     проверка приняла бы их за обращения. `export const` трогать нельзя — за
     ним само объявление */
  src = src
    .replace(/^[ \t]*import\s[^;\n]*;?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, '');
  /* длину считаем именно здесь: две замены выше меняют длину, и сохранённая
     раньше n уводила бы обход за конец строки — читать оттуда нечего */
  const n = src.length;

  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < n && src[i] !== '\n') i++; continue; }
    if (two === '/*') { i += 2; while (i < n && src.slice(i, i + 2) !== '*/') i++; i += 2; continue; }
    const ch = src[i];
    if (ch === '/' && startsRegex(prev, word)) {
      /* сначала смотрим вперёд, и только если регулярка действительно
         закрылась — двигаем i. Иначе «незакрытый» слеш съел бы символ после
         себя, а это уже не сохранение текста, а порча */
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { j++; closed = true; break; }
        else if (src[j] === '\n') break; /* на строке не закрылась — деление */
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(src[j])) j++; /* флаги gimsuy */
        emit(' REGEX ');
        i = j;
        continue;
      }
      /* это было деление — отдаём слеш обычным символом */
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { i += 2; continue; }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          /* подстановка внутри шаблона — это код, её надо сохранить */
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          emit(' ' + src.slice(i + 2, j - 1) + ' ');
          i = j;
          continue;
        }
        i++;
      }
      i++;
      emit(' STR ');
      continue;
    }
    emit(ch);
    i++;
  }
  return out;
}

/**
 * Начинается ли здесь регулярное выражение.
 *
 * Смотрим на последний значащий символ уже нарезанного текста. Регулярка может
 * стоять там, где значение ещё не началось: после открывающей скобки, запятой,
 * знака равенства, двоеточия, начала строки — или после слова, перед которым
 * значение необходимо (`return`, `typeof`, `case`, `in`, `of`, `new`). После
 * буквы, цифры, `)` или `]` стоит деление, и резать там нельзя.
 */
function startsRegex(prev, word) {
  if (!prev) return true; // начало файла
  if (/[([{=,;:?&|!+\-*%~^<>]/.test(prev)) return true;
  if (prev === '}' || prev === ']' || prev === ')') return false;
  if (!word) return true;
  return ['return', 'typeof', 'case', 'in', 'of', 'new', 'void', 'delete', 'do', 'else', 'yield', 'await']
    .includes(word);
}

const undeclaredUses = [];

/** индекс закрывающей скобки, парной открывающей на позиции open */
function matchingParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

for (const [file, mod] of modules) {
  const raw = readFileSync(file, 'utf8');
  /* имена импортов снимаем из сырого текста, а сканируем уже очищенный: в
     самих строках import перечислены чужие имена, и проверка приняла бы их
     за обращения */
  const imported = new Set();
  for (const m of raw.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const n of splitList(m[1])) imported.add(n.split(/\s+as\s+/).pop().trim());
  }
  for (const m of raw.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) imported.add(m[1]);
  for (const m of raw.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) imported.add(m[1]);

  const src = stripNoise(raw);
  const local = declaredNames(src);

  /* вызов: имя сразу перед скобкой, без точки перед ним. Разделитель смотрим
     lookbehind'ом, а не съедаем: иначе `Error(status())` теряется — после
     `Error(` регулярка уже не может заглянуть назад за `(` */
  const CALL_RE = /(?<![\w$.)\]])([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of src.matchAll(CALL_RE)) {
    const name = m[1];
    if (GLOBALS.has(name) || local.has(name) || imported.has(name)) continue;
    if (!projectExports.has(name)) continue;
    /* `on(event, fn) {` - это объявление метода класса, а не вызов */
    const open = m.index + m[0].length - 1;
    const after = matchingParen(src, open);
    if (after >= 0 && /^\s*\{/.test(src.slice(after + 1))) continue;
    undeclaredUses.push(`${modId(file)} вызывает «${name}(…)», но не импортирует его из ${projectExports.get(name)}`);
  }

  /* и то же для обращения без вызова: `GENRE_COLORS[i]` падает ровно так же,
     как `GENRE_COLORS()` — значение просто не приехало из модуля */
  const READ_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(READ_RE)) {
    const name = m[1];
    if (GLOBALS.has(name) || local.has(name) || imported.has(name)) continue;
    if (!projectExports.has(name)) continue;
    const tail = src.slice(m.index + name.length);
    if (/^\s*[:(]/.test(tail)) continue; // ключ объекта или вызов — выше
    if (/^\s*=[^=]/.test(tail)) continue; // присваивание
    undeclaredUses.push(`${modId(file)} читает «${name}», но не импортирует его из ${projectExports.get(name)}`);
  }
}
if (undeclaredUses.length) {
  console.error('✗ вызывается то, что не импортировано:');
  for (const line of [...new Set(undeclaredUses)]) console.error(`   ${line}`);
  process.exit(1);
}
console.log('✓ вызовы разрешаются');

/* ----------------------------- 3. топологический порядок ----------------- */
const order = [];
const done = new Set();
(function visit(file) {
  if (done.has(file)) return;
  done.add(file);
  const mod = modules.get(file);
  for (const d of mod.deps) visit(d);
  order.push(file);
})(ENTRY);

/* ----------------------------- 4. сборка скрипта ------------------------- */
const chunks = order.map((file) => {
  const mod = modules.get(file);
  const ret = mod.exports.map(([exp, local]) => (exp === local ? exp : `${JSON.stringify(exp)}: ${local}`)).join(', ');
  return `__mod(${JSON.stringify(modId(file))}, function () {\n${mod.code}\nreturn { ${ret} };\n});`;
});

const bundle = `(function () {
'use strict';
var __defs = Object.create(null);
var __cache = Object.create(null);
function __mod(id, fn) { __defs[id] = fn; }
function __req(id) {
  var hit = __cache[id];
  if (hit) return hit;
  var fn = __defs[id];
  if (!fn) throw new Error('Модуль не найден: ' + id);
  var out = fn();
  __cache[id] = out;
  return out;
}
${chunks.join('\n\n')}
__req(${JSON.stringify(modId(ENTRY))});
})();`;

/* синтаксическая проверка результата до записи на диск */
const tmp = p('dist', '.bundle.check.js');
mkdirSync(p('dist'), { recursive: true });
writeFileSync(tmp, bundle, 'utf8');
execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
rmSync(tmp);
console.log(`✓ модулей склеено: ${order.length}`);

/* ----------------------------- 5. HTML ---------------------------------- */
let html = readFileSync(p('index.html'), 'utf8');

/* favicon → data URI */
const favicon = readFileSync(p('assets/favicon.svg'), 'utf8');
const faviconUri = `data:image/svg+xml;base64,${Buffer.from(favicon, 'utf8').toString('base64')}`;
html = html.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${faviconUri}" type="image/svg+xml">`);

/* css → один <style> в том же порядке, что и <link> */
const cssHrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
const css = cssHrefs.map((href) => `/* ${href} */\n${readFileSync(p(href), 'utf8')}`).join('\n');
html = html.replace(/([ \t]*)<link rel="stylesheet"[^>]*>\n?/g, '');
html = html.replace('</head>', `<style>\n${css}\n</style>\n</head>`);

/* modulepreload больше не нужен, скрипт встраиваем в конец body */
html = html.replace(/[ \t]*<link rel="modulepreload"[^>]*>\n?/g, '');
html = html.replace(
  /[ \t]*<script type="module" src="scripts\/main\.js"><\/script>/,
  `<script>\n${bundle}\n</script>`,
);

/* проверки результата */
const problems = [];
if (/<link rel="stylesheet"/.test(html)) problems.push('остались внешние стили');
if (/<script[^>]+src=/.test(html)) problems.push('остались внешние скрипты');
if (/<link rel="modulepreload"/.test(html)) problems.push('остались modulepreload');
if (/^\s*import\s/m.test(bundle)) problems.push('в бандле остался import');
if (!html.includes('__req(')) problems.push('бандл не вставлен');
if (problems.length) throw new Error(problems.join('; '));

const out = p('dist/sonora.html');
writeFileSync(out, html, 'utf8');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`✓ dist/sonora.html — ${kb} KB (один файл, открывается без сервера)`);
