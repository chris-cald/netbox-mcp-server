# Container deployment

The container image is for an operator-controlled MCP host. It does **not** make
this server a public HTTP service: public HTTP remains unavailable. The Compose
`deployment` profile binds Streamable HTTP to `127.0.0.1` inside the container
and deliberately declares no `ports:`. Do not add a port mapping, reverse proxy,
tunnel, or public/wildcard bind as a workaround; remote HTTP-only clients remain
unsupported until the TLS-terminating proxy/TLS milestone.

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

The Compose file requires only two operator-supplied values:

- `NETBOX_URL`: the NetBox base URL, without `/api`. It is configuration, not a
  credential.
- `NETBOX_TOKEN_FILE`: an **absolute host path** to a file containing only the
  NetBox API token. Compose mounts it as the `netbox_token` secret and supplies
  `NETBOX_TOKEN_FILE=/run/secrets/netbox_token` to the process.

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

There is no host port to browse and no supported remote endpoint. Keep normal
MCP use on stdio. Running the image directly also preserves the image's stdio
default; the Compose profile is the explicit, loopback-only HTTP exception.
