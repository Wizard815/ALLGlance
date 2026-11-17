# Compatibility with the other apps

What ALLGlance was checked against, and what was found. Re-run the checks after a bump
(`scripts/upstream.sh status`, then the tests; see README "Upkeep").

## Last check: 2026-11-17

| Component | In this stack | Latest | Result |
|---|---|---|---|
| dayGLANCE | v5.11.0 | v5.15.0 | The synced file format and encryption are unchanged (shared `@glance-apps/sync` 2.3.0 -> 2.4.0 only touches the vault engine, not the file tier). Intents `@glance-apps/intents` 1.4.0 -> 1.5.0 is additive; the completion-event UUID filename bug is still there, so `eventNormalizer.mjs` stays. **Not a drop-in bump of the pin:** 5.15 moved its MCP model into `packages/dayglance-mcp` and its frame code into agenda-core, so `container-mcp/scripts/vendor-model.mjs` fails (`src/utils/frameInstances.js` is gone) and the vendoring has to be redone first. A 5.15 app still syncs to this stack: the container MCP edits only the four task slices and passes every other field through |
| lastGLANCE | v2.14.0 | v3.2.0 | Sync adapter and data model unchanged (chores, categories, completion events, users), so the gateway still reads it. **The `3.2.0` image is not published yet** (`3.1.1` is, `3.0.0` is not), so `scripts/upstream.sh bump lastglance` correctly refuses |
| lifeGLANCE | v3.6.0 | v5.1.0 | The payload keeps `lives.default.milestones`; v5 only adds `lifeRecords`, `relationships` and a `writers` stamp, which the gateway ignores. Image `5.1.0` exists |
| Vikunja | v2.8.0 | v2.8.0 | Current. `main` is ahead but unreleased |
| Omi (omi-local) | `d782ccb` earlier | `9fdb1b3` | Unit tests 83/83 on the ALLGlance-facing files; the family-calendar approve was run against a live gateway (time zone, no duplicate on a second approve, member binding). New: per-person CalDAV collections with approval, which still work against Vikunja (task lists only: MKCALENDAR is refused and Omi falls back to a free task list), and an egress guard (see README, Omi section) |
| Pondering Orb | `84d4e44` earlier | `a92ccce` | Its own 88 tests pass and it type-checks; its gateway client was run against a live gateway (users, add event with a member and without a time, day, tasks, chores, milestones) |
| Home Assistant | CalDAV integration, verified earlier | n/a | Not re-run in this check |

## Not checked

- The three new web images could not be pulled in the check environment (blob downloads were
  blocked), so no real browser sync was run against them. The conclusions above come from the
  upstream source and the shared libraries' changelogs and diffs.
- Nothing was run on an Unraid host, a phone or the desktop apps.

## Known gap, not caused by any upgrade

The WebDAV server (hacdias/webdav) ignores `If-Match` on `PUT`: a write with a stale ETag is
accepted. `If-None-Match` (the `304` the apps use to skip unchanged polls) works. The apps also
check client-side that a write follows a read, so a lost update needs two devices to sync in the
same moment.
