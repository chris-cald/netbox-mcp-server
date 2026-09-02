/**
 * NetBox credential sources.
 *
 * Credentials are resolved at request time rather than copied into an HTTP
 * client's defaults. This lets a secret manager rotate a token file without a
 * server restart and keeps credential values out of configuration errors.
 */

import { readFile, stat } from "node:fs/promises";

import { ENV_NETBOX_TOKEN, ENV_NETBOX_TOKEN_FILE } from "./constants.js";

/** Resolves the NetBox API token immediately before an outbound request. */
export interface NetBoxCredentialProvider {
  getToken(): Promise<string>;
}

/** Minimal filesystem dependency for deterministic credential-source tests. */
export interface CredentialFileSystem {
  stat(path: string): Promise<{ isFile(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const nodeFileSystem: CredentialFileSystem = { readFile, stat };

export interface CredentialProviderOptions {
  inlineToken?: string | undefined;
  tokenFile?: string | undefined;
  fileSystem?: CredentialFileSystem | undefined;
}

/** A configuration or credential-source error whose message is always secret-safe. */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

class InlineCredentialProvider implements NetBoxCredentialProvider {
  constructor(private readonly token: string) {}

  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}

class FileCredentialProvider implements NetBoxCredentialProvider {
  constructor(
    private readonly path: string,
    private readonly fileSystem: CredentialFileSystem,
  ) {}

  async getToken(): Promise<string> {
    let info: { isFile(): boolean };
    try {
      info = await this.fileSystem.stat(this.path);
    } catch {
      throw new CredentialError(
        `${ENV_NETBOX_TOKEN_FILE} could not be read. Ensure it names a readable regular file.`,
      );
    }
    if (!info.isFile()) {
      throw new CredentialError(
        `${ENV_NETBOX_TOKEN_FILE} must name a regular file, not a directory or other file type.`,
      );
    }

    let contents: string;
    try {
      contents = await this.fileSystem.readFile(this.path, "utf8");
    } catch {
      throw new CredentialError(
        `${ENV_NETBOX_TOKEN_FILE} could not be read. Ensure it names a readable regular file.`,
      );
    }

    // Secret files conventionally end in a newline. Trim it (and equivalent
    // surrounding whitespace) before use, but reject a blank rotated file.
    const token = contents.trim();
    if (!token) {
      throw new CredentialError(`${ENV_NETBOX_TOKEN_FILE} is empty.`);
    }
    return token;
  }
}

/**
 * Select exactly one credential source. File contents are deliberately not
 * read here: the returned provider reads them for every request so rotation is
 * observed by an already-running server.
 */
export function createCredentialProvider(
  options: CredentialProviderOptions,
): NetBoxCredentialProvider {
  const inlineToken = options.inlineToken?.trim();
  const tokenFile = options.tokenFile?.trim();

  if (inlineToken && tokenFile) {
    throw new CredentialError(
      `${ENV_NETBOX_TOKEN} and ${ENV_NETBOX_TOKEN_FILE} are mutually exclusive. Set exactly one.`,
    );
  }
  if (inlineToken) return new InlineCredentialProvider(inlineToken);
  if (tokenFile)
    return new FileCredentialProvider(tokenFile, options.fileSystem ?? nodeFileSystem);

  throw new CredentialError(
    `Missing NetBox credential. Set exactly one of ${ENV_NETBOX_TOKEN} or ${ENV_NETBOX_TOKEN_FILE}.`,
  );
}
