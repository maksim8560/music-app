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
