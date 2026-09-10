# Authentik 2026.5.7 audience and scope configuration

This procedure is documentation only. It does not create a provider, mapping, policy, or token.
It follows Authentik's current OAuth2 provider and property-mapping documentation:
<https://docs.goauthentik.io/add-secure-apps/providers/oauth2/> and
<https://docs.goauthentik.io/add-secure-apps/providers/property-mappings/>.

## Compatibility decision

For an Authentik OAuth2 provider, the access-token audience is the provider **Client ID**. This
is the only supported provider-specific audience control documented for normal OAuth tokens;
there is no separate resource-audience field in the 2026.5.7 provider UI to set
`netbox-mcp`. Therefore set:

```text
NETBOX_OIDC_AUDIENCE=<Client ID shown by the NetBox MCP OAuth2 provider>
```

Do not set `NETBOX_OIDC_AUDIENCE=netbox-mcp`, decode a token to discover a value, or use a
scope mapping to overwrite `aud`. The provider Client ID is the configuration source of truth;
the local verification below confirms the resulting claim without printing the token. If `aud`
does not equal that Client ID, stop: do not deploy the gateway with an audience value and do not
attempt a custom `aud` claim override. That is an incompatible/unresolved configuration.

## Create the required `mcp` scope mapping

### Prerequisites

- Authentik 2026.5.7 administrator access.
- The separate **NetBox MCP** OAuth2/OIDC provider already exists.
- The provider's Client ID has been recorded as the intended gateway audience.

Stop if the provider is missing or the Client ID cannot be displayed in the Admin UI.

1. In Authentik Admin Interface, open **Customization** → **Property Mappings** → **Create**.
2. Choose **OAuth2 Scope Mapping**.
3. Enter only these changed fields; leave every other field at the UI default:

   | Field      | Enter              | Source                                                                         |
   | ---------- | ------------------ | ------------------------------------------------------------------------------ |
   | Name       | `NetBox MCP scope` | local naming convention                                                        |
   | Scope name | `mcp`              | gateway required scope                                                         |
   | Expression | `return {}`        | scope grant is represented by requested scope; do not override reserved claims |

   ```python
   return {}
   ```

4. Click **Create**. Expected result: `NetBox MCP scope` appears in Property Mappings and shows
   scope name `mcp`.
5. Open **Applications** → **Providers** → the **NetBox MCP** OAuth2/OIDC provider. In the
   provider's **Scopes** selector, add `NetBox MCP scope`; leave existing `openid`, `profile`,
   `email`, and any other required mappings unchanged. Click **Update**.
6. Open **Applications** → **Applications** → **NetBox MCP**. Use **Policy / Group / User
   Bindings** to add the already-approved group/policy that may request this provider. Leave
   bindings for other applications unchanged. Click **Create** or **Update**.
7. The client must request `scope=openid mcp` (plus only client-required standard scopes) in its
   authorization request. Do not request `mcp` from a different provider. Expected result: the
   issued access token's space-delimited `scope` claim includes `mcp`.

The mapping expression deliberately returns no custom claims. Authentik uses the requested scope
name to construct the token's `scope` claim; adding `{"scope": "mcp"}` is unsafe because it can
replace the server-generated scope set.

## Claim-only local verification

Paste a test access token at the silent prompt. The command reads it from stdin, prints only
selected claim names/values, and does not write the token to a file, shell history, or stdout.

```sh
read -rs ACCESS_TOKEN; printf '%s' "$ACCESS_TOKEN" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const p = s.trim().split(".")[1];
  if (!p) process.exitCode = 2;
  else {
    const c = JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"), "base64url"));
    console.log(JSON.stringify(Object.fromEntries(["iss","aud","scope","sub","exp"].filter(k => k in c).map(k => [k, c[k]])), null, 2));
  }
});
'; unset ACCESS_TOKEN
```

Expected result: output contains the provider Client ID in `aud`, `mcp` in the space-delimited
`scope`, nonempty `sub`, exact issuer, and numeric `exp`. It must not print the compact JWT.
If any expectation fails, stop and correct the Authentik provider/mapping/requested scope before
setting gateway environment values.
