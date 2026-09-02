import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";

const base = { NETBOX_URL: "https://netbox.example.com", NETBOX_TOKEN: "abc123" };

describe("loadConfig", () => {
  it("rejects a missing URL and names the variable", () => {
    expect(() => loadConfig({ NETBOX_TOKEN: "abc123" })).toThrow(/NETBOX_URL/);
  });

  it("rejects a missing credential source and names both supported variables", () => {
    expect(() => loadConfig({ NETBOX_URL: base.NETBOX_URL })).toThrow(
      /NETBOX_TOKEN.*NETBOX_TOKEN_FILE/,
    );
  });

  it("rejects inline and file credential sources together", () => {
    expect(() =>
      loadConfig({ ...base, NETBOX_TOKEN_FILE: "/run/secrets/netbox-token" }),
    ).toThrow(/NETBOX_TOKEN.*NETBOX_TOKEN_FILE.*mutually exclusive/);
  });

  it("treats whitespace-only values as missing", () => {
    expect(() => loadConfig({ NETBOX_URL: "   ", NETBOX_TOKEN: "abc" })).toThrow(
      /NETBOX_URL/,
    );
    expect(() => loadConfig({ NETBOX_URL: base.NETBOX_URL, NETBOX_TOKEN: "  " })).toThrow(
      /NETBOX_TOKEN/,
    );
    expect(() =>
      loadConfig({ NETBOX_URL: base.NETBOX_URL, NETBOX_TOKEN_FILE: "  " }),
    ).toThrow(/NETBOX_TOKEN_FILE/);
  });

  it("uses the inline token through the credential provider", async () => {
    await expect(loadConfig(base).credentials.getToken()).resolves.toBe("abc123");
  });

  it("never repeats the token in an error message", () => {
    // A thrown config error is the one place a token could plausibly leak into
    // a log the user pastes into an issue.
    try {
      loadConfig({ NETBOX_URL: "not a url", NETBOX_TOKEN: "s3cr3t-token" });
      expect.unreachable("expected loadConfig to throw");
    } catch (err) {
      expect(String(err)).not.toContain("s3cr3t-token");
    }
  });

  it("strips a trailing slash and a trailing /api", () => {
    expect(loadConfig({ ...base, NETBOX_URL: "https://n.example.com/" }).apiUrl).toBe(
      "https://n.example.com/api",
    );
    expect(loadConfig({ ...base, NETBOX_URL: "https://n.example.com/api" }).apiUrl).toBe(
      "https://n.example.com/api",
    );
    expect(loadConfig({ ...base, NETBOX_URL: "https://n.example.com/api/" }).apiUrl).toBe(
      "https://n.example.com/api",
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => loadConfig({ ...base, NETBOX_URL: "not a url" })).toThrow(/not a valid/);
  });

  it("rejects userinfo, query, and fragment without echoing credentials", () => {
    for (const url of [
      "https://user:password@netbox.example.com",
      "https://@netbox.example.com",
      "https://netbox.example.com?access_token=query-secret",
      "https://netbox.example.com#token=fragment-secret",
    ]) {
      const error = (() => {
        try {
          loadConfig({ ...base, NETBOX_URL: url });
          expect.unreachable("expected loadConfig to reject the URL");
        } catch (reason) {
          return String(reason);
        }
      })();
      expect(error).toMatch(/not a valid URL/);
      expect(error).not.toContain("password");
      expect(error).not.toContain("query-secret");
      expect(error).not.toContain("fragment-secret");
    }
  });

  it("parses the truthy spellings of NETBOX_INSECURE", () => {
    for (const value of ["1", "true", "TRUE", "yes", "y", "on", " true "]) {
      expect(loadConfig({ ...base, NETBOX_INSECURE: value }).insecure).toBe(true);
    }
    for (const value of ["0", "false", "no", "", "off"]) {
      expect(loadConfig({ ...base, NETBOX_INSECURE: value }).insecure).toBe(false);
    }
  });

  it("defaults to verifying TLS", () => {
    expect(loadConfig(base).insecure).toBe(false);
  });
});
