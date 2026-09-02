# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/zenixsolutions/netbox-mcp-server/security/advisories/new)
on this repository. Include:

- what the vulnerability allows an attacker to do
- the steps to reproduce it
- the version or commit you tested against

We aim to acknowledge reports within a few business days. This is a small project
maintained alongside other work — please be patient, and we will keep you updated on
progress toward a fix.

## Scope

In scope:

- Leakage of `NETBOX_TOKEN`, `NETBOX_TOKEN_FILE` contents, auth headers, or token-file paths into logs, tool responses, error messages, or files
- Any path by which a tool call reaches a NetBox endpoint the caller did not intend —
  in particular, any way to make `object_type` resolve to an endpoint outside the
  registry, or to smuggle a path or URL through it
- A delete that proceeds without a correct `confirm` value
- Injection through tool arguments into the constructed HTTP request
- An upstream error body reaching the caller unbounded or unscrubbed
- Dependency vulnerabilities that are reachable from this code

Out of scope:

- Vulnerabilities in NetBox itself — report those to
  [NetBox](https://github.com/netbox-community/netbox/security/policy)
- Vulnerabilities in an MCP client (Claude Desktop, ChatGPT, Cursor, …)
- An LLM choosing to call `netbox_write` with a token that permits the write. The
  token's permissions are the control — see "Operating this safely" below.
- Anything requiring an attacker to already have write access to the user's machine

## Operating this safely

This server is a bridge between a language model and your infrastructure source of
truth. A few properties are worth understanding before you deploy it.

**The NetBox token is the only write control, and that is deliberate.** This server has
no read-only mode and no way to withhold a tool. If the assistant should not be able to
change anything, create the token with **write enabled unchecked** and constrain its
object permissions. NetBox enforces that, on NetBox's side, where no tool argument can
reach it.

Earlier versions shipped `NETBOX_READONLY` and `NETBOX_TOOL_GROUPS`, which chose
which tools to register. Both were removed in 0.1.0, and their removal strengthened
the posture rather than weakening it. A gate that the server chooses to honour was
never a boundary: it protects you exactly as long as the process behaves, and it
invites the belief that you are safe when nobody has checked the token. The cautionary
example is in this repository's own history — the installer that was removed alongside
them reported `mode: read-only` for values the server evaluated as false, registering
the entire write surface under an affirmative safety claim. A control that can
misreport is worse than no control, because it is trusted.

Verify the real boundary at the source: in NetBox, under your user menu > API Tokens,
check the token's **write enabled** flag and its object permissions.

**Deletes cascade and cannot be undone.** NetBox removes dependent objects: deleting a
device removes its interfaces, power ports, and assigned IPs; deleting a site can remove
its racks, devices, and prefixes. `netbox_write` therefore requires `confirm` to equal
the object's current `display` value — the caller has to read the object first, and a
mismatch refuses the delete and shows both values. This raises the cost of an
accidental delete; it does not prevent a deliberate one. Only the token does that.

**No tool accepts a path.** `netbox_read` and `netbox_write` take an `object_type` key
such as `dcim.device`, which is resolved to an endpoint through a registry derived from
the instance's own OpenAPI schema. There is no caller-supplied path or URL to traverse,
so path traversal is closed by construction rather than by filtering. An unknown key is
answered with near-misses, not with a request.

**Prompt injection is a real risk with write access.** Object descriptions, comments, and
custom fields in NetBox are attacker-influenceable in some environments, and a model that
reads them may be steered by their contents. If any of your NetBox data originates from
outside your organization, treat write access as high-risk and issue a token without
write enabled.

**Upstream error bodies are bounded and scrubbed.** Error mapping is centralised in
`src/errors.ts`: the request config — which carries the `Authorization` header — is
redacted, bodies are truncated, and an HTML response is described by its size rather
than relayed, so a NetBox error page or an intercepting proxy's login form cannot be
dumped into the model's context. Any new branch that touches `error.config` must keep
that redaction.

**Tokens live in client config files.** `~/Library/Application Support/Claude/
claude_desktop_config.json` and its equivalents are plaintext, and are created with the
default umask — usually world-readable. `chmod 600` them, and delete any `.bak` copy you
make while editing: a backup is a second copy of every token in the file, it inherits the
original's permissions, and nothing cleans it up. Set an expiry on every token, scope
tokens to the office IP range if your NetBox deployment supports it, and rotate them when
someone leaves — and remember that rotating a token does not help if an old copy of the
config still holds the previous one.

**Token files are an optional server-side credential source.** Set exactly one of `NETBOX_TOKEN` and `NETBOX_TOKEN_FILE`. The latter must name a readable regular file containing the token; it is read immediately before every NetBox request, so a secret-manager rotation is picked up without restarting the server. The file path and contents are deliberately never included in errors, logs, MCP arguments, or MCP results. Mount it with access limited to the server process and replace it atomically; an absent, unreadable, non-file, or empty rotation fails closed.

**`NETBOX_INSECURE=1` disables TLS certificate validation entirely**, which exposes the
token to anyone able to intercept the connection. Prefer installing your internal root CA
into the system trust store.

## Secret scanning

A real NetBox API token was briefly committed to this public repository, pasted into a
test fixture. The secret scan caught it on its first real run, and the token was
revoked.

The fix is worth stating because the obvious version of it would have been wrong.
`.gitleaks.toml` now allowlists the fabricated fixture credentials **by exact value,
and never by path**. Excluding the fixture's file would have been easier and would have
suppressed precisely the finding that mattered, in precisely the file where it happened.
Matching on the value keeps the scan live: any other secret-shaped string in that file,
or a real token pasted over one of the fakes, still trips it.

If you add a fixture that looks like a credential, make it obviously fake and add its
exact value to the allowlist. Do not add a path.

## Supported versions

Fixes land on `main` and go out in the next release. There is no long-term support
branch: upgrade to the latest published version of `@zenixsolutions/netbox-mcp` (or, if
you run from a clone, pull `main` and rebuild). If your client config pins a version,
bump the pin — a pinned `npx` invocation never picks up a fix on its own.
