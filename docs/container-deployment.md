# Container deployment

The container image is for an operator-controlled MCP host. The Compose
`deployment` profile deliberately declares no `ports:`. If an operator adds a port
mapping or reverse proxy in an overlay, they must set `NETBOX_HTTP_ALLOWED_HOSTS`
to the published `Host` values and protect the endpoint with TLS, OIDC, and a
firewall or network policy. Allowed hosts provide DNS-rebinding protection; they
are not authentication, because a direct client can forge `Host`.

`docker-compose.e2e.yml` is a separate, disposable NetBox fixture for explicit
E2E testing. It is not a deployment template and must not be combined with this
profile.

## Build metadata

The image records the standard OCI `version`, `revision`, and `created` labels.
Set the corresponding optional variables when a build is promoted; the defaults
make local builds visibly non-release artifacts:

```bash
export NETBOX_MCP_IMAGE_VERSION="0.2.0"
export NETBOX_MCP_IMAGE_REVISION="$(git rev-parse HEAD)"
export NETBOX_MCP_IMAGE_CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose --profile deployment build
```

## Environment and secret file

The Compose file requires the following operator-supplied values when HTTP is enabled:

- `NETBOX_URL`: the NetBox base URL, without `/api`. It is configuration, not a
  credential.
- `NETBOX_TOKEN_FILE`: an **absolute host path** to a file containing only the
  NetBox API token. Compose mounts it as the `netbox_token` secret and supplies
  `NETBOX_TOKEN_FILE=/run/secrets/netbox_token` to the process.
- `NETBOX_HTTP_ALLOWED_HOSTS`: comma-separated external `Host` values, including
  the published port when non-default.
- `NETBOX_OIDC_ISSUER`, `NETBOX_OIDC_JWKS_URL`, `NETBOX_OIDC_AUDIENCE`, and
  `NETBOX_OIDC_REQUIRED_SCOPE`: Authentik token-verification inputs.
- `NETBOX_OIDC_RESOURCE_URL`: canonical public HTTPS URL ending in `/mcp`.

HTTP fails closed unless all of these OIDC values are present. It serves RFC 9728
protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`; do not
put an Authentik client secret or a token in Compose configuration.

Never put `NETBOX_TOKEN`, a token literal, or an `env_file` containing a token
in `compose.yaml`, an image layer, a shell profile, or a committed `.env` file.
Keep the token file outside the repository and outside the Docker build context;
`.dockerignore` is deliberately allow-list based to prevent it being sent to the
Docker daemon. The server reads the mounted file before every NetBox request, so
rotate the file in the approved secret store and restart the Compose service if
the Compose implementation replaces rather than updates its file mount.

Compose implementations differ in how their file-backed `secrets:` mount applies
`uid`, `gid`, and `mode`. The profile requests `1000:1000` and `0400`, matching
the unprivileged `node` account. Before deployment, verify that the mounted file
is readable by that account and not writable by it or by the application
process. Use your container platform's managed secret facility if local Compose
cannot enforce that ownership and mode; do not fall back to an inline environment
variable.

Set only the URL and token-file _path_ in the launch environment, then inspect
the resolved configuration before starting it:

```bash
export NETBOX_URL="https://netbox.example.internal"
export NETBOX_TOKEN_FILE="/absolute/path/outside/the/repository/netbox-token"
export NETBOX_HTTP_ALLOWED_HOSTS="mcp.example.internal"
export NETBOX_OIDC_ISSUER="https://issuer.example.internal/application/o/netbox-mcp/"
export NETBOX_OIDC_JWKS_URL="https://issuer.example.internal/application/o/netbox-mcp/jwks/"
export NETBOX_OIDC_AUDIENCE="netbox-mcp"
export NETBOX_OIDC_REQUIRED_SCOPE="mcp"
export NETBOX_OIDC_RESOURCE_URL="https://mcp.example.internal/mcp"
docker compose --profile deployment config
```

The rendered configuration may contain the token-file path and URL, but must
never contain the token value. The image runs as UID/GID `1000`, drops every
Linux capability, forbids privilege escalation, uses a read-only root filesystem,
and has a bounded writable `/tmp` tmpfs for the schema cache.

## Start and verify

```bash
docker compose --profile deployment up --build -d
docker compose --profile deployment ps
docker compose --profile deployment logs netbox-mcp
```

The Compose healthcheck calls both `GET /healthz` and `GET /readyz` over the
container's loopback interface. A healthy service means the process is alive and
its HTTP listener has become ready; it does not validate that the NetBox URL or
token can complete an API request, because startup intentionally remains lazy.

There is no host port to browse in the default profile. Keep normal MCP use on
stdio. Running the image directly also preserves the image's stdio default; the
Compose profile is the explicit container-HTTP exception.

## Authentik and NPM exposure

Do not publish a port until the gateway is running with OIDC and a firewall rule
limits its published port to NPM. Host validation is DNS-rebinding protection,
not access control.

### Recommended Authentik boundary

Create a **separate Application and OAuth2/OIDC Provider** for MCP. Do not extend
NetBox's existing provider/client: separate provider settings isolate the MCP
client ID, audience, scope, authorization policy, consent history, token lifetime,
and revocation from the NetBox UI. A provider without an Application is possible,
but the Authentik combined Application + Provider workflow is the maintainable
choice.

In **Applications → Applications → Create**, use these values:

| Field               | Recommended value                                                                                                                                   | Why                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Application name    | `NetBox MCP`                                                                                                                                        | Distinct operator and user-facing identity.                            |
| Application slug    | `netbox-mcp`                                                                                                                                        | Produces the default per-provider discovery path.                      |
| Provider type       | `OAuth2/OIDC`                                                                                                                                       | The gateway validates OAuth Bearer access tokens.                      |
| Provider name       | `netbox-mcp`                                                                                                                                        | Keeps application and provider ownership obvious.                      |
| Client type         | Match the connector; use public + PKCE for a native/public client, confidential only where the client can protect its secret.                       | The gateway never needs the client secret.                             |
| Authorization grant | Authorization Code with PKCE/S256; disable the OAuth implicit grant.                                                                                | Avoids browser-token leakage.                                          |
| Authorization flow  | **Explicit consent** for third-party/user-facing connectors; implicit consent only for a tightly controlled first-party client after policy review. | This Authentik setting controls consent, not the OAuth implicit grant. |
| Issuer mode         | Per-provider/default.                                                                                                                               | Produces an isolated issuer and discovery document.                    |
| Signing             | RS256 or ES256 JWS; do not enable JWE encryption.                                                                                                   | The gateway accepts RS256/ES256 signed JWTs, not encrypted JWTs.       |
| Access policy       | Bind only intended groups/users.                                                                                                                    | NetBox MCP may expose infrastructure data and writes.                  |

Create a provider scope mapping named `mcp`, attach it to this provider, and
require clients to request it. Configure the provider's access-token audience
claim/claim mapping to emit exactly `netbox-mcp` (or choose another stable,
MCP-only value and use it consistently below). The audience and scope belong to
the **MCP provider**, not the NetBox application or NPM.

Add only connector-supplied, exact redirect URIs to the provider. Do not use
wildcards. If a connector requires client registration or a redirect URI not yet
known, stop there and obtain it from that connector's documentation; do not guess
or weaken redirect validation.

### Derive the gateway settings

After creating the provider, open its OpenID Connect discovery document, normally
at:

```text
https://AUTHENTIK_HOST/application/o/netbox-mcp/.well-known/openid-configuration
```

Copy the document's `issuer` and `jwks_uri` values; they are public, non-secret
URLs. The authorization and token endpoints remain Authentik client settings and
are not gateway environment variables. For a virtual MCP path under NetBox, use:

```text
NETBOX_HTTP_ALLOWED_HOSTS=home:8765,home.calan.lan:8765,netbox.calan.co
NETBOX_OIDC_ISSUER=<discovery issuer>
NETBOX_OIDC_JWKS_URL=<discovery jwks_uri>
NETBOX_OIDC_AUDIENCE=netbox-mcp
NETBOX_OIDC_REQUIRED_SCOPE=mcp
NETBOX_OIDC_RESOURCE_URL=https://netbox.calan.co/mcp
```

Before deployment, verify a locally decoded test access token has an exact `iss`,
`aud`, `scope` containing `mcp`, numeric `exp`, and nonempty `sub` matching those
values. Do not paste the token into a terminal command line, a config file, or a
support ticket. Never place an Authentik client secret, JWT, refresh token, or
private signing key in Compose, NPM, or this repository.

### NPM virtual-path configuration

Keep the existing `netbox.calan.co` Proxy Host and its NetBox default route. Do
not replace its forward host with the MCP gateway.

In that Proxy Host's **Custom Locations**, add both routes below. For each, set
**Forward Scheme** `http`, **Forward Hostname/IP** `home.calan.lan`, and **Forward
Port** `8765`:

| Location                                    | Purpose                               |
| ------------------------------------------- | ------------------------------------- |
| `/mcp`                                      | Streamable HTTP MCP endpoint.         |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 protected-resource metadata. |

Do not rewrite either location, append or remove a slash, or set a different Host
header. Enable Websockets Support on the Proxy Host and keep its existing TLS
certificate/Force SSL settings. In each location's Advanced configuration, add
only directives NPM does not already set:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_set_header Host $host;
proxy_set_header Authorization $http_authorization;
proxy_set_header X-Forwarded-Proto $scheme;
```

Do **not** add `proxy_pass` in the advanced field: NPM generates it from the
Custom Location fields. Do not use an NPM Access List or Authentik proxy/cookie
redirect for either MCP location. OAuth clients must receive the gateway's JSON
`401` Bearer `resource_metadata` challenge. If the existing NetBox authentication
configuration cannot exempt both paths, use a separate HTTPS hostname instead of
silently accepting redirects.

### Network restriction and verification

Restrict `home.calan.lan:8765` at the host firewall to NPM's source address only.
Do not forward it to the Internet or configure a tunnel. Keep `/healthz` and
`/readyz` private.

Before enabling a connector, verify:

1. `https://netbox.calan.co/.well-known/oauth-protected-resource/mcp` returns
   resource `https://netbox.calan.co/mcp` and the expected Authentik issuer.
2. `POST https://netbox.calan.co/mcp` without a Bearer token returns `401` with
   `WWW-Authenticate: Bearer resource_metadata=...`, not an HTML login redirect.
3. A valid scoped token succeeds; expired, wrong-audience, and missing-scope
   tokens fail.
4. The NetBox API sees only its configured server token, never the caller Bearer
   token.

The resource metadata endpoint lets OAuth-aware clients discover the Authentik
authorization server from the `401` Bearer challenge.
