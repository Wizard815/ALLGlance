// Renames only what the shared intents library would otherwise ignore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOnce, conformingName, FILENAME_RE } from '../eventNormalizer.mjs';

const env = (id, at = '2026-11-05T21:41:04.943Z') => JSON.stringify({ schema_version: 1, event_id: id, emitted_at: at, emitted_by: 'app.dayglance', encrypted: true, payload_ciphertext: 'x' });
const old = async (p) => { const t = new Date(Date.now() - 60_000); await utimes(p, t, t); };

test('renames UUID-named events to the accepted form, keeps content, leaves everything else alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ev-'));
  const ev = join(root, 'GLANCE', 'events'); const snap = join(root, 'GLANCE', 'lastglance');
  await mkdir(ev, { recursive: true }); await mkdir(snap, { recursive: true });
  const uuid = '444fa477-a9c6-4317-95e8-495ff8219a50';
  const files = {
    [join(ev, `${uuid}.json`)]: env(uuid),                                   // should be renamed
    [join(ev, '20261105T214018Z-2cd5ab.json')]: env('20261105T214018Z-2cd5ab'), // already fine
    [join(ev, 'intents-encryption-salt.json')]: '{"salt":"abc"}',            // salt file
    [join(ev, 'notes.json')]: '{"hello":1}',                                // not an envelope
    [join(ev, 'broken.json')]: '{nope',                                     // unparseable
    [join(snap, 'lastglance-sync.json')]: env('whatever'),                  // outside an events dir + snapshot
  };
  for (const [p, c] of Object.entries(files)) { await writeFile(p, c); await old(p); }

  const done = await normalizeOnce(root);
  assert.equal(done.length, 1);
  assert.match(done[0].to, FILENAME_RE);
  const now = Date.now();
  assert.ok(done[0].to.startsWith(new Date(now).toISOString().slice(0, 10).replace(/-/g, '')), 'an old event is stamped with the rename time');
  assert.deepEqual((await readdir(ev)).sort(), ['20261105T214018Z-2cd5ab.json', done[0].to, 'broken.json', 'intents-encryption-salt.json', 'notes.json'].sort());
  assert.deepEqual(await readdir(snap), ['lastglance-sync.json']);
  assert.deepEqual(await normalizeOnce(root), [], 'idempotent');
});

test('does not touch a file that was written moments ago (it may still be mid-write)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ev-'));
  const ev = join(root, 'events'); await mkdir(ev);
  await writeFile(join(ev, 'abc.json'), env('abc'));
  assert.deepEqual(await normalizeOnce(root), []);
  assert.deepEqual(await readdir(ev), ['abc.json']);
});

test('timestamp: fresh events keep their own time, old ones get "now" so a moved-on receiver cursor cannot skip them', () => {
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const fresh = JSON.parse(env('aaa', '2026-11-06T11:50:00.000Z'));
  const stale = JSON.parse(env('bbb', '2026-11-05T01:00:00.000Z')); // service was down for a day
  const future = JSON.parse(env('ccc', '2026-11-07T00:00:00.000Z')); // clock skew
  assert.ok(conformingName(fresh, now).startsWith('20261106T115000Z-'));
  assert.ok(conformingName(stale, now).startsWith('20261106T120000Z-'));
  assert.ok(conformingName(future, now).startsWith('20261106T120000Z-'));
  for (const e of [fresh, stale, future]) assert.match(conformingName(e, now), FILENAME_RE);
  assert.equal(conformingName(stale, now), conformingName(stale, now), 'deterministic for a given moment');
});
