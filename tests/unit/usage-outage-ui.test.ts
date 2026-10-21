import { expect, it } from "vitest";
import {
  emptyDashboard,
  parseDashboard,
} from "../../packages/contracts/src/index";
import { applyHttpDashboard } from "../../apps/dashboard/src/data/usage-state";

it("retains backend outage status without changing canonical same-revision usage", () => {
  const base = {
    ...emptyDashboard(),
    usageConnection: "connected" as const,
    usageDelivery: {
      schemaVersion: 1 as const,
      streamId: "s",
      revision: "2",
      publishedAt: "2026-10-22T00:00:00.000Z",
    },
  };
  const incoming = parseDashboard({ ...base, usageConnection: "unavailable" });
  const next = applyHttpDashboard(base, incoming);
  expect(next.usageConnection).toBe("unavailable");
  expect(next.usage).toEqual(base.usage);
  expect(next.usageDelivery).toEqual(base.usageDelivery);
});
