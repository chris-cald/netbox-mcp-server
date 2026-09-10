# OAuth authorization-server metadata bridge design

This is a reviewed design, **not** a deployment instruction. It makes no Authentik, NPM, DNS,
container, or OpenTofu change. Its only purpose is to serve RFC 8414 public metadata where an
OAuth client cannot use Authentik's working OIDC discovery endpoint.

## Scope and security boundary

The bridge is a static, internal-only HTTP container. NPM is the sole permitted caller; NPM
publishes one exact HTTPS path on the existing `auth.calan.co` host:

```text
/.well-known/oauth-authorization-server/application/o/netbox
```

The bridge must not proxy Authentik, accept a request body, set cookies, receive a Bearer token,
issue a token, expose a client secret, or implement an authorization/token/registration endpoint.
It returns only a checked-in-or-mounted **public** JSON file. Firewall/container networking must
allow only NPM to reach it. The public listener remains NPM's TLS endpoint.

## Build the static document

Obtain the input only from this live, public OIDC discovery response:

```sh
curl -fsS https://auth.calan.co/application/o/netbox/.well-known/openid-configuration
```

Before rendering, require JSON, exact issuer
`https://auth.calan.co/application/o/netbox`, and
`code_challenge_methods_supported` containing `S256`. Stop if any required value is missing.
Copy values verbatim; do not infer URLs, algorithms, scopes, grants, or authentication methods.

| RFC 8414 member                         | Include           | Source in OIDC discovery   | Rule                                         |
| --------------------------------------- | ----------------- | -------------------------- | -------------------------------------------- |
| `issuer`                                | yes               | `issuer`                   | must exactly equal gateway issuer            |
| `authorization_endpoint`                | yes               | `authorization_endpoint`   | copy exactly                                 |
| `token_endpoint`                        | yes for code flow | `token_endpoint`           | copy exactly                                 |
| `jwks_uri`                              | yes               | `jwks_uri`                 | copy exactly                                 |
| `scopes_supported`                      | only if present   | `scopes_supported`         | copy exact array                             |
| `response_types_supported`              | only if present   | `response_types_supported` | copy exact array                             |
| `grant_types_supported`                 | only if present   | `grant_types_supported`    | copy exact array                             |
| `token_endpoint_auth_methods_supported` | only if present   | same-named member          | copy exact array                             |
| `code_challenge_methods_supported`      | yes               | same-named member          | include `S256`; copy only discovered methods |

Do **not** add `registration_endpoint`, `device_authorization_endpoint`, an introspection or
revocation endpoint, a JWKS private key, a client ID, a client secret, or a claim saying DCR is
supported. A bridge cannot supply those capabilities.

### JSON template

Omit every optional member that Authentik discovery did not return. Replace placeholders only
with exact public discovery values.

```json
{
  "issuer": "https://auth.calan.co/application/o/netbox",
  "authorization_endpoint": "<discovered authorization_endpoint>",
  "token_endpoint": "<discovered token_endpoint>",
  "jwks_uri": "<discovered jwks_uri>",
  "scopes_supported": ["<discovered scope>"],
  "response_types_supported": ["<discovered response type>"],
  "grant_types_supported": ["authorization_code"],
  "token_endpoint_auth_methods_supported": ["<discovered auth method>"],
  "code_challenge_methods_supported": ["S256"]
}
```

## Static bridge container

Use a minimal unprivileged NGINX-based image or an equivalent reviewed static-file server. The
container listens only on an internal network; it has no host port and no Authentik credentials.
This example is the complete static-server behavior, not a Compose deployment file:

```nginx
server {
  listen 8080;
  server_name _;
  server_tokens off;
  default_type application/json;
  add_header Cache-Control "public, max-age=300, must-revalidate" always;
  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;

  location = /healthz {
    limit_except GET { deny all; }
    default_type application/json;
    return 200 '{"status":"ok"}\n';
  }

  location = /.well-known/oauth-authorization-server/application/o/netbox {
    limit_except GET { deny all; }
    try_files /oauth-authorization-server-netbox.json =404;
  }

  location / { return 404; }
}
```

Mount `oauth-authorization-server-netbox.json` read-only into the server's static root. Require
file mode readable by the unprivileged server process and verify it contains no secret-shaped
values before release. The `limit_except` policy permits only `GET`; `POST`, `PUT`, `PATCH`, `DELETE`, and `HEAD`
return `403`. NPM must not forward request bodies. Add explicit `HEAD` support only after a
client requirement and verification justify it.

**CORS:** omit `Access-Control-Allow-Origin` by default. OAuth metadata discovery is normally
server-to-server. Add an exact allow-origin only after a verified browser requirement identifies
the exact origin; never use `*` while credentials are involved. This bridge never uses browser
credentials.

**Cache:** five minutes avoids serving stale endpoints/scopes after an Authentik change while
allowing normal metadata caching. Set `Cache-Control: no-store` instead when change propagation
must be immediate; do not set a longer cache without an expiry/rotation review.

## NPM route design

Do not change the existing Authentik application routes. On the existing `auth.calan.co` Proxy
Host, add one Custom Location with these exact values only after separate authorization:

| NPM field             | Value                                                          | Leave unchanged                        |
| --------------------- | -------------------------------------------------------------- | -------------------------------------- |
| Location              | `/.well-known/oauth-authorization-server/application/o/netbox` | all other locations                    |
| Forward Scheme        | `http` on NPM-to-bridge internal network                       | public host TLS/Force SSL              |
| Forward Hostname/IP   | internal bridge service DNS name                               | Authentik upstream                     |
| Forward Port          | `8080`                                                         | all other ports                        |
| Cache Assets          | disabled                                                       | default app caching elsewhere          |
| Block Common Exploits | enabled                                                        | —                                      |
| Websockets Support    | disabled                                                       | —                                      |
| Access List           | public metadata route; do not attach a cookie-login list       | existing Authentik route access policy |

Do not rewrite the URI, set `proxy_pass` in Advanced, forward `Authorization`, or forward
cookies. Use only the NPM-generated proxy location plus this Advanced text:

```nginx
proxy_http_version 1.1;
proxy_pass_request_body off;
proxy_set_header Content-Length "";
proxy_set_header Authorization "";
proxy_set_header Cookie "";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
```

NPM Access Lists are Proxy Host scoped. If the existing `auth.calan.co` host cannot expose this
single metadata route without affecting Authentik, do not weaken it: use an explicitly reviewed
separate public issuer/authorization-server design instead. A different hostname cannot be
substituted for the existing issuer by this bridge.

## Health, verification, rollback

From NPM's internal network:

```sh
curl -fsS http://<BRIDGE_SERVICE_DNS>:8080/healthz
curl -fsS http://<BRIDGE_SERVICE_DNS>:8080/.well-known/oauth-authorization-server/application/o/netbox
```

Expected results: `{"status":"ok"}` and the rendered JSON respectively. From the public
origin after the NPM route is present:

```sh
curl -iS https://auth.calan.co/.well-known/oauth-authorization-server/application/o/netbox
```

Expected result: `200`, `Content-Type: application/json`, the exact issuer, and
`"code_challenge_methods_supported":["S256"]`; no `Set-Cookie`, `Authorization`, client secret,
or token text. `curl -i -X POST` to the same public URL must return `403` or `405` and no JSON
body other than an error. Retry ChatGPT only after all checks pass.

Rollback is deterministic: remove the one NPM Custom Location, stop/remove the bridge
container, and remove its internal network rule. Do not change Authentik discovery, issuer,
provider, scope, signing key, or the gateway to roll back the bridge.

## ChatGPT compatibility boundary

**Status: blocked; this bridge is not ChatGPT-ready.** RFC 8414 metadata plus `S256` alone does
not establish compatibility. OpenAI's OAuth documentation describes ChatGPT support for PKCE,
predefined OAuth clients, Dynamic Client Registration (DCR), and Client ID Metadata Documents
(CIMD); its authorization-server metadata example includes both
`client_id_metadata_document_supported` and `registration_endpoint`; see
[OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth).

The static bridge must not add either member unless the live authorization server actually
implements the corresponding behavior. It does **not** create DCR, CIMD processing, client
registration, redirect-URI validation, consent behavior, or token endpoint authentication.
Authentik compatibility is unconfirmed for all three ChatGPT client-registration paths:

| ChatGPT path      | Authentik status | Required proof before advertising it                                                                                  |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| CIMD              | unconfirmed      | Authentik accepts and validates a Client ID Metadata Document URL as `client_id`                                      |
| DCR               | unconfirmed      | Authentik publishes a working `registration_endpoint` and ChatGPT registers a client                                  |
| Predefined client | unconfirmed      | ChatGPT UI supplies a stable client ID and exact redirect URI; Authentik accepts both and full authorization succeeds |

Do not advertise `registration_endpoint` or `client_id_metadata_document_supported` in bridge
JSON. Confirm the selected path from current OpenAI documentation and perform an end-to-end
ChatGPT authorization, callback, token exchange, and MCP `initialize` test before describing
this integration as supported. If Authentik cannot meet the selected path, use an authorization
server that can; the bridge is not a substitute.

## OpenTofu desired state

OpenTofu can later manage the desired state of the Authentik application/provider, public scope
mapping, NPM Custom Location, internal bridge container/network policy, and public JSON checksum.
It must treat the static JSON as a public artifact. Keep secrets in the secret manager and out of
variables, plan output, state, and repository history. OpenTofu does not change protocol
behavior: it only applies the reviewed bridge configuration after separate authorization.
