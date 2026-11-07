# Integrations: Pondering Orb and Omi

Findings from running the real projects against AllGLANCE (not just reading them).

## Pondering Orb (Wizard815/pondering-orb): works, verified

Orb's `docs/allglance.md` describes the integration; this is the check that it
still holds with the current gateway.

Configured as: `allglance.baseUrl = http://<host>:8090` with the gateway token, and
`caldav.url = http://<host>:8090/dav/` (the gateway's CalDAV, not Vikunja's port)
with the Vikunja login.

| Check | Result |
|---|---|
| Orb's built-in "Test" for the gateway | "Reached the ALLGlance gateway. Working: vikunja, dayglance, lastglance, lifeglance." |
| Orb's built-in "Test" for CalDAV | Reached; discovered the Inbox and Family lists |
| Day plan, dayGLANCE tasks, lastGLANCE chores, lifeGLANCE milestones, users | all returned real data (Orb's `/api/allglance/*`) |
| Task created in Orb (priority high, raised to urgent, due date) | arrived in Vikunja through `/dav` with the same due date and **urgent**; completing it in Orb showed done in AllGLANCE |
| Task created by an agent in AllGLANCE | Orb pulled it (260 tasks) with the right list, due date and priority |
| Orb's same-origin rule for CalDAV hrefs | satisfied: the gateway keeps Vikunja's `/dav/...` paths |

Notes for Orb's docs/config (its repo is separate and was only read):
- Point Orb's CalDAV at the gateway (`:8090/dav/`) so everything uses one address.
- Its docs say lastGLANCE is read through Playwright. The gateway now reads
  lastGLANCE and lifeGLANCE from their synced snapshots instead.
- `dayglance-tasks` now returns every scheduled day, not only the inbox and today.
- "Writing to dayGLANCE from Orb" (listed there as still to do) now exists on the
  gateway: `POST /mcp` tools `allglance_create_task` / `allglance_update_task` with
  `source: "dayglance"`. Orb has no tool for it yet.

## Omi (Wizard815/omi-local): wired both ways

`omi-local` is a self-hosted Omi (backend, Firestore emulator, local STT/LLM). Omi and
AllGLANCE now meet in three places; each is one setting on one side.

| Direction | What moves | Set on | How |
|---|---|---|---|
| Omi → Vikunja (CalDAV) | action items as VTODOs, both ways: a task ticked in Vikunja completes in Omi, a task created in Vikunja becomes an Omi action item | omi-host `.env`: `CALDAV_DEFAULT_URL=http://<host>:8090/dav/`, `CALDAV_USER` / `CALDAV_PASSWORD` = a Vikunja login or CalDAV token | Omi's hourly sync (`backend/utils/caldav/sync.py`) against the gateway's `/dav` |
| Omi → gateway (MCP + REST) | Omi's assistant gets the `allglance_*` tools (what's on today, chores, milestones, create a task); new Omi action items are created in Vikunja at once | omi-host `.env`: `ALLGLANCE_URL=http://<host>:8090`, `ALLGLANCE_TOKEN=<GATEWAY_TOKEN>` | Omi seeds a private "ALLGlance" chat app from the gateway's `/mcp` and an `allglance` task integration (`backend/utils/allglance.py`); the same can be done by hand with `POST /v1/apps/mcp` (now takes `access_token`) |
| Gateway → Omi (MCP) | Omi's tools appear here as `omi_*` (day review, conversations, memories, action items), and `allglance_get_day` carries `omi_day_summary` | `.env.allglance`: `OMI_URL=http://<host>:8000`, `OMI_MCP_TOKEN=omi_mcp_…` | `gateway/src/adapters/OmiAdapter.js`, a passthrough of Omi's Streamable HTTP MCP at `/v1/mcp` |

**The CalDAV catch is fixed in omi-local.** Omi's sync used to resolve an *events*
calendar first and fail the whole sync when Vikunja (task lists only) answered 404 to
`MKCALENDAR`. It now looks for an events calendar only when an event direction is on, and
when the server has none it syncs the tasks and reports, in the app's last sync report:
"This server only has task lists (no events calendar) …". Day summaries and conversation
events therefore do not reach Vikunja over CalDAV; the day summary reaches AllGLANCE
through `allglance_get_day` (`omi_day_summary`) instead: omi-local's bundled day (`get_day_review`: title,
text, tags, sections) when the key lists that tool, else the classic `get_daily_summaries`; the field says
which in `source`. Omi still talks to one CalDAV
server per user, so choose: Vikunja through the gateway (tasks shared with the family) or
Omi's bundled Radicale (tasks and events, Omi only).

**Omi puts events on the family calendar, after asking.** Dates Omi hears in conversations
("the inspection is Friday at eleven") do not go anywhere by themselves: Omi's app lists them
under *Family calendar* with the date, time and length it heard, and the user fixes what the
extractor got wrong, adds the event or declines it. Only "Add" writes: Omi POSTs
`/api/allglance/tasks` with `source: "dayglance"`, `start: "YYYY-MM-DD HH:MM"` (the user's
local time) and `duration_minutes` (and `owner_id`, the household member from `allglance_list_users` the event
belongs to, when Omi is bound to one), the gateway's REST mirror of `allglance_create_task`, so
the event lands as a dayGLANCE block, assigned to that member, and shows in `allglance_get_day`. The gateway needs
dayGLANCE on (`ENABLE_DAYGLANCE=true`, `DAYGLANCE_MCP_HOST/PORT/TOKEN`); without it the
create answers 503 and Omi shows that text. For tests without the desktop app,
`scripts/dev/fake_dayglance.py` stands in for dayGLANCE's MCP.

**Omi's MCP tools surfaced here.** `OMI_TOOLS=core` (default) exposes
`get_day_review` (omi-local only), `get_daily_summaries`, `get_conversations`, `search_conversations`, `get_memories`,
`search_memories` and `get_action_items` (reads only: creating or completing tasks goes
through CalDAV / Vikunja, so there is one place to write them);
`all` exposes every tool the key allows, writes included; `off` keeps only the day summary in
`allglance_get_day`. The key's scopes (set when creating it in Omi) still apply. Omi's
action items are not listed as a task source here: they already reach Vikunja through
CalDAV or the task integration, so a second listing would show every task twice.

**Checked without a phone.** The adapter is covered by `gateway/test/omi.adapter.test.js`
against a fake Omi MCP; the Omi side by its unit tests (`tests/unit/test_caldav_sync.py`
tasks-only cases, `test_allglance.py`). Not yet run against
a live Omi and a live gateway together.

Network note: omi-host runs as its own compose project, so point it at the gateway by
host address (`http://<host>:8090/…`), not a container name, and point the gateway at
Omi the same way (`OMI_URL=http://<host>:8000`).

**Trying it without Docker.** `scripts/dev/fake_vikunja.py` is a stand-in Vikunja (the REST the
gateway uses, the CalDAV Omi syncs with: Basic auth, VTODO only, 404 on MKCALENDAR, one list per
project), in memory, on one port. Start it, point the gateway at it (`VIKUNJA_URL`,
`VIKUNJA_TOKEN`, `ENABLE_VIKUNJA_MCP=false`) and point Omi's `CALDAV_DEFAULT_URL` at the
gateway's `/dav/`: tasks created in Omi appear as its REST tasks and tasks created through
`POST /api/allglance/tasks` reach Omi on its next sync pass. A week-long synthetic run against it
(seven bundled days, 21 Omi tasks pushed, two Vikunja tasks pulled, one completed each way,
`allglance_get_day` with Omi's summary) is how this integration was exercised.

**Omi and calendars.** Omi extracts events from conversations (title, start, duration; the app lets you
confirm each one) and can read a calendar (Google Calendar, the phone's, or a CalDAV events calendar).
Its chat tool for *creating* events only writes to Google Calendar, and its CalDAV event push needs an
events calendar, which Vikunja does not have. With the ALLGlance chat app enabled, "put the dentist on
Thursday at 3" can instead go to dayGLANCE through `allglance_create_task` (`source: dayglance`, `start`),
which is the family calendar in this stack and shows up in `allglance_get_day`.
