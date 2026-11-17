// Re-vendor dayGLANCE's pure model into ./model/.
//
// The container MCP answers with dayGLANCE's own read and write models rather than a
// second copy. This script copies the pure (no DOM, no storage) modules from the dayGLANCE
// checkout and rewrites the workspace-package imports to local relative paths. Run from the
// container-mcp dir:
//
//   node scripts/vendor-model.mjs [path-to-dayglance-app]
//
// Default app path: ../../apps/dayglance relative to this file.
//
// What comes from where (dayGLANCE 5.12+ layout):
//   src/utils/*.js                         the write model (mcpWriteModel.js) and the pure helpers it uses
//   packages/dayglance-mcp/src             the READ model (handleMcpRequest, buildMcpReadState, ...)
//   packages/agenda-core/src               calendar, frames, routines, occupancy, scoping
//   packages/obsidian-format/src           note-link helpers the models import
//   packages/mcp-host/src/dates.js         the date helpers the read state uses
//   packages/dayglance-vault/src           two merge helpers (createdAt.js, retiredTaskIds.js), not the engine
// The directory is rebuilt from scratch each run, so a file upstream removed or moved
// cannot linger. A listed file that no longer exists is a hard error: that is the signal
// that upstream moved something and this list needs to follow it.

import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destRoot = join(here, '..');
const app = process.argv[2] || join(destRoot, '..', '..', 'apps', 'dayglance');
const modelDir = join(destRoot, 'model');

const need = (p) => {
  if (!existsSync(p)) throw new Error(`[vendor] ${p} does not exist: upstream moved or removed it; update scripts/vendor-model.mjs`);
  return p;
};

// Roots: the modules the server imports directly.
const UTILS = ['mcpWriteModel.js', 'taskUtils.js', 'taskMutations.js', 'recurrenceEngine.js', 'goalProgress.js', 'projectProgress.js',
  'colorUtils.js', 'localeFormatting.js', 'obsidianProjectNotes.js', 'bucketList.js', 'dayOccupancy.js'];

// Workspace packages: [package dir, vendored dir, bare specifier it is imported as, entry file].
const PACKAGES = [
  ['agenda-core', 'agenda-core', '@glance-apps/agenda-core', 'index.js'],
  ['obsidian-format', 'obsidian-format', '@glance-apps/obsidian-format', 'index.js'],
  ['dayglance-mcp', 'dayglance-mcp', '@glance-apps/dayglance-mcp/model', 'model.js'],
  ['mcp-host', 'mcp-host', '@glance-apps/mcp-host/dates', 'dates.js'],
];

rmSync(modelDir, { recursive: true, force: true });
mkdirSync(modelDir, { recursive: true });

// 1. src/utils, plus every sibling it imports (./x.js) that exists there.
const copied = new Set();
const queue = [...UTILS];
while (queue.length) {
  const f = queue.pop();
  if (copied.has(f)) continue;
  cpSync(need(join(app, 'src', 'utils', f)), join(modelDir, f));
  copied.add(f);
  for (const m of readFileSync(join(modelDir, f), 'utf8').matchAll(/from '\.\/([\w.-]+\.js)'/g)) {
    if (!copied.has(m[1]) && existsSync(join(app, 'src', 'utils', m[1]))) queue.push(m[1]);
  }
}

// 2. Packages. agenda-core and obsidian-format are copied whole (their src is small and
//    self-contained); dayglance-mcp and mcp-host only the files the read model reaches.
const copyClosure = (srcDir, destDir, entry) => {
  mkdirSync(destDir, { recursive: true });
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    cpSync(need(join(srcDir, f)), join(destDir, f));
    for (const m of readFileSync(join(destDir, f), 'utf8').matchAll(/from '\.\/([\w.-]+\.js)'/g)) stack.push(m[1]);
  }
};
for (const [pkg, local, , entry] of PACKAGES) {
  const src = need(join(app, 'packages', pkg, 'src'));
  const dest = join(modelDir, local);
  if (pkg === 'agenda-core' || pkg === 'obsidian-format') {
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(src)) if (f.endsWith('.js') && !f.endsWith('.test.js')) cpSync(join(src, f), join(dest, f));
  } else {
    copyClosure(src, dest, entry);
  }
}

// 2b. dayglance-vault is the vault sync engine (heavy, not needed here); the model only
//     borrows two self-contained merge helpers from it. Copy just those files.
const VAULT_FILES = ['createdAt.js', 'retiredTaskIds.js'];
mkdirSync(join(modelDir, 'dayglance-vault'), { recursive: true });
for (const f of VAULT_FILES) cpSync(need(join(app, 'packages', 'dayglance-vault', 'src', f)), join(modelDir, 'dayglance-vault', f));
// [importing file, bare specifier, vendored file]
const VAULT_REWRITES = [
  ['createdAt.js', '@glance-apps/dayglance-vault', 'dayglance-vault/createdAt.js'],
  ['retiredTaskIds.js', '@glance-apps/dayglance-vault', 'dayglance-vault/retiredTaskIds.js'],
  ['retiredTaskIds.js', '@glance-apps/dayglance-vault/src/retiredTaskIds.js', 'dayglance-vault/retiredTaskIds.js'],
];

// 3. Rewrite the bare package specifiers to relative paths, from wherever the importing file sits.
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});
for (const file of walk(modelDir)) {
  const txt = readFileSync(file, 'utf8');
  let next = txt;
  for (const [, local, spec, entry] of PACKAGES) {
    let rel = relative(dirname(file), join(modelDir, local, entry)).split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    next = next.split(`'${spec}'`).join(`'${rel}'`);
  }
  for (const [importer, spec, target] of VAULT_REWRITES) {
    if (relative(modelDir, file) === importer) next = next.split(`'${spec}'`).join(`'./${target}'`);
  }
  if (next !== txt) writeFileSync(file, next);
}

// 4. i18next shim (localeFormatting only reads .resolvedLanguage/.language).
writeFileSync(join(modelDir, 'i18next-shim.js'), `const i18n = {\n  resolvedLanguage: process.env.DAYGLANCE_LOCALE || 'en',\n  language: process.env.DAYGLANCE_LOCALE || 'en',\n};\nexport default i18n;\n`);
const lf = join(modelDir, 'localeFormatting.js');
writeFileSync(lf, readFileSync(lf, 'utf8').replace("from 'i18next'", "from './i18next-shim.js'"));

// 5. Anything still bare that is not a Node builtin would fail at load time: say so now.
const bare = new Set();
for (const file of walk(modelDir)) {
  for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^'.][^']*)'/g)) {
    if (!m[1].startsWith('node:')) bare.add(`${relative(modelDir, file)}: ${m[1]}`);
  }
}
if (bare.size) {
  console.error('[vendor] unresolved bare imports in the vendored model (add them to PACKAGES or to package.json):');
  for (const b of bare) console.error('  ' + b);
  process.exit(1);
}

console.log(`[vendor] model re-vendored from ${app}`);
