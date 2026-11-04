// Re-vendor dayGLANCE's pure model into ./model/.
//
// Copies the pure (dependency-free-at-runtime) modules the MCP read/write
// models need from the dayglance submodule, rewrites the @glance-apps/agenda-core
// imports to a local relative path, and installs a tiny i18next shim so the
// locale helper runs headless. Run from the container-mcp dir:
//
//   node scripts/vendor-model.mjs [path-to-dayglance-app]
//
// Default app path: ../../apps/dayglance relative to this file.

import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destRoot = join(here, '..');
const app = process.argv[2] || join(destRoot, '..', '..', 'apps', 'dayglance');

const UTILS = [
  'bucketList.js', 'colorUtils.js', 'dayOccupancy.js', 'frameInstances.js',
  'goalProgress.js', 'localeFormatting.js', 'mcpFrames.js', 'mcpReadModel.js',
  'mcpRoutines.js', 'mcpWriteModel.js', 'obsidianProjectNotes.js', 'projectProgress.js', 'recurrenceEngine.js',
  'taskMutations.js', 'taskUtils.js',
];

const modelDir = join(destRoot, 'model');
const acDir = join(modelDir, 'agenda-core');
mkdirSync(acDir, { recursive: true });

for (const f of UTILS) {
  cpSync(join(app, 'src', 'utils', f), join(modelDir, f));
}

// Pull in transitive sibling imports (./x.js) from src/utils that UTILS misses,
// so a dayglance update that adds a helper doesn't break the vendored model.
const copied = new Set(UTILS);
for (let changed = true; changed; ) {
  changed = false;
  for (const f of [...copied]) {
    const txt = readFileSync(join(modelDir, f), 'utf8');
    for (const m of txt.matchAll(/from '\.\/([\w.-]+\.js)'/g)) {
      const dep = m[1];
      if (copied.has(dep) || !existsSync(join(app, 'src', 'utils', dep))) continue;
      cpSync(join(app, 'src', 'utils', dep), join(modelDir, dep));
      copied.add(dep);
      changed = true;
    }
  }
}

// Vendored workspace packages: [package dir, local dir name, bare specifier].
const PACKAGES = [
  ['agenda-core', 'agenda-core', '@glance-apps/agenda-core'],
  ['obsidian-format', 'obsidian-format', '@glance-apps/obsidian-format'],
];
for (const [pkg, local] of PACKAGES) {
  const src = join(app, 'packages', pkg, 'src');
  const dest = join(modelDir, local);
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(src)) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) cpSync(join(src, f), join(dest, f));
  }
}

// Rewrite the bare agenda-core specifier to the local copy.
for (const f of readdirSync(modelDir)) {
  if (!f.endsWith('.js')) continue;
  const p = join(modelDir, f);
  const txt = readFileSync(p, 'utf8');
  let next = txt;
  for (const [, local, spec] of PACKAGES) {
    next = next.split(`'${spec}'`).join(`'./${local}/index.js'`);
  }
  if (next !== txt) writeFileSync(p, next);
}

// i18next shim (localeFormatting only reads .resolvedLanguage/.language).
writeFileSync(join(modelDir, 'i18next-shim.js'), `const i18n = {\n  resolvedLanguage: process.env.DAYGLANCE_LOCALE || 'en',\n  language: process.env.DAYGLANCE_LOCALE || 'en',\n};\nexport default i18n;\n`);
const lf = join(modelDir, 'localeFormatting.js');
writeFileSync(lf, readFileSync(lf, 'utf8').replace("from 'i18next'", "from './i18next-shim.js'"));

console.log(`[vendor] model re-vendored from ${app}`);
