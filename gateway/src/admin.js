// The admin page: /admin (HTML) and /admin/api/* (JSON).
//
// One place to see whether the stack is healthy, to copy the values each app and agent needs,
// and to change the day-to-day settings without editing .env.allglance. Guarded by the same
// bearer token as the rest of the gateway (the page asks for it once per browser session).
// With no GATEWAY_TOKEN the page still works on a private network, but secrets (the sync
// password, the token itself) are not shown: it is the token that proves you may see them.

import express from 'express';
import { readFileSync } from 'node:fs';
import { readdir, stat, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSnapshot } from './lib/syncSnapshot.js';
import { SETTINGS, describe, saveOverrides } from './adminSettings.js';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, 'admin', 'index.html'), 'utf8');
const VERSION = (() => { try { return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();
const STARTED = Date.now();

/** Every adapter's status, in parallel, each capped: one dead service must not stall the page. */
async function healthFast(gateway, capMs = 4000) {
  const entries = await Promise.all(gateway.adapters().map(async (a) => {
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('did not answer in time')), capMs).unref?.());
      return [a.source, await Promise.race([a.status(), timeout])];
    } catch (err) {
      return [a.source, { ok: false, error: err.message }];
    }
  }));
  return { adapters: Object.fromEntries(entries), roster: gateway.roster.list() };
}

const hostOf = (req) => {
  const h = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
  return { name: m?.[1] ?? 'localhost', port: m?.[2] ?? '' };
};

async function fileInfo(path) {
  if (!path) return { exists: false };
  try {
    const st = await stat(path);
    let encrypted = false;
    const fh = await open(path, 'r');
    try {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(64), 0, 64, 0);
      encrypted = /"enc"\s*:\s*"AES-GCM/.test(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await fh.close(); }
    return { exists: true, path, modified: st.mtime.toISOString(), bytes: st.size, encrypted };
  } catch {
    return { exists: false, path };
  }
}

/**
 * @param {{ gateway: object, config: object, settingsFile: string, guard?: Function, restart?: () => void, fetchImpl?: Function }} deps
 */
export function createAdminRouter({ gateway, config, settingsFile, guard = (_q, _s, n) => n(), restart = () => process.exit(0), supervised = Boolean(process.env.ALLGLANCE_SUPERVISED) }) {
  const router = express.Router();
  const revealSecrets = Boolean(config.server.token);

  router.get('/admin', (_req, res) => {
    res.set('cache-control', 'no-store').type('html').send(PAGE);
  });

  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  async function snapshots() {
    const dir = config.sync.dir;
    const day = config.sync.dayglanceFile || (dir ? await findSnapshot(dir, 'dayglance-sync.json') : null);
    const last = dir ? await findSnapshot(dir, 'lastglance-sync.json') : null;
    const life = dir ? await findSnapshot(dir, 'lifeglance-sync.json') : null;
    let events = { exists: false };
    if (dir) {
      try {
        const names = await readdir(join(dir, 'GLANCE', 'events'));
        events = { exists: true, files: names.filter((n) => /^\d{8}T\d{6}Z-[a-f0-9]{6,8}\.json$/.test(n)).length, encrypted: names.includes('intents-encryption-salt.json'), waitingToBeFixed: names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)).length };
      } catch { /* none yet */ }
    }
    return { dayglance: await fileInfo(day), lastglance: await fileInfo(last), lifeglance: await fileInfo(life), events };
  }

  api.get('/status', async (_req, res) => {
    const health = await healthFast(gateway);
    let sync = null;
    if (process.env.SYNC_WEBDAV_PORT) {
      const ok = await fetch(`http://127.0.0.1:${process.env.SYNC_WEBDAV_PORT}/`, { method: 'OPTIONS', signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
      sync = { ok };
    }
    res.json({ version: VERSION, uptimeSeconds: Math.round((Date.now() - STARTED) / 1000), adapters: health.adapters, roster: health.roster, syncServer: sync, files: await snapshots(), supervised, passphraseSet: Boolean(config.sync.passphrase) });
  });

  api.get('/setup', async (req, res) => {
    const { name, port } = hostOf(req);
    const gwPort = port || String(config.server.port);
    const base = `http://${name}:${gwPort}`;
    const syncPort = process.env.PUBLIC_SYNC_PORT || '8091';
    const folder = process.env.DAYGLANCE_SYNC_FOLDER || 'dayglance';
    const secret = (v) => (revealSecrets ? v : null);
    const [health, files] = await Promise.all([healthFast(gateway), snapshots()]);
    const a = health.adapters;
    const passphraseSet = Boolean(config.sync.passphrase);
    const checklist = [
      { id: 'token', label: 'Gateway token set', ok: Boolean(config.server.token), detail: config.server.token ? '' : 'Anyone on your network can read and create tasks. Set GATEWAY_TOKEN in .env.allglance.' },
      { id: 'vikunja', label: 'Vikunja connected', ok: Boolean(a.vikunja?.ok && a.vikunja?.authenticated), detail: a.vikunja?.ok ? (a.vikunja?.authenticated ? '' : 'Reachable but no API token: tasks are read-only.') : (a.vikunja?.error ?? 'Not enabled.') },
      { id: 'passphrase', label: 'Sync passphrase set', ok: passphraseSet, detail: passphraseSet ? '' : 'Set GLANCE_SYNC_PASSPHRASE to the passphrase typed into the apps, or encrypted files cannot be read.' },
      { id: 'dayglance', label: 'dayGLANCE synced', ok: Boolean(a.dayglance?.ok && files.dayglance.exists), detail: files.dayglance.exists ? '' : 'Open dayGLANCE, Settings, Sync, and turn on WebDAV Sync with the values below.' },
      { id: 'lastglance', label: 'lastGLANCE synced', ok: Boolean(files.lastglance.exists && a.lastglance?.ok), detail: files.lastglance.exists ? '' : 'Open lastGLANCE, Cloud Sync, and enter the values below.' },
      { id: 'lifeglance', label: 'lifeGLANCE synced', ok: Boolean(files.lifeglance.exists && a.lifeglance?.ok), detail: files.lifeglance.exists ? '' : 'Open lifeGLANCE, sync, and enter the values below.' },
    ];
    if (config.omi.url) checklist.push({ id: 'omi', label: 'Omi reachable', ok: Boolean(a.omi?.ok), detail: a.omi?.ok ? '' : (a.omi?.error ?? 'Not reachable from here.') });
    res.json({
      checklist,
      connect: {
        mcpUrl: `${base}/mcp`,
        restUrl: `${base}/api/allglance`,
        token: secret(config.server.token),
        caldavUrl: `${base}/dav/`,
        vikunjaUrl: config.vikunja.url,
        syncUrl: `http://${name}:${syncPort}`,
        syncUser: process.env.DAYGLANCE_SYNC_USER || 'glance',
        syncPassword: secret(process.env.DAYGLANCE_SYNC_PASSWORD ?? ''),
        syncFolder: folder,
        passphraseSet,
        intentsFolder: 'GLANCE/events',
      },
      snippets: {
        claudeCode: `claude mcp add --transport http allglance ${base}/mcp --header "Authorization: Bearer ${secret(config.server.token) ?? '<GATEWAY_TOKEN>'}"`,
        omiHost: [
          `ALLGLANCE_URL=${base}`,
          `ALLGLANCE_TOKEN=${secret(config.server.token) ?? '<GATEWAY_TOKEN>'}`,
          `CALDAV_DEFAULT_URL=${base}/dav/`,
          'CALDAV_USER=<your Vikunja user>',
          'CALDAV_PASSWORD=<your Vikunja password>',
        ].join('\n'),
      },
    });
  });

  api.get('/config', (_req, res) => {
    res.json({ settings: describe(settingsFile), file: settingsFile, restartAvailable: supervised });
  });

  api.put('/config', (req, res) => {
    try {
      const body = req.body ?? {};
      const known = new Set(SETTINGS.map((s) => s.key));
      const patch = {};
      for (const [k, v] of Object.entries(body)) {
        if (!known.has(k)) throw new Error(`${k} cannot be changed here`);
        const s = SETTINGS.find((x) => x.key === k);
        if (s.type === 'secret' && (v === undefined || v === null)) continue; // untouched secret
        patch[k] = v;
      }
      const changed = saveOverrides(settingsFile, patch);
      res.json({ changed, restartRequired: changed.length > 0, restartAvailable: supervised });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/restart', (_req, res) => {
    if (!supervised) return res.status(409).json({ error: 'Not running under the container supervisor: restart the container instead.' });
    res.status(202).json({ restarting: true });
    setTimeout(restart, 300);
  });

  api.post('/test/:what', async (req, res) => {
    const adapter = gateway.adapter(req.params.what);
    if (!adapter) return res.status(404).json({ error: `${req.params.what} is not enabled` });
    try {
      res.json(await adapter.status());
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  router.use('/admin/api', guard, api);
  return router;
}

export default createAdminRouter;
