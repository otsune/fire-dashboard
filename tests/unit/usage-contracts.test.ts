import { expect, it } from "vitest";
import * as usage from "../../packages/usage-contracts/src/index";
import * as legacy from "../../packages/contracts/src/index";

it("keeps the existing wire format independent of Fire contracts", () => {
  expect(usage.emptyUsage("claude")).toEqual(legacy.emptyUsage("claude"));
  const value = {
    schemaVersion: 1, streamId: "test", revision: "9".repeat(39),
    publishedAt: "2026-10-22T00:00:00.000Z",
    usage: [usage.emptyUsage("claude")],
  };
  expect(usage.usageDeliverySchema.parse(value)).toEqual(legacy.usageDeliverySchema.parse(value));
  expect(() => usage.usageDeliverySchema.parse({ ...value, usage: [...value.usage, ...value.usage] })).toThrow();
  expect(usage.windowSchema.parse({ id: "w", label: "枠", usedPercent: null, windowMinutes: 300, resetsAt: null }).usedPercent).toBeNull();
  expect(usage.compareUsageRevision(value, { ...value, revision: "1" })).toBe(1);
  expect(usage.compareUsageRevision(value, { ...value, streamId: "other" })).toBeNull();
});
