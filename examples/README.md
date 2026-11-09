# Examples

Copy what you need; every file says what to change. The install guide is in the
[README](../README.md#install-guide).

| File | What it is |
|---|---|
| `omi-host.env.example` | The lines to add to Omi's `omi-host/.env` so Omi uses this gateway |
| `claude-mcp.json` | Connect Claude Code, Claude Desktop or any MCP client to the gateway |
| `docker-compose.override.example.yml` | Local changes to the stack without editing `docker-compose.yml` (ports, LAN-only binding, the optional vault) |
| `home-assistant/configuration.yaml` | A Home Assistant `rest_command` that creates a task (reading and ticking tasks is the CalDAV integration, see the README) |
| `reverse-proxy/Caddyfile` | HTTPS in front of the gateway and the sync server |
