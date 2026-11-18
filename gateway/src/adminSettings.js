// Settings the admin UI may change, and where they are kept.
//
// The container is configured from .env.allglance, which is awkward to edit by hand on a NAS.
// The admin page writes the safe, day-to-day subset to a small JSON file on the data volume
// (/data/admin-config.json, mode 600). config.js applies it over the environment at start-up,
// so a value saved here wins over the same variable in .env.allglance, and the page says so.
// Infrastructure (ports, the gateway's own admin token, data paths) is deliberately not editable
// here: those stay in .env.allglance. The keys the gateway uses to reach the apps (Vikunja,
// dayGLANCE, Omi) can be pasted here instead, so ALLGlance holds them in one place, and with a
// Vikunja login saved it renews its own Vikunja token (src/vikunjaTokenKeeper.js).

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** @typedef {{ key: string, label: string, group: string, type: 'bool'|'enum'|'text'|'secret'|'url'|'int', options?: string[], help?: string, def?: string, allowSpaces?: boolean }} Setting */

/** @type {Setting[]} */
export const SETTINGS = [
  { key: 'ENABLE_DAYGLANCE', label: 'dayGLANCE', group: 'Apps', type: 'bool', def: 'true', help: 'Read and write the day plan through the dayGLANCE MCP.' },
  { key: 'ENABLE_LASTGLANCE', label: 'lastGLANCE', group: 'Apps', type: 'bool', def: 'true', help: 'Read chores from lastGLANCE\'s synced file.' },
  { key: 'ENABLE_LIFELANCE', label: 'lifeGLANCE', group: 'Apps', type: 'bool', def: 'true', help: 'Read milestones from lifeGLANCE\'s synced file.' },
  { key: 'VIKUNJA_TOKEN', label: 'Vikunja API token', group: 'Vikunja', type: 'secret', def: '', help: 'The token the gateway uses (Vikunja: Settings, API tokens; tk_...). With a login saved below it is renewed automatically before it expires.' },
  { key: 'VIKUNJA_USERNAME', label: 'Vikunja login: username', group: 'Vikunja', type: 'text', def: '', help: 'Lets the gateway make itself a new API token before the old one expires, and lets apps sign in to CalDAV with a gateway token. Used for nothing else.' },
  { key: 'VIKUNJA_PASSWORD', label: 'Vikunja login: password', group: 'Vikunja', type: 'secret', allowSpaces: true, def: '', help: 'The password (or a Vikunja CalDAV token) for that username.' },
  { key: 'VIKUNJA_NATIVE_TOOLS', label: 'Vikunja native tools', group: 'Vikunja', type: 'enum', options: ['meta', 'all', 'off'], def: 'meta', help: 'meta: three discovery tools (recommended). all: every Vikunja tool. off: none.' },
  { key: 'VIKUNJA_DEFAULT_PROJECT_ID', label: 'Default project id', group: 'Vikunja', type: 'int', def: '', help: 'Where new tasks go when none is named. Blank: Vikunja\'s first project (Inbox).' },
  { key: 'CALDAV_TOKEN_LOGIN', label: 'CalDAV sign-in with a gateway token', group: 'Vikunja', type: 'bool', def: 'true', help: 'Apps may sign in to /dav with the admin token or a household alg_ token as the password (any user name); the gateway signs in to Vikunja with the login above. Person tokens are refused: CalDAV cannot hide private tasks.' },
  { key: 'ENABLE_CALDAV_PROXY', label: 'Serve CalDAV at /dav', group: 'Vikunja', type: 'bool', def: 'true', help: 'Let phones, Home Assistant and Omi use the gateway as their CalDAV server.' },
  { key: 'DAYGLANCE_MCP_TOKEN', label: 'dayGLANCE MCP token', group: 'Apps', type: 'secret', def: '', help: 'Must match the token the dayglance-mcp service was started with (.env.allglance).' },
  { key: 'ENABLE_OMI', label: 'Omi', group: 'Omi', type: 'bool', def: 'true', help: 'Needs the Omi address below.' },
  { key: 'OMI_URL', label: 'Omi address', group: 'Omi', type: 'url', def: '', help: 'Where Omi\'s backend answers, e.g. http://192.168.1.20:8000 (a LAN address). Blank: Omi is off.' },
  { key: 'OMI_MCP_TOKEN', label: 'Omi MCP key', group: 'Omi', type: 'secret', def: '', help: 'Omi app: Settings, Developer, MCP, Create Key (omi_mcp_...).' },
  { key: 'OMI_TOOLS', label: 'Omi tools', group: 'Omi', type: 'enum', options: ['core', 'all', 'off'], def: 'core', help: 'core: read-only everyday tools. all: everything the key allows, writes included. off: only the day summary.' },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const BOOL = /^(1|yes|true|on)$/i;

/** Validate and normalise one value; throws a message fit to show the user. */
export function normalise(setting, raw) {
  const v = raw === null || raw === undefined ? '' : String(raw).trim();
  switch (setting.type) {
    case 'bool':
      if (v === '') return '';
      if (BOOL.test(v)) return 'true';
      if (/^(0|no|false|off)$/i.test(v)) return 'false';
      throw new Error(`${setting.label}: use on or off`);
    case 'enum':
      if (v !== '' && !setting.options.includes(v)) throw new Error(`${setting.label}: choose one of ${setting.options.join(', ')}`);
      return v;
    case 'int':
      if (v !== '' && !/^\d{1,9}$/.test(v)) throw new Error(`${setting.label}: a whole number`);
      return v;
    case 'url':
      if (v === '') return '';
      try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw new Error('x'); return v.replace(/\/+$/, ''); } catch { throw new Error(`${setting.label}: a full address such as http://192.168.1.20:8000`); }
    case 'secret':
      if (!setting.allowSpaces && /[\s]/.test(v)) throw new Error(`${setting.label}: no spaces`);
      return v;
    default:
      return v;
  }
}

export function loadOverrides(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw ?? {})) if (BY_KEY.has(k) && typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Apply saved overrides over `env` (a value saved on the admin page wins over .env.allglance). */
export function applyOverrides(file, env = process.env) {
  const o = loadOverrides(file);
  for (const [k, v] of Object.entries(o)) env[k] = v;
  return o;
}

/**
 * Save a change set. `patch` maps keys to values; an empty string clears the override (the
 * environment value applies again). For secrets, `undefined`/missing means "leave as is".
 * Returns the keys changed. Throws on the first invalid value without writing anything.
 */
export function saveOverrides(file, patch) {
  const current = loadOverrides(file);
  const next = { ...current };
  const changed = [];
  for (const [k, raw] of Object.entries(patch ?? {})) {
    const setting = BY_KEY.get(k);
    if (!setting) throw new Error(`${k} cannot be changed here`);
    const v = normalise(setting, raw);
    if (v === '') delete next[k]; else next[k] = v;
    if ((current[k] ?? '') !== (next[k] ?? '')) changed.push(k);
  }
  if (!changed.length) return [];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  return changed;
}

/** The settings with their effective values; secrets are never returned, only whether they are set. */
export function describe(file, env = process.env) {
  const overrides = loadOverrides(file);
  return SETTINGS.map((s) => {
    const fromAdmin = Object.hasOwn(overrides, s.key);
    // `env` already has overrides applied at start-up; the environment value underneath is unknown
    // after that, so "source" reports whether the saved file holds a value.
    const value = env[s.key] ?? '';
    const base = { key: s.key, label: s.label, group: s.group, type: s.type, options: s.options, help: s.help, def: s.def, source: fromAdmin ? 'admin' : value !== '' ? 'env' : 'default' };
    return s.type === 'secret' ? { ...base, set: value !== '' } : { ...base, value: value !== '' ? value : (s.def ?? '') };
  });
}
