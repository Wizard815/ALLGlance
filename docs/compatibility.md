# Compatibility with the other apps

What ALLGlance was checked against, and what was found. Re-run the checks after a bump
(`scripts/upstream.sh status`, then the tests; see README "Upkeep").

## Last check: 2026-11-17

| Component | In this stack | Latest | Result |
|---|---|---|---|
| dayGLANCE | **v5.15.0** (was v5.11.0) | v5.15.0 | Moved to 5.15 on 2026-11-17. The synced file format and encryption are unchanged (shared `@glance-apps/sync` 2.4.0 only touches the vault engine). Intents `@glance-apps/intents` 1.5.0 is additive; the completion-event UUID filename bug is still there, so `eventNormalizer.mjs` stays. 5.12 moved the MCP read model into `packages/dayglance-mcp` (state is now built with `buildMcpReadState`), so `vendor-model.mjs` was rewritten for the new layout and the server builds its read state that way. Checked live in the rebuilt image: a 5.15-shaped snapshot (routines, frames, areas, an unknown future slice) was read through the agent tools, a task created through MCP landed in the file with the unknown slice untouched |
| lastGLANCE | v2.14.0 | v3.2.0 | Tested at **3.2.0** built from its release tag (see "Real-app run" below). The `3.2.0` image is not published yet (`3.1.1` is, `3.0.0` is not), so the pin stays at 2.14.0 and `scripts/upstream.sh bump lastglance` correctly refuses until it is |
| lifeGLANCE | **v5.1.0** (was v3.6.0) | v5.1.0 | Moved to 5.1.0 on 2026-11-17 after the real-app run. The payload keeps `lives.default.milestones`; v5 only adds `lifeRecords`, `relationships` and a `writers` stamp, which the gateway ignores |
| Vikunja | v2.8.0 | v2.8.0 | Current. `main` is ahead but unreleased |
| Omi (omi-local) | `d782ccb` earlier | `9fdb1b3` | Unit tests 83/83 on the ALLGlance-facing files; the family-calendar approve was run against a live gateway (time zone, no duplicate on a second approve, member binding). New: per-person CalDAV collections with approval, which still work against Vikunja (task lists only: MKCALENDAR is refused and Omi falls back to a free task list), and an egress guard (see README, Omi section) |
| Pondering Orb | `84d4e44` earlier | `a92ccce` | Its own 88 tests pass and it type-checks; its gateway client was run against a live gateway (users, add event with a member and without a time, day, tasks, chores, milestones) |
| Home Assistant | CalDAV integration, verified earlier | n/a | Not re-run in this check |

## Real-app run (2026-11-17)

The published web images could not be downloaded in the check environment (the registry's blob
host was blocked), so the three apps were **built from their release tags** (dayGLANCE v5.15.0,
lastGLANCE v3.2.0, lifeGLANCE v5.1.0) and served the way the images serve them (static files plus
the app's own Node proxy for WebDAV). A headless Chromium drove each app's own settings screens
against the rebuilt `allglance` container (real WebDAV server behind the sync guard, end-to-end
encryption on, one household passphrase):

| Step | Result |
|---|---|
| dayGLANCE 5.15: enable encryption, add WebDAV, test connection, sync | Created the folder, uploaded an encrypted snapshot (GET 404, PUT 409, MKCOL, PUT 201) |
| Agent creates a task through MCP | dayGLANCE pulled it and showed it at the right time |
| Task typed into dayGLANCE | Reached the gateway (`days/<date>`) after the app's next upload |
| lifeGLANCE 5.1: add a milestone, sync | Appeared in `/milestones` and `allglance_list_milestones` |
| lastGLANCE 3.2: sync with encryption, log a chore | `/chores` shows the completion and `overdue: false` |
| lastGLANCE sends an overdue chore to dayGLANCE (encrypted intents) | dayGLANCE created the all-day task from the event file |
| Tick that task in dayGLANCE | It wrote `<uuid>.json` (the upstream naming bug); the container renamed it to the timestamp form; lastGLANCE logged the completion and the gateway shows the chore done |
| `/health` | vikunja, dayglance, lastglance and lifeglance all ok |

Things a new install of these versions asks for, all one-time: the dayGLANCE and lastGLANCE
intent settings both need the sync passphrase once ("Encrypt intent events"), and the desktop
builds need the LAN address allowed (see the README).

## Not checked

- The published images themselves (only the same releases built from source), and the lastGLANCE
  3.1.1 image.
- Nothing was run on an Unraid host, a phone or the desktop apps.

## Sync server: conditional writes

hacdias/webdav ignores `If-Match` on `PUT`, so a device uploading from an out-of-date read would
silently overwrite a newer file. The `allglance` container now runs a small guard in front of it
(`gateway/src/syncGuard.js`, on :6065; the WebDAV server moved to internal :6066) that enforces
`If-Match` and `If-None-Match` on PUT / DELETE / MOVE with a `412`, one write at a time per file,
and passes everything else straight through (including the `304` the apps use to skip unchanged
polls). Checked against the real server: stale `If-Match` and repeated `If-None-Match: *` are
refused, the current ETag is accepted, and a device holding the ETag from before an MCP write is
refused afterwards. Writers that bypass it (the gateway/MCP replacing the file on disk) change the
ETag, which is what makes the next stale device upload fail.
