# GLANCE × Gateway × Mealie — Audit + Architecture Report

_Grounded in the actual source at `apps/dayglance`, `apps/lastglance`, `services/vikunja`, `gateway/src`, plus the public Mealie docs (mealie.io/documentation/getting-started/api-usage/) as of Oct 4 2026._

---

## 1. The big reframe: there is no "all apps talk to one gateway" wiring yet

- **No gateway code exists inside the apps.** I grepped `apps/` — every `allglance`/`gateway` hit was a false positive (a `"bad gateway"` test string). The apps already expose integration surfaces; **the gateway is the consumer**, so all remaining work is gateway-side (plus small app config flags).
- Each app speaks a *different* language to its consumers. The gateway is where they should be unified. That is the real job.

---

## 2. dayGLANCE — has a real MCP server; the old client was broken

`apps/dayglance/electron/` ships a **real Streamable-HTTP MCP server** on loopback `:7893`, bearer-token gated (`mcpAuth.ts`: CSPRNG 32-byte token → `~/.config/dayglance/mcp.json` discovery file).

Real tools:
- `dayglance_ping` — health (no data)
- `dayglance_get_today` / `dayglance_get_day{date}` → `{ blocks, frames }`
- `dayglance_list_unscheduled_tasks` → paginated inbox
- `dayglance_list_users` (multi-user only) → `{ users: [{ id, name }] }`
- `dayglance_get_goal_progress{goal_id, window}` → goal/project progress
- Writes: `create_task` / `update_task` / `schedule_task` / `move_block` / `resize_block` / `set_task_completion`

**The old gateway client (`DayglanceMcpClient`) called `dayglance_roster`, `dayglance_list_tasks`, `dayglance_list_blocks` — NONE of these exist.** Every MCP read got a silent `401` (no auth) *and* a "tool not found". Fix written: `DayglanceMcpClient.js` now calls the real tools, sends the bearer token, reads token from `DAYGLANCE_MCP_TOKEN` env (or discovery file), and returns the shape the adapter normalizes. `config.js` + `server.js` updated. **Verified with `node --check`.**

### Ownership / per-user limitation (important for your "admin vs user" ask)
- Read `blocks`/inbox do **not** carry the assignee. Only `dayglance_list_users` returns `{id,name}`.
- Therefore **per-user data scoping over MCP is not possible** — MCP reads always return the full family day. Owner scoping still works on the localStorage/desktop fallback (which *does* carry `assignedUserSyncIds`).
- The MCP token is a **bearer token — dayGLANCE has no admin/user role model**. A connected client gets the whole family day. There is no "admin calls for any user, user only for self" on the dayGLANCE side; that concept would have to be invented in the gateway and enforced there, not by dayGLANCE.

---

## 3. lastGLANCE — chore data is NOT where the adapter looks (and it's encrypted)

- `LastglanceAdapter` currently scrapes `lg-chores` / `lastglance-chores` localStorage keys.
- **The real chore data flows through `@glance-apps/intents` → encrypted WebDAV outbox → "GLANCEvault".** Envelopes are E2E encrypted: a root key derived as `deriveIntentsRootKey(passphrase, salt)`, where the salt comes from either a WebDAV file (`intents-encryption-salt.json`) or the GLANCEvault `/salt/:accountId` endpoint. The derived `CryptoKey` is cached in the app's IndexedDB.
- **Blocker:** you do not have the passphrase/salt, and the key is a browser-IndexedDB `CryptoKey`, not a file you can drop into `.env`. The passphrase *can* live in `.env.allglance`, but the gateway would then need `deriveIntentsRootKey` vendored in (from `@glance-apps/intents`), a GLANCEvault/WebDAV target, the account id, and the salt. None of that exists in the repo. **lastglance = blocked until you provide a GLANCEvault target + passphrase.**

---

## 4. lifeGLANCE — pure localStorage, no MCP, no intents

- No `electron/mcp*`, no `@glance-apps/intents`, no MCP server. Its only surface is `lifeglance-pins` / `milestones` localStorage keys.
- **There is nothing for the gateway to consume over MCP** — the current localStorage adapter is actually the real surface. To give lifeGLANCE an MCP, you'd be *building a new server in the app* (substantial). For now it stays a read adapter.

---

## 5. vikunja — REST + native MCP, and it's compatible

- `VikunjaAdapter` already talks REST (`/api/v2/projects`, `/api/v2/tasks`, `/api/v2/authors/me`) and works.
- vikunja ships a **native MCP at `/api/v2/mcp`** (`services/vikunja/pkg/modules/mcp/`) — tasks, projects, users, calendars, CalDAV. Your adapter deliberately uses REST so ownership scoping stays in the gateway's hands. That's a sound choice. **No vault dependency** — vikunja needs only URL + API token.

---

## 6. Direct answers to your questions

**Q: Is the dayGLANCE token shared with lastGLANCE/lifeGLANCE/vikunja, or just for connecting to MCP?**
**A: It is only for connecting to dayGLANCE's own MCP.** dayGLANCE generates and validates its own token. There is **no shared token across apps** — each app validates its own credential (vikunja uses a bearer API token; dayGLANCE uses its MCP token). Any "one token to rule them all" is a *gateway-side* concept you'd build yourself (see below).

**Q: What other tool calls need to be exposed? (dayglance_roster/list_tasks/list_blocks)**
**A: Those three do not exist** — that's why the old client failed. The real equivalents are the read tools above. I built the client around them. The closest analogues to what you're picturing:
- "list all tasks" → `dayglance_list_unscheduled_tasks` (inbox) + `dayglance_get_day` (scheduled). There is no single "everything" call.
- "roster" → `dayglance_list_users`.

**Q: I need user scoping — admin can call for any user, user only for self.**
**A: Not available in dayGLANCE's MCP.** Its token is bearer-only; reads return the full family day with no assignee field. Two realistic options in the gateway:
1. **Roster-based filtering** — the gateway already maintains a normalized roster; it can tag which family member a task belongs to (from the localStorage/desktop path that *does* carry ownership) and present scoping there.
2. **A gateway-side token-per-family-member** layer — the gateway issues its own tokens and enforces role rules itself, sitting in front of dayGLANCE. That's a new gateway subsystem, not something dayGLANCE does.

**Q: lifeGLANCE — I want MCP to add/move dates and list events.**
**A: lifeGLANCE has no MCP server.** To add/move/list dates over MCP you must build one in the app. That's a multi-week feature (electron/mcp surface + renderer bridge + auth, modeled on dayGLANCE's). Not a one-shot.

**Q: vikunja — just make the MCP compatible with "the vault" and do all its calls with glance.**
**A: vikunja has NO vault dependency.** It already works via REST/MCP + an API token. I'll leave its adapter as-is and just make sure the unified gateway view includes its tasks/projects/calendar correctly (it already does).

**Q: WebDAV between all of them + 2 internal auth + 1 external.**
**A: WebDAV only exists for lastGLANCE's intents transport** (to GLANCEvault). dayGLANCE and vikunja do not use WebDAV for this. There is no single "webDAV sync bus" connecting all four apps. The "1 external" key (MCP to Claude/HA) is real and achievable; the "2 internal" both resolve to *one* mechanism (lastGLANCE→GLANCEvault), not three.

---

## 7. Mealie research — this part is very achievable

Mealie (mealie.io, AGPL-3.0, Vue + FastAPI, self-hosted) is a great fit for meal planning + "what's in the fridge" + grocery lists. It has a **documented REST API** (SQLite or PostgreSQL, up to ~20 users on SQLite).

- **Auth:** `POST /api/auth/token` with username/password → returns a bearer token → send as `Authorization: Bearer <token>` on every call. Long-lived API tokens can also be created under your profile page.
- **Meal planning:** the Meal Planner lets you plan breakfast/lunch/dinner/snack across a calendar; there's a "random recipe" option.
- **Fridge / pantry:** Mealie has **pantry items** (things you own) and a **shopping list** (things to buy). This maps cleanly onto your "what's in the fridge" idea.
- **Meal → ingredients:** recipes carry ingredients; Mealie can generate a shopping list from a meal plan (`shopping_generate_from_mealplan` equivalent).
- **MCP exists:** there are third-party MCP servers for Mealie:
  - `mealie-recipes/mealie` (the app itself)
  - `mdlopresti/mealie-mcp` — meal plans, shopping lists, recipes
  - `bobjansen/MealMCP` — LLM-driven meal planning + pantry management (closer to your "agent that sees the fridge" idea)
  - `djwmarcx/better-mealie-mcp` — exposes 250+ Mealie endpoints

**Recommended path:** stand up Mealie in your AllGLANCE stack (add it to `docker-compose.yml`), get a Mealie API token into `.env.allglance`, then either use a third-party Mealie MCP server as a source for your gateway *or* write a small `MealieAdapter`/Mealie client that reads meal plans + pantry items and merges them into the same unified `tasks`/`days` view the GLANCE apps already produce. The "fridge → suggest meals → add to shopping list" automation is best done by an agent (MealMCP or a custom MCP tool) rather than by hand.

---

## 8. What I recommend we actually build now (realistic ordering)

1. **dayGLANCE MCP wiring — DONE** (verified via `node --check`). The core fix you asked for.
2. **Unified MCP front door + REST + iCal feed** — the gateway already exposes `allglance_*` MCP tools and REST routes. Add a single iCal calendar endpoint (`/api/allglance/feed.ics`) that aggregates GLANCE + vikunja + (later) mealie blocks/tasks into ONE feed Home Assistant can subscribe to. This is the highest-value, fully achievable deliverable.
3. **Mealie integration** — achievable end-to-end. Stand up Mealie, add token to `.env`, wire meal-plan + pantry items into the gateway.
4. **Per-user scoping (gateway-level)** — implement a gateway-managed roster + optional token-per-member layer. Be clear this is *not* dayGLANCE's role model.
5. **lastGLANCE chores** — blocked on GLANCEvault target + passphrase; cannot proceed until you provide them.
6. **lifeGLANCE MCP** — a substantial app-side build; not a one-shot. Defer unless you want to invest in it.
7. **vikunja** — already compatible; no changes needed beyond what's done.

---

## 9. Open questions I need answered

- **lastGLANCE:** Do you have a GLANCEvault server to point at (or will lastGLANCE's WebDAV URL be your own host?), and do you know the sync passphrase? Without these, lastglance chores can't be read.
- **Per-user scoping:** Do you actually need *enforcement* (block a user from seeing others' data), or is it enough for the gateway to *tag* ownership and let an external client filter? The former needs a new gateway auth subsystem; the latter is quick.
- **lifeGLANCE MCP:** Confirm you want to invest in building a new MCP server in lifeGLANCE (multi-week), or scope it to read-only for now.
- **Mealie:** Is Mealie going on the same Docker host? I'll add it to `docker-compose.yml` and pull the token into `.env.allglance`.
