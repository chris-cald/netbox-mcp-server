# OAuth metadata compatibility bridge

## Diagnosis

The gateway's RFC 9728 protected-resource metadata correctly identifies the authorization
server with `authorization_servers: ["<ISSUER>"]`. For the Authentik issuer
`https://auth.calan.co/application/o/netbox`, OIDC discovery is available at:

```text
https://auth.calan.co/application/o/netbox/.well-known/openid-configuration
```

It advertises `code_challenge_methods_supported` including `S256`. That is enough for an OIDC
client that uses OpenID Connect Discovery. It is not enough for a client that follows the RFC
8414 authorization-server metadata discovery URL and requires its own
`code_challenge_methods_supported` member.

RFC 8414 section 3.1 derives the path-bearing issuer's metadata URL by inserting
`/.well-known/oauth-authorization-server` before the issuer path:

```text
https://auth.calan.co/.well-known/oauth-authorization-server/application/o/netbox
```

If that URL returns `404` (including when requested without a trailing slash), ChatGPT cannot
obtain RFC 8414 metadata even though the OIDC discovery document advertises `S256`. This is an
Authentik/RFC-8414 discovery-compatibility gap, not a gateway PKCE setting or a missing PKCE
claim.

Sources: [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html),
[RFC 8414 section 3.1](https://www.rfc-editor.org/rfc/rfc8414.html#section-3.1),
[MCP authorization-server discovery](https://modelcontextprotocol.io/specification/draft/basic/authorization/authorization-server-discovery),
and [OpenAI auth guidance](https://developers.openai.com/plugins/build/auth).

## Compatibility bridge

Do not change Authentik, NPM, or DNS until separately authorized. If ChatGPT still requires
RFC 8414 metadata, serve a static **metadata-only bridge** at the exact RFC 8414 URL on the
same `auth.calan.co` HTTPS origin. It must not proxy credentials, perform authentication, issue
tokens, or replace Authentik endpoints.

### Bridge inputs

Collect only public values from the already-working OIDC discovery document; do not copy a
client secret or token.

| JSON field                         | Entered value                                | Source                         |
| ---------------------------------- | -------------------------------------------- | ------------------------------ |
| `issuer`                           | `https://auth.calan.co/application/o/netbox` | OIDC discovery `issuer`        |
| `authorization_endpoint`           | exact discovered endpoint                    | OIDC discovery                 |
| `token_endpoint`                   | exact discovered endpoint                    | OIDC discovery                 |
| `jwks_uri`                         | exact discovered endpoint                    | OIDC discovery                 |
| `scopes_supported`                 | exact discovered list                        | OIDC discovery/provider policy |
| `code_challenge_methods_supported` | `["S256"]` plus only methods discovered      | OIDC discovery                 |

The returned `issuer` must exactly equal the gateway's `NETBOX_OIDC_ISSUER`. Do not invent an
issuer or change it to the bridge URL.

### Static response template

Render public values into this JSON document. Retain only fields whose values are present in
the live OIDC discovery document.

```json
{
  "issuer": "https://auth.calan.co/application/o/netbox",
  "authorization_endpoint": "<OIDC authorization_endpoint>",
  "token_endpoint": "<OIDC token_endpoint>",
  "jwks_uri": "<OIDC jwks_uri>",
  "scopes_supported": ["<OIDC scope>"],
  "code_challenge_methods_supported": ["S256"]
}
```

### Required proxy behavior

When authorized, route only this exact path to the static bridge with no rewrite:

```text
/.well-known/oauth-authorization-server/application/o/netbox
```

Set `Content-Type: application/json`; return `200`; preserve the public `auth.calan.co`
origin. Do not route `/application/o/netbox/.well-known/openid-configuration`: Authentik already
owns it. Keep the bridge endpoint public because OAuth clients must discover it.

### Verification and rollback

```sh
curl -fsS https://auth.calan.co/.well-known/oauth-authorization-server/application/o/netbox
```

Expected result: JSON with the exact issuer and
`"code_challenge_methods_supported":["S256"]`. Confirm it contains no secret values. Do not
claim ChatGPT compatibility or retry production registration until CIMD, DCR, or predefined
client requirements are separately proven end to end. Roll back by deleting only the bridge
route/service; the existing Authentik OIDC discovery endpoint remains unchanged.

## OpenTofu

OpenTofu is desired-state automation, not a protocol fix. It can later manage the Authentik
provider/application, scope mapping, NPM route, bridge service, and verification data after a
reviewed provider/module and explicit authorization exist. It cannot make Authentik emit RFC
8414 metadata by itself. Keep bridge JSON public-only and obtain all secret values from the
secret manager at apply time; do not put them in Terraform/OpenTofu variables, state, plans, or
this repository. For the reviewed static-container, NPM, method, cache, CORS, verification,
and rollback design, see [OAuth authorization-server metadata bridge design](oauth-metadata-bridge-design.md).
