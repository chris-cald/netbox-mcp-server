import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Build must run before test in every workflow that does both.
 *
 * `tests/installation/package-contents.test.ts` asks `npm pack` what would be
 * published, and `files` points at `dist`. Without a build the tarball is
 * documents only and that suite fails for a reason unrelated to the change
 * under test. It passes locally regardless, because a previous build leaves
 * `dist/` lying around — so the failure only exists on a clean checkout, which
 * is exactly what CI is.
 *
 * This has now been got wrong twice: once in `ci.yml`, and then again in
 * `release.yml`, which kept the wrong order after `ci.yml` was fixed and cost
 * a release run to discover. Two occurrences of the same defect in two files
 * is a class, and a class deserves a test rather than a third fix.
 */
const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/release.yml"];

/** Step names in file order. Deliberately not a YAML parse — the order of
 *  `- name:` entries is the whole property under test, and a parser that
 *  normalises or regroups them would hide it. */
function stepNames(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => /^\s*-\s*name:\s*(.+?)\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe.each(WORKFLOWS)("%s", (workflow) => {
  const names = stepNames(workflow);

  it("has steps at all, so a rename cannot make this test vacuous", () => {
    expect(names.length).toBeGreaterThan(3);
  });

  it("runs Build before Test", () => {
    const build = names.findIndex((n) => n === "Build");
    const test = names.findIndex((n) => n.startsWith("Test"));

    // A workflow that does neither is fine; one that does both must order them.
    if (build === -1 || test === -1) return;

    expect(
      build,
      `${workflow} runs "${names[test] ?? "Test"}" before "Build". ` +
        "The packaging suite inspects `npm pack` output, which is empty without " +
        "a build, and fails with an error that looks like a broken package.",
    ).toBeLessThan(test);
  });

  it("runs Build before any step that executes the built binary", () => {
    const build = names.findIndex((n) => n === "Build");
    const smoke = names.findIndex((n) => n.toLowerCase().includes("smoke"));
    if (build === -1 || smoke === -1) return;
    expect(build).toBeLessThan(smoke);
  });
});

/**
 * The `.npmrc` `_authToken` line is load-bearing on ONE path and fatal on the
 * other, which is why this is pinned rather than left to a comment.
 *
 * setup-node writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`.
 * Under trusted publishing that variable is unset, so npm reads an empty
 * credential, decides auth is configured, and never starts the OIDC exchange —
 * the line has to go. Under a granular token that same line is the only thing
 * telling npm to use NODE_AUTH_TOKEN — the line has to stay.
 *
 * Stripping it unconditionally passes every check including `npm publish
 * --dry-run`, because a dry run never authenticates, and then fails ENEEDAUTH
 * at the real publish. That is exactly what happened on the first v0.1.0
 * release run.
 */
describe(".github/workflows/ci.yml opt-in NetBox E2E", () => {
  const yaml = readFileSync(".github/workflows/ci.yml", "utf8");

  it("keeps the container fixture manual or explicitly opted in without secrets", () => {
    const job = yaml.slice(yaml.indexOf("  netbox-e2e:"), yaml.indexOf("\n  secrets:"));
    expect(job).toContain("NetBox fixture E2E (manual/opt-in)");
    expect(job).toContain(
      "github.event_name == 'workflow_dispatch' || vars.NETBOX_E2E == '1'",
    );
    expect(job).toContain("runs-on: ubuntu-latest");
    expect(job).toContain('NETBOX_E2E_COMPOSE_COMMAND: "docker compose"');
    expect(job).not.toContain("secrets.");
  });
});

describe(".github/workflows/release.yml auth paths", () => {
  const yaml = readFileSync(".github/workflows/release.yml", "utf8");

  it("strips the _authToken line only when there is no NPM_TOKEN", () => {
    const step = /- name: Strip the _authToken line[^\n]*\n([\s\S]*?)\n\s*- name:/.exec(
      yaml,
    );
    expect(step, "the strip step is gone — was it renamed?").not.toBeNull();
    expect(
      step?.[1] ?? "",
      "the strip step must be conditional. Unconditional, it deletes the line " +
        "the granular-token path depends on, and the failure appears only at " +
        "the real publish — after the dry run has passed.",
    ).toMatch(/if:\s*env\.HAS_NPM_TOKEN\s*!=\s*'true'/);
  });

  it("never reads `secrets` in a step-level if", () => {
    // A `secrets` reference in a step `if` does not fail the step — it fails
    // the whole workflow file to parse, producing a run with no jobs, no logs
    // and a message that points nowhere.
    const stepIfs = yaml.split("\n").filter((l) => /^\s+if:/.test(l));
    for (const line of stepIfs) {
      expect(line, "use a job-level env, compared as a string").not.toContain("secrets.");
    }
  });
});

/**
 * The skill is NOT in the npm tarball.
 *
 * `files` points at `dist`, and the publish job's build step is `tsc`, so
 * `dist/skills/` does not exist when `npm pack` runs. That is fine — the skill
 * is not a Node module — but it means the GitHub release is the ONLY place a
 * user on ChatGPT desktop or Grok Build can get the skill as a file.
 *
 * `docs/installing-the-skill.md` said so before it was true. v0.2.0 published
 * to npm and produced no GitHub release at all, only a tag: `release.yml`
 * never ran `build:skill`, never created a release, never uploaded an asset.
 * Nothing failed, because nothing was watching.
 */
describe(".github/workflows/release.yml ships the skill", () => {
  const yaml = readFileSync(".github/workflows/release.yml", "utf8");

  it("packages the skill during a release", () => {
    expect(yaml).toContain("npm run build:skill");
  });

  it("attaches both artifacts to the release", () => {
    // The archive is for Claude; the flattened Markdown is for the surfaces
    // that take an uploaded document instead of a skill directory. Shipping
    // one without the other silently strands half the install matrix.
    expect(yaml).toContain("dist/skills/netbox-modeling.skill");
    expect(yaml).toContain("dist/skills/netbox-modeling.md");
    expect(yaml).toContain("gh release create");
  });

  it("creates the release only after the publish succeeded", () => {
    // Otherwise a failed publish leaves a release announcing a version that is
    // not on the registry — worse than no release, because it looks fine.
    expect(yaml).toMatch(/github-release:[\s\S]*?needs:\s*publish/);
  });

  it("keeps contents:write off the job that holds the npm credential", () => {
    // Least privilege, and it is cheap to state: the release job needs write to
    // create a release; the publish job must not have it.
    const publishBlock = yaml.slice(
      yaml.indexOf("  publish:"),
      yaml.indexOf("  github-release:"),
    );
    const releaseBlock = yaml.slice(yaml.indexOf("  github-release:"));
    expect(publishBlock).not.toContain("contents: write");
    expect(releaseBlock).toContain("contents: write");
  });

  it("refuses to upload an artifact that built empty", () => {
    // A zip writer that produced a 0-byte archive would otherwise be published
    // as a release asset and found by whoever downloaded it.
    expect(yaml).toMatch(/is missing or empty|-s "\$f"/);
  });
});
