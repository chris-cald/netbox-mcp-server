# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is **not yet stable**. While the version is below `1.0.0`, the tool
surface may change in a minor release, with the change noted here.

## [Unreleased]

### Added

- **Container operations profile.** A multi-stage, non-root Docker image now
  carries OCI version/revision/created metadata. The separate Compose
  `deployment` profile consumes a mounted token file, makes its root filesystem
  read-only, drops Linux capabilities, and checks loopback `/healthz` and
  `/readyz`; it deliberately publishes no port. CI builds and starts that
  profile with an ephemeral file-backed dummy secret, while the disposable
  NetBox E2E fixture remains separate. It publishes no port by default.

- **Streamable HTTP MCP transport with optional OIDC.** Set
  `NETBOX_TRANSPORT=http` with `NETBOX_HTTP_ALLOWED_HOSTS` to serve MCP at `/mcp`
  and unauthenticated `/healthz` and `/readyz` probes on container port 3000.
  Optional canonical HTTPS issuer/JWKS settings and exact audience authenticate
  callers; every MCP request requires an expiring RS256/ES256 Bearer token and
  binds sessions to its issuer and subject. Gateway credentials are not forwarded
  to NetBox, which continues to use only its configured API token.

### Fixed

- **HTTP Host-header bypass in container deployments.** HTTP now requires
  `NETBOX_HTTP_ALLOWED_HOSTS`, an explicit comma-separated published-host policy.
  The listener still uses the conventional container port and Compose controls
  port mappings; the policy is DNS-rebinding protection, not authentication.
  Network-reachable deployments require TLS, OIDC, and firewall or network policy.

- **The release workflow never shipped the skill.** `docs/installing-the-skill.md`
  said the artifacts were attached to each GitHub release. They were not:
  `release.yml` published to npm and stopped — it never ran `build:skill`, never
  created a release, never uploaded an asset. **v0.2.0 produced no GitHub
  release at all, only a tag.** Nothing failed, because nothing was watching.

  This matters because the skill is not in the npm tarball either, and cannot
  be: `files` points at `dist`, and the publish job's build step is `tsc`, so
  `dist/skills/` does not exist when `npm pack` runs. The GitHub release is the
  only place a user on ChatGPT desktop or Grok Build can get the skill as a
  file. Until now the only route was to clone the repo and build it.

  A `github-release` job now packages both artifacts, verifies neither built
  empty, takes its notes from the changelog section the publish job already
  gated on, and uploads them. It is a separate job so that `contents: write`
  stays off the job holding an npm credential, and `needs: publish` so a failed
  publish cannot leave behind a release announcing a version that is not on the
  registry. Five assertions in `tests/unit/workflow-step-order.test.ts` pin all
  of that.

## [0.2.0] - 2026-08-17

### Added

- **NetBox deprecation warnings, surfaced through `netbox_describe`**
  (`src/schema/deprecations.ts`). NetBox emits no machine-readable deprecation
  signal — no `Deprecation` or `Sunset` header, no `deprecated: true` anywhere
  in the OpenAPI document, for any deprecated model. Verified against 4.6.8. A
  client cannot detect any of it at runtime, which is why this one table is
  hand-maintained while the rest of the layer is derived.

  It is **advisory only**. Nothing is blocked, nothing is refused, and there is
  no switch to turn it into a gate. Write access remains the NetBox token's
  `write_enabled` flag and object permissions, enforced by NetBox where no tool
  argument can reach them.

  Covered: `dcim.inventoryitem`, `dcim.inventoryitemrole` and
  `dcim.inventoryitemtemplate` (deprecated 4.3, #19004, still full CRUD in
  4.6.8 — and note that **5.0 appears only in the tracking issue**: the release
  notes and all three model docs say "a future NetBox release", so the note
  says that too); `dcim.interface.mac_address` and
  `virtualization.interface.mac_address`; `ipam.vlan.site` (deprecated 4.4,
  **no removal version announced at all**); `dcim.module.local_context_data`
  (removed in a _patch_ release, 4.6.3); `dcim.frontport.rear_port` and
  `rear_port_position` (removed 4.5 for `PortMapping`); writes to
  `dcim.cabletermination` (405 since 4.5); and v1 API tokens.

  Deprecations appear on **read** operations as well as writes — a caller
  enumerating inventory items in order to migrate off them should be told why.

- The modular-hardware modelling doctrine, and a deprecations reference, in the
  `netbox-modeling` skill. Modules generate interfaces; interfaces never hold
  modules; cables terminate only on interfaces, so the module install precedes
  the cable. Covers the `{module}` / `{module}/N` / `eth/{module}/N` patterns —
  including that **`{module}` substitutes the module bay's `position`, not its
  `name`**, which is the difference between `eth/1/1` and an interface named
  after nothing — nested bays (4.6, #19796), and the distinction between a
  breakout _optic_ (a module with several interface templates) and a breakout
  _cable_ (`dcim.cable` with a `profile`, 26 values in 4.6.8 against 4 in the
  model doc, so take the enum from `netbox_describe`).

  The skill now forbids **creating** inventory items and models the same
  hardware as modules in module bays, with module type profiles for parts that
  have no components — 4.6 ships `Fan`, `Power Supply`, `Hard Disk`, `CPU`,
  `GPU` and `Memory` profiles by default. **Reading existing inventory items
  stays allowed**, because migrating off them requires enumerating them first.
  Where NetBox has no replacement — `discovered`, per-instance roles, the
  `component` generic FK for a transceiver in a fixed port, and a spare part on
  a shelf — the skill stops and asks rather than inventing an answer.

- Distribution as a plugin: `.claude-plugin/marketplace.json` and
  `.claude-plugin/plugin.json` bundle the skill and the MCP server together, and
  `docs/installing-the-skill.md` gives per-surface steps for Claude, ChatGPT
  desktop (`~/.codex/config.toml`, skills in `~/.agents/skills/`) and Grok Build
  (`~/.grok/config.toml`, which also reads Claude Code config unmodified).
  `npm run build:skill` now emits a flattened single-file Markdown render
  alongside the `.skill` archive, for surfaces that take an uploaded document
  rather than a skill directory.

  What updates and what does not is stated plainly rather than implied: Claude
  plugins check at session start, third-party marketplaces default to
  auto-update **off**, and nothing else updates at all. ChatGPT Scheduled Tasks
  and Grok Automations can report that a document changed but cannot write back
  to stored skills or instructions, so a weekly _alarm_ is possible and a weekly
  _refresh_ is not.

- `tests/unit/tool-schema-contract.test.ts`, which asserts what `tools/list`
  actually publishes rather than what the Zod shapes say. The input schema is
  the contract, and this repository does not generate it — the SDK converts our
  Zod shapes and **Zod decides what the JSON Schema says**, so the contract can
  change without a line here changing.

  It already has. Bumping Zod 3.25.76 → 4.4.3 (#40) drops
  `additionalProperties: false` from **all five** tool schemas: 7 occurrences
  become 2. Every test passed and all six CI checks were green. Zod still strips
  unknown keys at runtime, so it is not an injection path — but a host that
  validates a call against the advertised schema before dispatching would begin
  accepting arguments the previous schema refused, and nothing would report it.

  The test also pins the properties that are meant to be structural: that
  neither execution tool exposes a `path`, `url`, `endpoint` or `uri` argument,
  and that the read/write annotation split is accurate rather than conservative
  — ChatGPT desktop's `writes` approval mode gates on exactly those hints.
  Confirmed to fail under 4.4.3 and pass under 3.25.76.

### Fixed

- **A removal note asserted behaviour the connected instance refuted.** It read
  "It worked on earlier releases, so an instance older than 4.6.3 still accepts
  it" for `dcim.module.local_context_data` — and a contract run against a live
  NetBox **4.6.0** found the field absent from that instance's own derived write
  schema. NetBox's release note calls it "unused", so it was very likely never
  writable through the API at all. The table knew a version number and inferred
  behaviour from it.

  A removal is now read against the instance rather than asserted from the
  table: absent explains why the field is missing, present says the instance
  predates the release so the field works now and breaks on upgrade, and with no
  field list to check the note states the removal and stops. Same discipline as
  the rest of this layer — the connected instance is the evidence.

- **`netbox_read` could send `brief=false`, which turns brief mode ON.** NetBox
  tests the raw query string for truthiness — `request.GET.get('brief')` — and
  `'false'` and `'0'` are truthy Python strings, so absence is the only "off".
  A model asking for complete objects wrote the obvious `{ brief: false }` and
  received the compact form: a well-formed object with most of its fields
  missing, HTTP 200, and nothing in the response saying it had been truncated.
  A caller could then report a field as absent from NetBox and be wrong.

  This is the same failure shape as the misspelled filter the live contract run
  found — the request succeeds and the answer is not what was asked for — and it
  is caught the same way, before the request leaves the process. `brief` is now
  translated rather than forwarded: falsey values drop the parameter, truthy
  ones send the canonical `true`. Real boolean filters such as `enabled=false`
  are untouched. The underlying behaviour is a source-level reading of 4.6.8 and
  is not documented, so the tests pin our translation rather than NetBox's
  parsing.

- `netbox_describe`'s `structuredContent` omitted the new `deprecations` array,
  so a client reading the structured channel rather than the rendered Markdown
  would have seen none of it.

- Eight claims in the `netbox-modeling` skill that a 4.6.8 audit refuted,
  including "a front port requires the rear port it maps to" (`rear_port` was
  removed in 4.5), the asset-intake instruction to model SFPs and cables as
  inventory item types, and "if this skill and `netbox_describe` disagree,
  `netbox_describe` is right" — still true about what the API _accepts_, false
  about what you should _write_, since the schema cannot signal deprecation.

## [0.1.3] - 2026-08-05

### Changed

- Tool descriptions no longer claim that discovery is mandatory. `netbox_discover`
  opened with "START HERE" and "Do not guess one"; `netbox_read` said "Call this
  AFTER netbox_discover". Neither was true — a wrong `object_type` is answered
  with near-misses, so guessing a plausible key costs no more than looking it
  up. `netbox_read` now says so and carries the naming convention, and
  `netbox_global_search` leads with the condition that should trigger it.

  **This did not reduce round-trips.** Re-running the same three probes with six
  fresh blind models produced identical counts: 10 and 10 for a name lookup, 4
  and 4 for a trivial count. One model did open with `netbox_global_search` for
  the first time, found the complete answer in that one call — and then made
  eight more, re-deriving through the layers to confirm what it already had.

  The cost is defensive verification, not missing signposts, and wording will
  not fix it. `docs/reference/eval-model-in-loop.md` records the negative result
  and what would actually be needed. The change ships because the old text was
  inaccurate, not because it worked.

## [0.1.2] - 2026-08-05

### Fixed

- **Array-valued filters were silently dropped, returning the complete
  unfiltered collection.** Axios serialises an array as `name[]=value`;
  NetBox's filters expect the key repeated, `name=a&name=b`, and NetBox
  **ignores a parameter it does not recognise and answers 200 with
  everything**. So the bracketed form did not error — it returned a plausible
  wrong answer. Asking for the device named `sw-core-01` returned every device.

  A comment in `src/client.ts` asserted the opposite and had done since before
  the layered rewrite. The filter-name validation added in 0.1.0 cannot catch
  this: the caller sends `name`, a legitimate parameter, and the corruption
  happens afterwards during serialisation. A guard on the way in does not
  protect against a bug on the way out.

  Found by running the eval set against the published 0.1.1 package with two
  independent models, both of which hit it and one of which wrote that it
  "could easily lead someone to misjudge which device is a match."

### Added

- `docs/reference/eval-model-in-loop.md` — the model-in-the-loop judgement the
  eval set flagged as needed and could not perform itself. Two of three probes
  went against the design: a trivial read takes four calls where the reference
  path is one, and `netbox_global_search` — kept in the surface specifically to
  make name lookups cheap — was used by neither model on the task it exists for.
  The impossible-task probe passed cleanly: neither model invented a tool, and
  both refused to pass a `last_updated` timestamp off as an audit trail.

## [0.1.1] - 2026-08-05

### Fixed

- `docs/compatibility.md` stated the opposite of the truth in three places, and
  a document whose only job is to be honest about limitations is worse than
  useless when it is stale. It claimed the server had never been contract-tested
  against a live instance, that plugin support was entirely unverified, and that
  the tool surface was 446 tools costing ~180,000 tokens — all true when written
  and all false by the time 0.1.0 shipped. It now records the 4.6.0 run (435
  checks, 0 defects, `netbox_inventory` 2.6.0 verified), states plainly that one
  instance is evidence rather than a range, and names the real trade the layered
  design makes: a trivial read costs 1 call and a device with three
  prerequisites costs 6.
- The release workflow ran `Test` before `Build`, and stripped the `.npmrc`
  `_authToken` line on both publish paths rather than only the
  trusted-publishing one. The first cost a release run; the second failed
  `ENEEDAUTH` after a green dry run, because a dry run never authenticates.
  Both are now pinned by `tests/unit/workflow-step-order.test.ts`.

### Changed

- `actions/checkout` and `actions/setup-node` to v7. Held deliberately until
  after a successful publish: `setup-node` is the action whose `.npmrc`
  behaviour caused the failure above, and no CI job publishes, so CI cannot vet
  it.

## [0.1.0] - 2026-08-05

First release. The repository existed before this — 446 tools, no tests, no CI,
one squashed commit — and none of that was published. Everything below is the
work of bringing it under Engineering OS governance (RFC-003) and replacing the
tool surface.

### Added

- Engineering OS governance: RFC-003, issue and pull request templates, a
  contributor code of conduct, and CI covering typecheck, lint, format, test,
  build, a built-binary smoke test, and a secret scan.
- Test suite (Vitest) covering configuration parsing, tool-group gating, error
  formatting, response shaping, the packaged tarball's contents, and the size of
  the `tools/list` response.
- `--version`, `--check` and `--list-tools` command-line verbs, so a published
  package can be verified without a NetBox instance.
- Live contract suite in `tests/contract/`, run with `npm run test:contract`
  (issue #4). It compares what the server derives from an instance's own
  `/api/schema/` against what that instance actually does: schema acquisition,
  every derived endpoint, the pagination envelope, declared fields versus real
  objects, enum values, filter behaviour including unknown query parameters, the
  real status codes behind the error mapping, and the refusal of a create and a
  delete under a read-only token. It is opt-in — `npm test` never runs it, and
  without `NETBOX_URL`/`NETBOX_TOKEN` it skips with an explanation instead of
  failing. Every run writes `docs/reference/spec-defects.md` and prints the same
  report to the console, including the checks that passed.

- **The `netbox-modeling` skill, rewritten for the five-tool surface and moved
  into this repository** (RFC-003, Open Question 3). It previously lived as an
  account-level skill on one machine and drove the 446 tool names directly, so
  it did not degrade when the surface changed — it broke completely, and nothing
  in either artifact could have caught that, because the two were not versioned
  together. It now lives in `skills/netbox-modeling/` and is reviewed with the
  tools it calls.

  The rewrite teaches the layer discipline (`netbox_discover` →
  `netbox_describe` → `netbox_read`/`netbox_write`) and is explicit that three
  calls before a write is the design: batch discovery, describe once per type
  per task, resolve independent references together. It keeps the domain
  knowledge the schema cannot supply — the conventional build order for a real
  task, standard-practice defaults, and the playbooks for cabling, device
  intake, IPAM and bulk creation — and carries the live findings that change how
  a model should behave: take filter names from `netbox_describe` because NetBox
  silently ignores the ones it does not recognise, send the `value` of a choice
  field rather than the `{value, label}` object a GET returns, use `brief=true`
  when scanning for ids, and never assume an object-type key exists. The
  confirm-before-writing rule from the old skill is kept, and extended with the
  delete guard: `confirm` must echo the object's current `display` value, and
  the blast radius of a cascading delete is stated to the user before it runs.

  Three claims the old skill made were wrong before the rewrite and are not
  carried over: that `dcim.site` requires `status` (it defaults), that an
  interface's `mac_address` can be written as a legacy string (it has been
  read-only since 4.2 — a MAC is a `dcim.macaddress` object), and the long list
  of objects the server "cannot manage", which was true of the old surface and
  is now empty — tenants, regions, RIRs, module types, component templates,
  patch-panel ports and tags are all ordinary object types.

- `skills/README.md`, and `npm run build:skill`
  (`scripts/build-skill.mjs`), which validates a skill's frontmatter and packs
  the directory into a distributable `.skill` archive at
  `dist/skills/<name>.skill`. Dependency-free: `node:zlib` plus a minimal zip
  writer, rather than a dev dependency to produce one archive per release.

### Changed

- **The tool surface is now five tools instead of 446** (issue #3, RFC-003 D1).
  `netbox_global_search` finds an instance; `netbox_discover` finds a type;
  `netbox_describe` returns fields, enums, filters and what must exist first;
  `netbox_read` and `netbox_write` execute. Measured over a real stdio
  handshake, a `tools/list` response went from 720,863 characters (~180,000
  tokens) to 11,981 (~3,000). The old surface could not be loaded alongside any
  real workload.

  Layers 1 and 2 are derived at runtime from the connected instance's own
  OpenAPI document, so the planning layer cannot drift from the instance and
  picks up whatever plugins are installed.

  Execution is split in two so the MCP `annotations` stay honest: a single
  execute tool would have to declare itself destructive on every read.

  Neither execution tool accepts a path. `object_type` resolves through a
  registry, so there is no argument through which a caller can reach an
  arbitrary URL — a path-traversal surface closed by construction rather than
  by validation.

  `netbox_write` validates against the derived schema before the request leaves
  the process and returns the field description on failure, so a wrong call
  self-heals in one round-trip instead of bouncing off a NetBox 400. Deleting
  requires echoing the object's current `display` value: NetBox cascades
  deletes and there is no undo.

- Minimum Node.js is now 20 LTS. Node 18 reached end of life.
- Package renamed to `@zenixsolutions/netbox-mcp` and reset to `0.1.0`. Nothing
  was ever published under the previous name or version.
- The package no longer declares `main`. The entry point is an executable that
  starts a stdio server on import, so importing it was never meaningful.

### Removed

- `NETBOX_READONLY` and `NETBOX_TOOL_GROUPS`. Write access is controlled by the
  NetBox token's own permissions, which are enforced by NetBox where no tool
  argument can reach them. Client-side gates that a server chooses to honour
  were never the real boundary, and the installer's misreport of `read-only`
  showed what a false one costs.

- `scripts/install.sh`, and every instruction that referenced it (issue #12). A
  published package is launched with `npx @zenixsolutions/netbox-mcp`, which
  needs no clone, no build, and no installer. The script's remaining job was
  writing a client config block, and that was where its two most serious defects
  lived: it reported `mode: read-only` for values the server evaluates as false —
  registering all 446 tools, including 89 cascading deletes, under an affirmative
  safety claim — and it left a permanent world-readable backup containing the API
  token. `README.md` and `AGENTS.md` now document the `npx` invocation, the
  from-a-clone path for contributors, and `--check` as the way to verify a
  configuration.

### Fixed

- **Four defects found by running the contract suite against a real NetBox
  4.6.0.** Each was a rule that had been verified against a captured 4.6.7
  schema document and never against a live instance answering requests.

  - **A misspelled filter no longer returns the whole collection.** The
    derivation assumed a wrong query parameter would be rejected. NetBox
    ignores it: `?nb_mcp_contract_probe=1` came back HTTP 200 with the same
    `count` as the unfiltered collection, and nothing in the response said the
    filter had been dropped. `netbox_read` forwarded any syntactically valid
    name, so an agent asking for "the devices at site X" with a typo received
    **every device**, believed it had filtered, and would then act on that
    list. Filter names are now checked against the parameter set derived for
    that object type and an unknown one is refused before the request is sent,
    with near-misses named. The check is against the FULL derived set, not the
    list `netbox_describe` shows: that list is summarised — 120 of 158 names
    are elided for `dcim.site` — and `name__ic` is both legitimate and absent
    from it.

  - **An invalid token is no longer reported as a permissions problem.** The
    error mapping assumed 401 for a bad credential, on DRF's documented
    behaviour. The instance answered **403**, with a `detail` of
    "Invalid v2 token", which fell into the 403 branch and told the operator
    "the API token lacks permission for this object or action" — sending
    someone whose token is simply wrong to audit object permissions. 403 is now
    read from the body rather than the status: an invalid or expired credential
    names `NETBOX_TOKEN`, a permission refusal names the token's permissions
    and `write_enabled`, and a body matching neither says both are possible
    rather than guessing. The unauthenticated case — 403 with a `detail` of
    "Authentication credentials were not provided.", which is what a proxy
    stripping the header looks like, and which presents as neither a network
    error nor an obvious auth error — is now named explicitly.

  - **An upstream error page can no longer reach the model.** A 404 on an
    unknown endpoint answered `text/html`, and the body extractor returned a
    plain-string body verbatim — a whole error page, however large. Bodies are
    now collapsed to one line and truncated, and an HTML body is described
    rather than relayed.

  - **`plugins/inventory/purchases` derived as `plugins.inventory.purchas`.**
    The singularisation rule strips `-es` after any sibilant, which is right
    for `addresses` and wrong for `purchases`. The endpoint sweep passed
    because the endpoint is stored rather than reconstructed — but the key is
    what a model passes to `netbox_read`, and no user or model would guess the
    misspelling. `-ses` is now resolved by testing the candidate (`address`
    keeps its `-es` strip; `purchase` does not), and, ahead of the heuristic,
    the key is taken from the component the schema itself resolved
    (`PurchaseRequest` → `Purchase`) wherever that agrees with the slug modulo
    pluralisation. The slug is a routing convenience; the component is the
    serializer's own name for the model. No core object-type key changes:
    `users/permissions` stays `users.permission` and `dcim/devices` stays
    `dcim.device`, because `ObjectPermission` and `DeviceWithConfigContext` are
    not the URL's noun and are not trusted.

  The same run measured the schema fetch at **12.43 MB in 7,451 ms with no
  `Content-Encoding`** — transferred uncompressed. That one is not a defect on
  this side and nothing was changed for it: the loader already sends
  `Accept-Encoding: gzip, deflate` (the contract suite asked for compression
  too and was not given it), and the on-disk cache means the fetch is paid once
  per NetBox-plus-plugin version rather than once per process. The instance's
  front end is not compressing `application/vnd.oai.openapi+json`, which is
  worth fixing where it is served. Both the request header and the cache's
  "once per version" guarantee are now pinned by tests, because losing either
  quietly would make a 12 MB first tool call the normal case.

- Source maps are no longer published, cutting the installed size of every
  `npx` run.
- Documentation corrections (issue #13). Node.js was stated as `>= 18` in
  `README.md`, `AGENTS.md` and `CLAUDE.md` while `engines` requires `>= 20.11`;
  `--help` was prescribed for diagnosing configuration errors, which it cannot
  do because it returns before any configuration is read; a hand-rolled
  seven-line JSON-RPC pipe was documented for counting tools, which
  `--list-tools` now does; `--check`, `--version` and `--list-tools` were
  documented nowhere and are now documented everywhere they are needed; and
  `README.md` pointed contributors adding a tool group at `src/index.ts`, but
  registration lives in the `REGISTRARS` table in `src/server.ts`. The 15 tool
  counts were verified against the built binary and are correct as published.

[Unreleased]: https://github.com/ZenixSolutions/netbox-mcp-server/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ZenixSolutions/netbox-mcp-server/releases/tag/v0.2.0
[0.1.3]: https://github.com/ZenixSolutions/netbox-mcp-server/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/ZenixSolutions/netbox-mcp-server/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ZenixSolutions/netbox-mcp-server/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ZenixSolutions/netbox-mcp-server/releases/tag/v0.1.0
