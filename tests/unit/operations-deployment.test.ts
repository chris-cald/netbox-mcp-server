import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const compose = readFileSync("compose.yaml", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");
const readme = readFileSync("README.md", "utf8");
const containerDeployment = readFileSync("docs/container-deployment.md", "utf8");
const operatorSetup = readFileSync("docs/operator-setup.md", "utf8");
const oauthMetadataCompatibility = readFileSync(
  "docs/oauth-metadata-compatibility.md",
  "utf8",
);
const oauthMetadataBridgeDesign = readFileSync(
  "docs/oauth-metadata-bridge-design.md",
  "utf8",
);
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
    expect(compose).toContain("NETBOX_HTTP_ALLOWED_HOSTS");
    for (const name of [
      "NETBOX_OIDC_ISSUER",
      "NETBOX_OIDC_JWKS_URL",
      "NETBOX_OIDC_AUDIENCE",
      "NETBOX_OIDC_REQUIRED_SCOPE",
      "NETBOX_OIDC_RESOURCE_URL",
    ]) {
      expect(compose).toContain(name);
    }
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

  it("documents the Host policy and network security boundary", () => {
    expect(readme).toContain("## Container deployment");
    expect(readme).toContain("NETBOX_TOKEN_FILE");
    expect(readme).toContain("NETBOX_HTTP_ALLOWED_HOSTS");
    expect(readme).toMatch(/not authentication/i);
    expect(readme).toMatch(/TLS, OIDC, and firewall/i);
  });

  it("documents isolated Authentik and NPM virtual-path setup without secrets", () => {
    for (const detail of [
      "separate Application and OAuth2/OIDC Provider",
      "Authorization Code with PKCE/S256",
      "NETBOX_OIDC_RESOURCE_URL=https://<PUBLIC_MCP_HOST>/mcp",
      "NETBOX_HTTP_ALLOWED_HOSTS=<PRIVATE_HOST>:<PRIVATE_PORT>,<PUBLIC_MCP_HOST>",
      "/.well-known/oauth-protected-resource/mcp",
      "proxy_set_header Authorization $http_authorization",
      "Do **not** add `proxy_pass`",
    ]) {
      expect(containerDeployment).toContain(detail);
    }
    expect(containerDeployment).toMatch(/Never place an Authentik client secret, JWT/i);
  });

  it("names every evidence-backed agent integration without a catch-all heading", () => {
    expect(readme).toContain("docs/operator-setup.md");
    const agentHeadings = [
      "#### ChatGPT",
      "#### Codex",
      "#### Claude Desktop",
      "#### Claude Code",
      "#### Cursor",
      "#### GitHub Copilot",
      "#### Gemini CLI",
      "#### Windsurf",
      "#### Cline",
      "#### Roo Code",
      "#### Continue",
    ];
    for (const heading of agentHeadings) {
      const start = operatorSetup.indexOf(heading);
      const next = operatorSetup.indexOf("#### ", start + heading.length);
      const section = operatorSetup.slice(start, next === -1 ? undefined : next);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(section).toMatch(/https:\/\//);
      expect(section).toMatch(/1\./);
    }
    expect(operatorSetup).not.toMatch(/\bet al\b/i);
  });

  it("separates preflight inputs from outputs produced by later steps", () => {
    const preflightStart = operatorSetup.indexOf("## Preflight");
    const outputsStart = operatorSetup.indexOf("## Outputs produced later");
    const installationStart = operatorSetup.indexOf("## Installation");
    const preflight = operatorSetup.slice(preflightStart, outputsStart);
    const outputs = operatorSetup.slice(outputsStart, installationStart);

    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(outputsStart).toBeGreaterThan(preflightStart);
    expect(installationStart).toBeGreaterThan(outputsStart);
    expect(preflight).not.toContain("<ISSUER>");
    expect(preflight).not.toContain("<JWKS_URI>");
    expect(preflight).not.toContain("<AUDIENCE>");
    expect(preflight).not.toContain("<SCOPE>");
    expect(outputs).toMatch(
      /\|\s+Output\s+\|\s+Producer section\/step\s+\|\s+Validation\s+\|/,
    );
    for (const heading of [
      "## Installation",
      "### Container",
      "### Package Manager",
      "## Integration",
      "### Reverse Proxy",
      "### Authorization",
      "### Agent",
    ]) {
      const start = operatorSetup.indexOf(heading);
      const next = operatorSetup.indexOf("\n#", start + heading.length);
      const section = operatorSetup.slice(start, next === -1 ? undefined : next);

      expect(section).toContain("**Prerequisites:**");
      expect(section).toContain("Stop");
    }
  });

  it("uses numbered procedures and default/value/source tables without invented artifacts", () => {
    for (const fieldTable of [
      /\|\s+Compose field\s+\|\s+Leave default\s+\|\s+Change to\s+\|\s+Source\s+\|/,
      /\|\s+NPM field\s+\|.*\|\s+Leave default \/ why\s+\|\s+Source\s+\|/,
      /\|\s+Authentik field\s+\|\s+Enter\s+\|\s+Leave default \/ reason\s+\|\s+Source\s+\|/,
    ]) {
      expect(operatorSetup).toMatch(fieldTable);
    }
    expect(operatorSetup).toContain("1. Log in to Authentik Admin Interface");
    expect(operatorSetup).toContain("1. Open ChatGPT");
    expect(operatorSetup).toContain(
      "No Kubernetes manifest, Helm chart, Kustomize overlay",
    );
    expect(operatorSetup).toMatch(
      /never put a NetBox\s+token, OAuth client secret, JWT/i,
    );
    for (const forbiddenPlaceholder of [
      "documented equivalent",
      "verify privately",
      "as appropriate",
      "etc.",
      "inspect it",
    ]) {
      expect(operatorSetup.toLowerCase()).not.toContain(forbiddenPlaceholder);
    }
    expect(operatorSetup).toContain("podman compose --profile deployment config");
    expect(operatorSetup).toContain("podman compose --profile deployment up -d");
    expect(operatorSetup).toContain("podman compose --profile deployment ps");
    expect(operatorSetup).toContain("podman compose --profile deployment down");
    expect(operatorSetup).toContain('{"status":"ok"}');
    for (const heading of [
      "##### Docker",
      "##### Podman",
      "#### NPM",
      "#### Authentik",
      "### Agent",
    ]) {
      const start = operatorSetup.indexOf(heading);
      const next = operatorSetup.indexOf("\n####", start + heading.length);
      const section = operatorSetup.slice(start, next === -1 ? undefined : next);

      expect(start).toBeGreaterThanOrEqual(0);
      expect(section).toMatch(/```(?:sh|json|nginx|text)\n/);
    }
  });

  it("requires an Authentik upgrade instead of a metadata bridge", () => {
    expect(operatorSetup).toContain("oauth-metadata-compatibility.md");
    for (const detail of [
      "Authentik `2025.2.4` predates RFC 8414",
      "Authentik upgrade to `>=2025.8`",
      "/.well-known/oauth-authorization-server/application/o/netbox/",
      "code_challenge_methods_supported",
      "Passing this metadata check does **not** establish ChatGPT compatibility.",
      "OpenTofu can manage reviewed Authentik image/version desired state",
    ]) {
      expect(oauthMetadataCompatibility).toContain(detail);
    }
    expect(oauthMetadataBridgeDesign).toContain("Do not implement this bridge.");
    expect(oauthMetadataBridgeDesign).toContain("Authentik `>=2025.8`");
  });

  it("runs container build and Compose configuration gates in CI", () => {
    expect(ci).toContain("Container build and Compose deployment profile");
    expect(ci).toContain("docker build");
    expect(ci).toContain("docker compose --profile deployment config");
  });
});
