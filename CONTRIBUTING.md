# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

**Security issues do not belong here** — see [SECURITY.md](SECURITY.md) for private
reporting.

## Getting set up

Node.js >= 20.11 is required (`engines.node` in `package.json`; CI runs 20 and 22).

```bash
git clone https://github.com/zenixsolutions/netbox-mcp-server.git
cd netbox-mcp-server
npm ci
npm run build
```

Run `npm ci` in a shell with no `NETBOX_TOKEN` exported — it runs the install scripts of
every package in the dependency tree, and each one inherits your environment.

To iterate:

```bash
npm run dev     # tsx watch src/index.ts
```

You need a NetBox instance to test against. The public
[NetBox demo](https://demo.netbox.dev/) works for read-only exploration; for anything
involving writes, run NetBox locally with Docker rather than pointing at production.

## Before opening a pull request

```bash
npm run typecheck      # tsc --noEmit over sources and tests
npm run lint           # eslint
npm run format:check   # prettier --check; `npm run format` fixes
npm test               # vitest run
npm run build          # must pass with no TypeScript errors
npm audit              # review new advisories
```

`npm audit` is a review step, not a pass/fail gate. The advisories it currently reports
arrive transitively through `@modelcontextprotocol/sdk` and clear when that dependency
updates. What matters is that your change introduces none of its own.

And confirm the tool surface still registers as expected:

```bash
node dist/index.js --list-tools
```

That must print exactly six tools — `netbox_global_search`, `netbox_discover`,
`netbox_describe`, `netbox_read`, `netbox_write`, `netbox_invoke` — and needs no
credentials. The count is a deliberate design property, not an incidental one: adding a
seventh tool is an architectural change, not a routine addition. Raise it in an issue first.

## Adding an object type

You almost certainly do not need to. There is no per-resource code and no registration
step. Object types are **derived at runtime** from the instance's own OpenAPI schema
(`/api/schema/`), so a NetBox that exposes a resource — including one from a plugin —
already has it, with no change here and no release.

If an object type is missing or resolves badly, the bug is in derivation, under
`src/schema/`:

- `loader.ts` fetches and caches the schema document.
- `registry.ts` builds the `object_type` registry from it and resolves the read, write,
  and patch component for each entry. Note the invariant it enforces: a write schema is
  resolved by `$ref` from an operation, **never by component name**, because a name rule
  resolves to the wrong schema rather than failing. The `writeSchemasResolvedByName`
  diagnostic must stay at zero.
- `describe.ts` renders an entry into the field documentation `netbox_describe` returns.
- `provider.ts` and `types.ts` hold the caching seam and the shared types.

Changes here affect every object type at once, so cover them in `tests/unit/schema-*`
and check the diagnostics rather than spot-checking one resource. `src/index.ts` is argv
parsing only — nothing is wired there.

## Conventions

- Tool descriptions are the model's only documentation — write them for an LLM that has
  never seen NetBox. Say what the tool does, when to use it instead of a neighbouring
  tool, and what the arguments mean in NetBox's terms.
- `netbox_write` is separate from `netbox_read` so that `destructiveHint: true` is
  honest — every call to it can change NetBox. Keep that split, keep the annotations
  accurate, and keep spelling out what cascades.
- Never log, echo, or interpolate `NETBOX_TOKEN` into a response or error string.
- Keep responses under the `CHARACTER_LIMIT` in `src/constants.ts`; use the pagination
  helpers in `src/formatting.ts` rather than truncating by hand.
- No new runtime dependencies without a good reason. The dependency surface is
  deliberately small: the MCP SDK, axios, and zod.

## Documentation changes

`AGENTS.md` is written to be executed by an AI assistant, not skimmed by a person. When
editing it, keep steps imperative and unambiguous, state the expected output of every
command, and give the fix inline rather than deferring to "consult the docs." If you find
a step that caused an assistant to guess or improvise, that is a bug worth reporting even
without a fix attached.
