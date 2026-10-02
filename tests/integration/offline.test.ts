import { it, expect } from "vitest";
import {
  emptyDashboard,
  emptyCommon,
} from "../../packages/contracts/src/index";
import {
  saveDashboard,
  loadDashboard,
  mergeDashboard,
} from "../../apps/dashboard/src/data/cache";
it("preserves a healthy card across partial adapter failure", () => {
  const previous = emptyDashboard();
  previous.weather = {
    ...previous.weather,
    ...emptyCommon("ok"),
    regionLabel: "旧正常地域",
  };
  const next = emptyDashboard();
  next.weather = { ...next.weather, status: "error", errorCode: "network" };
  const merged = mergeDashboard(previous, next);
  expect(merged.weather.regionLabel).toBe("旧正常地域");
  expect(merged.weather.status).toBe("error");
  expect(merged.usage).toEqual(next.usage);
});
it("atomically persists and reloads normalized cards", async () => {
  const d = emptyDashboard();
  d.usage[0].sourceAlias = "test-source";
  await saveDashboard(d);
  expect(await loadDashboard()).toEqual(d);
});
