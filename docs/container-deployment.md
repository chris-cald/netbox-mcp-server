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

1. In Authentik, create an OAuth2/OIDC provider and application for this MCP
   resource. Configure an access-token audience and scope (for example,
   `netbox-mcp` and `mcp`), then obtain these **non-secret** values from its
   discovery document or provider settings: issuer, JWKS URL, audience, and
   required scope. Do not put a client secret, access token, or private key in
   Compose, NPM, or this repository.
2. Choose the final HTTPS URL, for example `https://mcp.example.com/mcp`. Set
   `NETBOX_OIDC_RESOURCE_URL` to that exact URL. Add `mcp.example.com` to
   `NETBOX_HTTP_ALLOWED_HOSTS` (no `:443` for default HTTPS) alongside any
   retained private host values. The resource URL and forwarded `Host` must
   agree exactly.
3. Configure NPM only after the authenticated gateway is healthy: proxy the
   public hostname to `http://home.calan.lan:8765`, preserve the public `Host`
   header, enable its TLS certificate and force HTTPS. Do not make NPM’s access
   list the authentication boundary; the gateway validates Authentik JWTs.
4. Restrict `home.calan.lan:8765` at the host firewall to NPM’s source address.
   Do not forward it to the Internet or configure a tunnel. Keep `/healthz` and
   `/readyz` private as well.
5. Verify before enabling a connector: the protected-resource metadata endpoint
   returns its exact resource URL and Authentik issuer; an MCP request without a
   token returns `401` with `resource_metadata`; a valid scoped token succeeds;
   expired, wrong-audience, and missing-scope tokens fail; and the NetBox API
   sees only its configured server token, never the caller Bearer token.

The resource metadata endpoint is
`/.well-known/oauth-protected-resource/mcp`. It lets OAuth-aware clients discover
the Authentik authorization server from the `401` Bearer challenge.
