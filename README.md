# ALLGlance

**Calendar · Tasks · Life Events, with MCP.** Using the GLANCE ecosystem &
vikunja.

ALLGlance gathers the GLANCE family of apps plus vikunja into a single MCP +
REST surface, with per-person scoping, so an agent (Claude, Home Assistant,
anything that speaks MCP or HTTP) can read and update the whole family's day
from one place.

```
                    ┌─────────────────────────────────────────┐
   Claude / HA ───▶ │  allglance-gateway   :8090              │
   (MCP or REST)    │  ONE MCP server + REST + roster         │
                    └───────┬───────────────┬─────────────────┘
                            │               │
              REST /api/v2  │               │  MCP /mcp
                            ▼               ▼
                    ┌──────────────┐  ┌──────────────────┐
                    │   vikunja    │  │  dayglance-mcp   │  ← container port of
                    │  :3456       │  │  :7893           │    dayGLANCE's Electron MCP
                    └──────────────┘  └──────────────────┘
                            ▲               ▲
                            │  CalDAV       │  state document (volume)
                    ┌───────┴───────────────┴─────────────────┐
                    │  GLANCE browser apps (dayglance /       │
                    │  lastglance / lifeglance)               │
                    └──────────────────┬──────────────────────┘
                                       │  encrypted sync (optional)
                                       ▼
                              ┌──────────────────┐
                              │   glance-vault   │  zero-knowledge sync
                              │   :8080          │
                              └──────────────────┘
```

## What this actually is (read this first)

- **The gateway is the product.** `allglance-gateway` is one MCP server + one
  REST API that fronts every app. It is the single thing you connect Claude or
  Home Assistant to.
- **`dayglance-mcp` is a container port of dayGLANCE's MCP.** dayGLANCE's own
  MCP only exists inside its Electron desktop app; the published Docker image is
  nginx + a static SPA with **no MCP**. This repo ships a small Node service
  (`gateway/container-mcp/`) that reuses dayGLANCE's *real* pure model and
  serves the same tools over Streamable HTTP — so dayGLANCE works in a
  container-only deployment.
- **`glance-vault` is the optional sync backbone.** It is a zero-knowledge
  relay (it stores opaque encrypted bytes) and is *not* required for the
  gateway to work — it exists so the browser apps can sync across devices and
  exchange cross-app intents. No GPU, no embeddings, no model.
- **vikunja is the one app with its own server + database.** The gateway reads
  it over the REST API (`/api/v2/`).
- **The apps are git submodules** pointing at their own upstreams. AllGLANCE's
  code lives in `gateway/` and the top-level compose; it does not fork the apps.

## Services

| Service | Port | What it is |
|---|---|---|
| `allglance-gateway` | `8090` | The one MCP (`/mcp`) + REST (`/api/allglance/`) front door |
| `dayglance-mcp` | `7893` (internal) | Container port of dayGLANCE's MCP; the gateway's dayGLANCE source |
| `vikunja` | `3457` | Task/calendar manager (web UI, CalDAV, REST `/api/v2/`) |
| `dayglance-sync` | `8091` | WebDAV server dayGLANCE syncs to; `dayglance-mcp` reads/writes the same file |
| `glance-vault` | `8088` | **Optional, off by default** (`--profile vault`): zero-knowledge sync backend for the browser apps; nothing here needs it |
| `dayglance` | `6767` | dayGLANCE web build |
| `lastglance` | `3000` | lastGLANCE web build (chores) |
| `lifeglance` | `6868` | lifeGLANCE web build (milestones) |

## The one MCP / REST surface

**MCP:** `POST /mcp` (Streamable HTTP, stateless: any number of clients, no
session handshake state to lose). **One endpoint, ten tools**, kept few on
purpose so an agent can choose well.

| Tool | Use it for | Source |
|---|---|---|
| `allglance_get_day` | "What's on today / tomorrow?" (blocks in time order, tasks due, overdue count) | dayGLANCE + Vikunja |
| `allglance_list_tasks` | Filtered task lists (status, source, owner, due range, limit); compact | Vikunja + dayGLANCE |
| `allglance_list_chores` | Recurring chores, last done, overdue | lastGLANCE |
| `allglance_list_milestones` | Life-timeline events, optional date range | lifeGLANCE |
| `allglance_list_users` | Turn a name into the `owner_id` the other tools take | all |
| `allglance_create_task` | New task: Vikunja (default) or dayGLANCE (scheduled or inbox) | Vikunja / dayGLANCE |
| `allglance_update_task` | Done / rename / priority / due date / (dayGLANCE) schedule | Vikunja / dayGLANCE |
| `vikunja_native_find_action` · `_do_action` · `_filter_syntax` | Anything else in Vikunja (labels, buckets, comments, filters) | Vikunja |

Design choices: results are **compact** (no raw app records; `source` + `id` go
straight into `allglance_update_task`), lists have **filters and a default limit**
so an agent never pulls everything, and each tool's description says when to use
it and which sibling to use instead. lastGLANCE and lifeGLANCE are read-only here
(their apps own that data). The old per-adapter `vikunja_*` tools were removed as
duplicates; their REST routes remain. `VIKUNJA_NATIVE_TOOLS=all` exposes all 11 of
Vikunja's own tools if you want them (default `meta`: the three above).

**Vikunja's native MCP (Vikunja 2.7+).** Vikunja ships its own MCP server
(`/api/v2/mcp`, generated from its OpenAPI spec). The gateway discovers it and
re-exposes its discovery tools; `find_action` / `do_action` reach every other
Vikunja action your token allows. The native tools are Vikunja's own and are
**not owner-scoped**. They need an API token with the `mcp.access` permission
(`scripts/setup.sh` creates one). Without it, or on Vikunja older than 2.7, they
simply don't appear. Switch off with `ENABLE_VIKUNJA_MCP=false`.

**CalDAV: the gateway is the front door for it too.** Point calendar apps, phones
and Home Assistant at `http://<host>:8090/dav/` (or just `http://<host>:8090`; the
gateway answers `/.well-known/caldav` and a root `PROPFIND` with a redirect to
`/dav/`). The gateway forwards CalDAV to Vikunja unchanged, so Vikunja is still
the CalDAV server (tasks only, one calendar per project) and still does the login:
clients use their **Vikunja username and password, or a Vikunja CalDAV token**
(Settings -> CalDAV; better than your account password for phones and Home
Assistant). The gateway's `GATEWAY_TOKEN` is for MCP/REST and does not apply to
CalDAV (clients use Basic auth). Only `/dav` is forwarded; Vikunja's REST API and
web UI are not exposed through the gateway. Turn it off with
`ENABLE_CALDAV_PROXY=false`. Put TLS in front (a reverse proxy) for anything beyond
your LAN: Basic auth is only as private as the connection.

**`dayglance-mcp`** exposes dayGLANCE's full native tool set to the gateway:

```
dayglance_ping · dayglance_get_today · dayglance_get_day
dayglance_list_unscheduled_tasks (inbox) · dayglance_list_users
dayglance_get_goal_progress
dayglance_create_task · dayglance_update_task · dayglance_schedule_task
dayglance_move_block · dayglance_resize_block · dayglance_set_task_completion
```

**REST:** `/api/allglance/` mirrors the MCP tools for non-MCP clients.

```
GET  /api/allglance/users                     → family roster
GET  /api/allglance/tasks?owner=<id>          → tasks across sources
GET  /api/allglance/days/:date?owner=<id>     → blocks + tasks for a date
POST /api/allglance/tasks                     → create (vikunja)
PATCH /api/allglance/tasks/:source/:id        → update {done, priority, title, due_date} (vikunja)
GET  /api/allglance/chores?owner=<id>         → lastGLANCE chores
GET  /api/allglance/milestones                → lifeGLANCE milestones
GET  /api/allglance/vikunja/tasks             → vikunja tasks
GET  /api/allglance/vikunja/projects          → vikunja projects
PATCH /api/allglance/vikunja/tasks/:id        → update a vikunja task
GET  /health                                  → per-adapter health + roster
```

**Priority.** Every task carries `priority` (0 none, 1 low, 2 medium, 3 high,
4 urgent, 5 do now; vikunja's scale) and `priority_label`. dayGLANCE's 0-3
means the same for 0-3 (only inbox tasks have one). Apps that speak CalDAV use
RFC 5545's PRIORITY (1 highest, 9 lowest); vikunja maps it as low 9,
medium 5, high 3, urgent 2, do now 1, and `src/model.js` has the same mapping.

**Access.** Set `GATEWAY_TOKEN` and every `/api/allglance/*` and `/mcp` call
needs `Authorization: Bearer <token>` (`/health` stays open). Without it the
gateway is open to anyone who can reach its port, and it says so on start.

The "calendar" view **is** `/api/allglance/days/:date` — dayGLANCE's time blocks
plus vikunja's tasks for that date come back together.

## Per-person scoping

dayGLANCE owns the family identity: its `users[]` + `meUserSyncId` is the source
of truth for "who is who." The gateway exposes that as `allglance_list_users`,
and every task tool takes an optional `owner_id` to scope a call to one person
("Dad's view") or leave it off for the shared family view.

Ownership survives where the transport carries it: vikunja tags tasks with
`assigned_users`, dayGLANCE's local state carries `assignedUserSyncIds`, and the
browser-sync envelopes carry owner fields. One honest limit: dayGLANCE's **MCP**
read blocks do not carry the assignee, so per-user filtering *over MCP* returns
the full family day — ownership filtering is a property of the sources that
expose it, not something the gateway can invent.

## Running it

### Prerequisites

- Docker + Compose (Unraid appdata container, or any Docker host).
- Node ≥ 20 and pnpm if you run the gateway or `dayglance-mcp` from source.

### Docker (recommended): one command

```bash
git clone https://github.com/Wizard815/ALLGlance && cd ALLGlance
scripts/setup.sh
```

`setup.sh` is safe to re-run. It generates every secret into `.env.allglance`
(mode 600, gitignored), asks you for **one** thing (your household sync
passphrase), creates the data folders with the right owner, starts Vikunja,
creates its user and an API token that includes MCP access, builds and starts
everything, waits for the gateway, and prints: the MCP URL + token for your
agent, the sync settings to type into each GLANCE app, and the Vikunja login.

What remains manual is inherent to the apps (their settings live in the browser):
once per device, enter the printed WebDAV settings and your passphrase in
dayGLANCE / lastGLANCE / lifeGLANCE (see
[Connecting the GLANCE apps](#connecting-the-glance-apps-one-time-per-device)).

Doing it by hand instead:

```bash
cp gateway/.env.example .env.allglance      # fill in the secrets and tokens
docker compose --env-file .env.allglance up -d --build
curl http://localhost:8090/health
```

The gateway reaches the apps by service name on the compose network
(`DAYGLANCE_MCP_HOST=dayglance-mcp`), set in `docker-compose.yml`.

**Building behind a TLS-intercepting proxy** (corporate proxy, CI sandbox): image
builds fail verifying npm's certificate unless they trust the proxy's CA. Put the
CA bundle at `docker/proxy-ca.crt` (gitignored) and set
`COMPOSE_FILE=docker-compose.yml:docker/compose.proxy-ca.yml` before running
`scripts/setup.sh` (or any `docker compose` command).

The gateway image no longer bundles Chromium by default (the legacy browser
reader is opt-in: `--build-arg INSTALL_BROWSER=true`).

### From source

```bash
cd gateway
corepack enable && pnpm install
pnpm start                        # node src/server.js → :8090

cd ../gateway/container-mcp       # the dayGLANCE MCP service
npm install
DAYGLANCE_MCP_TOKEN=secret DAYGLANCE_STATE_FILE=/data/dayglance-state.json node index.mjs
```

## Where the data comes from (and the honest gaps)

| App | Gateway reads it via | Notes |
|---|---|---|
| vikunja | REST `/api/v2/` | Real server + DB. Works today. |
| dayGLANCE | `dayglance-mcp` (MCP) | Container port of dayGLANCE's model. |
| lastGLANCE | intents / localStorage adapter | Chore data natively flows as encrypted intents. |
| lifeGLANCE | localStorage adapter | Milestones, no ownership model. |

- **lastGLANCE / lifeGLANCE** are read from the snapshots they sync to the shared
  WebDAV directory (see [Connecting the GLANCE apps](#connecting-the-glance-apps-one-time-per-device)).
  The older browser-reader fallback (used only when `GLANCE_SYNC_DIR` is unset)
  cannot work: lastGLANCE stores data in IndexedDB, not localStorage.
- **`dayglance-mcp` state (automatic):** the stack runs `dayglance-sync`, a
  WebDAV server for dayGLANCE's built-in Cloud Sync. dayGLANCE syncs its whole
  planner to `dayglance-sync.json` there, and `dayglance-mcp` reads *and writes*
  that same file. So the gateway sees live app data, and tasks created or
  changed through MCP flow back into the app on its next sync. See
  [Connecting the GLANCE apps](#connecting-the-glance-apps-one-time-per-device).
  If `DAYGLANCE_SYNC_FILE` is unset, the MCP falls back to a standalone JSON
  state document that starts empty (a read returns an empty day, never a
  fabricated one).
- **Writes:** the gateway writes through each app's own transport (vikunja REST,
  dayGLANCE MCP -> the sync file -> the app). It does not write into the browser
  apps' localStorage.
- **GLANCEvault** is optional for the gateway; enable it only for multi-device
  sync + cross-app intents.

## Connecting the GLANCE apps (one time per device)

All three apps sync through the same engine, so they all point at the **same
WebDAV server** (`dayglance-sync`) with the **same sync passphrase**:

| Field | Value |
|---|---|
| Provider | Generic WebDAV |
| URL | `http://<host>:8091` (web builds inside this stack: `http://dayglance-sync:6065`) |
| Username / password | `DAYGLANCE_SYNC_USER` / `DAYGLANCE_SYNC_PASSWORD` from `.env.allglance` |
| Encryption | on, with your sync passphrase — also set it as `GLANCE_SYNC_PASSPHRASE` in `.env.allglance` |
| Sync folder | dayGLANCE: `dayglance` (must match `DAYGLANCE_SYNC_FOLDER`); lastGLANCE / lifeGLANCE: leave their defaults (`GLANCE/lastglance`, `GLANCE/lifeglance`) — the gateway finds the files wherever they are |

Where: dayGLANCE **Settings -> Sync**; lastGLANCE **Cloud Sync**; lifeGLANCE
**sync**. A new device's first sync may ask how to combine local and server data
("Merge both" is the safe choice).

**The key.** Yes: one passphrase is the shared key. Each app derives its key
from the passphrase plus a salt stored in the file (PBKDF2-SHA256, AES-256-GCM),
so the MCP and gateway, given the same passphrase, read every app's encrypted
snapshot, and the MCP can write dayGLANCE's back (re-encrypting with the file's
existing salt, so the apps never ask for the passphrase again). Without the
passphrase an encrypted file is reported, never overwritten.

**What flows where (all automatic once connected)**

| App | Into the gateway | Back to the app |
|---|---|---|
| dayGLANCE | live tasks/blocks via `dayglance-mcp` | tasks created/changed through MCP appear on its next sync |
| lastGLANCE | chores, last completion, cadence, overdue (from `lastglance-sync.json`) | read-only |
| lifeGLANCE | milestones (from `lifeglance-sync.json`) | read-only |

lastGLANCE and lifeGLANCE keep their data in browser IndexedDB, which nothing
server-side can read; their Cloud Sync snapshot is the readable copy. They push
on app open, on manual **Sync now**, and on their sync interval, so a change
can take up to one interval to appear (dayGLANCE pushes sooner).

Verified end to end with the real apps: a dayGLANCE task reached the MCP; tasks
created, scheduled and completed through MCP reached the app, including with
encryption on; a lifeGLANCE milestone and lastGLANCE chore completions made in
their UIs appeared in the gateway's `/milestones` and `/chores`.

**App-to-app handoff: lastGLANCE chore -> dayGLANCE task (verified).** This uses
the apps' own "intents" integration over the same WebDAV server; it is a second,
separate setting from Cloud Sync in each app:

| In | Setting | Value |
|---|---|---|
| lastGLANCE | Settings -> Integration (the plug) | WebDAV URL `http://<host>:8091` (or `http://dayglance-sync:6065` for the web build), the same user/password, folder `GLANCE/events`, enabled |
| dayGLANCE | Settings -> Integrations (intents) | the same URL, user/password, events path `/GLANCE/events/` |

Then a chore that is overdue (and has a cadence and some history) shows a "send
to dayGLANCE" button, and can also auto-send once per day. Tested with the real
apps: pressing it wrote an event file into `GLANCE/events/`; dayGLANCE polled it
(every 2 minutes in the foreground, 15 in the background) and created the task
(due today, all day), which then synced into the planner file and appeared in
the gateway's `/tasks` and `/days/:date` and through the MCP. Verified with
intents both **unencrypted and encrypted** (same passphrase; the first app to
enable it creates `intents-encryption-salt.json` in the events folder and the
other derives its key from it; the chore title is not readable on the server).
The **return path** also works: ticking the task in dayGLANCE logs the chore as
done in lastGLANCE. That needed a workaround: dayGLANCE 5.11 names completion
events `<uuid>.json`, which the shared intents library (and so lastGLANCE)
ignores, so `dayglance-mcp` renames such files in the events folder to the
timestamped form (`DAYGLANCE_EVENTS_ROOT`, see `eventNormalizer.mjs`). Remove it
once upstream fixes `useNotifyEmitter.js`.

## Using the data from other tools

Verified against a live Vikunja v2.7.1:

- **CalDAV (tasks):** the gateway serves Vikunja's tasks as VTODO at
  `http://<host>:8090/dav/` (Basic auth with your Vikunja user; Vikunja itself is
  also at `:3457/dav/`). A task created through the gateway
  appears there as a VTODO with its due date, so any CalDAV tasks client
  (Tasks.org, Apple Reminders, Thunderbird, Home Assistant's CalDAV
  integration) can read and edit it.
- **Home Assistant:** either its CalDAV integration pointed at Vikunja, or REST
  calls to the gateway (`/api/allglance/tasks`, `/days/:date`), or the MCP
  endpoint `/mcp`.
- **Export:** `vikunja dump` (CLI, whole instance) and the v2
  `/user/export/request` endpoint; CSV and other import via `/migration/*`.
- dayGLANCE tasks are not in CalDAV by themselves; they reach the gateway through
  `dayglance-mcp`.

### Home Assistant (verified)

Home Assistant's built-in **CalDAV** integration, pointed at the gateway,
`http://<host>:8090/dav/`, with the Vikunja login, creates one to-do list per
Vikunja project. Tested with a real Home Assistant: it lists the tasks; an item
added or completed in Home Assistant appears in the gateway; a task created
through the agent appears in Home Assistant (verified through the gateway's `/dav`) (after its next poll). Priorities are
not shown in Home Assistant's to-do UI.

## Unraid / appdata layout

```
/mnt/user/appdata/allglance-data/      # ALLGLANCE_DATA; kept outside the git checkout
├── vikunja/{db,files,logs}
├── gateway         # roster cache
├── dayglance-sync  # dayglance/dayglance-sync.json (owned 99:100)
├── dayglance-mcp   # dayglance-state.json fallback (owned 99:100)
└── glance-vault    # glancevault.db (owned 99:100)
```

The `dayglance`, `lastglance`, and `lifeglance` web builds keep their data in the
browser; they need no host mounts.

## Repo layout

```
AllGLANCE/
├── apps/                 # the GLANCE apps (git submodules, their own upstreams)
│   ├── dayglance/  ├── lastglance/  └── lifeglance/
├── services/vikunja/     # vikunja source (git submodule)
├── gateway/              # the AllGLANCE gateway (MCP + REST) — our code
│   ├── src/              #   model, roster, adapters, mcp server, entry
│   ├── container-mcp/    #   container port of dayGLANCE's MCP — our code
│   ├── DESIGN.md         #   design document
│   └── Dockerfile
├── docker-compose.yml    # the whole stack (7 services)
└── gateway/.env.example  # copy to .env.allglance
```

The apps and vikunja are submodules pointing at their own upstreams (no forks
needed). They are pinned to release tags and are **reference source only**: the
stack runs the matching prebuilt ghcr images, pinned in `docker-compose.yml`.
Clone with `git clone --recurse-submodules` (or `git submodule update --init`)
if you want the sources, e.g. to re-run the vendoring script. To upgrade: move
the submodule to the new tag, bump the matching image tag, and (dayglance only)
re-run `node gateway/container-mcp/scripts/vendor-model.mjs`. AllGLANCE's own
work lives under `gateway/`.

## Upkeep

Nothing is forked, so upkeep is: move the pins, re-vendor, re-test.

```bash
scripts/upstream.sh status        # pinned vs latest release, and drift between pin / compose / .env.example
scripts/upstream.sh bump vikunja  # or dayglance | lastglance | lifeglance  [vX.Y.Z]
scripts/upstream.sh verify        # CI runs this: pin = compose tag = .env.example
```

`bump` checks the ghcr image exists, moves the submodule to the tag, updates the
compose default and `.env.example`, re-vendors the dayGLANCE model when that is
the component, and runs both test suites. A weekly workflow
(`upstream-watch.yml`) keeps one open issue listing whatever is behind.

After a bump, before merging, run the live checks for that component:
- **vikunja**: create and read back a task through the gateway; `/health` shows vikunja ok.
- **dayglance**: let the app sync, then read the day through the MCP, write through
  the MCP, and confirm it reaches the app (the sync snapshot format is upstream-internal).
- **lastglance / lifeglance**: sync the app, then check `/chores` or `/milestones`.

Reference: the gateway uses Vikunja's v2 API (OpenAPI-based, `/api/v2`), which
needs Vikunja **2.4+**; its built-in MCP server (`/api/v2/mcp`) needs **2.7+**
(optional: the gateway works without it); `/api/v1` remains upstream. Tested here
on 2.7.1 and 2.8.0. Pins are deliberately exact.

## What's deferred (honest)

- `gateway/container-mcp/model/` is **vendored** from
  `apps/dayglance/src/utils` + `agenda-core`; re-sync it with
  `node gateway/container-mcp/scripts/vendor-model.mjs` after a dayglance update.
- The namespaced MCP tools sketched in `gateway/DESIGN.md` §6 (`calendar_*`,
  `goals_*`, `habits_*`, `get_week`, `move_block`, …) are **not** all
  implemented; the shipped set is the `allglance_*` / `vikunja_*` tools above
  plus dayGLANCE's native tools behind `dayglance-mcp`.
- dayGLANCE MCP hydration from GLANCEvault needs the sync passphrase (a vault
  provider hook is reserved in `container-mcp/state.mjs`).
