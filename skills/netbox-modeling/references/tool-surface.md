# The six-tool surface

Exact argument shapes and behaviour. Everything here is the tool contract, not
advice; if a tool's own description disagrees with this file, the tool wins.

## `netbox_global_search` — find an instance

```json
{ "query": "sw-core-01", "limit_per_resource": 5, "response_format": "json" }
```

- `query` (required) — free text, passed to NetBox as `q`.
- `limit_per_resource` — 1-50, default 5.
- `resources` — restrict to a subset of: `sites`, `racks`, `devices`,
  `interfaces`, `prefixes`, `ip_addresses`, `vlans`, `vrfs`, `assets`.
- `response_format` — `markdown` (default) or `json`.

Fans one query across those nine resources in parallel and returns hits grouped
by resource with each hit's numeric id. Use it when the user names a _thing_ and
you do not know its type. It only covers those nine resources — for anything
else (tenants, circuits, module types, console ports) use `netbox_read` with
`operation: "list"` and a `q` filter.

## `netbox_discover` — find a type

```json
{ "query": "vlan" }
{ "app": "dcim" }
```

Both arguments are optional; with neither you get the whole registry. Returns
one line per type: `object_type`, label, endpoint, and the operations that type
supports. An operation absent from that list will be refused.

Object-type keys look like `dcim.device`, `ipam.prefix`,
`plugins.inventory.asset`. They are derived from the connected instance, so:

- Plugin types are `plugins.<plugin>.<model>`, and only appear if the plugin is
  installed.
- A few keys are not the obvious singular, because they come from the endpoint
  and the endpoint is not always the model's name. VM interfaces
  (`/api/virtualization/interfaces/`) are `virtualization.interface`, and object
  permissions (`/api/users/permissions/`) are `users.permission`. **Call
  `netbox_discover`; do not construct a key.**
- These keys are this server's identifiers. They are _not_ interchangeable with
  the content-type strings NetBox itself uses inside payloads — the same VM
  interface is `virtualization.vminterface` when it appears as an
  `assigned_object_type` value. Keys go in the tool's `object_type` argument;
  content-type strings go in `data`. See the cable and IP notes in
  `build-order.md`.

If a key does not resolve, the error lists near-miss suggestions. Take one of
those rather than guessing again.

## `netbox_describe` — plan one type

```json
{ "object_type": "dcim.device", "operation": "create" }
```

`operation` is one of `list`, `get`, `create`, `update`, `delete`. The answer
differs per operation:

- **create / update** — required fields, optional fields with types and exact
  enum values, read-only fields you must not send, and **"Must exist first"**:
  the object types this one references. `update` also states that it is a
  partial write, so the "required" list is what `create` needs, not what
  `update` needs.
- **list** — the accepted filters, summarised, plus the lookup-suffix grammar.
- **get / delete** — the arguments needed to address one object.

Field lines look like:

```
- `site` (integer, reference to dcim.site (pass its numeric id)) — references dcim.site; accepts a numeric ID (preferred) or a nested object
- `status` (string, one of: offline | active | planned | staged | failed | inventory | decommissioning)
```

Call it once per object type per task. It costs nothing at NetBox — it is
derived from a cached schema document, not a live query.

## `netbox_read` — list and get

```json
{ "object_type": "dcim.interface", "operation": "list",
  "filters": { "device_id": 42, "name__ic": "eth" }, "limit": 50 }

{ "object_type": "dcim.device", "operation": "get", "id": 42,
  "response_format": "json" }
```

- `operation` — `list` or `get`. `get` requires `id`.
- `filters` — an object of NetBox query-parameter names to values. A value may
  be a string, number, boolean, or an array (which repeats the parameter, OR
  semantics for most filters).
- `limit` — 1-1000, default 50. `offset` — default 0; use the `next_offset` a
  truncated response reports.
- `response_format` — `markdown` (default) or `json`. **Use `json` whenever you
  are going to chain the result into another call** — you need the raw `id`.

JSON list output is `{ total, count, offset, limit, items, has_more, next_offset? }`.
Responses over the character budget are truncated and tell you where to resume;
narrow the filter or paginate rather than raising `limit`.

### Filters — the one rule that matters

**Take filter names from `netbox_describe(object_type, "list")`.** NetBox
answers HTTP 200 and silently ignores query parameters it does not recognise: a
misspelled `site` returns the whole unfiltered collection and looks like a
successful search. `netbox_read` therefore rejects unknown filter names locally
and never sends the request. A known filter with an invalid _value_ is still
NetBox's to judge, and it answers 400 naming the valid choices.

Practical points:

- A filter value is usually a **slug or an id**, not a display name:
  `site: "dc1"` or `site_id: 3`, not `site: "DC 1"`.
- FK filters commonly come in both forms: `device` (slug/name) and `device_id`
  (numeric). `netbox_describe` shows which exist.
- Append a lookup suffix to any filter name: `__n` negates; strings also take
  `__ic`/`__nic` (contains), `__isw`/`__nisw` (starts with), `__iew`/`__niew`
  (ends with), `__ie`/`__nie` (case-insensitive exact), `__empty`,
  `__regex`/`__iregex`; numbers and dates take `__lt`/`__lte`/`__gt`/`__gte`; a
  few multi-value filters take `__any`. So `name__ic: "core"` or
  `created__gte: "2026-01-01"`.
- `q` is free-text search across the type's searchable fields — present on
  essentially every list endpoint.
- `brief: true` returns a compact object (verified on 4.6.0: `id`, `url`,
  `display`, `name`, `slug`, `description`). Use it when scanning many objects
  for an id; drop it when you need the full record.

## `netbox_write` — create, update, delete

```json
{ "object_type": "dcim.device", "operation": "create",
  "data": { "name": "dc1-leaf-01", "device_type": 12, "role": 4, "site": 3 } }

{ "object_type": "dcim.device", "operation": "update", "id": 87,
  "data": { "primary_ip4": 511 } }

{ "object_type": "dcim.cable", "operation": "delete", "id": 33,
  "confirm": "#33" }
```

- `create` needs `data`. `update` needs `id` **and** `data`. `delete` needs `id`
  **and** `confirm`.
- **`update` is a PATCH.** Only the fields in `data` change; everything else is
  left alone. Send only what you are changing. Pass `null` to clear a nullable
  field.
- `data` is validated locally before anything is sent: unknown field names,
  read-only fields, wrong types, enum values outside the declared set, and
  missing required fields on `create` are all rejected here. The rejection
  message includes the full `netbox_describe` output for that type, so you can
  fix the call and retry without a second describe.
- **`delete` requires `confirm` to equal the object's current `display`
  value**, exactly as `netbox_read` returned it. A mismatch refuses the delete
  and shows both values. Call it without `confirm` first if you need to see the
  current value — that error tells you the `display` string. Deletes cascade and
  cannot be undone: get the user's explicit agreement before calling.

## `netbox_invoke` — schema-confirmed semantic actions

`netbox_invoke` is a closed semantic-action surface, **not** a generic HTTP
client. Its `operation` and numeric `target` are the only routing inputs; it
accepts no URL, path, or method. Read the `semantic_actions` metadata returned
by `netbox_discover` or `netbox_describe` before calling it. An action not
advertised there is not discovered for that connected instance and must not be
guessed.

The action IDs currently possible are only these, and only when the connected
instance reports NetBox **4.6.x** (>=4.6.0, <4.7.0) and its OpenAPI document proves
the matching native contract. Unknown or out-of-range versions are refused rather
than inferred:

```json
{ "operation": "ipam.prefix.available_ips", "target": 42,
  "input": { "query": { "brief": true, "fields": "id,address" } } }

{ "operation": "ipam.prefix.allocate_ip", "target": 42,
  "input": { "data": [{ "prefix_length": 31 }] } }

{ "operation": "dcim.interface.trace", "target": 42, "input": {} }

{ "operation": "dcim.front_port.paths", "target": 42, "input": {} }

{ "operation": "dcim.rear_port.paths", "target": 42, "input": {} }
```

- `ipam.prefix.available_ips` is a **read** action. Its `input.query` schema is
  copied from that instance's native GET query parameters. Do not invent a
  `limit`: the captured 4.6.7 contract does not declare one. Results are an
  array and are bounded before tool output; narrow with only schema-advertised
  query parameters when possible.
- `ipam.prefix.allocate_ip` is a non-destructive **write** action. `input.data`
  is the native required **array** request body, with **exactly one item** and a
  **25 KiB UTF-8 serialized JSON** maximum. It is not a bulk allocation surface:
  use `netbox_write` for deliberate multi-record changes. Its item and response
  schemas are advertised from the connected OpenAPI contract.
- An allocation POST is sent exactly once. A conflict or other error is
  surfaced; it is never automatically retried, because NetBox owns allocation
  concurrency.
- `dcim.interface.trace`, `dcim.front_port.paths`, and `dcim.rear_port.paths`
  are **read** actions with an empty `input` object. They preserve NetBox's
  native trace/path JSON; this server does not traverse or render a cable graph.
- No `available-prefixes`, console, power, or circuit action is currently
  advertised. Each remains unavailable until a connected schema proves its
  complete contract and explicit version support is added.

## Keeping the round-trips down

Three calls before a write is the design, not an accident. Make them count:

- **Batch discovery.** One `netbox_discover` with `app: "dcim"` gives you every
  DCIM key you will need for a racking task.
- **One describe per type per task.** Twelve interfaces on one device: describe
  `dcim.interface` once.
- **Resolve several references in parallel.** Independent `netbox_read` lookups
  (the site, the role, the device type) do not depend on each other — issue them
  together.
- **Use `netbox_global_search` as a shortcut.** When the user names a device and
  you just need its id, one search beats discover → describe → read.
- **Reuse ids within the task.** You already resolved the site; do not look it
  up again for the next object.
- **Do not describe a type you are only reading trivially.** `get` by id needs
  no describe. A `list` with filters does.
