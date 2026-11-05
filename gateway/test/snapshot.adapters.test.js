// lastGLANCE / lifeGLANCE adapters reading their own synced (optionally
// end-to-end-encrypted) snapshots from the shared WebDAV directory.
import { describe, it } from 'node:test';
import { equal, ok, deepEqual, rejects } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Roster } from '../src/identity/roster.js';
import { LastglanceAdapter } from '../src/adapters/LastglanceAdapter.js';
import { LifeglanceAdapter } from '../src/adapters/LifeglanceAdapter.js';
import { readSnapshot } from '../src/lib/syncSnapshot.js';

// Encrypt exactly as @glance-apps/sync does.
async function encrypt(doc, pass, salt = new Uint8Array(16).fill(7)) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const mat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(doc))));
  return { v: 1, enc: 'AES-GCM-256', data: Buffer.concat([salt, iv, ct]).toString('base64') };
}
const snap = (appId, data) => ({ schemaVersion: 1, appId, version: 2, lastModified: '2026-11-05T00:00:00.000Z', data });

async function setup({ pass = 'pw' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gsync-'));
  await mkdir(join(dir, 'GLANCE', 'lastglance'), { recursive: true });
  await mkdir(join(dir, 'GLANCE', 'lifeglance'), { recursive: true });
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  await writeFile(join(dir, 'GLANCE', 'lastglance', 'lastglance-sync.json'), JSON.stringify(await encrypt(snap('lastglance', {
    categories: [{ id: 'c1', name: 'Home' }],
    users: [{ id: 'u1', name: 'Dad' }],
    chores: [
      { id: 'ch1', name: 'Mop kitchen', categorySyncId: 'c1', targetCadenceDays: 14, assignedUserSyncIds: ['u1'] },
      { id: 'ch2', name: 'Wash car', categorySyncId: 'c1', targetCadenceDays: 30, assignedUserSyncIds: [] },
      { id: 'ch3', name: 'No cadence', targetCadenceDays: null },
    ],
    completionEvents: [
      { id: 'e1', choreSyncId: 'ch1', completedAt: new Date(now - 20 * day).toISOString() }, // overdue (14d)
      { id: 'e2', choreSyncId: 'ch1', completedAt: new Date(now - 30 * day).toISOString() }, // older: ignored
      { id: 'e3', choreSyncId: 'ch2', completedAt: new Date(now - 2 * day).toISOString() },  // fine (30d)
    ],
  }), pass)));
  await writeFile(join(dir, 'GLANCE', 'lifeglance', 'lifeglance-sync.json'), JSON.stringify(snap('lifeglance', { // plaintext also accepted
    lives: { default: { milestones: [{ id: 'm1', title: 'Moved house', date: '2025-06-01T00:00:00.000Z', date_precision: 'day', category: 'family', dayglance_linked: true }], chapters: [] } },
  })));
  const config = { sync: { dir, passphrase: pass }, lastglance: { enabled: true, webUrl: '' }, lifeglance: { enabled: true, webUrl: '' }, playwright: {} };
  return { dir, config, roster: new Roster() };
}

describe('snapshot adapters', () => {
  it('lastGLANCE: chores, last completion, cadence/overdue, owner, roster — from the encrypted snapshot', async () => {
    const { config, roster } = await setup();
    const a = new LastglanceAdapter({ config, roster });
    const { chores } = await a.readChores();
    const by = Object.fromEntries(chores.map((c) => [c.title, c]));
    equal(by['Mop kitchen'].overdue, true);
    equal(by['Mop kitchen'].owner_id, 'u1');
    equal(by['Mop kitchen'].category, 'Home');
    equal(by['Wash car'].overdue, false);
    equal(by['No cadence'].overdue, null);
    ok(by['Mop kitchen'].last_completed.startsWith(new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10)));
    ok(roster.list().some((p) => p.name === 'Dad'));
    equal((await a.readChores('u1')).chores.length, 1, 'owner scoping');
    equal((await a.status()).ok, true);
  });

  it('lifeGLANCE: milestones from its snapshot (plaintext snapshots work too)', async () => {
    const { config, roster } = await setup();
    const a = new LifeglanceAdapter({ config, roster });
    const { milestones } = await a.readMilestones();
    equal(milestones.length, 1);
    equal(milestones[0].title, 'Moved house');
    equal(milestones[0].date, '2025-06-01');
    equal(milestones[0].dayglance_linked, true);
  });

  it('wrong passphrase / missing passphrase are reported, not swallowed; a missing file is empty, not fabricated', async () => {
    const { config, roster, dir } = await setup();
    const bad = new LastglanceAdapter({ config: { ...config, sync: { dir, passphrase: 'nope' } }, roster });
    equal((await bad.status()).ok, false);
    ok((await bad.status()).error.includes('wrong GLANCE_SYNC_PASSPHRASE'));
    await rejects(readSnapshot({ dir, filename: 'lastglance-sync.json', passphrase: '' }), /GLANCE_SYNC_PASSPHRASE/);

    const empty = await mkdtemp(join(tmpdir(), 'gsync-empty-'));
    const none = new LastglanceAdapter({ config: { ...config, sync: { dir: empty, passphrase: '' } }, roster });
    deepEqual(await none.readChores(), { chores: [] });
    equal((await none.status()).ok, false);
  });
});
