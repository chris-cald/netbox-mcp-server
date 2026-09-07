import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const compose = readFileSync("compose.yaml", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");
const readme = readFileSync("README.md", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

describe("production container deployment", () => {
  it("builds a small non-root runtime image with OCI build metadata", () => {
    expect(dockerfile).toMatch(/^FROM .+ AS build$/m);
    expect(dockerfile).toMatch(/^FROM .+ AS runtime$/m);
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("org.opencontainers.image.version");
    expect(dockerfile).toContain("org.opencontainers.image.revision");
    expect(dockerfile).toContain("org.opencontainers.image.created");
  });

  it("leaves deployment exposure to Compose and uses a mounted token file", () => {
    expect(compose).toContain('profiles: ["deployment"]');
    expect(compose).toContain("NETBOX_TRANSPORT: http");
    expect(compose).not.toContain("NETBOX_HTTP_HOST");
    expect(compose).not.toContain("NETBOX_HTTP_PORT");
    expect(compose).toContain("NETBOX_TOKEN_FILE: /run/secrets/netbox_token");
    expect(compose).toMatch(/secrets:\s*\n\s+netbox_token:/);
    expect(compose).not.toMatch(/^\s*ports:/m);
    expect(compose).not.toMatch(/^\s*NETBOX_TOKEN:/m);
    expect(dockerignore).toContain("!package.json");
    expect(dockerignore).not.toMatch(/^!\.env/m);
  });

  it("hardens the deployment and makes its healthcheck prove both probes", () => {
    for (const setting of ["read_only: true", "cap_drop:", "no-new-privileges:true"]) {
      expect(compose).toContain(setting);
    }
    expect(compose).toContain("/healthz");
    expect(compose).toContain("/readyz");
  });

  it("documents the environment and secret boundary without advertising public HTTP", () => {
    expect(readme).toContain("## Container deployment");
    expect(readme).toContain("NETBOX_TOKEN_FILE");
    expect(readme).toContain("not published");
    expect(readme).toMatch(/public HTTP\s+remains\s+unavailable/i);
  });

  it("runs container build and Compose configuration gates in CI", () => {
    expect(ci).toContain("Container build and Compose deployment profile");
    expect(ci).toContain("docker build");
    expect(ci).toContain("docker compose --profile deployment config");
  });
});
