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
| `glance-vault` | `8088` | Optional zero-knowledge sync backend for the browser apps |
| `dayglance` | `6767` | dayGLANCE web build |
| `lastglance` | `3000` | lastGLANCE web build (chores) |
| `lifeglance` | `6868` | lifeGLANCE web build (milestones) |

## The one MCP / REST surface

**MCP:** `POST /mcp` (Streamable HTTP) — initialize, then `tools/list` / `tools/call`.

| Tool | Purpose | Source |
|---|---|---|
| `allglance_list_users` | The family roster (who is who) | dayGLANCE + vikunja |
| `allglance_list_tasks` | Tasks across all sources (optional `owner_id`) | vikunja + dayGLANCE |
| `allglance_list_days` | Time blocks + tasks for one date (optional `owner_id`) | dayGLANCE + vikunja |
| `allglance_create_task` | Create a task (defaults to vikunja) | vikunja |
| `vikunja_list_tasks` | List vikunja tasks in open projects (optional `owner_id`) | vikunja |
| `vikunja_create_task` | Create a vikunja task (needs `project_id`) | vikunja |

Each adapter registers its own tools, so adding an app = adding an adapter.

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
GET  /api/allglance/chores?owner=<id>         → lastGLANCE chores
GET  /api/allglance/milestones                → lifeGLANCE milestones
GET  /api/allglance/vikunja/tasks             → vikunja tasks
GET  /api/allglance/vikunja/projects          → vikunja projects
GET  /health                                  → per-adapter health + roster
```

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

### Docker (recommended)

```bash
# 1. Configure it.
cp gateway/.env.example .env.allglance
#    Edit .env.allglance: at minimum set VIKUNJA_TOKEN and DAYGLANCE_MCP_TOKEN.
#    (The gateway and the dayglance-mcp service must share the same
#     DAYGLANCE_MCP_TOKEN.)

# 2. Build + run the stack on one internal network.
docker compose up --build

# 3. Check it.
curl http://localhost:8090/health
curl http://localhost:8090/api/allglance/users
```

The gateway reaches dayglance over MCP by service name
(`DAYGLANCE_MCP_HOST=dayglance-mcp`), set in `docker-compose.yml`.

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

- **`dayglance-mcp` state:** it serves a JSON state document on a mounted volume
  (`/data/dayglance-state.json`). To populate it with real data you either seed
  the file, let dayGLANCE sync to vikunja over CalDAV (the gateway then reads
  vikunja), or hydrate it from GLANCEvault once you have the sync passphrase. It
  starts empty by design — a read returns an empty day, never a fabricated one.
- **Writes:** the gateway writes through each app's own transport (vikunja REST,
  dayGLANCE MCP). It does not write into the browser apps' localStorage.
- **GLANCEvault** is optional for the gateway; enable it only for multi-device
  sync + cross-app intents.

## Unraid / appdata layout

```
/mnt/user/appdata/allglance/
├── vikunja/{config,db,files,logs}
├── gateway         # .env, roster cache
├── dayglance-mcp   # dayglance-state.json (owned 99:100)
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

The apps and vikunja are submodules pointing at their own upstreams — keep them
on `main`. AllGLANCE's own work lives under `gateway/`.

## What's deferred (honest)

- `gateway/container-mcp/model/` is **vendored** from
  `apps/dayglance/src/utils` + the workspace packages it imports; re-sync it with
  `node gateway/container-mcp/scripts/vendor-model.mjs` after a dayglance update.
- The namespaced MCP tools sketched in `gateway/DESIGN.md` §6 (`calendar_*`,
  `goals_*`, `habits_*`, `get_week`, `move_block`, …) are **not** all
  implemented; the shipped set is the `allglance_*` / `vikunja_*` tools above
  plus dayGLANCE's native tools behind `dayglance-mcp`.
- dayGLANCE MCP hydration from GLANCEvault needs the sync passphrase (a vault
  provider hook is reserved in `container-mcp/state.mjs`).
