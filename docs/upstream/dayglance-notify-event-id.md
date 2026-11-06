# Upstream issue draft: dayGLANCE completion events are ignored by the intents library

**For:** https://github.com/krelltunez/dayGLANCE/issues (not filed; copy the text below)
**Seen on:** dayGLANCE v5.11.0 and `main` (same code), `@glance-apps/intents` 1.4.0, lastGLANCE v2.14.0

---

## Title

Task completion notifications are written as `<uuid>.json` and ignored by receivers

## Summary

A task completed in the dayGLANCE UI emits a `notify` intent whose `event_id` is a
random UUID. Over WebDAV it is written as `<uuid>.json`. `@glance-apps/intents`
only accepts `YYYYMMDDTHHMMSSZ-<hex>.json` (`parseFilename` returns `null` for
anything else), and every receiver lists the events folder and skips what it
cannot parse. So lastGLANCE never sees the completion, and a chore completed from
dayGLANCE stays overdue in lastGLANCE.

## Steps to reproduce

1. lastGLANCE and dayGLANCE both pointed at the same WebDAV events folder
   (encryption on or off; it does not matter).
2. In lastGLANCE, send an overdue chore to dayGLANCE; it arrives as a task.
3. In dayGLANCE, tick the task.
4. Look at the events folder: a new `<uuid>.json` appears and lastGLANCE never
   logs the completion (no `GET` for that file in its poll).
5. Rename that file to `YYYYMMDDTHHMMSSZ-<6 hex>.json` (timestamp from its
   `emitted_at`): lastGLANCE now fetches it, decrypts it and logs the chore as
   completed from dayGLANCE. So the envelope is fine; only the filename is wrong.

Library behaviour, in isolation:

```js
import { eventId, filenameFor, parseFilename } from '@glance-apps/intents';
for (const id of [eventId(), crypto.randomUUID()]) {
  const name = filenameFor({ event_id: id });
  console.log(name, parseFilename(name));
}
// 20261106T044403Z-7ed0d7.json  { event_id: '20261106T044403Z-7ed0d7', timestamp: '20261106T044403Z' }
// 1a5e4b2d-151c-4878-9a4c-36287a4c03b3.json  null
```

## Cause

- `src/hooks/useTaskActions.js` sets `transitionId: crypto.randomUUID()` when a task
  is completed or reopened.
- `src/intents/useNotifyEmitter.js` (`buildNotifyPayload`) then uses
  `event_id: task.transitionId ?? makeEventId()`, so every UI completion gets a
  UUID `event_id`.
- `filenameFor(envelope)` is `${event_id}.json`, and `parseFilename` requires the
  timestamped form (it also reads the timestamp out of the id for cursoring and
  retention), so a UUID can never be parsed.

## Suggested fix

Keep the id stable per transition (so retries still collapse to one event) but in
the format the library requires:

```js
// src/intents/useNotifyEmitter.js
const hex6 = (s) => { let h = 0x811c9dc5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6); };

export function buildNotifyPayload(task, change, now, meUserSyncId = null) {
  return {
    // event_id must look like YYYYMMDDTHHMMSSZ-<hex> (the library's filename format).
    event_id: task.transitionId
      ? makeEventId(new Date(now)).replace(/-[a-f0-9]+$/, `-${hex6(task.transitionId)}`)
      : makeEventId(),
    ...
```

Regression test (next to the existing `buildNotifyPayload` tests):

```js
import { filenameFor, parseFilename } from '@glance-apps/intents';
it('notify event_id is always a valid event filename', () => {
  const p = buildNotifyPayload({ id: 't', title: 'x', source_app: 'app.lastglance', source_entity_id: 'c1', transitionId: crypto.randomUUID() }, { event: 'completed' }, new Date().toISOString());
  expect(parseFilename(filenameFor({ event_id: p.event_id }))).not.toBeNull();
});
```

(An alternative is to relax the library's filename pattern, but then UUID events
would have no timestamp for ordering and retention, so fixing the id is safer.)

## Workaround in AllGLANCE (until this is fixed)

`gateway/container-mcp/eventNormalizer.mjs` renames such files in the shared events
folder to the accepted form, using the envelope's own `emitted_at`. The envelope is
untouched. Tested end to end with encrypted intents: lastGLANCE then logs the
completion. Delete the normalizer (and `DAYGLANCE_EVENTS_ROOT`) once upstream ships
the fix.
