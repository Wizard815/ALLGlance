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

import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const destRoot = join(here, '..');
const app = process.argv[2] || join(destRoot, '..', '..', 'apps', 'dayglance');

const UTILS = [
  'bucketList.js', 'colorUtils.js', 'dayOccupancy.js', 'frameInstances.js',
  'goalProgress.js', 'localeFormatting.js', 'mcpFrames.js', 'mcpReadModel.js',
  'mcpRoutines.js', 'mcpWriteModel.js', 'projectProgress.js', 'recurrenceEngine.js',
  'taskMutations.js', 'taskUtils.js',
];

const modelDir = join(destRoot, 'model');
const acDir = join(modelDir, 'agenda-core');
mkdirSync(acDir, { recursive: true });

for (const f of UTILS) {
  cpSync(join(app, 'src', 'utils', f), join(modelDir, f));
}

const acSrc = join(app, 'packages', 'agenda-core', 'src');
for (const f of readdirSync(acSrc)) {
  if (f.endsWith('.js') && !f.endsWith('.test.js')) {
    cpSync(join(acSrc, f), join(acDir, f));
  }
}

// Rewrite the bare agenda-core specifier to the local copy.
for (const f of readdirSync(modelDir)) {
  if (!f.endsWith('.js')) continue;
  const p = join(modelDir, f);
  const txt = readFileSync(p, 'utf8');
  const next = txt.replace(/'@glance-apps\/agenda-core'/g, "'./agenda-core/index.js'");
  if (next !== txt) writeFileSync(p, next);
}

// i18next shim (localeFormatting only reads .resolvedLanguage/.language).
writeFileSync(join(modelDir, 'i18next-shim.js'), `const i18n = {\n  resolvedLanguage: process.env.DAYGLANCE_LOCALE || 'en',\n  language: process.env.DAYGLANCE_LOCALE || 'en',\n};\nexport default i18n;\n`);
const lf = join(modelDir, 'localeFormatting.js');
writeFileSync(lf, readFileSync(lf, 'utf8').replace("from 'i18next'", "from './i18next-shim.js'"));

console.log(`[vendor] model re-vendored from ${app}`);
