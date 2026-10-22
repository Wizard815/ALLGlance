// Re-vendor dayGLANCE's pure model into ./model/.
//
// Starts from the MCP read/write models in the dayglance submodule and follows
// their import graph, copying every module they need: src/utils files land in
// ./model/, and @glance-apps/<pkg> workspace packages (packages/<pkg>/src) land
// in ./model/<pkg>/ with the bare specifier rewritten to that local copy.
// i18next is swapped for a tiny shim so the locale helper runs headless. Any
// other bare import fails the run, since the container has no dayGLANCE
// node_modules. ./model/ is regenerated from scratch. Run from the
// container-mcp dir:
//
//   node scripts/vendor-model.mjs [path-to-dayglance-app]
//
// Default app path: ../../apps/dayglance relative to this file.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destRoot = join(here, '..');
const app = resolve(process.argv[2] || join(destRoot, '..', '..', 'apps', 'dayglance'));
const modelDir = join(destRoot, 'model');

const ENTRIES = ['mcpReadModel.js', 'mcpWriteModel.js'].map((f) => join(app, 'src', 'utils', f));
const WORKSPACE = '@glance-apps/';
const SHIMS = { i18next: 'i18next-shim.js' };

// Source roots and where each lands under ./model/.
function destFor(abs) {
  const rel = relative(app, abs).split(sep).join('/');
  if (rel.startsWith('src/utils/')) return rel.slice('src/utils/'.length);
  const m = rel.match(/^packages\/([^/]+)\/src\/(.+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

// Static imports/re-exports, side-effect imports and dynamic import('...').
// Comment lines are dropped first so prose like `from "now"` isn't matched.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])([^'"]+)\1/gm;
function specifiers(txt) {
  const code = txt.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');
  return [...new Set([...code.matchAll(IMPORT_RE)].map((m) => m[2]))];
}

// Walk the graph; files maps source path -> { dest, rewrites: [[spec, target dest]] }.
const files = new Map();
const queue = [...ENTRIES];
while (queue.length) {
  const abs = queue.shift();
  if (files.has(abs)) continue;
  const dest = destFor(abs);
  if (!dest) throw new Error(`[vendor] ${relative(app, abs)} is outside src/utils and packages/*/src`);
  if (!existsSync(abs)) throw new Error(`[vendor] missing module ${relative(app, abs)}`);
  const entry = { dest, rewrites: [] };
  files.set(abs, entry);
  for (const spec of specifiers(readFileSync(abs, 'utf8'))) {
    if (spec.startsWith('.')) {
      queue.push(resolve(dirname(abs), spec));
    } else if (spec.startsWith(WORKSPACE)) {
      const target = join(app, 'packages', spec.slice(WORKSPACE.length), 'src', 'index.js');
      entry.rewrites.push([spec, destFor(target)]);
      queue.push(target);
    } else if (spec in SHIMS) {
      entry.rewrites.push([spec, SHIMS[spec]]);
    } else {
      throw new Error(`[vendor] ${relative(app, abs)} imports unsupported package '${spec}'`);
    }
  }
}

rmSync(modelDir, { recursive: true, force: true });
for (const [abs, { dest, rewrites }] of files) {
  const out = join(modelDir, dest);
  mkdirSync(dirname(out), { recursive: true });
  let txt = readFileSync(abs, 'utf8');
  for (const [spec, target] of rewrites) {
    let rel = relative(dirname(dest), target).split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    txt = txt.replace(new RegExp(`(['"])${spec.replace(/[/.]/g, '\\$&')}\\1`, 'g'), `'${rel}'`);
  }
  writeFileSync(out, txt);
}

// i18next shim (localeFormatting only reads .resolvedLanguage/.language).
writeFileSync(join(modelDir, 'i18next-shim.js'), `// Minimal i18next shim for the headless container MCP.
// The vendored localeFormatting.js only reads i18n.resolvedLanguage/language
// (via activeLocale). In a container there is no i18n runtime; a fixed locale
// is correct, because MCP output is machine-facing (dates are ISO, times are
// wall-clock HH:MM) and the human-facing labels this feeds are not on the
// tool path. Keep this the ONLY difference from the app's localeFormatting.js.
const i18n = {\n  resolvedLanguage: process.env.DAYGLANCE_LOCALE || 'en',\n  language: process.env.DAYGLANCE_LOCALE || 'en',\n};\nexport default i18n;\n`);

console.log(`[vendor] ${files.size} modules re-vendored from ${app}`);
