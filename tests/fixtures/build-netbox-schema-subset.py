#!/usr/bin/env python3
"""Build tests/fixtures/netbox-schema-subset.json from a full NetBox OpenAPI document.

The full document (NetBox 4.6.7) is ~12.9 MB and is committed upstream at
contrib/openapi.json in netbox-community/netbox. This script extracts a real,
unmodified subset: a chosen set of paths plus the transitive $ref closure of the
component schemas they reach.

Usage:
    git clone --depth 1 https://github.com/netbox-community/netbox.git /tmp/netbox-src
    python3 build-netbox-schema-subset.py /tmp/netbox-src/contrib/openapi.json \
        > netbox-schema-subset.json

Nothing is hand-written or edited: every path item and component schema is copied
verbatim from the upstream document.
"""
import json
import re
import sys

# Object types the fixture must cover, plus deliberately-chosen exception cases.
KEEP_PATHS = [
    # --- ordinary object types (collection + detail) ---
    "/api/dcim/devices/",
    "/api/dcim/devices/{id}/",
    "/api/dcim/sites/",
    "/api/dcim/sites/{id}/",
    "/api/dcim/interfaces/",
    "/api/dcim/interfaces/{id}/",
    "/api/dcim/interfaces/{id}/trace/",
    "/api/dcim/front-ports/",
    "/api/dcim/front-ports/{id}/",
    "/api/dcim/front-ports/{id}/paths/",
    "/api/dcim/rear-ports/",
    "/api/dcim/rear-ports/{id}/",
    "/api/dcim/rear-ports/{id}/paths/",
    "/api/ipam/prefixes/",
    "/api/ipam/prefixes/{id}/",
    "/api/ipam/ip-addresses/",
    "/api/ipam/ip-addresses/{id}/",
    # --- exception cases (see README.md) ---
    # 3-segment collection, GET only, no detail route, not an object type
    "/api/dcim/connected-device/",
    # 3-segment collection whose PUT/PATCH/DELETE are SINGLETON ops, not bulk ops
    "/api/extras/dashboard/",
    # URL slug != model name: users.permission (path) vs users.objectpermission (model)
    "/api/users/permissions/",
    "/api/users/permissions/{id}/",
    # viewset with no serializer: {name} detail param, no POST, no schema to describe
    "/api/core/background-queues/",
    "/api/core/background-queues/{name}/",
    # POST with no application/json request body at all
    "/api/extras/scripts/",
    # sub-resource action hanging off a detail path (not an object type)
    "/api/ipam/prefixes/{id}/available-ips/",
    # 2-segment non-object endpoints
    "/api/status/",
    "/api/schema/",
]

REF_RE = re.compile(r'"#/components/schemas/([^"]+)"')


def closure(doc, roots):
    seen = set()
    stack = list(roots)
    schemas = doc["components"]["schemas"]
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.add(name)
        if name not in schemas:
            continue
        for ref in REF_RE.findall(json.dumps(schemas[name])):
            if ref not in seen:
                stack.append(ref)
    return seen


def main(src):
    with open(src) as fh:
        doc = json.load(fh)

    paths = {p: doc["paths"][p] for p in KEEP_PATHS if p in doc["paths"]}
    missing = [p for p in KEEP_PATHS if p not in doc["paths"]]
    if missing:
        print(f"WARNING: paths absent from source document: {missing}", file=sys.stderr)

    roots = set(REF_RE.findall(json.dumps(paths)))
    keep = closure(doc, roots)

    out = {
        "openapi": doc["openapi"],
        "info": doc["info"],
        "paths": paths,
        "components": {
            "schemas": {n: doc["components"]["schemas"][n] for n in sorted(keep)
                        if n in doc["components"]["schemas"]},
            "securitySchemes": doc["components"].get("securitySchemes", {}),
        },
    }
    if "servers" in doc:
        out["servers"] = doc["servers"]

    print(f"paths: {len(paths)}  schemas: {len(out['components']['schemas'])}", file=sys.stderr)
    json.dump(out, sys.stdout, separators=(",", ":"), sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1])
