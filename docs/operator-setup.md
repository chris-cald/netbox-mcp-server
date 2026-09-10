# Operator setup guide

This is a provisioning guide, not an installer. It lists the values an operator must
collect before configuring a runtime, gateway, identity provider, proxy, or agent. It
never needs a NetBox token, OAuth client secret, JWT, refresh token, or private key in
source control, a shell profile, or a support request.

## 1. Collect values in this order

| Order | Value                                                  | Source                                                 | Keep secret?                                       |
| ----- | ------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------- |
| 1     | NetBox base URL                                        | NetBox operator                                        | No                                                 |
| 2     | NetBox server token or token-file mount                | NetBox operator / secret manager                       | **Yes**                                            |
| 3     | Runtime executable paths                               | `command -v node`, `command -v npx`, container runtime | No                                                 |
| 4     | Private gateway host/port and allowed public hostnames | Network/proxy operator                                 | No                                                 |
| 5     | OAuth issuer, JWKS URI, audience, scope                | Authorization-server discovery and provider policy     | No                                                 |
| 6     | Public HTTPS MCP resource URL                          | Reverse-proxy DNS/TLS design                           | No                                                 |
| 7     | Client redirect URI/client registration data           | The MCP client vendor                                  | Client secret, if any, stays only with that client |

The server itself requires `NETBOX_URL` plus exactly one of `NETBOX_TOKEN` or
`NETBOX_TOKEN_FILE`. HTTP additionally fails closed unless all of these are set:
`NETBOX_HTTP_ALLOWED_HOSTS`, `NETBOX_OIDC_ISSUER`, `NETBOX_OIDC_JWKS_URL`,
`NETBOX_OIDC_AUDIENCE`, `NETBOX_OIDC_REQUIRED_SCOPE`, and
`NETBOX_OIDC_RESOURCE_URL`.

## 2. Installation

### Package managers

This project publishes an npm package, not OS packages, Homebrew formulae, Chocolatey
packages, Helm charts, or Kubernetes manifests. Do not invent package-manager commands.
Install a supported Node.js runtime first, then use npm/npx:

| Platform/package manager | Leave default              | Set/verify                                                                                  | Status                 |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| Homebrew (macOS)         | Nothing project-specific   | Install a Node.js version satisfying `package.json` (`>=20.11`); record absolute `npx` path | Manual prerequisite    |
| Chocolatey (Windows)     | Nothing project-specific   | Install supported Node.js; record absolute `npx.cmd` path                                   | Manual prerequisite    |
| apt, dnf, apk (Linux)    | Nothing project-specific   | Install Node.js `>=20.11`; distro versions may be older, so verify `node --version`         | Manual prerequisite    |
| npm/npx                  | Use the package name below | `npx -y @zenixsolutions/netbox-mcp --version`                                               | Supported distribution |

For a local stdio client, the normal command is:

```text
<absolute path to npx> -y @zenixsolutions/netbox-mcp
```

Use a clone only for contribution or a blocked npm registry; see the repository README.
Do not use `sudo`, create an install script, or put credentials in a package-manager
configuration.

## 3. Runtime choices

### Container image and Compose: Docker or Podman

`compose.yaml` is the supported container profile. It creates no host port by default.
It uses a read-only, non-root process and a file-backed NetBox token mount.

| Compose field               | Leave/default                              | Set                                                      | Value source               |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------- | -------------------------- |
| `NETBOX_URL`                | none                                       | NetBox base URL, no `/api`                               | NetBox operator            |
| `NETBOX_TOKEN_FILE`         | `/run/secrets/netbox_token` in the service | Host/Compose secret-source path; Compose mounts it there | Secret manager             |
| `NETBOX_TRANSPORT`          | `http` in profile                          | Leave as provided                                        | Project file               |
| `NETBOX_HTTP_ALLOWED_HOSTS` | `localhost` only for un-published profile  | Private/public `Host` values expected by the gateway     | Proxy/network design       |
| OIDC fields                 | no defaults                                | All five values from section 5                           | Authorization/proxy design |
| `ports:`                    | none                                       | Keep none in the base profile                            | Deployment overlay only    |

Use either `docker compose` or `podman-compose` only if that implementation supports the
Compose features in this file. Render the configuration before starting it; verify it
contains secret _paths_, never secret values. A Podman deployment is manual support, not a
separate image or Compose file.

### Pods: Kubernetes or Podman

No Kubernetes manifest, Helm chart, Kustomize overlay, or Podman pod definition is shipped.
These paths are **manual/unsupported templates**, not recipes to copy from this project.
An operator must provide, before adoption:

- a non-root workload identity, read-only root filesystem, dropped capabilities, and a
  bounded writable cache/tmp volume;
- a managed secret mount as `NETBOX_TOKEN_FILE`, not an environment token;
- a NetworkPolicy/firewall restricting private gateway access to the intended proxy;
- OIDC configuration from section 5 and TLS/encrypted transport for Bearer tokens;
- liveness/readiness checks for `/healthz` and `/readyz` that remain private.

### Direct Docker or Podman run

There is no maintained `docker run`/`podman run` command because correct networking, secret
mounting, lifecycle, and OIDC settings are deployment-specific. Use Compose first. A manual
run is unsupported unless it preserves every Compose security property above and exposes no
unauthenticated port.

## 4. Reverse proxy

### Provider-neutral baseline

Provision in this order:

1. Choose a final public HTTPS resource URL, for example
   `https://<PUBLIC_MCP_HOST>/mcp`.
2. Obtain a valid certificate and force HTTPS at the proxy.
3. Route **both** `/mcp` and
   `/.well-known/oauth-protected-resource/mcp` to the gateway without URI rewriting.
4. Preserve the public `Host` and `Authorization` headers; disable response buffering for
   streaming/SSE.
5. Do not put the MCP routes behind a cookie/login redirect. The gateway must emit its own
   `401` Bearer `resource_metadata` challenge.
6. Permit only the proxy to reach the private gateway. If the proxy and gateway are not
   co-hosted or on an isolated trusted link, encrypt the upstream path (for example,
   encrypted networking or a TLS tunnel) before forwarding Bearer tokens.

nginx, HAProxy, and Caddy are **manual integrations**: this repository does not provide
or validate their configuration snippets. Apply the baseline above, consult each proxy's
own documentation, and test the validation sequence in section 8.

### Nginx Proxy Manager (NPM)

NPM is documented because its UI fields map directly to the baseline. In the existing Proxy
Host for `<PUBLIC_MCP_HOST>`, retain the default application route and create two **Custom
Locations**:

| NPM field                                 | `/mcp` and `/.well-known/oauth-protected-resource/mcp`                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Forward Scheme                            | `http` only on co-hosted/isolated trusted upstream; otherwise use encrypted upstream transport |
| Forward Hostname/IP                       | Private gateway hostname                                                                       |
| Forward Port                              | Private gateway port                                                                           |
| URI handling                              | Leave unchanged; no rewrite or slash normalization                                             |
| TLS / Force SSL                           | Leave the public host certificate and HTTPS enforcement enabled                                |
| Access List / Authentik proxy cookie flow | Do not apply to these locations                                                                |
| Websockets Support                        | Enable on the Proxy Host                                                                       |

In the Custom Location advanced area, add only:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_set_header Host $host;
proxy_set_header Authorization $http_authorization;
proxy_set_header X-Forwarded-Proto $scheme;
```

Do not add `proxy_pass` there; NPM generates it from the Custom Location fields. If the
existing application authentication cannot exempt the two MCP paths, use a separate public
hostname instead of accepting redirects.

## 5. Authorization

### OAuth/OIDC baseline

The gateway is an OAuth protected resource, not an authorization server. It verifies JWS
access tokens using its configured issuer, JWKS URI, audience, required scope, expiry, and
subject. It supports RS256 and ES256, and never forwards caller Bearer tokens to NetBox.

| Gateway field                | Set                           | Source                                  |
| ---------------------------- | ----------------------------- | --------------------------------------- |
| `NETBOX_OIDC_ISSUER`         | Exact discovery `issuer`      | Authorization-server discovery document |
| `NETBOX_OIDC_JWKS_URL`       | Exact discovery `jwks_uri`    | Authorization-server discovery document |
| `NETBOX_OIDC_AUDIENCE`       | Stable MCP-only `aud` value   | Provider token/audience mapping         |
| `NETBOX_OIDC_REQUIRED_SCOPE` | MCP-only required scope       | Provider scope policy                   |
| `NETBOX_OIDC_RESOURCE_URL`   | Exact public HTTPS `/mcp` URL | Reverse-proxy DNS/TLS design            |

It publishes RFC 9728 metadata at
`/.well-known/oauth-protected-resource/mcp`. Ensure clients can reach the authorization
server's discovery and JWKS endpoints without an interactive proxy challenge.

### Authentik

Create a **separate Application + OAuth2/OIDC Provider** for MCP. Do not share the NetBox
UI provider/client: keep client ID, audience, `mcp` scope, authorization policy, consent,
and token lifetime separate.

| Authentik field         | Recommended value                                        | Leave/default                                             |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Application name / slug | `NetBox MCP` / `netbox-mcp`                              | No inherited NetBox UI policy                             |
| Provider type           | OAuth2/OIDC                                              | —                                                         |
| Client type             | Match connector; public + PKCE for native/public clients | Do not store its secret in gateway/proxy config           |
| OAuth grant             | Authorization Code + PKCE/S256                           | Disable OAuth implicit grant                              |
| Authorization flow      | Explicit consent for third-party/user-facing connectors  | Use implicit consent only after first-party policy review |
| Issuer mode             | Per-provider/default                                     | Do not reuse a NetBox issuer accidentally                 |
| Signing                 | RS256 or ES256 JWS                                       | Do not enable JWE                                         |
| Scope mapping           | Attach required `mcp` scope                              | Bind users/groups deliberately                            |
| Audience claim          | Emit stable MCP-only value, e.g. `netbox-mcp`            | Verify actual `aud` in a local test token                 |

Use the provider discovery document, normally
`https://<AUTHENTIK_HOST>/application/o/netbox-mcp/.well-known/openid-configuration`, to
copy `issuer` and `jwks_uri`. Configure exact connector-provided redirect URIs only. Do not
guess a ChatGPT, Copilot, or other client redirect URI; client registration behavior is
client-specific.

## 6. Agent integrations

| Agent/client                                   | Transport         | Project guidance                                                                                                                               |
| ---------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Desktop, Claude Code, Cursor, Codex CLI | stdio             | Supported/documented local integration; use absolute `npx` path and client configuration from README/AGENTS.md.                                |
| ChatGPT, Copilot, other remote connectors      | Remote HTTP OAuth | Manual/client-specific. Confirm that client supports the authorization server's registration and redirect-URI requirements before enabling it. |
| Any unlisted agent                             | Unknown           | Unsupported until its MCP transport, OAuth, and redirect behavior are verified.                                                                |

Do not claim a remote connector works merely because it can reach `/mcp`. It must complete
the 401/metadata/OAuth flow with a valid scoped token.

## 7. Validation and rollback

In this order, before enabling a connector:

1. Render runtime configuration; verify it names no token value.
2. Start the gateway privately; verify `/healthz` and `/readyz` privately.
3. Verify protected-resource metadata returns the exact public resource URL and issuer.
4. Verify a missing token returns `401` with `resource_metadata`, not HTML.
5. Verify a valid MCP `initialize` POST uses JSON, `Content-Type: application/json`, and
   `Accept` containing `application/json` and `text/event-stream`; expect `200` and
   `Mcp-Session-Id`.
6. Verify expired, wrong-audience, and missing-scope tokens fail; verify NetBox receives
   only its server token.
7. Preserve the prior image/configuration and restore it if health, metadata, or token
   checks fail. Remove public proxy routes first during rollback.
