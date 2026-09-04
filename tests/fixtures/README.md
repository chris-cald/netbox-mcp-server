# Test fixtures

## `netbox-schema-subset.json`

A **real, unmodified subset** of NetBox's own generated OpenAPI document. Nothing in it is
hand-written: every path item and component schema is copied verbatim from upstream. It
**must remain unmodified**: the `IPAddress.role` response shape is deliberately the
unpatched v4.6.7 contract used to prove that gateway validation rejects `role: null`.
The separately opt-in patched-container E2E test validates the upstream fix; it does not
change this captured fixture.

|                     |                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NetBox version      | **4.6.7** (`info.version` in the source document)                                                                                                               |
| Source repo         | `https://github.com/netbox-community/netbox`                                                                                                                    |
| Source path         | `contrib/openapi.json` (12,938,247 bytes)                                                                                                                       |
| Source commit       | `280e32fcc95a2dfb9a51f307e9a0b6b6e9388433` (`main`, 2026-08-05; `netbox/release.yaml` = 4.6.8-rc2, but the committed schema had last been regenerated at 4.6.7) |
| OpenAPI version     | 3.0.3                                                                                                                                                           |
| Generator           | drf-spectacular 0.30.0 (see upstream `requirements.txt`)                                                                                                        |
| Full document stats | 308 paths, 1043 component schemas                                                                                                                               |
| This subset         | 27 paths, 138 component schemas, ~603 KB                                                                                                                        |

Upstream regenerates and commits this document itself; `scripts/verify-openapi.sh` in the
NetBox repo diffs `python netbox/manage.py spectacular --format openapi-json` against
`contrib/openapi.json` in CI. So the committed file _is_ live drf-spectacular output, not a
post-processed derivative. (By contrast, the `openapi.yaml` vendored in
`netbox-community/go-netbox` is **not** suitable as a fixture: `scripts/fix-spec.py` there
rewrites `required` lists, strips `null` from nullable enums, and hard-codes
`Device.required`.)

### What it covers

Ordinary object types — collection + detail paths and the full `$ref` closure of their
request/response components:

- `dcim.device` — `/api/dcim/devices/`, `/api/dcim/devices/{id}/`
- `dcim.site` — `/api/dcim/sites/`, `/api/dcim/sites/{id}/`
- `dcim.interface` — `/api/dcim/interfaces/`, `/api/dcim/interfaces/{id}/`, `/api/dcim/interfaces/{id}/trace/`
- `dcim.frontport` — `/api/dcim/front-ports/`, `/api/dcim/front-ports/{id}/`, `/api/dcim/front-ports/{id}/paths/`
- `dcim.rearport` — `/api/dcim/rear-ports/`, `/api/dcim/rear-ports/{id}/`, `/api/dcim/rear-ports/{id}/paths/`
- `ipam.prefix` — `/api/ipam/prefixes/`, `/api/ipam/prefixes/{id}/`
- `ipam.ipaddress` — `/api/ipam/ip-addresses/`, `/api/ipam/ip-addresses/{id}/`

Deliberately-included exception cases, each of which breaks a naive derivation rule:

| Path                                                                           | Why it is here                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/dcim/connected-device/`                                                  | 3-segment collection, `GET` only, **no detail route, no POST** — a query endpoint that the segment-count rule would wrongly admit as an object type.    |
| `/api/extras/dashboard/`                                                       | 3-segment collection whose `PUT`/`PATCH`/`DELETE` are **singleton** ops (`extras_dashboard_update`), _not_ bulk ops. The inverse of the bulk trap.      |
| `/api/users/permissions/`, `/{id}/`                                            | URL slug ≠ model name: path yields `users.permission`, NetBox's own object type is `users.objectpermission`. Write schema is `ObjectPermissionRequest`. |
| `/api/core/background-queues/`, `/{name}/`                                     | Viewset with no serializer; detail param is `{name}`, not `{id}`; no POST; response schema is unresolvable.                                             |
| `/api/extras/scripts/`                                                         | Has a `POST` with **no `application/json` request body schema at all**.                                                                                 |
| `/api/ipam/prefixes/{id}/available-ips/`                                       | Sub-resource action on a detail path — 5 segments, `GET` + `POST`, not an object type.                                                                  |
| `/api/dcim/interfaces/{id}/trace/`, `/api/dcim/{front,rear}-ports/{id}/paths/` | Read-only cable-trace actions on detail paths, not object types.                                                                                        |
| `/api/status/`, `/api/schema/`                                                 | 2-segment `/api/*` endpoints that are not object types.                                                                                                 |

Also present because they are in the `$ref` closure and are load-bearing for the write-schema
tests: `WritableDeviceWithConfigContextRequest`, `DeviceWithConfigContextRequest` (the
_bulk-delete_ payload — a different schema with a colliding-looking name),
`BulkDeviceWithConfigContextRequest`, `PatchedWritable*Request`, `SiteRequest` vs
`WritableSiteRequest`, `Brief*` / `Brief*Request`, `Paginated*List`.

### Not covered

**No plugin paths.** The upstream `contrib/openapi.json` is generated from a stock NetBox with
no plugins installed, so `/api/plugins/**` does not appear anywhere in the source document.
Plugin-path handling cannot be tested from this fixture and needs a separate,
hand-marked-as-synthetic fixture or a live instance with a plugin installed.

### Regenerating

```sh
git clone --depth 1 https://github.com/netbox-community/netbox.git /tmp/netbox-src
cd tests/fixtures
python3 build-netbox-schema-subset.py /tmp/netbox-src/contrib/openapi.json \
    > netbox-schema-subset.json
```

`build-netbox-schema-subset.py` selects the path list above and walks the transitive
`$ref` closure of the component schemas those paths reach. It copies; it never edits.
Update the version table above whenever you regenerate against a newer NetBox.

Alternatively, generate from a live instance (this is what the server does at runtime):

```sh
curl -H 'Authorization: Token <token>' \
     -H 'Accept: application/vnd.oai.openapi+json' \
     'https://<netbox>/api/schema/?format=json'
```
