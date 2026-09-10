import { describe, expect, it, vi } from "vitest";

import { resolveOidcConfig } from "../../src/oidc.js";

const manual = {
  NETBOX_OIDC_ISSUER: "https://issuer.example.test",
  NETBOX_OIDC_JWKS_URL: "https://issuer.example.test/jwks",
  NETBOX_OIDC_AUDIENCE: "netbox-mcp",
  NETBOX_OIDC_REQUIRED_SCOPE: "mcp",
  NETBOX_OIDC_RESOURCE_URL: "https://mcp.example.test/mcp",
};

const discovery = "https://issuer.example.test/.well-known/openid-configuration";

describe("OIDC discovery configuration", () => {
  it("leaves complete manual configuration unchanged when discovery is omitted", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(resolveOidcConfig(manual, true)).resolves.toEqual({
        issuer: manual.NETBOX_OIDC_ISSUER,
        jwksUrl: manual.NETBOX_OIDC_JWKS_URL,
        audience: manual.NETBOX_OIDC_AUDIENCE,
        requiredScope: manual.NETBOX_OIDC_REQUIRED_SCOPE,
        resourceUrl: manual.NETBOX_OIDC_RESOURCE_URL,
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("derives issuer and JWKS URL from discovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(
            JSON.stringify({
              issuer: manual.NETBOX_OIDC_ISSUER,
              jwks_uri: manual.NETBOX_OIDC_JWKS_URL,
            }),
          ),
      ),
    );
    try {
      await expect(
        resolveOidcConfig(
          {
            ...manual,
            NETBOX_OIDC_DISCOVERY_URL: discovery,
            NETBOX_OIDC_ISSUER: "",
            NETBOX_OIDC_JWKS_URL: "",
          },
          true,
        ),
      ).resolves.toMatchObject({
        issuer: manual.NETBOX_OIDC_ISSUER,
        jwksUrl: manual.NETBOX_OIDC_JWKS_URL,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when manually supplied discovery values do not exactly match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(
            JSON.stringify({
              issuer: manual.NETBOX_OIDC_ISSUER,
              jwks_uri: "https://issuer.example.test/discovered-jwks",
            }),
          ),
      ),
    );
    try {
      await expect(
        resolveOidcConfig({ ...manual, NETBOX_OIDC_DISCOVERY_URL: discovery }, true),
      ).rejects.toThrow(/exactly match/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("warns and uses a complete valid manual pair when discovery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("not JSON")),
    );
    const warn = vi.fn();
    try {
      await expect(
        resolveOidcConfig(
          { ...manual, NETBOX_OIDC_DISCOVERY_URL: discovery },
          true,
          warn,
        ),
      ).resolves.toMatchObject({
        issuer: manual.NETBOX_OIDC_ISSUER,
        jwksUrl: manual.NETBOX_OIDC_JWKS_URL,
      });
      expect(warn).toHaveBeenCalledWith(
        "warning: OIDC discovery failed; using manually configured issuer and JWKS URL.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when discovery failure has an invalid manual fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("not JSON")),
    );
    try {
      await expect(
        resolveOidcConfig(
          {
            ...manual,
            NETBOX_OIDC_DISCOVERY_URL: discovery,
            NETBOX_OIDC_ISSUER: "http://issuer.example.test",
          },
          true,
        ),
      ).rejects.toThrow(/discovery failed.*manual/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when invalid discovery has no complete valid manual fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response(JSON.stringify({ issuer: "http://invalid.test" }))),
    );
    try {
      await expect(
        resolveOidcConfig(
          {
            ...manual,
            NETBOX_OIDC_DISCOVERY_URL: discovery,
            NETBOX_OIDC_ISSUER: "",
            NETBOX_OIDC_JWKS_URL: "",
          },
          true,
        ),
      ).rejects.toThrow(/discovery failed.*manual/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
