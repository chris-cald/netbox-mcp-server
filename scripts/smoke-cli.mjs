#!/usr/bin/env node
// Verify the built binary's CLI contract on whatever platform this is running
// on.
//
// Written in Node rather than shell deliberately: the previous version used
// `set -e`, `$?` and `> /dev/null`, none of which run on Windows, so a Windows
// job would have failed on the smoke test rather than on anything real.
//
// It checks the contract a published package has to honour — the verbs a user
// runs before they have credentials, and the exit code `--check` promises.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const ENTRY = "dist/index.js";
const EX_CONFIG = 78;

if (!existsSync(ENTRY)) {
  console.error(`::error::${ENTRY} does not exist — run \`npm run build\` first.`);
  process.exit(1);
}

/** Run the built binary with a clean environment for the config variables. */
function run(args, overrides = {}) {
  const env = { ...process.env };
  delete env["NETBOX_URL"];
  delete env["NETBOX_TOKEN"];
  delete env["NETBOX_TOKEN_FILE"];
  delete env["NETBOX_INSECURE"];
  return spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });
}

let failures = 0;
function check(what, condition, detail) {
  if (condition) {
    console.log(`  ok    ${what}`);
  } else {
    console.log(`::error::${what} — ${detail}`);
    failures += 1;
  }
}

console.log(`smoke test on ${process.platform}/${process.arch}, node ${process.version}`);

const version = run(["--version"]);
check(
  "--version prints the package version and exits 0",
  version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()),
  `status=${version.status} stdout=${JSON.stringify(version.stdout)}`,
);

const help = run(["--help"]);
check(
  "--help exits 0 and mentions the required variables",
  help.status === 0 &&
    help.stdout.includes("NETBOX_URL") &&
    help.stdout.includes("NETBOX_TOKEN"),
  `status=${help.status}`,
);

const expectedListToolsStdout =
  "netbox_global_search\nnetbox_discover\nnetbox_describe\nnetbox_read\nnetbox_write\n";
const expectedListToolsStderr = "5 tools registered.\n";
function hasExactListToolsOutput(stdout, stderr) {
  return stdout === expectedListToolsStdout && stderr === expectedListToolsStderr;
}

// These fixtures prove that leading or trailing blank output is a contract failure.
check(
  "--list-tools exact output comparison rejects leading or trailing blank output",
  !hasExactListToolsOutput(`\n${expectedListToolsStdout}`, expectedListToolsStderr) &&
    !hasExactListToolsOutput(`${expectedListToolsStdout}\n`, expectedListToolsStderr) &&
    !hasExactListToolsOutput(expectedListToolsStdout, `\n${expectedListToolsStderr}`) &&
    !hasExactListToolsOutput(expectedListToolsStdout, `${expectedListToolsStderr}\n`),
  "a leading or trailing blank line was accepted",
);

const list = run(["--list-tools"]);
check(
  "--list-tools reports exactly the five ordered tool names and one trailing newline",
  list.status === 0 && hasExactListToolsOutput(list.stdout, list.stderr),
  `status=${list.status} stdout=${JSON.stringify(list.stdout)} stderr=${JSON.stringify(list.stderr)}`,
);

const uncheck = run(["--check"]);
check(
  `--check exits ${EX_CONFIG} with no configuration`,
  uncheck.status === EX_CONFIG,
  `got ${uncheck.status}`,
);
check(
  "--check names the variable that is missing",
  (uncheck.stderr + uncheck.stdout).includes("NETBOX_URL"),
  "the message did not name NETBOX_URL",
);

const configured = run(["--check"], {
  NETBOX_URL: "https://netbox.invalid",
  NETBOX_TOKEN: "smoke-test-token",
});
check(
  "--check exits 0 when configured, without contacting NetBox",
  configured.status === 0,
  `got ${configured.status}: ${configured.stderr}`,
);
check(
  "--check does not echo the token",
  !(configured.stdout + configured.stderr).includes("smoke-test-token"),
  "the token appeared in the output",
);

if (failures > 0) {
  console.error(`::error::${failures} smoke check(s) failed on ${process.platform}`);
  process.exit(1);
}
console.log(`all smoke checks passed on ${process.platform}/${process.arch}`);
