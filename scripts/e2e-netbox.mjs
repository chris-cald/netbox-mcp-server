#!/usr/bin/env node
/**
 * Lifecycle runner for the disposable NetBox 4.6.7 E2E fixture.
 *
 * It intentionally does nothing until NETBOX_E2E=1 is supplied. The compose
 * command defaults to `podman compose`; CI may explicitly set
 * NETBOX_E2E_COMPOSE_COMMAND="docker compose".
 */

import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";

const fetch = globalThis.fetch;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = resolve(root, "docker-compose.e2e.yml");
const startupTimeoutMs = 4 * 60_000;
const pollIntervalMs = 1_000;
const upstreamRevision = "635361b87d67b70e9338fa141e8ad932c2b2fba4";
const upstreamSourceUrl = "https://github.com/chris-cald/netbox.git";
const upstreamBranch = "fix/nullable-ipaddress-role-response";
const patchedImage = "localhost/netbox-mcp-e2e:4.6.7-635361b";
const baseImageDigest =
  "sha256:7ad3a287d38829c98799c4a03d874d3d309738d1f42987dfd8037ec0e80587ce";
const baseImage = `netboxcommunity/netbox@${baseImageDigest}`;

export function assertE2eGate(env = process.env) {
  if (env.NETBOX_E2E !== "1") {
    const error = new Error(
      "Refusing to launch the disposable NetBox fixture. Set NETBOX_E2E=1 explicitly.",
    );
    error.exitCode = 78;
    throw error;
  }
}

function commandExists(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

/** Select Podman locally, with an explicit Docker-compatible CI override. */
export function selectComposeCommand(env = process.env) {
  const configured = env.NETBOX_E2E_COMPOSE_COMMAND?.trim();
  if (configured) {
    const command = configured.split(/\s+/);
    if (command.length === 0 || command.some((part) => !part)) {
      throw new Error("NETBOX_E2E_COMPOSE_COMMAND must name a compose command.");
    }
    if (!commandExists(command[0], [...command.slice(1), "version"])) {
      throw new Error(
        "NETBOX_E2E_COMPOSE_COMMAND is not an available Compose command; no fixture was launched.",
      );
    }
    return command;
  }
  if (commandExists("podman", ["compose", "version"])) return ["podman", "compose"];
  throw new Error(
    "Podman Compose is required locally (podman compose version failed). For Docker CI, set NETBOX_E2E_COMPOSE_COMMAND='docker compose'.",
  );
}

function secret() {
  return randomBytes(20).toString("hex");
}

export function createFixtureSecretKey() {
  return randomBytes(48).toString("base64url");
}

export function createFixtureSuperuserApiKey() {
  return randomBytes(4).toString("hex");
}

export function createFixtureTokenPepper() {
  return randomBytes(48).toString("base64url");
}

async function freeLoopbackPort() {
  const listener = createServer();
  await new Promise((resolveListen, rejectListen) => {
    listener.once("error", rejectListen);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Unable to reserve a port.");
    return address.port;
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      listener.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
}

function projectName() {
  return `netbox-mcp-e2e-${process.pid}-${randomBytes(4).toString("hex")}`;
}

export function redactor(values) {
  const secrets = values.filter(Boolean).sort((a, b) => b.length - a.length);
  return (text) =>
    secrets.reduce((safe, value) => safe.replaceAll(value, "[REDACTED]"), text);
}

async function createLogger(redact, env = process.env) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const path = resolve(
    root,
    env.NETBOX_E2E_LOG_DIR ?? "artifacts/e2e",
    `netbox-4.6.7-${stamp}-${process.pid}.log`,
  );
  await mkdir(dirname(path), { recursive: true });
  const write = async (text) => appendFile(path, redact(text));
  await write(`Patched NetBox 4.6.7 disposable E2E fixture log (${upstreamRevision})\n`);
  return { path, write };
}

async function run(command, args, env, log, input) {
  await log.write(`$ ${command} ${args.join(" ")}\n`);
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input);
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", async (code) => {
      await log.write(output);
      if (code === 0) resolveRun();
      else
        rejectRun(
          new Error(
            `${command} exited with status ${code ?? "unknown"}. See the redacted fixture log.`,
          ),
        );
    });
  });
}

function gitOutput(source, args) {
  const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Unable to verify the local NetBox source revision (${args.join(" ")}).`,
    );
  }
  return result.stdout.trim();
}

function imageLabel(containerRuntime, image, label) {
  const result = spawnSync(
    containerRuntime,
    ["image", "inspect", image, "--format", `{{index .Config.Labels "${label}"}}`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to inspect provenance for ${image}.`);
  }
  return result.stdout.trim();
}

function verifyPatchedImage(containerRuntime) {
  const provenance = {
    baseDigest: imageLabel(
      containerRuntime,
      patchedImage,
      "org.opencontainers.image.base.digest",
    ),
    revision: imageLabel(
      containerRuntime,
      patchedImage,
      "org.opencontainers.image.revision",
    ),
  };
  if (
    provenance.baseDigest !== baseImageDigest ||
    provenance.revision !== upstreamRevision
  ) {
    throw new Error(
      "Patched E2E image provenance does not match the pinned base or fork revision.",
    );
  }
}

async function preparePatchedImage(env, log, containerRuntime) {
  const source = resolve(
    env.NETBOX_E2E_UPSTREAM_DIR ?? resolve(tmpdir(), "netbox-upstream-467"),
  );
  try {
    await access(resolve(source, ".git"));
  } catch {
    await run(
      "git",
      ["clone", "--branch", upstreamBranch, upstreamSourceUrl, source],
      env,
      log,
    );
  }
  if (gitOutput(source, ["rev-parse", "HEAD"]) !== upstreamRevision) {
    throw new Error(
      `NetBox source must be ${upstreamRevision}; remove ${source} to recreate it from ${upstreamBranch}.`,
    );
  }
  if (gitOutput(source, ["status", "--porcelain"])) {
    throw new Error("NetBox source must be clean before the patched E2E image is built.");
  }
  const containerfile = `FROM ${baseImage}
LABEL org.opencontainers.image.source=${upstreamSourceUrl}
LABEL org.opencontainers.image.revision=${upstreamRevision}
LABEL org.opencontainers.image.base.digest=${baseImageDigest}
COPY --chown=netbox:root netbox/ipam/api/serializers_/ip.py /opt/netbox/netbox/ipam/api/serializers_/ip.py
`;
  await run(
    containerRuntime,
    ["build", "--tag", patchedImage, "--file", "-", source],
    env,
    log,
    containerfile,
  );
  verifyPatchedImage(containerRuntime);
  await log.write(
    `Built ${patchedImage} from ${upstreamSourceUrl}@${upstreamRevision} on ${baseImageDigest}.\n`,
  );
}

async function request(url, token, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok)
    throw new Error(`NetBox request ${path} returned HTTP ${response.status}.`);
  return response;
}

export async function waitForReady(url, token, log) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      await request(url, token, "/api/status/");
      await request(url, token, "/api/schema/?format=json");
      await log.write(
        "NetBox status and authenticated schema readiness checks passed.\n",
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `NetBox did not become ready within ${startupTimeoutMs / 1000}s (${lastError}).`,
  );
}

async function seedPrefix(url, token, log) {
  const response = await request(url, token, "/api/ipam/prefixes/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prefix: "198.51.100.0/29",
      status: "active",
      description: "Disposable MCP available-IPs E2E fixture",
    }),
  });
  const prefix = await response.json();
  if (!prefix || typeof prefix !== "object" || !Number.isInteger(prefix.id)) {
    throw new Error("NetBox created the fixture prefix without a numeric id.");
  }
  await log.write(
    `Seeded deterministic fixture prefix 198.51.100.0/29 (id ${prefix.id}).\n`,
  );
  return prefix;
}

async function composeLogs(compose, project, env, log) {
  try {
    await run(
      compose[0],
      [...compose.slice(1), "-f", composeFile, "-p", project, "logs", "--no-color"],
      env,
      log,
    );
  } catch {
    // The teardown command and retained log are more useful than a secondary log failure.
  }
}

async function composeDown(compose, project, env, log) {
  try {
    await run(
      compose[0],
      [
        ...compose.slice(1),
        "-f",
        composeFile,
        "-p",
        project,
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      env,
      log,
    );
  } catch (error) {
    await log.write(
      `Teardown failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    throw error;
  }
}

export function onceAsync(callback) {
  let result;
  return () => (result ??= callback());
}

export function installSignalTeardown(teardown, processRef = process, stop = () => {}) {
  let started = false;
  const signals = ["SIGINT", "SIGTERM"];
  const remove = () => {
    for (const signal of signals) processRef.removeListener(signal, handler);
  };
  const handler = async (signal) => {
    if (started) return;
    started = true;
    stop();
    try {
      await teardown();
    } finally {
      remove();
      // Removing our listener restores Node's normal signal termination after
      // cleanup rather than quietly turning Ctrl-C into a successful exit.
      if (signal && typeof processRef.kill === "function")
        processRef.kill(processRef.pid, signal);
    }
  };
  for (const signal of signals) processRef.on(signal, handler);
  return remove;
}

function createFixtureLifecycle() {
  let stopped = false;
  return {
    stop: () => {
      stopped = true;
    },
    assertRunning: () => {
      if (stopped) throw new Error("Fixture startup cancelled by SIGINT or SIGTERM.");
    },
  };
}

/**
 * Starts a clean fixture, waits for authenticated readiness, and seeds exactly
 * one deterministic /29. The callback and all startup failures are cleaned up
 * in finally; generated credentials are never returned or logged.
 */
export async function withNetBoxFixture(callback, options = {}) {
  const suppliedEnv = options.env ?? process.env;
  const processRef = options.processRef ?? process;
  assertE2eGate(suppliedEnv);
  const compose = selectComposeCommand(suppliedEnv);
  const superuserApiKey = createFixtureSuperuserApiKey();
  const superuserApiToken = secret();
  const credentials = {
    token: `nbt_${superuserApiKey}.${superuserApiToken}`,
    dbPassword: secret(),
    superuserPassword: secret(),
    superuserApiKey,
    superuserApiToken,
    secretKey: createFixtureSecretKey(),
    tokenPepper: createFixtureTokenPepper(),
  };
  const secrets = Object.values(credentials);
  const port = await freeLoopbackPort();
  const project = projectName();
  const env = {
    ...suppliedEnv,
    NETBOX_E2E_IMAGE: patchedImage,
    NETBOX_E2E_TOKEN: credentials.superuserApiToken,
    NETBOX_E2E_DB_PASSWORD: credentials.dbPassword,
    NETBOX_E2E_SUPERUSER_PASSWORD: credentials.superuserPassword,
    NETBOX_E2E_SUPERUSER_API_KEY: credentials.superuserApiKey,
    NETBOX_E2E_SECRET_KEY: credentials.secretKey,
    NETBOX_E2E_API_TOKEN_PEPPER_1: credentials.tokenPepper,
    NETBOX_E2E_PORT: String(port),
  };
  const redact = redactor(secrets);
  const log = await createLogger(redact, env);
  const url = `http://127.0.0.1:${port}`;
  const teardown = onceAsync(() => composeDown(compose, project, env, log));
  const lifecycle = createFixtureLifecycle();
  const removeSignalTeardown = installSignalTeardown(
    async () => {
      try {
        await teardown();
      } catch {
        // composeDown already recorded the teardown failure in the fixture log.
      }
    },
    processRef,
    lifecycle.stop,
  );
  let fixtureError;

  let callbackResult;
  try {
    await preparePatchedImage(env, log, compose[0]);
    lifecycle.assertRunning();
    await run(
      compose[0],
      [...compose.slice(1), "-f", composeFile, "-p", project, "up", "-d"],
      env,
      log,
    );
    lifecycle.assertRunning();
    await waitForReady(url, credentials.token, log);
    lifecycle.assertRunning();
    const prefix = await seedPrefix(url, credentials.token, log);
    lifecycle.assertRunning();
    callbackResult = await callback({
      url,
      token: credentials.token,
      prefix,
      logPath: log.path,
    });
  } catch (error) {
    fixtureError = error;
    await log.write(
      `Fixture failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await composeLogs(compose, project, env, log);
  }

  let teardownError;
  try {
    await teardown();
  } catch (error) {
    if (!fixtureError) teardownError = error;
  } finally {
    removeSignalTeardown();
  }
  delete env.NETBOX_E2E_TOKEN;
  delete env.NETBOX_E2E_DB_PASSWORD;
  delete env.NETBOX_E2E_SUPERUSER_PASSWORD;
  delete env.NETBOX_E2E_SUPERUSER_API_KEY;
  delete env.NETBOX_E2E_SECRET_KEY;
  delete env.NETBOX_E2E_API_TOKEN_PEPPER_1;
  for (const key of Object.keys(credentials)) credentials[key] = "";
  secrets.fill("");
  if (fixtureError) throw fixtureError;
  if (teardownError) throw teardownError;
  return callbackResult;
}

async function main() {
  try {
    assertE2eGate();
    await withNetBoxFixture(async ({ url, prefix, logPath }) => {
      // Credentials are intentionally omitted from this human-facing result.
      process.stdout.write(
        `NetBox 4.6.7 fixture ready at ${url}; seeded prefix id ${prefix.id}. Redacted log: ${logPath}\n`,
      );
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode =
      error && typeof error === "object" && "exitCode" in error ? error.exitCode : 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
