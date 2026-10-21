import { spawnSync } from "node:child_process";
// Uses only the test's ephemeral container, random loopback ports and topic.
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/integration/usage-broker.test.ts",
  ],
  {
    env: { ...process.env, USAGE_BROKER_TEST: "1" },
    stdio: "inherit",
  },
);
process.exitCode = result.status ?? 1;
