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

## Omi (Wizard815/omi-local): CalDAV works for tasks; one catch; two further options

`omi-local` is a self-hosted Omi (backend, Firestore emulator, local STT/LLM). Its
latest commit added a CalDAV page (server URL, login, per-direction switches, test,
sync). Omi's own CalDAV client (`backend/utils/caldav/client.py`) was run against
`/dav/`: principal discovery, calendar home, listing, query, create, complete and
delete of VTODOs all work, so Omi action items can sync to Vikunja tasks (both ways).

**The catch.** Omi's sync always resolves an *events* calendar first
(`ensure_calendars`). Vikunja only has task lists, so with no events calendar chosen
Omi tries `MKCALENDAR` and Vikunja answers 404, failing the whole sync (even for tasks
only). Either save the same list as both the tasks and calendar href while keeping all
event switches off, or (better, in omi-local) only resolve the events calendar when an
event direction is enabled. Omi also talks to ONE CalDAV server per user, so Vikunja
(tasks) and its bundled Radicale (events) cannot both be used at once.

**Other options (not built):**
1. *Omi asks AllGLANCE:* Omi's assistant has a tool framework
   (`backend/utils/retrieval/tools/`) but no MCP client. A small `allglance_tools.py`
   calling the gateway REST would let it answer "what's on my day / which chores are
   overdue" and create tasks.
2. *AllGLANCE asks Omi:* Omi ships its own MCP server (`mcp/`, API-key based). The
   gateway already surfaces Vikunja's MCP as `vikunja_native_*`; the same mechanism
   could surface Omi's tools so one endpoint covers memories and conversations too.

Network note: omi-host runs as its own compose project, so point it at the gateway by
host address (`http://<host>:8090/dav/`), not a container name.
