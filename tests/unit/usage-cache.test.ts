import { expect, it } from "vitest";
import {
  saveDashboard,
  saveUsage,
  loadDashboard,
} from "../../apps/dashboard/src/data/cache";
import { emptyDashboard } from "../../packages/contracts/src/index";
import { usageEnvelope } from "../helpers/usage";
it("updates MQTT usage without replacing a concurrently newer weather snapshot", async () => {
  const base = emptyDashboard();
  base.weather.regionId = "130010";
  await saveDashboard(base);
  const live = { ...emptyDashboard(), usage: [usageEnvelope(1).payload] };
  live.weather.regionId = "140010";
  await saveUsage(live);
  const saved = await loadDashboard();
  expect(saved?.weather.regionId).toBe("130010");
  expect(saved?.usage[0].buckets[0].windows[0].usedPercent).toBe(30);
});
