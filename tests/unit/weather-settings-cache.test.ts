import { expect, it, vi, afterEach } from "vitest";
import { emptyDashboard } from "../../packages/contracts/src/index";
import {
  invalidateDashboardCache,
  mergeDashboard,
  saveDashboard,
  loadDashboard,
} from "../../apps/dashboard/src/data/cache";
import * as db from "../../apps/dashboard/src/data/db";
afterEach(() => vi.restoreAllMocks());
const weatherAt = (revision: string) => ({
  ...emptyDashboard().weather,
  configurationRevision: revision,
  regionId: "130010",
  regionLabel: "東京",
  temperatureStationLabel: "東京",
  status: "ok" as const,
  lastSuccessAt: "2026-10-03T12:00:00Z",
  periods: [
    {
      startsAt: "2026-10-03T00:00:00Z",
      endsAt: "2026-10-04T00:00:00Z",
      summary: "晴れ",
      weatherCode: "100",
      temperatureMinC: 18,
      temperatureMaxC: 28,
      precipitationProbabilityPct: 0,
    },
  ],
});
it("never preserves station temperatures across configuration revisions", () => {
  const previous = { ...emptyDashboard(), weather: weatherAt("r1") };
  const next = {
    ...emptyDashboard(),
    weather: { ...weatherAt("r2"), status: "error" as const, periods: [] },
  };
  expect(mergeDashboard(previous, next).weather).toEqual(next.weather);
  expect(
    mergeDashboard(previous, {
      ...next,
      weather: { ...next.weather, configurationRevision: "r1" },
    }).weather.periods,
  ).toHaveLength(1);
});
it("rejects legacy weather merging across different districts", () => {
  const previous = {
    ...emptyDashboard(),
    weather: { ...weatherAt("r1"), configurationRevision: null },
  };
  const next = {
    ...emptyDashboard(),
    weather: {
      ...weatherAt("r1"),
      configurationRevision: null,
      regionId: "140010",
      status: "error" as const,
      periods: [],
    },
  };
  expect(mergeDashboard(previous, next).weather.periods).toEqual([]);
});
it("does not let a late database open write an invalidated snapshot", async () => {
  const actualOpen = db.openDatabase;
  let release!: (value: IDBDatabase) => void;
  const opened = await actualOpen();
  vi.spyOn(db, "openDatabase").mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const stale = saveDashboard({
    ...emptyDashboard(),
    weather: weatherAt("old"),
  });
  invalidateDashboardCache();
  await saveDashboard({ ...emptyDashboard(), weather: weatherAt("new") });
  release(opened);
  await stale;
  expect((await loadDashboard())?.weather.configurationRevision).toBe("new");
});
it("does not return a late database read from an invalidated generation", async () => {
  const actualOpen = db.openDatabase;
  let release!: (value: IDBDatabase) => void;
  const opened = await actualOpen();
  vi.spyOn(db, "openDatabase").mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const stale = loadDashboard();
  invalidateDashboardCache();
  release(opened);
  expect(await stale).toBeNull();
});
it("aborts an already-started obsolete write rather than replacing acknowledged cache", async () => {
  await saveDashboard({
    ...emptyDashboard(),
    weather: weatherAt("acknowledged"),
  });
  const opened = await db.openDatabase();
  vi.spyOn(db, "openDatabase").mockResolvedValueOnce(opened);
  const stale = saveDashboard({
    ...emptyDashboard(),
    weather: weatherAt("obsolete"),
  });
  await Promise.resolve();
  invalidateDashboardCache();
  await stale;
  expect((await loadDashboard())?.weather.configurationRevision).toBe(
    "acknowledged",
  );
});
