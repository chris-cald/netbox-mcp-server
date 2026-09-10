# Operator setup guide

This is a field-ordered provisioning guide, not an installer. Never place a NetBox
token, OAuth client secret, JWT, refresh token, or signing key in the repository, a
shell profile, a proxy UI, or a support request. `NETBOX_URL` plus exactly one of
`NETBOX_TOKEN` and `NETBOX_TOKEN_FILE` is always required. HTTP also requires
`NETBOX_HTTP_ALLOWED_HOSTS`, issuer, JWKS URL, audience, scope, and resource URL.

**Common collection order:** (1) NetBox URL and a managed server-token mount; (2)
runtime path/image; (3) private gateway endpoint and public DNS/TLS hostname; (4) OAuth
discovery issuer/JWKS and provider audience/scope; (5) final public `https://<HOST>/mcp`
resource URL; (6) client redirect registration data from the actual agent.

## Installation

Provision an operating-system Node.js runtime satisfying `package.json` (`>=20.11`) before
selecting one of the paths below. The supported distribution is npm/npx:
`<absolute npx path> -y @zenixsolutions/netbox-mcp`. This project ships no OS package,
formula, chart, manifest, or direct-run recipe.

### Container

**Provision order:** collect the common values; select Docker or Podman; render
`compose.yaml`; verify only secret _paths_ appear; then start privately. **Defaults:** the
supplied Compose profile is non-root/read-only, HTTP transport, and has no host-port
mapping. **Fields:** set `NETBOX_URL`, a managed token source, allowed hosts, and all HTTP
OIDC fields; values come from the common collection order.

#### Compose

**Provision order:** set the Compose secret source, then gateway variables, then an
operator-owned network/port overlay only if required. **Defaults:** use `compose.yaml` as
shipped; keep `ports:` absent and do not add `NETBOX_HTTP_HOST` or `NETBOX_HTTP_PORT`.
**Fields:**

| Field                       | Default / leave                          | Set                                                | Value source                 |
| --------------------------- | ---------------------------------------- | -------------------------------------------------- | ---------------------------- |
| `NETBOX_URL`                | none                                     | NetBox base URL without `/api`                     | NetBox operator              |
| `NETBOX_TOKEN_FILE`         | service path `/run/secrets/netbox_token` | Compose secret source on host; retain service path | Secret manager               |
| `NETBOX_TRANSPORT`          | `http` in supplied profile               | leave                                              | Project file                 |
| `NETBOX_HTTP_ALLOWED_HOSTS` | `localhost` in un-published profile      | exact private/public `Host` values                 | Network/proxy design         |
| `NETBOX_OIDC_*`             | none                                     | issuer, JWKS, audience, scope, resource URL        | Authorization + proxy design |
| `ports:`                    | absent                                   | leave absent in base profile                       | Project file                 |

##### Docker

**Provision order:** install Docker/Compose, render the supplied Compose file, then run it
privately. **Defaults:** leave image build, non-root/read-only settings, and no published
port unchanged. **Fields:** use the Compose table; Docker supplies only the runtime and
secret-mount implementation. **Status:** supported through `compose.yaml`; no separate
Docker-only command is maintained.

##### Podman

**Provision order:** install a Compose-compatible Podman implementation, render the same
file, verify equivalent secret/read-only/network behavior, then run privately. **Defaults:**
do not substitute a different image or port mapping. **Fields:** use the Compose table;
secret-mount syntax and runtime path come from the local Podman documentation. **Status:**
manual compatibility path, not a separate supported Compose file.

#### Pods

**Provision order:** first build an organization-owned pod/workload definition, then apply
secret, security, network, and OIDC requirements before starting it. **Defaults:** none:
this repository ships no Kubernetes manifest, Helm chart, Kustomize overlay, or Podman pod
definition. **Fields:** every workload must map the managed token to
`NETBOX_TOKEN_FILE=/run/secrets/netbox_token`, set the Compose-table HTTP/OIDC values, and
use the private/public endpoint values from the common collection order.

##### Kubernetes

**Provision order:** define workload security; mount a managed secret; add NetworkPolicy;
set gateway fields; then private health checks. **Defaults:** no YAML/chart is supplied.
**Fields:** non-root identity, read-only root filesystem, dropped capabilities, bounded
tmp/cache, managed secret mount, NetworkPolicy limited to proxy source, and private
`/healthz`/`/readyz` probes. **Value sources:** cluster policy, secret manager, and common
collection order. **Status:** manual/unsupported; do not infer a manifest from this guide.

##### Podman

**Provision order:** define equivalent Podman pod security/network/secret settings, set
gateway fields, and validate privately. **Defaults:** no pod definition is supplied.
**Fields:** same workload, token-path, network, and health requirements as Kubernetes.
**Value sources:** local Podman documentation, secret manager, and common collection order.
**Status:** manual/unsupported; do not invent a `podman pod` command from this guide.

#### Direct

**Provision order:** prefer Compose; only use a locally-reviewed runtime invocation after
reproducing its secret, security, network, OIDC, and lifecycle properties. **Defaults:** no
direct command is maintained. **Fields:** all Compose-table values plus explicit
read-only/non-root/secret-mount/network settings. **Value sources:** local runtime
reference and common collection order. **Status:** manual/unsupported.

##### Docker

**Provision order:** use Compose instead; otherwise review a local run specification before
execution. **Defaults:** no `docker run` command exists here. **Fields:** preserve every
Compose security field, set the Compose values, and expose no unauthenticated port.
**Value sources:** Docker documentation and common collection order. **Status:**
manual/unsupported.

##### Podman

**Provision order:** use Compose instead; otherwise review a local run specification before
execution. **Defaults:** no `podman run` command exists here. **Fields:** preserve every
Compose security field, set the Compose values, and expose no unauthenticated port.
**Value sources:** Podman documentation and common collection order. **Status:**
manual/unsupported.

### Package Manager

**Provision order:** use the platform package manager only to obtain a supported Node.js
runtime, verify `node --version`, then record the absolute `npx` path and use npm/npx.
**Defaults:** install no project-specific OS package. **Fields:** Node version `>=20.11` and
absolute runtime path; values come from `package.json` and `command -v npx` (or `where
npx` on Windows). All entries below are manual prerequisites, not project package recipes.

#### Choco

**Provision order:** install/upgrade a supported Node.js runtime, verify its version, then
use absolute `npx.cmd`. **Defaults:** no Chocolatey package name is prescribed. **Fields:**
Node version/path from `package.json` and `where npx`. **Status:** manual prerequisite.

#### Homebrew

**Provision order:** install/upgrade supported Node.js, verify version, then use absolute
`npx`. **Defaults:** no project formula/tap is prescribed. **Fields:** Node version/path
from `package.json` and `command -v npx`. **Status:** manual prerequisite.

#### apt

**Provision order:** install a supported Node.js source, verify version, then use absolute
`npx`. **Defaults:** no apt package/version is prescribed because distro packages vary.
**Fields:** Node version/path from `package.json` and `command -v npx`. **Status:** manual
prerequisite.

#### dnf

**Provision order:** install a supported Node.js source, verify version, then use absolute
`npx`. **Defaults:** no dnf package/version is prescribed. **Fields:** Node version/path
from `package.json` and `command -v npx`. **Status:** manual prerequisite.

#### apk

**Provision order:** install a supported Node.js source, verify version, then use absolute
`npx`. **Defaults:** no apk package/version is prescribed. **Fields:** Node version/path
from `package.json` and `command -v npx`. **Status:** manual prerequisite.

## Integration

**Provision order:** make the gateway private and OIDC-configured before adding a proxy,
then authorize the proxy/private network, then register a client. **Defaults:** stdio is the
normal transport; no public HTTP endpoint is enabled by this guide. **Fields:** public HTTPS
resource URL, exact allowed hosts, and OIDC fields derive from the common collection order.

### Reverse Proxy

**Provision order:** choose public HTTPS URL; issue certificate; configure both MCP paths
without rewriting; preserve Host/Authorization; restrict upstream network; then test 401
metadata before a connector. **Defaults:** retain existing application default route and
TLS enforcement. **Fields:** route `/mcp` and
`/.well-known/oauth-protected-resource/mcp`, preserve public `Host` and `Authorization`,
disable buffering, and use encrypted upstream networking unless co-hosted/isolated.
**Value sources:** DNS/TLS design, gateway metadata, and proxy documentation.

#### nginx

**Provision order:** apply the Reverse Proxy baseline, then test each path privately.
**Defaults:** no nginx configuration is supplied or validated. **Fields:** both no-rewrite
locations; public Host; Authorization; HTTP/1.1; disabled buffering; protected upstream.
**Value sources:** Reverse Proxy baseline and nginx documentation. **Status:** manual.

#### NPM

**Provision order:** retain Proxy Host default route; add both Custom Locations; apply
advanced headers; verify metadata/401; then enable connector. **Defaults:** retain existing
certificate/Force SSL and default route; do not apply Access Lists or cookie-login auth to
the MCP locations. **Fields:**

| NPM field           | `/mcp` and `/.well-known/oauth-protected-resource/mcp`       | Source             |
| ------------------- | ------------------------------------------------------------ | ------------------ |
| Forward Scheme      | `http` only co-hosted/isolated; otherwise encrypted upstream | Network design     |
| Forward Hostname/IP | private gateway hostname                                     | Network design     |
| Forward Port        | private gateway port                                         | Deployment overlay |
| URI handling        | no rewrite/slash normalization                               | Gateway paths      |
| Websockets Support  | enable on Proxy Host                                         | NPM UI             |

Use only this Advanced configuration (NPM generates `proxy_pass`):

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_set_header Host $host;
proxy_set_header Authorization $http_authorization;
proxy_set_header X-Forwarded-Proto $scheme;
```

**Status:** current documented UI integration.

#### haproxy

**Provision order:** apply the Reverse Proxy baseline, then test each path privately.
**Defaults:** no HAProxy configuration is supplied or validated. **Fields:** both no-rewrite
paths; public Host; Authorization; streaming-safe response behavior; protected upstream.
**Value sources:** Reverse Proxy baseline and HAProxy documentation. **Status:** manual.

#### caddy

**Provision order:** apply the Reverse Proxy baseline, then test each path privately.
**Defaults:** no Caddy configuration is supplied or validated. **Fields:** both no-rewrite
paths; public Host; Authorization; streaming-safe response behavior; protected upstream.
**Value sources:** Reverse Proxy baseline and Caddy documentation. **Status:** manual.

### Authorization

**Provision order:** define MCP-only audience/scope and authorization policy; create provider
and client registration; read discovery; set gateway fields; then test token failures before
proxy exposure. **Defaults:** gateway accepts only RS256/ES256 JWS tokens and uses no
provider-specific secret. **Fields:** issuer, JWKS URI, audience, required scope, and exact
public resource URL; sources are discovery, provider policy, and DNS/TLS design.

#### Authentik et al

**Provision order:** create a separate MCP application/provider; configure authorization
code + PKCE/S256; attach MCP-only audience/scope and restrictive user/group policy; obtain
discovery; set gateway fields; register only client-provided redirect URIs. **Defaults:**
disable implicit grant; use explicit consent for third-party/user-facing connectors; do not
share NetBox UI policy/client; no client secret belongs in gateway/proxy config. **Fields:**

| Field                        | Set                                           | Value source           |
| ---------------------------- | --------------------------------------------- | ---------------------- |
| Provider/application         | separate MCP OAuth2/OIDC provider/application | Authorization policy   |
| Grant                        | Authorization Code + PKCE/S256                | Connector capability   |
| `NETBOX_OIDC_ISSUER`         | exact discovery `issuer`                      | Discovery document     |
| `NETBOX_OIDC_JWKS_URL`       | exact discovery `jwks_uri`                    | Discovery document     |
| `NETBOX_OIDC_AUDIENCE`       | stable MCP-only audience                      | Provider claim mapping |
| `NETBOX_OIDC_REQUIRED_SCOPE` | MCP-only required scope                       | Provider scope policy  |
| `NETBOX_OIDC_RESOURCE_URL`   | `https://<PUBLIC_MCP_HOST>/mcp`               | DNS/TLS design         |

Authentik discovery is normally
`https://<AUTHENTIK_HOST>/application/o/netbox-mcp/.well-known/openid-configuration`.
Other authorization servers are provider-neutral/manual: use the same fields and baseline,
not Authentik UI labels.

### Agent

**Provision order:** confirm client transport/OAuth support; collect its exact registration
and redirect-URI data; configure its endpoint/command; then test the gateway challenge and
MCP initialize request. **Defaults:** do not guess redirect URIs, client secrets, or remote
connector support. **Fields:** local clients need absolute executable path and NetBox server
environment; remote clients need public resource URL and their own OAuth registration data.
**Value sources:** client vendor documentation and the common collection order.

#### ChatGPT

**Provision order:** confirm the currently available connector supports remote MCP OAuth;
collect UI-provided registration values; test challenge/metadata. **Defaults:** do not invent
a config path or client registration. **Fields:** public resource URL and exact client
registration/redirect values. **Value sources:** current OpenAI documentation/UI. **Status:**
manual/client-specific.

#### Codex

**Provision order:** for Codex CLI, set absolute `npx` command and `mcp_servers` TOML entry;
for remote OAuth, confirm client support first. **Defaults:** no secret in shell profile.
**Fields:** command path, package args, `NETBOX_URL`, exactly one server token source, and
HTTP/OIDC fields when remote. **Value sources:** `command -v npx`, client docs, common
collection order. **Status:** local stdio documented; remote manual.

#### Claude

**Provision order:** use Claude Desktop/Code local-MCP configuration with absolute `npx`, or
confirm remote OAuth support before registration. **Defaults:** never use bare `npx` for a
GUI app; no secret in shell profile. **Fields:** command path, package args, server
environment, and client registration values only if remote. **Value sources:** `command -v
npx`, Claude documentation, common collection order. **Status:** local stdio documented;
remote manual.

#### Cursor

**Provision order:** add a local MCP JSON entry with absolute `npx`; confirm remote OAuth
support before registration. **Defaults:** do not overwrite existing `mcp.json` entries.
**Fields:** command path, package args, server environment, and remote registration values
if supported. **Value sources:** `command -v npx`, Cursor docs, common collection order.
**Status:** local stdio documented; remote manual.

#### Copilot

**Provision order:** verify current MCP/OAuth support, collect client-provided registration
data, then test metadata/challenge. **Defaults:** no Copilot config or redirect URI is
provided here. **Fields:** public resource URL and exact registration values. **Value
sources:** current GitHub documentation/UI. **Status:** manual/client-specific.

#### et al

**Provision order:** verify MCP transport, OAuth, redirect, and token capabilities before
registration. **Defaults:** unlisted agents are unsupported. **Fields:** public resource URL
and exact vendor-supplied registration values. **Value sources:** vendor documentation and
common collection order. **Status:** manual until verified.

## Validation and rollback

**Provision order:** render configuration (no secret values); start privately; verify private
health; verify RFC 9728 metadata; verify missing-token `401` with `resource_metadata`; send
a valid JSON MCP `initialize` request with `Content-Type: application/json` and `Accept`
including `application/json` and `text/event-stream`; expect `200` plus `Mcp-Session-Id`;
then test expired/wrong-audience/missing-scope failures. **Defaults:** no connector is
enabled before these checks. **Fields:** expected issuer/resource URL/path come from the
common collection order. **Rollback:** remove public routes first, then restore prior
image/config if health, metadata, or token checks fail.
