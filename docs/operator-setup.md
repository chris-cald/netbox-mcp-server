# Operator setup: concrete procedures

This guide changes **no** live system. Replace every `<PLACEHOLDER>` from the preparation
table; never put a NetBox token, OAuth client secret, JWT, refresh token, or signing key in
this repository, a shell profile, NPM, or a ticket.

## Preparation

Collect in this order before clicking or running anything:

| Placeholder                        | Entered value                                         | Source                         |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------ |
| `<NETBOX_URL>`                     | `https://<netbox-host>` (no `/api`)                   | NetBox operator                |
| `<TOKEN_FILE>`                     | managed host secret-file path                         | secret manager                 |
| `<PRIVATE_HOST>`, `<PRIVATE_PORT>` | gateway's private DNS name and Compose-published port | deployment/network operator    |
| `<PUBLIC_MCP_HOST>`                | public DNS name                                       | DNS/TLS operator               |
| `<RESOURCE_URL>`                   | `https://<PUBLIC_MCP_HOST>/mcp`                       | public DNS/TLS design          |
| `<ISSUER>`, `<JWKS_URI>`           | exact `issuer`, `jwks_uri` in discovery               | authorization-server discovery |
| `<AUDIENCE>`, `<SCOPE>`            | MCP-only audience and required scope                  | provider claim/scope policy    |
| `<NPX>`                            | absolute `npx`/`npx.cmd` path                         | `command -v npx` / `where npx` |

Gateway HTTP values are exactly:

```text
NETBOX_URL=<NETBOX_URL>
NETBOX_TOKEN_FILE=/run/secrets/netbox_token
NETBOX_TRANSPORT=http
NETBOX_HTTP_ALLOWED_HOSTS=<PRIVATE_HOST>:<PRIVATE_PORT>,<PUBLIC_MCP_HOST>
NETBOX_OIDC_ISSUER=<ISSUER>
NETBOX_OIDC_JWKS_URL=<JWKS_URI>
NETBOX_OIDC_AUDIENCE=<AUDIENCE>
NETBOX_OIDC_REQUIRED_SCOPE=<SCOPE>
NETBOX_OIDC_RESOURCE_URL=<RESOURCE_URL>
```

The server token is for NetBox only. The gateway validates the caller Bearer token and never
forwards it to NetBox.

## Installation

### Container

**Prerequisites:** a managed token file, Docker or Podman, and values above. **Do not** add
`NETBOX_HTTP_HOST` or `NETBOX_HTTP_PORT`: Compose owns listener/port mapping.

#### Compose

1. In the source checkout, create an operator-owned Compose override/secret definition; do
   not modify `compose.yaml` to embed a secret.
2. Set its secret **source** to `<TOKEN_FILE>`; leave service-side
   `NETBOX_TOKEN_FILE=/run/secrets/netbox_token` unchanged.
3. Set exactly the preparation-table HTTP values in the service environment. Leave the
   supplied image build, non-root user, read-only filesystem, dropped capabilities, and base
   `ports:` setting unchanged.
4. Render first, then start privately; confirm the rendered output contains the secret path,
   never its contents.
5. Roll back by stopping the new container and restoring the prior override/image; remove a
   public proxy route before reopening an old deployment.

| Compose field               | Leave default                          | Change to                                    | Source                 |
| --------------------------- | -------------------------------------- | -------------------------------------------- | ---------------------- |
| `NETBOX_TOKEN_FILE`         | `/run/secrets/netbox_token` in service | host Compose secret source is `<TOKEN_FILE>` | secret manager         |
| `NETBOX_TRANSPORT`          | `http`                                 | leave                                        | project Compose file   |
| `NETBOX_HTTP_ALLOWED_HOSTS` | profile's private default              | preparation value                            | network design         |
| `NETBOX_OIDC_*`             | no defaults                            | five preparation values                      | discovery/provider/DNS |
| `ports:`                    | absent base mapping                    | leave absent; use approved overlay only      | deployment operator    |

##### Docker

1. Verify `docker compose version` and `docker version`; use the project Compose profile.
2. Run `docker compose --profile deployment config` and inspect it for the expected secret
   **path** and values, never a secret value.
3. Run `docker compose --profile deployment up -d`; verify private health endpoints.
4. Stop with `docker compose --profile deployment down` for rollback.

**Defaults/fields:** use the Compose table; no Docker-only image, port, or `docker run`
command is supported.

##### Podman

1. Verify the installed Compose-compatible Podman implementation renders the same profile.
2. Run its documented Compose equivalent of `config`; verify non-root, read-only, secret-path,
   and private-network semantics match Docker output.
3. Start it with that implementation's documented Compose command; verify privately.
4. Stop via the same implementation for rollback.

**Defaults/fields:** use the Compose table. This is a manual compatibility path: no separate
Podman Compose file is shipped.

#### Pods

No Kubernetes manifest, Helm chart, Kustomize overlay, or Podman pod definition is shipped.
Do not fabricate one from this guide.

##### Kubernetes

1. Have the cluster operator create a workload from their approved baseline.
2. Set non-root identity, read-only root filesystem, dropped capabilities, bounded tmp/cache,
   a managed secret mounted at `/run/secrets/netbox_token`, and a NetworkPolicy allowing only
   the proxy to the private port.
3. Set exactly the preparation values as workload environment variables; keep health endpoints
   private.
4. Apply the operator-owned manifest, verify metadata and 401 privately, then roll back with
   the cluster operator's prior revision.

**Defaults:** none. **Value sources:** cluster policy, secret manager, and Preparation.
**Status:** manual/unsupported; the exact manifest must be supplied and reviewed by the
cluster operator.

##### Podman pod

1. Have the runtime operator create an approved pod definition with equivalent security,
   secret mount, and private networking.
2. Mount the token at `/run/secrets/netbox_token` and set the Preparation values.
3. Validate health, metadata, and 401 privately; remove the pod and restore the previous
   runtime definition on rollback.

**Defaults:** none. **Status:** manual/unsupported; no `podman pod` command is provided.

#### Direct

Direct execution is not maintained because it is too easy to omit a secret mount, read-only
filesystem, network restriction, or restart policy. Use Compose.

##### Docker

**Prerequisite:** an operator-reviewed invocation reproducing every Compose security property.

1. Do not use a command copied from this document; prepare it locally from Docker's reference.
2. Require non-root/read-only, managed token mount at the service path, Preparation fields,
   and no unauthenticated published port.
3. Validate privately; stop/remove it and restore the previous runtime definition to roll back.

**Defaults:** none. **Status:** manual/unsupported.

##### Podman

**Prerequisite:** an operator-reviewed invocation reproducing every Compose security property.

1. Do not use a command copied from this document; prepare it locally from Podman's reference.
2. Require non-root/read-only, managed token mount at the service path, Preparation fields,
   and no unauthenticated published port.
3. Validate privately; stop/remove it and restore the previous runtime definition to roll back.

**Defaults:** none. **Status:** manual/unsupported.

### Package Manager

The project ships only an npm package, `@zenixsolutions/netbox-mcp`. It ships no Chocolatey,
Homebrew, apt, dnf, or apk package. Each distinct procedure below installs a compatible Node
runtime only; then run `<NPX> -y @zenixsolutions/netbox-mcp --version`.

#### Choco

1. Use your approved Chocolatey policy to install/upgrade Node.js; this guide deliberately
   provides no unverified package formula.
2. Run `node --version` (must satisfy `>=20.11`) and `where npx`.
3. Enter the returned absolute `npx.cmd` as `<NPX>` in the chosen agent configuration.
4. Roll back with your Windows package-management policy.

**Defaults:** no project package. **Value source:** `package.json`, local `where` output.

#### Homebrew

1. Use your approved Homebrew policy to install/upgrade Node.js; no project formula/tap exists.
2. Run `node --version` and `command -v npx`.
3. Enter the returned absolute path as `<NPX>`; do not use bare `npx` in GUI clients.
4. Roll back with your Homebrew policy.

**Defaults:** no project formula. **Value source:** `package.json`, local shell output.

#### apt

1. Obtain Node.js from an approved source; no apt package/version is specified because distro
   versions differ.
2. Verify `node --version` and `command -v npx`.
3. Use that absolute `<NPX>` in the agent configuration; roll back through approved apt policy.

**Defaults:** no project package. **Value source:** `package.json`, local shell output.

#### dnf

1. Obtain Node.js from an approved source; no dnf package/version is specified.
2. Verify `node --version` and `command -v npx`.
3. Use that absolute `<NPX>`; roll back through approved dnf policy.

**Defaults:** no project package. **Value source:** `package.json`, local shell output.

#### apk

1. Obtain Node.js from an approved source; no apk package/version is specified.
2. Verify `node --version` and `command -v npx`.
3. Use that absolute `<NPX>`; roll back through approved apk policy.

**Defaults:** no project package. **Value source:** `package.json`, local shell output.

## Integration

### Reverse Proxy

1. Choose `<RESOURCE_URL>` and obtain a public TLS certificate first.
2. Route **both** `/mcp` and `/.well-known/oauth-protected-resource/mcp` to the private
   gateway with no URI rewrite or slash normalization.
3. Preserve public `Host` and caller `Authorization`; disable buffering for streaming.
4. Allow only the proxy to reach `<PRIVATE_HOST>:<PRIVATE_PORT>`. Plain HTTP is allowed only
   on a co-hosted or isolated trusted path; otherwise use encrypted networking/TLS tunnel.
5. Verify metadata and 401 before enabling an agent. Roll back by removing both proxy routes.

#### nginx

No tested nginx configuration is shipped. Apply the five Reverse Proxy steps with nginx's
official syntax; leave unrelated server settings unchanged. **Fields:** exact two paths,
public Host, Authorization, HTTP/1.1, buffering disabled, protected upstream. **Source:**
Preparation and nginx documentation. **Status:** manual.

#### NPM

**UI navigation:** NPM Dashboard → **Hosts** → **Proxy Hosts** → select the existing public
NetBox host → **Custom Locations** → **Add Location**, once for each path below.

| NPM field           | `/mcp` and `/.well-known/oauth-protected-resource/mcp`       | Leave default / why                         | Source              |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------- | ------------------- |
| Location            | enter each exact path                                        | no rewrite or slash change                  | gateway routes      |
| Forward Scheme      | `http` only co-hosted/isolated; otherwise encrypted upstream | do not send Bearer over untrusted plaintext | network design      |
| Forward Hostname/IP | `<PRIVATE_HOST>`                                             | do not use public host                      | deployment operator |
| Forward Port        | `<PRIVATE_PORT>`                                             | do not guess `3000`                         | deployment overlay  |
| Websockets Support  | enabled on Proxy Host                                        | retain cert / Force SSL                     | NPM UI              |
| Access List         | leave existing Proxy Host setting unchanged                  | NPM scopes it to the whole Proxy Host       | NPM behavior        |

In **Advanced** for each Custom Location, paste only:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_set_header Host $host;
proxy_set_header Authorization $http_authorization;
proxy_set_header X-Forwarded-Proto $scheme;
```

Leave NPM-generated `proxy_pass` alone; do not add one. NPM Access Lists are scoped to the
whole Proxy Host, so they cannot safely exempt only MCP paths. If the existing NetBox Proxy
Host has an Access List or cookie-login authentication, keep it unchanged and create a
separate HTTPS Proxy Host/hostname for MCP instead. Click **Save** after each location,
restart no service unless NPM says so, verify both paths, and delete the two locations to roll
back. NPM reference: <https://nginxproxymanager.com/advanced-config/>.

#### haproxy

No tested HAProxy configuration is shipped. Apply the five Reverse Proxy steps; leave
unrelated frontend/backend defaults unchanged. **Fields/source/status:** same as nginx, using
HAProxy documentation. **Status:** manual.

#### caddy

No tested Caddy configuration is shipped. Apply the five Reverse Proxy steps; leave unrelated
site defaults unchanged. **Fields/source/status:** same as nginx, using Caddy documentation.
**Status:** manual.

### Authorization

#### Authentik

This is an MCP-specific application/provider; do **not** reuse the NetBox UI client. The
reference procedure it follows is Authentik's NetBox integration:
<https://integrations.goauthentik.io/documentation/netbox/>.

1. Log in to Authentik Admin Interface → **Applications** → **Applications** → **New
   Application**.
2. Enter Application name `NetBox MCP`; set slug `netbox-mcp`; leave group and UI settings at
   their current defaults; choose policy engine mode required by local policy.
3. In **Choose a Provider type**, select **OAuth2/OpenID Connect**. In **Configure Provider**,
   accept/generated provider name, select a locally approved authorization flow, and select an
   available signing key. Do not copy a client secret to gateway/NPM configuration.
4. Configure Authorization Code with PKCE/S256 for public/native agent clients; disable the
   implicit grant. Use explicit consent for third-party/user-facing clients unless a documented
   first-party policy approves implicit consent.
5. Create/attach an MCP-only scope `<SCOPE>` and claim mapping emitting audience `<AUDIENCE>`;
   restrict application/provider bindings to approved users/groups. Values come from
   authorization policy, not this document.
6. Add only exact redirect URIs supplied by each agent's current UI/docs. Do not use the
   NetBox redirect URI (`/oauth/complete/oidc/`), which belongs to NetBox UI SSO, not MCP.
7. Click **Submit**. Open
   `https://<AUTHENTIK_HOST>/application/o/netbox-mcp/.well-known/openid-configuration`; copy
   `issuer` into `<ISSUER>` and `jwks_uri` into `<JWKS_URI>`.
8. Apply the Preparation gateway environment values, restart only the gateway, then verify
   metadata, a 401 challenge, valid scoped token, and expired/wrong-audience/missing-scope
   rejection. Roll back by removing gateway public routes, then disabling bindings/provider.

| Authentik field       | Enter                       | Leave default / reason        | Source               |
| --------------------- | --------------------------- | ----------------------------- | -------------------- |
| Application name/slug | `NetBox MCP` / `netbox-mcp` | group/UI unchanged            | local naming policy  |
| Provider type         | OAuth2/OpenID Connect       | —                             | Authentik UI         |
| Flow                  | Code + PKCE/S256            | implicit disabled             | OAuth baseline       |
| Signing key           | approved key                | existing algorithm/key policy | Authentik admin      |
| Scope/audience        | `<SCOPE>` / `<AUDIENCE>`    | MCP-only, no NetBox UI reuse  | authorization policy |
| Discovery fields      | `<ISSUER>` / `<JWKS_URI>`   | copy exactly                  | discovery document   |
| Resource URL          | `<RESOURCE_URL>`            | exact public HTTPS `/mcp`     | DNS/TLS design       |

### Agent

All local stdio configurations use this server command and environment:

```json
{
  "command": "<NPX>",
  "args": ["-y", "@zenixsolutions/netbox-mcp"],
  "env": { "NETBOX_URL": "<NETBOX_URL>", "NETBOX_TOKEN_FILE": "<TOKEN_FILE>" }
}
```

Use the actual client UI/path below. Do not commit token values. For remote OAuth, configure
only `<RESOURCE_URL>` and exact client-provided registration data after the Authentik steps;
never guess redirect URIs.

#### ChatGPT

**Evidence:** <https://developers.openai.com/api/docs/guides/developer-mode>. 1. Open ChatGPT
web → Settings → Apps/Connectors → Developer mode (availability is account-controlled). 2.
Add a remote MCP connector and enter `<RESOURCE_URL>`; leave authentication selection at the
UI default until it offers OAuth. 3. Copy only the redirect/client registration data it shows
into Authentik, save, reconnect, and verify tools. 4. Remove the connector to roll back.
**Status:** evidence-backed remote path; exact UI fields vary by account.

#### Codex

**Evidence:** <https://developers.openai.com/codex/mcp/>. 1. Open `~/.codex/config.toml`. 2. Add `[mcp_servers.netbox]`, `command = "<NPX>"`, and
`args = ["-y", "@zenixsolutions/netbox-mcp"]`; under `[mcp_servers.netbox.env]` set
`NETBOX_URL` and exactly one token source. 3. Leave other tables unchanged; restart Codex. 4. Verify `netbox_*` tools; remove both tables to roll back. **Status:** documented stdio.

#### Claude Desktop

**Evidence:** <https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop>.

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json`; back it up. 2. Under
   existing `mcpServers`, add `netbox` using the JSON template above. 3. Leave existing servers
   unchanged, validate `python3 -m json.tool`, `chmod 600`, then fully quit/reopen Claude. 4. Verify tools; restore backup to roll back. **Status:** documented stdio.

#### Claude Code

**Evidence:** <https://code.claude.com/docs/en/mcp>. 1. In a shell, set only non-secret URL
and use a protected token source. 2. Run `claude mcp add netbox -- "<NPX>" -y
@zenixsolutions/netbox-mcp` with the documented `--env` flags for `NETBOX_URL` and exactly one
token source. 3. Leave other MCP servers unchanged; run `claude mcp list`. 4. Remove `netbox`
with Claude Code's documented command to roll back. **Status:** documented stdio.

#### Cursor

**Evidence:** <https://cursor.com/docs/mcp>. 1. Open global `~/.cursor/mcp.json` or project
`.cursor/mcp.json`; back it up. 2. Under `mcpServers`, add `netbox` from the JSON template. 3.
Leave existing entries unchanged, save valid JSON, and restart Cursor. 4. Verify tools; remove
only `netbox` to roll back. **Status:** documented stdio.

#### GitHub Copilot

**Evidence:** <https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers>.

1. In VS Code create/open `.vscode/mcp.json`. 2. Add a local stdio server using VS Code's
   current MCP schema, with `<NPX>`, package args, and environment template. 3. Leave existing
   servers/tool allowlists unchanged unless policy requires an allowlist; restart/reload VS Code.
2. Verify tools; delete only the server entry to roll back. **Status:** evidence-backed local
   MCP; schema is editor-version controlled.

#### Gemini CLI

**Evidence:** <https://geminicli.com/docs/tools/mcp-server/>. 1. Open
`~/.gemini/settings.json` (user) or `.gemini/settings.json` (project). 2. Add `netbox` beneath
`mcpServers` with the JSON template fields. 3. Leave trust/tool-policy defaults unchanged
unless enterprise policy requires them; restart Gemini CLI or use its documented `gemini mcp
add`. 4. Verify with `gemini mcp list`; remove `netbox` to roll back. **Status:** documented
stdio/HTTP client; use stdio until remote OAuth is explicitly verified.

#### Windsurf

**Evidence:** <https://docs.windsurf.com/windsurf/cascade/mcp>. 1. Open Cascade Settings → MCP
or its `mcp_config.json`. 2. Add stdio `netbox` with template command/args/env. 3. Leave other
Cascade/Devin Local settings unchanged; save/restart Cascade. 4. Verify and remove `netbox` to
roll back. **Status:** evidence-backed for legacy Cascade; do not claim it configures Devin
Local.

#### Cline

**Evidence:** <https://docs.cline.bot/mcp/mcp-overview>. 1. In VS Code open Cline → MCP Servers
→ Configure → Configure MCP Servers. 2. Add a `mcpServers.netbox` stdio entry using template
command/args/env. 3. Leave other entries unchanged; save/restart extension. 4. Verify/remove
entry. **Status:** evidence-backed; use the extension-selected active config path.

#### Roo Code

**Evidence:** <https://github.com/RooCodeInc/Roo-Code>. 1. Open Roo Code MCP settings and choose
global `mcp_settings.json` or project `.roo/mcp.json`. 2. Add `mcpServers.netbox` from template. 3. Leave existing entries unchanged; save/restart extension. 4. Verify/remove entry. **Status:**
configuration locations are evidence-backed from project source; UI behavior is version-specific.

#### Continue

**Evidence:** <https://docs.continue.dev/customize/deep-dives/mcp>. 1. Open Continue
`config.yaml` or `.continue/mcpServers/`. 2. Add `netbox` as a stdio MCP server with `<NPX>`,
args, and environment template. 3. Leave unrelated model/agent settings unchanged; reload
Continue in Agent mode. 4. Verify/remove server. **Status:** documented stdio.

## Verification and rollback

1. Privately check `/healthz` and `/readyz`.
2. Check `https://<PUBLIC_MCP_HOST>/.well-known/oauth-protected-resource/mcp` returns
   `<RESOURCE_URL>` and `<ISSUER>`.
3. Check missing bearer `POST <RESOURCE_URL>` returns `401` with
   `WWW-Authenticate: Bearer resource_metadata=...`, never login HTML.
4. Send a valid MCP `initialize` JSON request with `Content-Type: application/json` and Accept
   containing `application/json` plus `text/event-stream`; expect `200` and `Mcp-Session-Id`.
5. Confirm expired/wrong-audience/missing-scope tokens fail and NetBox sees only server token.
6. If any step fails, remove agent connector, remove both proxy paths, stop new gateway, and
   restore prior private configuration/image.
