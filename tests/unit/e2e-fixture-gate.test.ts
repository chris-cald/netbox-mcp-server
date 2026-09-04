import { execFile } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

const runner = new URL("../../scripts/e2e-netbox.mjs", import.meta.url);
const compose = new URL("../../docker-compose.e2e.yml", import.meta.url);
const packageJson = new URL("../../package.json", import.meta.url);
const e2eLauncher = new URL("../../scripts/run-e2e.mjs", import.meta.url);
const defaultVitestConfig = new URL("../../vitest.config.ts", import.meta.url);
const compatibility = new URL("../../docs/compatibility.md", import.meta.url);
const fixtureReadme = new URL("../fixtures/README.md", import.meta.url);

async function loadRunnerWithComposeFailure() {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    spawnSync: vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.includes("rev-parse")
        ? "635361b87d67b70e9338fa141e8ad932c2b2fba4\n"
        : args.join(" ").includes("base.digest")
          ? "sha256:7ad3a287d38829c98799c4a03d874d3d309738d1f42987dfd8037ec0e80587ce\n"
          : args.join(" ").includes("image.revision")
            ? "635361b87d67b70e9338fa141e8ad932c2b2fba4\n"
            : "",
    })),
    spawn: vi.fn((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: { end: vi.fn() },
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => child.emit("close", args.includes("down") ? 1 : 0));
      return child;
    }),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(init?.method === "POST" ? { id: 1 } : {}),
      }),
    ),
  );
  return (await import(`${runner.href}?compose-failure=${Date.now()}`)) as unknown as {
    withNetBoxFixture: <T>(
      callback: (fixture: { logPath: string }) => Promise<T>,
      options: { env: NodeJS.ProcessEnv },
    ) => Promise<T>;
  };
}

async function loadRunnerWithPendingComposeDown() {
  let completeDown: (() => void) | undefined;
  let signalDownStarted!: () => void;
  const downStarted = new Promise<void>((resolve) => {
    signalDownStarted = resolve;
  });
  let downCount = 0;

  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    spawnSync: vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.includes("rev-parse")
        ? "635361b87d67b70e9338fa141e8ad932c2b2fba4\n"
        : args.join(" ").includes("base.digest")
          ? "sha256:7ad3a287d38829c98799c4a03d874d3d309738d1f42987dfd8037ec0e80587ce\n"
          : args.join(" ").includes("image.revision")
            ? "635361b87d67b70e9338fa141e8ad932c2b2fba4\n"
            : "",
    })),
    spawn: vi.fn((_command: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: { end: vi.fn() },
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => {
        if (args.includes("down")) {
          downCount += 1;
          signalDownStarted();
          completeDown = () => child.emit("close", 0);
        } else {
          child.emit("close", 0);
        }
      });
      return child;
    }),
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(init?.method === "POST" ? { id: 1 } : {}),
      }),
    ),
  );
  const module = (await import(
    `${runner.href}?pending-compose-down=${Date.now()}`
  )) as unknown as {
    withNetBoxFixture: <T>(
      callback: (fixture: { logPath: string }) => Promise<T>,
      options: { env: NodeJS.ProcessEnv },
    ) => Promise<T>;
  };
  return {
    ...module,
    downStarted,
    finishDown: () => completeDown?.(),
    downCount: () => downCount,
  };
}

async function loadRunnerWithBlockedBuild() {
  let finishBuild: (() => void) | undefined;
  let signalBuildStarted!: () => void;
  const buildStarted = new Promise<void>((resolve) => {
    signalBuildStarted = resolve;
  });
  let signalDownStarted!: () => void;
  const downStarted = new Promise<void>((resolve) => {
    signalDownStarted = resolve;
  });
  const commands: string[][] = [];

  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    spawnSync: vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout: args.includes("rev-parse")
        ? "635361b87d67b70e9338fa141e8ad932c2b2fba4\n"
        : args.join(" ").includes("base.digest")
          ? "sha256:7ad3a287d38829c98799c4a03d874d3d309738d1f42987dfd8037ec0e80587ce\n"
          : args.join(" ").includes("image.revision")
            ? "635361b87d67b70e9338fa141e8ad932c2b2fba4\n"
            : "",
    })),
    spawn: vi.fn((command: string, args: string[]) => {
      commands.push([command, ...args]);
      const child = Object.assign(new EventEmitter(), {
        stdin: { end: vi.fn() },
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      queueMicrotask(() => {
        if (command === "git" && args.includes("clone")) {
          signalBuildStarted();
          finishBuild = () => child.emit("close", 0);
        } else if (args.includes("down")) {
          signalDownStarted();
          child.emit("close", 0);
        } else {
          child.emit("close", 0);
        }
      });
      return child;
    }),
  }));
  vi.stubGlobal("fetch", vi.fn());
  const module = (await import(
    `${runner.href}?blocked-build=${Date.now()}`
  )) as unknown as {
    withNetBoxFixture: <T>(
      callback: (fixture: { logPath: string }) => Promise<T>,
      options: { env: NodeJS.ProcessEnv; processRef: EventEmitter },
    ) => Promise<T>;
  };
  return {
    ...module,
    buildStarted,
    downStarted,
    finishBuild: () => finishBuild?.(),
    commands,
  };
}

async function runRunner(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stderr: string;
}> {
  const child = execFile(process.execPath, [runner.pathname], { env });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stderr };
}

describe("disposable NetBox E2E fixture gate", () => {
  it("refuses to select a container runtime unless NETBOX_E2E=1", async () => {
    const result = await runRunner({ ...process.env, NETBOX_E2E: "0" });

    expect(result.code).toBe(78);
    expect(result.stderr).toContain("NETBOX_E2E=1");
    expect(result.stderr).not.toContain("NETBOX_E2E_TOKEN");
  });

  it("launches E2E tests through Node so the environment is portable", async () => {
    const [manifestText, launcher, defaultConfig] = await Promise.all([
      readFile(packageJson, "utf8"),
      readFile(e2eLauncher, "utf8"),
      readFile(defaultVitestConfig, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as { scripts: Record<string, string> };

    expect(manifest.scripts["test:e2e"]).toBe("node scripts/run-e2e.mjs");
    expect(launcher).toContain('NETBOX_E2E: "1"');
    expect(launcher).toContain("node_modules/vitest/vitest.mjs");
    expect(defaultConfig).toContain('"tests/e2e/**"');
  });

  it("authenticates both readiness probes with a v2 Bearer token without logging it", async () => {
    const token = `nbt_${"a".repeat(8)}.${"b".repeat(40)}`;
    const fetchCalls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = vi.fn((url: URL, init?: RequestInit) => {
      fetchCalls.push({ url, init: init ?? {} });
      return Promise.resolve({ ok: true, status: 200 });
    });
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    try {
      vi.resetModules();
      const { waitForReady } = (await import(
        `${runner.href}?readiness-auth=${Date.now()}`
      )) as unknown as {
        waitForReady: (
          url: string,
          token: string,
          log: { write: (text: string) => Promise<void> },
        ) => Promise<void>;
      };
      await waitForReady("http://127.0.0.1:1234", token, { write });

      expect(fetchCalls.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
        "/api/status/",
        "/api/schema/?format=json",
      ]);
      expect(fetchCalls.map(({ init }) => init.headers)).toEqual([
        { Accept: "application/json", Authorization: `Bearer ${token}` },
        { Accept: "application/json", Authorization: `Bearer ${token}` },
      ]);
      expect(write.mock.calls.flat().join("")).not.toContain(token);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("generates an unprefixed 8-character superuser API key for NetBox v2 tokens", async () => {
    const {
      createFixtureSecretKey,
      createFixtureSuperuserApiKey,
      createFixtureTokenPepper,
    } = (await import(runner.href)) as unknown as {
      createFixtureSecretKey: () => string;
      createFixtureSuperuserApiKey: () => string;
      createFixtureTokenPepper: () => string;
    };
    const secretKey = createFixtureSecretKey();
    const firstSuperuserApiKey = createFixtureSuperuserApiKey();
    const secondSuperuserApiKey = createFixtureSuperuserApiKey();
    const pepper = createFixtureTokenPepper();

    expect(secretKey).toMatch(/^[A-Za-z0-9_-]{64,}$/);
    expect(firstSuperuserApiKey).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(secondSuperuserApiKey).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(firstSuperuserApiKey).not.toBe(secondSuperuserApiKey);
    expect(firstSuperuserApiKey).not.toBe(secretKey);
    expect(pepper).toMatch(/^[A-Za-z0-9_-]{64,}$/);
  });

  it("redacts the unprefixed API key, full Bearer credential, and API token pepper", async () => {
    const { redactor } = (await import(runner.href)) as unknown as {
      redactor: (values: string[]) => (text: string) => string;
    };
    const superuserApiKey = "safe-key";
    const token = `nbt_${superuserApiKey}.${"s".repeat(40)}`;
    const pepper = "fixture-api-token-pepper";

    expect(
      redactor([superuserApiKey, token, pepper])(
        `error: ${superuserApiKey} Bearer ${token} ${pepper}`,
      ),
    ).toBe("error: [REDACTED] Bearer [REDACTED] [REDACTED]");
  });

  it("propagates a teardown failure after successful fixture work and logs it", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "netbox-e2e-test-"));
    try {
      const { withNetBoxFixture } = await loadRunnerWithComposeFailure();
      await expect(
        withNetBoxFixture(() => Promise.resolve(undefined), {
          env: { ...process.env, NETBOX_E2E: "1", NETBOX_E2E_LOG_DIR: logDir },
        }),
      ).rejects.toThrow("exited with status 1");

      const [logFile] = await readdir(logDir);
      if (!logFile) throw new Error("fixture log was not written");
      await expect(readFile(join(logDir, logFile), "utf8")).resolves.toContain(
        "Teardown failed: podman exited with status 1",
      );
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock("node:child_process");
      vi.resetModules();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("retains a fixture error when teardown also fails and logs both", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "netbox-e2e-test-"));
    try {
      const { withNetBoxFixture } = await loadRunnerWithComposeFailure();
      await expect(
        withNetBoxFixture(() => Promise.reject(new Error("fixture callback failed")), {
          env: { ...process.env, NETBOX_E2E: "1", NETBOX_E2E_LOG_DIR: logDir },
        }),
      ).rejects.toThrow("fixture callback failed");

      const [logFile] = await readdir(logDir);
      if (!logFile) throw new Error("fixture log was not written");
      const log = await readFile(join(logDir, logFile), "utf8");
      expect(log).toContain("Fixture failed: fixture callback failed");
      expect(log).toContain("Teardown failed: podman exited with status 1");
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock("node:child_process");
      vi.resetModules();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("keeps signal handlers active until normal teardown settles", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "netbox-e2e-test-"));
    const sigintBefore = new Set(process.listeners("SIGINT"));
    const sigtermBefore = new Set(process.listeners("SIGTERM"));
    let fixture: Promise<void> | undefined;
    let finishDown: (() => void) | undefined;
    try {
      const runnerModule = await loadRunnerWithPendingComposeDown();
      finishDown = runnerModule.finishDown;
      fixture = runnerModule.withNetBoxFixture(() => Promise.resolve(undefined), {
        env: { ...process.env, NETBOX_E2E: "1", NETBOX_E2E_LOG_DIR: logDir },
      });

      await runnerModule.downStarted;
      const sigint = process
        .listeners("SIGINT")
        .find((handler) => !sigintBefore.has(handler));
      const sigterm = process
        .listeners("SIGTERM")
        .find((handler) => !sigtermBefore.has(handler));
      expect(sigint).toBeTypeOf("function");
      expect(sigterm).toBe(sigint);

      const signalTeardown = (sigint as () => Promise<void>)();
      expect(runnerModule.downCount()).toBe(1);
      finishDown();
      await fixture;
      await signalTeardown;
      expect(process.listeners("SIGINT")).not.toContain(sigint);
      expect(process.listeners("SIGTERM")).not.toContain(sigterm);
    } finally {
      finishDown?.();
      await fixture?.catch(() => undefined);
      vi.unstubAllGlobals();
      vi.doUnmock("node:child_process");
      vi.resetModules();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("cancels a build race before compose up or the fixture callback", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "netbox-e2e-test-"));
    const sourceDir = await mkdtemp(join(tmpdir(), "netbox-e2e-source-"));
    const processRef = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    processRef.pid = 1234;
    processRef.kill = vi.fn();
    try {
      const runnerModule = await loadRunnerWithBlockedBuild();
      const callback = vi.fn(() => Promise.resolve(undefined));
      const fixture = runnerModule.withNetBoxFixture(callback, {
        env: {
          ...process.env,
          NETBOX_E2E: "1",
          NETBOX_E2E_LOG_DIR: logDir,
          NETBOX_E2E_UPSTREAM_DIR: sourceDir,
        },
        processRef,
      });

      await runnerModule.buildStarted;
      processRef.emit("SIGINT", "SIGINT");
      await runnerModule.downStarted;
      runnerModule.finishBuild();
      await expect(fixture).rejects.toThrow("startup cancelled");
      expect(callback).not.toHaveBeenCalled();
      expect(runnerModule.commands.some((args) => args.includes("up"))).toBe(false);
      expect(processRef.kill).toHaveBeenCalledWith(1234, "SIGINT");
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock("node:child_process");
      vi.resetModules();
      await Promise.all([
        rm(logDir, { recursive: true, force: true }),
        rm(sourceDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("waits for one signal teardown and removes both signal handlers", async () => {
    const { installSignalTeardown, onceAsync } = (await import(
      runner.href
    )) as unknown as {
      installSignalTeardown: (
        teardown: () => Promise<void>,
        processRef: {
          on: (signal: string, handler: () => Promise<void>) => void;
          removeListener: (signal: string, handler: () => Promise<void>) => void;
        },
      ) => () => void;
      onceAsync: (callback: () => Promise<void>) => () => Promise<void>;
    };
    const handlers = new Map<string, () => Promise<void>>();
    const removeListener = vi.fn((signal: string) => handlers.delete(signal));
    const processRef = {
      on: (signal: string, handler: () => Promise<void>) => handlers.set(signal, handler),
      removeListener,
    };
    let finishTeardown!: () => void;
    const teardown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTeardown = resolve;
        }),
    );
    installSignalTeardown(onceAsync(teardown), processRef);

    const sigint = handlers.get("SIGINT");
    if (!sigint) throw new Error("SIGINT handler was not installed");
    const waiting = sigint();
    expect(teardown).toHaveBeenCalledOnce();
    expect(removeListener).not.toHaveBeenCalled();
    const sigterm = handlers.get("SIGTERM");
    if (!sigterm) throw new Error("SIGTERM handler was not installed");
    await sigterm();
    expect(teardown).toHaveBeenCalledOnce();

    finishTeardown();
    await waiting;
    expect(removeListener).toHaveBeenCalledWith("SIGINT", sigint);
    expect(removeListener).toHaveBeenCalledWith("SIGTERM", sigint);
  });

  it("restores signal termination only after awaited teardown", async () => {
    const { installSignalTeardown } = (await import(runner.href)) as unknown as {
      installSignalTeardown: (
        teardown: () => Promise<void>,
        processRef: {
          pid: number;
          on: (signal: string, handler: (signal?: string) => Promise<void>) => void;
          removeListener: (
            signal: string,
            handler: (signal?: string) => Promise<void>,
          ) => void;
          kill: (pid: number, signal: string) => void;
        },
      ) => () => void;
    };
    const handlers = new Map<string, (signal?: string) => Promise<void>>();
    let finishTeardown!: () => void;
    const kill = vi.fn();
    installSignalTeardown(
      () =>
        new Promise<void>((resolve) => {
          finishTeardown = resolve;
        }),
      {
        pid: 1234,
        on: (signal, handler) => handlers.set(signal, handler),
        removeListener: (signal) => handlers.delete(signal),
        kill,
      },
    );

    const sigint = handlers.get("SIGINT");
    if (!sigint) throw new Error("SIGINT handler was not installed");
    const waiting = sigint("SIGINT");
    expect(kill).not.toHaveBeenCalled();
    finishTeardown();
    await waiting;
    expect(kill).toHaveBeenCalledWith(1234, "SIGINT");
  });

  it("requires a pinned locally-built patched image without replacing the stock fixture", async () => {
    const [fixture, runnerSource, compatibilityText, fixtureReadmeText] =
      await Promise.all([
        readFile(compose, "utf8"),
        readFile(runner, "utf8"),
        readFile(compatibility, "utf8"),
        readFile(fixtureReadme, "utf8"),
      ]);

    expect(fixture).toContain("image: ${NETBOX_E2E_IMAGE:?NETBOX_E2E_IMAGE is required}");
    expect(fixture).not.toContain("image: netboxcommunity/netbox:v4.6.7");
    expect(runnerSource).toContain(
      'const upstreamRevision = "635361b87d67b70e9338fa141e8ad932c2b2fba4";',
    );
    expect(runnerSource).toContain(
      'const patchedImage = "localhost/netbox-mcp-e2e:4.6.7-635361b";',
    );
    expect(runnerSource).toContain("const baseImageDigest =");
    expect(runnerSource).toContain(
      "sha256:7ad3a287d38829c98799c4a03d874d3d309738d1f42987dfd8037ec0e80587ce",
    );
    expect(runnerSource).toContain("FROM ${baseImage}");
    expect(runnerSource).toContain("verifyPatchedImage(containerRuntime)");
    expect(fixture).toContain(
      "postgres@sha256:53964f0d111d959109d9444640f4876b7b93e1bfff73716cfa93609dca582a66",
    );
    expect(fixture).toContain(
      "redis@sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952",
    );
    expect(runnerSource).toContain("git");
    expect(runnerSource).toContain("rev-parse");
    expect(runnerSource).toContain("podman");
    expect(runnerSource).toContain("NETBOX_E2E_IMAGE: patchedImage");
    expect(compatibilityText).toContain("Patched local E2E fixture");
    expect(compatibilityText).toContain("unpatched NetBox 4.6.7");
    expect(fixtureReadmeText).toContain("must remain unmodified");
  });

  it("passes, redacts, and clears generated fixture secrets through the contract", async () => {
    const [fixture, runnerSource] = await Promise.all([
      readFile(compose, "utf8"),
      readFile(runner, "utf8"),
    ]);
    const postgres = fixture.slice(
      fixture.indexOf("  postgres:"),
      fixture.indexOf("\n\n  redis:"),
    );
    const netbox = fixture.slice(fixture.indexOf("  netbox:"));

    expect(postgres).toContain(`    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U netbox -d netbox"]
      interval: 2s
      timeout: 5s
      retries: 30
      start_period: 15s`);
    expect(netbox).toContain('      DB_WAIT_TIMEOUT: "5"\n      MAX_DB_WAIT_TIME: "120"');
    expect(netbox).toContain(
      "      SECRET_KEY: ${NETBOX_E2E_SECRET_KEY:?NETBOX_E2E_SECRET_KEY is required}",
    );
    expect(netbox).toContain(
      "      SUPERUSER_API_KEY: ${NETBOX_E2E_SUPERUSER_API_KEY:?NETBOX_E2E_SUPERUSER_API_KEY is required}",
    );
    expect(netbox).toContain(
      "      API_TOKEN_PEPPER_1: ${NETBOX_E2E_API_TOKEN_PEPPER_1:?NETBOX_E2E_API_TOKEN_PEPPER_1 is required}",
    );
    expect(runnerSource).toContain(
      "NETBOX_E2E_SUPERUSER_API_KEY: credentials.superuserApiKey",
    );
    expect(runnerSource).toContain("NETBOX_E2E_TOKEN: credentials.superuserApiToken");
    expect(runnerSource).toContain('return randomBytes(4).toString("hex");');
    expect(runnerSource).toContain(
      "token: `nbt_${superuserApiKey}.${superuserApiToken}`",
    );
    expect(runnerSource).toContain("NETBOX_E2E_SECRET_KEY: credentials.secretKey");
    expect(runnerSource).toContain(
      "NETBOX_E2E_API_TOKEN_PEPPER_1: credentials.tokenPepper",
    );
    expect(runnerSource).toContain("const redact = redactor(secrets);");
    expect(runnerSource).toContain("delete env.NETBOX_E2E_SUPERUSER_API_KEY;");
    expect(runnerSource).toContain(
      'for (const key of Object.keys(credentials)) credentials[key] = "";',
    );
    expect(runnerSource).toContain('secrets.fill("");');
    expect(runnerSource).toContain("delete env.NETBOX_E2E_SECRET_KEY;");
    expect(runnerSource).toContain("delete env.NETBOX_E2E_API_TOKEN_PEPPER_1;");
  });
});
