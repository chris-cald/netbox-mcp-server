import { describe, expect, it } from "vitest";

import {
  createCredentialProvider,
  type CredentialFileSystem,
} from "../../src/credentials.js";

function fileSystem(options: {
  contents?: string;
  file?: boolean;
  statError?: Error;
  readError?: Error;
}): CredentialFileSystem {
  return {
    stat: () => {
      if (options.statError) return Promise.reject(options.statError);
      return Promise.resolve({ isFile: () => options.file ?? true });
    },
    readFile: () => {
      if (options.readError) return Promise.reject(options.readError);
      return Promise.resolve(options.contents ?? "");
    },
  };
}

describe("credential providers", () => {
  it("returns a trimmed inline token", async () => {
    const provider = createCredentialProvider({ inlineToken: "  inline-token\r\n" });
    await expect(provider.getToken()).resolves.toBe("inline-token");
  });

  it("reads and trims a token file", async () => {
    const provider = createCredentialProvider({
      tokenFile: "/run/secrets/netbox-token",
      fileSystem: fileSystem({ contents: "file-token\r\n" }),
    });
    await expect(provider.getToken()).resolves.toBe("file-token");
  });

  it("rejects missing and conflicting credential sources", () => {
    expect(() => createCredentialProvider({})).toThrow(/NETBOX_TOKEN.*NETBOX_TOKEN_FILE/);
    expect(() =>
      createCredentialProvider({ inlineToken: "inline-token", tokenFile: "/secret" }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects missing or unreadable files without exposing their path or filesystem error", async () => {
    const path = "/run/secrets/very-secret-token";
    const missing = createCredentialProvider({
      tokenFile: path,
      fileSystem: fileSystem({ statError: new Error(`ENOENT ${path}`) }),
    });
    await expect(missing.getToken()).rejects.toThrow(/readable regular file/);

    const secret = "credential-content-that-must-not-leak";
    const unreadable = createCredentialProvider({
      tokenFile: path,
      fileSystem: fileSystem({ readError: new Error(`EACCES ${path}: ${secret}`) }),
    });
    const error = await unreadable.getToken().then(
      () => undefined,
      (reason: unknown) => String(reason),
    );
    expect(error).toContain("readable regular file");
    expect(error).not.toContain(path);
    expect(error).not.toContain(secret);
  });

  it("rejects a non-regular token file without exposing its path", async () => {
    const path = "/run/secrets/very-secret-token";
    const directory = createCredentialProvider({
      tokenFile: path,
      fileSystem: fileSystem({ file: false }),
    });
    await expect(directory.getToken()).rejects.toThrow(/regular file/);
    await expect(directory.getToken()).rejects.not.toThrow(path);
  });

  it("rejects an empty rotated file without leaking its contents", async () => {
    const secret = "token-that-must-not-leak";
    const provider = createCredentialProvider({
      tokenFile: "/secret",
      fileSystem: fileSystem({ contents: ` \r\n${""}` }),
    });
    const error = await provider.getToken().then(
      () => undefined,
      (reason: unknown) => String(reason),
    );
    expect(error).toContain("NETBOX_TOKEN_FILE is empty");
    expect(error).not.toContain(secret);
  });

  it("reads the file for every request so rotation takes effect", async () => {
    let contents = "first-token\n";
    const provider = createCredentialProvider({
      tokenFile: "/secret",
      fileSystem: {
        stat: () => Promise.resolve({ isFile: () => true }),
        readFile: () => Promise.resolve(contents),
      },
    });

    await expect(provider.getToken()).resolves.toBe("first-token");
    contents = "second-token\n";
    await expect(provider.getToken()).resolves.toBe("second-token");
  });
});
