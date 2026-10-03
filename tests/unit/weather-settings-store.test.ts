import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryStore,
  createFileStore,
} from "../../services/aggregator/src/store";
import {
  createWeatherSettings,
  initializeWeatherSettings,
} from "../../services/aggregator/src/weather/settings";
import {
  createWeatherCatalog,
  JMA_AREA_URL,
} from "../../services/aggregator/src/weather/catalog";
import { emptyDashboard } from "../../packages/contracts/src/index";
import { forecast, response } from "../helpers/weather-catalog";
const selected = { office: "130000", region: "130010", station: "44132" };
const otherStation = { ...selected, station: "44133" };
const catalog = () =>
  createWeatherCatalog({
    fetch: async (url) =>
      response(
        url.href === JMA_AREA_URL
          ? { offices: { "130000": { name: "東京都" } } }
          : forecast,
      ),
  });
async function temporary(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fire-weather-"));
  try {
    await run(join(dir, "state.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
it("migrates once locally, then persisted disabled selection wins over config", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, selected);
  expect(initial.selection).toEqual(selected);
  expect((await store.readSnapshot()).weather).toMatchObject({
    configurationRevision: initial.revision,
    regionId: "130010",
    status: "missing",
    periods: [],
  });
  const settings = createWeatherSettings({ store, catalog: catalog() });
  const saved = await settings.save({
    revision: initial.revision,
    selection: null,
  });
  const restarted = await initializeWeatherSettings(store, selected);
  expect(restarted).toEqual(saved.settings);
  expect(restarted.selection).toBeNull();
  expect((await settings.read()).weather).toMatchObject({
    status: "unconfigured",
    configurationRevision: saved.settings.revision,
    periods: [],
  });
});
it("GET-style reads do not write the store", async () => {
  const store = createMemoryStore();
  await initializeWeatherSettings(store, null);
  const guarded = {
    ...store,
    update: async () => {
      throw Error("read must never write");
    },
  };
  const service = createWeatherSettings({
    store: guarded as typeof store,
    catalog: catalog(),
  });
  expect((await service.read()).settings.selection).toBeNull();
});
it("atomically saves settings plus empty selected weather and server-only labels", async () => {
  await temporary(async (path) => {
    const store = createFileStore(path);
    const initial = await initializeWeatherSettings(store, selected);
    await store.update((state) => {
      state.dashboard.weather = {
        ...state.dashboard.weather,
        status: "ok",
        temperatureStationLabel: "Old station",
        lastSuccessAt: "2026-10-03T00:00:00.000Z",
        periods: [
          {
            startsAt: "2026-10-03T00:00:00.000Z",
            endsAt: "2026-10-04T00:00:00.000Z",
            summary: "Old",
            weatherCode: null,
            temperatureMinC: 1,
            temperatureMaxC: 99,
            precipitationProbabilityPct: null,
          },
        ],
      };
      return { state, result: undefined };
    });
    const result = await createWeatherSettings({
      store,
      catalog: catalog(),
    }).save({ revision: initial.revision, selection: otherStation });
    expect(result.settings.revision).not.toBe(initial.revision);
    expect(result.weather).toMatchObject({
      configurationRevision: result.settings.revision,
      regionLabel: "東京地方",
      temperatureStationLabel: "別地点",
      periods: [],
      lastSuccessAt: null,
      status: "missing",
    });
    const disk = JSON.parse(await readFile(path, "utf8"));
    expect(disk.weatherSettings).toEqual(result.settings);
    expect(disk.dashboard.weather).toEqual(result.weather);
    const restarted = createFileStore(path);
    expect(await initializeWeatherSettings(restarted, selected)).toEqual(
      result.settings,
    );
    expect(
      await createWeatherSettings({
        store: restarted,
        catalog: catalog(),
      }).read(),
    ).toEqual(result);
  });
});
it("compares revisions inside the serialized transaction", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, null);
  const service = createWeatherSettings({ store, catalog: catalog() });
  const results = await Promise.allSettled([
    service.save({ revision: initial.revision, selection: selected }),
    service.save({ revision: initial.revision, selection: otherStation }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason.message).toBe("revision_conflict");
});
it("atomic rename failure retains both previous settings and previous weather", async () => {
  await temporary(async (path) => {
    const initial = await initializeWeatherSettings(
      createFileStore(path),
      selected,
    );
    const previous = await readFile(path, "utf8");
    const store = createFileStore(path, {
      beforeRename: async () => {
        throw Error("secret IO detail");
      },
    });
    await expect(
      createWeatherSettings({ store, catalog: catalog() }).save({
        revision: initial.revision,
        selection: otherStation,
      }),
    ).rejects.toThrow("storage_unavailable");
    expect(await readFile(path, "utf8")).toBe(previous);
  });
});
it.each([
  null,
  {
    revision: "one",
    selection: { office: "130000", region: "bad", station: "44132" },
  },
  { revision: "one" },
])(
  "fails closed on explicit malformed stored settings %j",
  async (weatherSettings) => {
    await temporary(async (path) => {
      await writeFile(
        path,
        JSON.stringify({
          dashboard: emptyDashboard(),
          weatherSettings,
          usageSequences: {},
          usageValues: {},
          usageObservedAt: {},
        }),
      );
      const store = createFileStore(path);
      await expect(initializeWeatherSettings(store, selected)).rejects.toThrow(
        "storage_unavailable",
      );
      await expect(
        createWeatherSettings({ store, catalog: catalog() }).read(),
      ).rejects.toThrow("storage_unavailable");
      expect(JSON.parse(await readFile(path, "utf8")).weatherSettings).toEqual(
        weatherSettings,
      );
    });
  },
);
it("initializes legacy files without remote catalog availability", async () => {
  await temporary(async (path) => {
    await writeFile(
      path,
      JSON.stringify({
        dashboard: emptyDashboard(),
        usageSequences: {},
        usageValues: {},
      }),
    );
    const store = createFileStore(path);
    expect(
      (await initializeWeatherSettings(store, selected)).selection,
    ).toEqual(selected);
  });
});
it("reconciles mismatched legacy weather to canonical selected revision", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, selected);
  await store.writeSnapshot(emptyDashboard());
  expect(await initializeWeatherSettings(store, null)).toEqual(initial);
  expect((await store.readSnapshot()).weather).toMatchObject({
    configurationRevision: initial.revision,
    regionId: selected.region,
    periods: [],
  });
});
it("does not misreport a committed save if scheduler reconciliation fails", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, null);
  const result = await createWeatherSettings({
    store,
    catalog: catalog(),
    onSaved: async () => {
      throw Error("scheduler");
    },
  }).save({ revision: initial.revision, selection: selected });
  expect((await store.readState()).weatherSettings).toEqual(result.settings);
});
it("save responses cannot mutate the canonical in-memory settings and weather", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, null);
  const service = createWeatherSettings({ store, catalog: catalog() });
  const saved = await service.save({
    revision: initial.revision,
    selection: selected,
  });
  const expected = structuredClone(saved);
  saved.settings.selection!.station = "99999";
  saved.weather.regionLabel = "tampered";
  expect(await service.read()).toEqual(expected);
});
it("explicit disabled settings clear inconsistent matching-revision stored forecasts", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, null);
  await store.update((state) => {
    state.dashboard.weather = {
      ...state.dashboard.weather,
      status: "ok",
      regionId: "130010",
      regionLabel: "Old region",
    };
    return { state, result: undefined };
  });
  expect(await initializeWeatherSettings(store, selected)).toEqual(initial);
  expect((await store.readSnapshot()).weather).toMatchObject({
    configurationRevision: initial.revision,
    status: "unconfigured",
    regionId: null,
    regionLabel: null,
    periods: [],
  });
});
