# CLAUDE.md

See [AGENTS.md](AGENTS.md) — it is the full runbook for installing, configuring, and
troubleshooting this MCP server, written for an AI assistant to follow step by step.

Quick orientation:

- This is a stdio MCP server for NetBox. Node >= 20.11, TypeScript, built with `npm run build` to `dist/index.js`. Current version 0.2.0.
- Requires `NETBOX_URL` and `NETBOX_TOKEN`. The only optional variable is `NETBOX_INSECURE` (disables TLS verification). There are no others — `NETBOX_READONLY` and `NETBOX_TOOL_GROUPS` were removed in 0.1.0.
- **Six tools**, not one per resource: `netbox_global_search`, `netbox_discover`, `netbox_describe`, `netbox_read`, `netbox_write`, `netbox_invoke`. Object types are derived at runtime from the instance's own OpenAPI schema; `netbox_invoke` exposes only schema-confirmed, closed IPAM prefix availability actions.
- Neither execution tool takes a path. `object_type` (e.g. `dcim.device`) resolves to an endpoint through a registry; a wrong key is answered with near-misses.
- Write access is controlled by the NetBox token's `write_enabled` flag and object permissions, enforced by NetBox. The server has no read-only mode. Deleting requires `confirm` to equal the object's current `display`, and NetBox cascades deletes.
- Users install it by pointing their MCP client at `npx -y @zenixsolutions/netbox-mcp`. There is no install script; a clone and `npm ci && npm run build` is the contributor path.
- CLI verbs: `--help` (usage, reads no config), `--version`, `--check` (validates config: exit 0 usable, 78 not), `--list-tools` (prints every registered tool; needs no credentials).
- Never commit a NetBox token. Never run `sudo`. Do not modify `src/` when installing.
