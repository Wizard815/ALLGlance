# AllGLANCE Gateway — Design Document

> One MCP server + one REST gateway that exposes **task, calendar, chore, and milestone**
> data across all four GLANCE apps (vikunja, dayGLANCE, lastGLANCE, lifeGLANCE), with
> **per-user ownership** so a family can attribute "who's who" — modeled on vikunja's
> built-in MCP (`pkg/modules/mcp/`).

**Status:** implemented. `gateway/DESIGN.md` is the design; the implementation lives in `gateway/src/` (see `gateway/DESIGN.md` §9 for the current build order vs. what exists). Run it with `docker compose up` (top-level `docker-compose.yml`) — the Dockerfile is `gateway/Dockerfile`.

---

## 1. What we're building and why

The four apps each live in their own silo with their own data format and its own idea of
"who did this." The gateway is the **single front door**:

- A **MCP server** (MCP protocol) that any MCP client (Claude, editors, HA) can connect to.
- A **REST gateway** (`/api/allglance/...`) for clients that don't use MCP.
- A **calendar + task model** that unifies vikunja tasks, dayGLANCE time blocks,
  lastGLANCE chores, and lifeGLANCE milestones.
- A **per-user ownership layer** so the same tool call can be scoped to "my view" or
  "Dad's view" — the family-calendar requirement.

The reference implementation is **vikunja's native MCP server**: it's always-on, auto-
generates tools from its own OpenAPI, and is token-scoped. We reuse that pattern rather
than inventing a new protocol.

---

## 2. The hard constraint (read this first)

**Only vikunja has a server. The other three apps are localStorage SPAs.**

| App | Where the data lives | Server surface | MCP |
|---|---|---|---|
| **vikunja** | Postgres/SQLite | ✅ REST `/api/v2/`, CalDAV, WebDAV | ✅ Native, always-on at `/api/v2/mcp` |
| **dayGLANCE** | Browser `localStorage` | ⚠️ Electron-IPC only (loopback `:7893`) | ⚠️ Electron build only |
| **lastGLANCE** | Browser `localStorage` | ⚠️ WebDAV proxy only | ❌ none |
| **lifeGLANCE** | Browser `localStorage` | ⚠️ WebDAV proxy only | ❌ none |

**Consequence:** A Node server cannot read `localStorage` directly. The gateway's adapters
for dayGLANCE / lastGLANCE / lifeGLANCE must obtain data one of two ways:

- **(A) Connect to what already has a surface** — vikunja's REST/MCP (authoritative,
  server-side), or dayGLANCE's Electron MCP over IPC (`:7893`).
- **(B) Read the client-side store** — an embedded headless browser (Playwright) that
  launches the app, reads `localStorage`, and drives the DOM. Works from the Docker web
  build but is heavier and more fragile.

The design supports **both** and picks per-app based on what's actually available. This is
not a limitation we can paper over — it's the architectural spine.

---

## 3. Identity layer — the "who's who" model

Each app tracks ownership differently. The gateway introduces a **normalized identity**
that maps every app's native ownership fields onto one concept: an `owner_id` with a
human `name`.

| App | Native ownership fields | → Gateway maps to |
|---|---|---|
| vikunja | `user.id`, `assigned_users` (task→users) | `owner_id` from vikunja user roster |
| dayGLANCE | `users[]` ({syncId, name}), `meUserSyncId`, `assignedUserSyncIds` on tasks | `owner_id = syncId`; roster from `users[]` |
| lastGLANCE | `assigned_user_sync_ids`, `completed_by_user_id` on chore envelopes | `owner_id` from the envelope field |
| lifeGLANCE | *(none — single-user)* | `owner_id = null` (shared/family) |

**Why this matters for the family calendar:**
- dayGLANCE's multi-user state (`users[]`, `meUserSyncId`) is the **authoritative roster** —
  that's where you add family members and pick "this is me" (`App.jsx` line ~1131).
- lastGLANCE's **intents transport preserves ownership** across the trip
  (`assigned_user_sync_ids`, `completed_by_user_id` in `emitter.ts` / `processNotifyEnvelope.ts`).
  So chores synced from lastGLANCE to dayGLANCE *carry their owner* — the gateway can attribute them.
- lifeGLANCE has **no ownership model**; its milestones are a shared timeline. They surface with `owner_id = null`.

The gateway exposes `list_users()` (the family roster) and every task/calendar tool accepts
an optional `owner_id`. Scope it to get one person's view; omit it for the family/shared view.

---

## 4. Data-plane adapters

Each adapter is a self-contained module that speaks one app's native surface and returns a
**canonical record** the unification layer understands. Canonical shapes:

```
Task  = { source, id, title, owner_id, due_date, completed, project_id, all_day, start_time, duration }
Day   = { date, blocks: [Task...], owner_id? }
Milestone = { source, id, title, date, owner_id?, pins }
```

### 4.1 VikunjaAdapter — the server-side hub (first, most complete)
- **Reads:** tasks, projects, calendars via REST `/api/v2/` **and** vikunja's native MCP
  (`/api/v2/mcp`) which auto-generates tools like `tasks_create`, `tasks_read_all`, etc.
- **Writes:** create/complete/move tasks through REST (server-side, always-on).
- **Owner mapping:** vikunja task → `assigned_users` → `owner_id`.
- **Why first:** it's the only adapter with a real server and a real MCP. It's the backbone.

### 4.2 DayglanceAdapter
- **Primary path (desktop):** connect to dayGLANCE's MCP on loopback `:7893`
  (`electron/mcpPort.ts: DEFAULT_MCP_PORT = 7893`) over MCP protocol. Gives access to
  time blocks, unscheduled inbox, habits, goals, routines — exactly the read/write models
  in `src/utils/mcpReadModel.js`, `src/utils/mcpRoutines.js`.
- **Fallback path (Docker web):** Playwright reader that launches the app, reads
  `localStorage` (`dayglance-multi-user-config`, task blobs), and maps
  `users[]` + `meUserSyncId` to the identity layer. Ownership roster comes from here —
  **dayGLANCE is the single source of truth for "who is who."**

### 4.3 LastglanceAdapter
- **Primary path (intents):** read the lastGLANCE **intents outbox/transport**
  (`src/intents/outbox.ts`, `dbTransport.ts`, `emitter.ts`). Chore envelopes carry
  `assigned_user_sync_ids` + `completed_by_user_id`, so ownership survives.
- **Fallback path:** Playwright reader over `localStorage`.

### 4.4 LifeglanceAdapter
- Milestones from `localStorage` (`PINS_KEY`) via Playwright reader. `owner_id = null`
  (shared/family view).

---

## 5. Unification layer

Merges adapter outputs into one task/calendar model:

- **Task calendar:** union of vikunja tasks + dayGLANCE time blocks. Dedupe by
  `source + id`. A task synced dayGLANCE→vikunja via CalDAV appears in both; the layer
  collapses the pair (dayGLANCE-side task owns the ownership; vikunja-side owns the server copy).
- **Calendar:** dayGLANCE timeline (time blocks) + vikunja calendars.
- **Ownership:** every canonical record carries `owner_id`; `list_users()` builds the
  family roster from dayGLANCE `users[]` (primary) + vikunja users (secondary).
- **Integrity rule:** never let the gateway write `localStorage` directly. Writes go
  through the app's own transport (MCP IPC, CalDAV, or the intents transport), which then
  persists — mirroring dayGLANCE's own rule that mutations commit by React, not by raw storage.

---

## 6. MCP server (the front door, modeled on vikunja)

One MCP server exposing **tools** across all apps (grouped below by domain; namespaced
`allglance_*` / `vikunja_*` prefixes in the shipped code). Every tool takes an **optional
`owner_id`** (per-user scoping). Tools return canonical records. Like vikunja, the server
auto-exposes what each adapter supports, so adding a new app = adding an adapter = the tool
appears.

| Group | Tools (shipped) | Source |
|---|---|---|
| `allglance_*` | `list_tasks`, `list_days`, `list_users`, `create_task` | dayGLANCE blocks + vikunja |
| `vikunja_*` | `list_tasks(owner?)`, `create_task(project_id, due?)` | vikunja (server-side) |

The documented §6 "ideal" namespaced tools (`calendar_*`, `goals_*`, `habits_*`,
`chores_*`, `milestones_*`, `get_task`, `get_week`, `move_block`, `get_recency`, `get_milestone`,
`list_family`) are **not yet implemented** — see §10. The REST gateway (`§7`) covers the
chore and milestone data, just without the MCP tool wrappers.

---

## 7. REST gateway

`/api/allglance/` mirrors the MCP tools for non-MCP clients:

```
GET    /api/allglance/users                       → family roster
GET    /api/allglance/tasks?owner=...             → tasks across sources
GET    /api/allglance/days/:date?owner=...        → day's tasks + time blocks (owner? optional)
POST   /api/allglance/tasks                       → create (vikunja)
GET    /api/allglance/chores?owner=...            → lastGLANCE chores
GET    /api/allglance/milestones                  → lifeGLANCE milestones
GET    /health                                    → per-adapter health + roster
```

The "calendar" view **is** `/days/:date` — dayGLANCE's time blocks plus vikunja's
tasks for that date are returned together there. vikunja has no separate calendar
surface the gateway can read (no `/api/v2/calendars` method today), so there is no
standalone `/api/allglance/calendars`; a full calendar UI is built from the
per-day blocks endpoint. This may change if vikunja exposes its calendars to the
gateway.

---

## 8. Transport / deployment (Unraid appdata)

- Gateway runs as its own Node service (`gateway/`) — Express server + MCP server.
- `docker/` orchestrates: gateway + vikunja + dayglance + lastglance + lifeglance together.
  Unraid container maps `/appdata/allglance-gateway` (config, roster cache, MCP config)
  and the four app configs beside it.
- Config via `.env`-style file: which adapters to enable, vikunja URL+token,
  dayGLANCE desktop MCP port (`7893`) or Docker web URL, Playwright timeouts.

---

## 9. Build order

1. **VikunjaAdapter + MCP tools** (server-side hub, least-risk, most complete). ✅ real data, real API.
2. **Identity layer + `list_users()`** — roster from dayGLANCE (desktop MCP) first, vikunja second.
3. **DayglanceAdapter** (desktop MCP path, then Playwright fallback).
4. **LastglanceAdapter** (intents path, then Playwright).
5. **LifeglanceAdapter** (Playwright).
6. **REST gateway** on top of the MCP server — `/users`, `/tasks` (GET+POST),
   `/days/:date`, **`/chores`**, **`/milestones`**, `/health`. ✅ all wired,
   documented in §7, covered by tests.
7. **docker/ orchestration** + top-level README. ✅ compose + Dockerfile present;
   `.env.example` provided at `gateway/.env.example` (README says copy it to
   `.env.allglance`).

## 10. What's deferred (and why)

- **Writing to dayGLANCE/lastGLANCE/lifeGLANCE `localStorage`:** not supported directly —
  the gateway only writes through each app's own transport (see §5 integrity rule).
- **Vikunja→dayGLANCE ownership round-trip:** CalDAV strips ownership on export, so the
  gateway reads ownership from dayGLANCE's client state, never from vikunja's copy.
- **Namespaced MCP tool wrappers** (`calendar_*`, `goals_*`, `habits_*`, `chores_*`,
  `milestones_*`, `get_task`, `get_week`, `move_block`, `get_recency`, `get_milestone`,
  `list_family` — listed as the design's §6 ideal): only the flat `allglance_*` /
  `vikunja_*` tools are implemented. The data behind many of these *is* reachable now via
  the REST gateway (`/chores`, `/milestones`, `/days/:date`); the MCP wrappers are the
  remaining work.
- **vikunja MCP read path:** `VikunjaAdapter` currently talks vikunja's REST `/api/v2/`
  only. Its native MCP (`/api/v2/mcp`) is referenced in §4.1 as a source of
  `tasks_create` / `tasks_read_all` but is not yet wired through the gateway.
- **vikunja `calendar` surface:** the gateway has no vikunja calendar endpoint (see the
  note under §7). If vikunja exposes calendars to the gateway, a `/api/allglance/calendars`
  route and `calendar_*` MCP tools can be added.
