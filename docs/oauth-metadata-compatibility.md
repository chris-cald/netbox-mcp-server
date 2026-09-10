# OAuth metadata compatibility prerequisite

## Diagnosis

Authentik `2025.2.4` predates RFC 8414 authorization-server metadata support. Authentik PR
[#12383](https://github.com/goauthentik/authentik/pull/12383) was merged as `c876b28` on 2025-07-24
and released in Authentik `2025.8`; it adds the path-bearing issuer endpoint:

```text
/.well-known/oauth-authorization-server/application/o/<slug>/
```

Therefore the correct protocol fix is an Authentik upgrade to `>=2025.8`, not a static bridge.
Do not deploy an NPM route, container, or bridge. The current `2025.2.4` `404` is expected.

## Post-upgrade gate

After separately authorized upgrade and rollback planning, query both public documents:

```sh
curl -fsS https://auth.calan.co/application/o/netbox/.well-known/openid-configuration
curl -fsS https://auth.calan.co/.well-known/oauth-authorization-server/application/o/netbox/
```

Expected results: valid JSON; exact issuer
`https://auth.calan.co/application/o/netbox`; an RFC 8414 response with authorization/token/JWKS
endpoints; and `code_challenge_methods_supported` containing `S256`. A `404`, HTML response,
issuer mismatch, or missing `S256` blocks ChatGPT setup.

## Public MCP route gate

**Current observed state:** Authentik OIDC and RFC 8414 documents now return JSON with
`["plain","S256"]`; that gate has passed. In contrast,
`https://netbox.calan.co/mcp` and
`https://netbox.calan.co/.well-known/oauth-protected-resource/mcp` return NPM/OpenResty `404`.
No public gateway resource metadata or OAuth challenge is live, so the earlier ChatGPT PKCE
error cannot be attributed to gateway metadata.

Do not retry ChatGPT. After separate authorization, stage the OIDC-enabled gateway deployment
first, then add NPM Custom Locations for exactly `/mcp` and
`/.well-known/oauth-protected-resource/mcp` with no URI rewrite. Verify, in order:

```sh
curl -iS https://netbox.calan.co/.well-known/oauth-protected-resource/mcp
curl -iS -X POST https://netbox.calan.co/mcp
```

Expected results are `200` JSON identifying the protected resource/issuer, then `401` with a
Bearer `resource_metadata` challenge—not an NPM `404` or login HTML. Only then continue to the
separate ChatGPT registration gate.

## Separate ChatGPT gate

Passing the Authentik metadata and public MCP route checks does **not** establish ChatGPT compatibility. CIMD, DCR, and
predefined-client support remain unproven. Do not advertise `registration_endpoint` or
`client_id_metadata_document_supported` unless Authentik actually implements the selected flow.
Only an end-to-end ChatGPT authorization, callback, token exchange, and MCP `initialize` test
can clear that gate.

## OpenTofu

OpenTofu can manage reviewed Authentik image/version desired state and later provider/application
configuration. It is not the RFC 8414 protocol fix and must not apply an upgrade, expose an MCP
route, or manage secrets without separate authorization.
