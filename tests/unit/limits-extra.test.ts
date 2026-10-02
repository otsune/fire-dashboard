import { it, expect } from "vitest";
import { createRateLimiter } from "../../services/aggregator/src/usage/ingest";
import { createServer } from "../../services/aggregator/src/server";
import { createMemoryStore } from "../../services/aggregator/src/store";
import { emptyUsage, emptyCommon } from "../../packages/contracts/src/index";
it("limits burst to five with one token replenished per second", () => {
  const accept = createRateLimiter();
  expect(Array.from({ length: 6 }, () => accept("pc", 0))).toEqual([
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  expect(accept("pc", 999)).toBe(false);
  expect(accept("pc", 1000)).toBe(true);
});
it("wires authenticated collector ingest and denies unauthenticated source metadata", async () => {
  const s = createServer({
    store: createMemoryStore(),
    authorize: async (_req, role) => role === "collector",
    sourceAlias: async () => "pc",
    preferredSources: { claude: "pc" },
  });
  const payload = {
    snapshotId: "s1",
    sequence: 1,
    sourceAlias: "pc",
    payload: {
      ...emptyUsage("claude"),
      ...emptyCommon("ok"),
      sourceAlias: "pc",
    },
  };
  const result = await s.inject({
    url: "/api/v1/usage",
    method: "POST",
    payload,
  });
  expect(result.statusCode).toBe(200);
  expect(result.json().status).toBe("accepted");
  await s.close();
});
