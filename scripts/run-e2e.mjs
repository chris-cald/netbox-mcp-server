#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const child = spawn(
  process.execPath,
  [vitest, "run", "--config", "vitest.e2e.config.ts"],
  {
    env: { ...process.env, NETBOX_E2E: "1" },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
