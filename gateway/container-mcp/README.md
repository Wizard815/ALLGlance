# dayGLANCE MCP (container build)

A **container-native port of dayGLANCE's MCP server**. dayGLANCE's own MCP runs
inside its Electron main process and reads state over an IPC renderer bridge;
the dayglance Docker image ships nginx + a static SPA + a tiny Node proxy — no
Electron, no MCP. dayGLANCE's spec (§4.4) resolves a headless Docker MCP as
"no" *for dayGLANCE* and names the missing product: *"a CLI that runs the sync
client locally with a user-supplied passphrase, decrypts in that process, and
serves MCP."* This directory is that product (decryption comes via the vault
provider later).

## What it reuses (not a reimplementation)

`./model/` is dayGLANCE's **real** pure model, vendored verbatim from
`apps/dayglance/src/utils` + the `packages/*` it imports (`agenda-core`,
`obsidian-format`):

- `mcpReadModel.js` — `handleMcpRequest(state, {method, params})` → `get_day`,
  `get_week`, `list_unscheduled`, `list_users`, `goal_progress`
- `mcpWriteModel.js` + `taskMutations.js` — `handleMcpWrite(state, setters, req)`

So tool output is **byte-identical** to the Electron MCP for the same state.

## What is new

- `server.mjs` — Streamable-HTTP MCP server registering the real tool set
  (`dayglance_ping/get_today/get_day/list_unscheduled_tasks/list_users/get_goal_progress`
  + `create_task/update_task/schedule_task/move_block/resize_block/set_task_completion`).
- `state.mjs` — the **substitute data source**: a JSON state document on a
  mounted volume (optionally hydrated from a vault provider).
- Ported pure helpers: `dates.mjs`, `localTime.mjs`, `paginate.mjs`,
  `inboxFilter.mjs`, `createArgs.mjs`, `updateArgs.mjs`, `parseStart.mjs`,
  `auth.mjs`, `port.mjs` (all verbatim logic from `apps/dayglance/electron/*`).

## Run

```bash
# from this directory
npm install
DAYGLANCE_MCP_TOKEN=secret DAYGLANCE_STATE_FILE=/data/dayglance-state.json \
  DAYGLANCE_MCP_PORT=7893 node index.mjs
```

Config (env):

| Var | Meaning | Default |
|---|---|---|
| `DAYGLANCE_MCP_PORT` | port to bind | `7893` |
| `DAYGLANCE_MCP_TOKEN` | bearer token required on every request (empty = open) | `` |
| `DAYGLANCE_STATE_FILE` | JSON state document path | `/data/dayglance-state.json` |
| `TZ` | IANA zone used to resolve "today" | host zone |

## State document shape

Same slices the React model reads:

```json
{
  "weekStartDay": 0,
  "tasks": [{ "id": "...", "title": "...", "date": "YYYY-MM-DD", "startTime": "HH:MM",
              "duration": 30, "isAllDay": false, "completed": false,
              "assignedUserSyncIds": ["dad"], "projectId": "p1" }],
  "unscheduledTasks": [{ "id": "...", "title": "...", "deadline": "YYYY-MM-DD", "priority": 2, "completed": false }],
  "recurringTasks": [],
  "users": [{ "syncId": "dad", "name": "Dad" }],
  "goals": [], "projects": []
}
```

## Re-vendoring the model

When the dayglance submodule updates, refresh `./model/`:

```bash
node scripts/vendor-model.mjs [path-to-apps/dayglance]
```

The script follows the import graph from `mcpReadModel.js` and
`mcpWriteModel.js`, so new upstream imports are picked up automatically;
`./model/` is regenerated from scratch. It fails on any npm import other than
`@glance-apps/*` workspace packages and `i18next` (shimmed), since the
container has no dayGLANCE `node_modules`.

## Tests

```bash
node --test        # boots the server on :7899 and exercises the real tools
```
