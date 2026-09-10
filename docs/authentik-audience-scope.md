# Authentik 2026.5.7: MCP scope and audience

Do not make these changes without separate authorization. This procedure uses public values
only and follows [OAuth2 providers](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)
and [property mappings](https://docs.goauthentik.io/add-secure-apps/providers/property-mappings/).

## Audience

Authentik normal OAuth2 access tokens use the OAuth2 provider **Client ID** as `aud`; 2026.5.7
has no separate resource-audience field. In Admin Interface open **Applications** →
**Providers** → **NetBox MCP** OAuth2/OIDC provider and copy the displayed **Client ID**. Set:

```text
NETBOX_OIDC_AUDIENCE=<copied provider Client ID>
```

Do not enter `netbox-mcp`, guess a Client ID, or use a scope mapping to write `aud`. If the
claim-only verification below does not show exactly that Client ID in `aud`, stop: gateway
exact-audience validation is incompatible/unresolved.

## Scope mapping and binding

**Prerequisites:** Authentik 2026.5.7 admin access and existing NetBox MCP OAuth2/OIDC provider.
Stop if either is absent.

1. **Customization** → **Property Mappings** → **Create** → **OAuth2 Scope Mapping**.
2. Change only these fields; leave all other fields at their UI defaults:

   | Field | Value | Source |
   | --- | --- | --- |
   | Name | `NetBox MCP scope` | local naming |
   | Scope name | `mcp` | gateway required scope |
   | Expression | `return {}` | avoid overwriting reserved claims |

   ```python
   return {}
   ```

3. Click **Create**. Expected result: mapping `NetBox MCP scope` shows scope name `mcp`.
4. **Applications** → **Providers** → **NetBox MCP** → **Scopes**: add `NetBox MCP scope`;
   leave existing standard scopes unchanged; click **Update**.
5. **Applications** → **Applications** → **NetBox MCP** → **Policy / Group / User Bindings**:
   create a binding for the approved group, user, or policy; leave other application bindings
   unchanged; click **Create**.
6. In the client authorization request, request `scope=openid mcp`. Expected access-token scope
   is space-delimited and contains `mcp`.

## Claim-only verification

This reads a pasted test token silently and prints only claims—not the token:

```sh
read -rs ACCESS_TOKEN; printf '%s' "$ACCESS_TOKEN" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=s.trim().split(".")[1];if(!p)process.exit(2);const c=JSON.parse(Buffer.from(p.replace(/-/g,"+").replace(/_/g,"/"),"base64url"));console.log(JSON.stringify(Object.fromEntries(["iss","aud","scope","sub","exp"].filter(k=>k in c).map(k=>[k,c[k]])),null,2));});
'; unset ACCESS_TOKEN
```

Expected output: exact issuer, provider Client ID `aud`, `mcp` in `scope`, nonempty `sub`, and
numeric `exp`. Any other result is a stop condition.
