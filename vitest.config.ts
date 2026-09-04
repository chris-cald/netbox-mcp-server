import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The live contract suite (issue #4) talks to a real NetBox instance and
    // has its own config, `vitest.contract.config.ts`. `npm test` stays
    // hermetic: it must not become network-dependent because a developer
    // happens to have NETBOX_URL exported.
    exclude: ["node_modules/**", "dist/**", "tests/contract/**", "tests/e2e/**"],
    environment: "node",
    // The surface and packaging suites build and spawn the server; they are
    // slower than a unit test and must not be raced against each other.
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Transport wiring is exercised by the surface suite through a real
      // stdio handshake, not by unit tests.
      exclude: ["src/index.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
