import { expect, it } from "vitest";
import { createWeatherSource } from "../../services/aggregator/src/sources";
import { createMemoryStore } from "../../services/aggregator/src/store";
import {
  createWeatherSettings,
  initializeWeatherSettings,
} from "../../services/aggregator/src/weather/settings";
import {
  createWeatherCatalog,
  JMA_AREA_URL,
} from "../../services/aggregator/src/weather/catalog";
import type { safeFetch } from "../../services/aggregator/src/fetch/safe-fetch";
import type { startSchedule } from "../../services/aggregator/src/fetch/schedule";
import { forecast, response } from "../helpers/weather-catalog";
const selection = { office: "130000", region: "130010", station: "44132" };
const otherStation = { ...selection, station: "44133" };
const catalog = () =>
  createWeatherCatalog({
    fetch: async (url) =>
      response(
        url.href === JMA_AREA_URL
          ? { offices: { "130000": { name: "東京都" } } }
          : forecast,
      ),
  });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function scheduler() {
  const jobs: {
    work: Parameters<typeof startSchedule>[0];
    stopped: boolean;
  }[] = [];
  const schedule: typeof startSchedule = (work, base) => {
    expect(base).toBe(1800000);
    const job = { work, stopped: false };
    jobs.push(job);
    return () => {
      job.stopped = true;
    };
  };
  return { jobs, schedule };
}
it.each(["success", "error"])(
  "old in-flight %s cannot mutate a new station revision",
  async (outcome) => {
    const store = createMemoryStore();
    await initializeWeatherSettings(store, selection);
    const { jobs, schedule } = scheduler();
    const network = deferred<Awaited<ReturnType<typeof safeFetch>>>();
    const started = deferred<void>();
    const source = createWeatherSource(store, {
      schedule,
      fetch: async () => {
        started.resolve();
        return network.promise;
      },
    });
    const service = createWeatherSettings({
      store,
      catalog: catalog(),
      onSaved: source.reconcile,
    });
    try {
      await source.reconcile();
      const pending = jobs[0].work();
      await started.promise;
      const initial = (await service.read()).settings;
      const saved = await service.save({
        revision: initial.revision,
        selection: otherStation,
      });
      expect(jobs[0].stopped).toBe(true);
      expect(jobs).toHaveLength(2);
      if (outcome === "success") network.resolve(response(forecast));
      else network.reject(Error("network"));
      await pending;
      expect((await store.readSnapshot()).weather).toEqual(saved.weather);
    } finally {
      source.stop();
    }
  },
);
it("replaces conditionals and never resurrects cached temperatures on station-only change", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, selection);
  const { jobs, schedule } = scheduler();
  const conditionals: unknown[] = [];
  const source = createWeatherSource(store, {
    schedule,
    fetch: async (_url, _policy, headers) => {
      conditionals.push(headers);
      return {
        ...response(forecast),
        etag: "old-etag",
        lastModified: "old-last",
      };
    },
    now: () => "2026-10-03T01:00:00.000Z",
  });
  const service = createWeatherSettings({
    store,
    catalog: catalog(),
    onSaved: source.reconcile,
  });
  try {
    await source.reconcile();
    await jobs[0].work();
    const previous = (await store.readSnapshot()).weather;
    expect(previous.configurationRevision).toBe(initial.revision);
    expect(previous.periods[0].temperatureMaxC).toBe(25);
    await jobs[0].work();
    const saved = await service.save({
      revision: initial.revision,
      selection: otherStation,
    });
    expect(saved.weather.periods).toEqual([]);
    await jobs[1].work();
    expect(conditionals).toEqual([
      { etag: null, lastModified: null },
      { etag: "old-etag", lastModified: "old-last" },
      { etag: null, lastModified: null },
    ]);
    const latest = (await store.readSnapshot()).weather;
    expect(latest.configurationRevision).toBe(saved.settings.revision);
    expect(latest.temperatureStationLabel).toBe("別地点");
    expect(latest.periods[0].temperatureMaxC).toBe(26);
  } finally {
    source.stop();
  }
});
it("304 without success in the same revision remains a missing forecast error", async () => {
  const store = createMemoryStore();
  const settings = await initializeWeatherSettings(store, selection);
  const { jobs, schedule } = scheduler();
  const source = createWeatherSource(store, {
    schedule,
    fetch: async () => ({ ...response(null), status: 304 }),
  });
  try {
    await source.reconcile();
    expect((await jobs[0].work()).ok).toBe(false);
    expect((await store.readSnapshot()).weather).toMatchObject({
      configurationRevision: settings.revision,
      status: "error",
      periods: [],
    });
  } finally {
    source.stop();
  }
});
it("disabling stops weather and late fetches leave the disabled revision empty", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, selection);
  const { jobs, schedule } = scheduler();
  const network = deferred<Awaited<ReturnType<typeof safeFetch>>>();
  const source = createWeatherSource(store, {
    schedule,
    fetch: async () => network.promise,
  });
  const service = createWeatherSettings({
    store,
    catalog: catalog(),
    onSaved: source.reconcile,
  });
  try {
    await source.reconcile();
    const pending = jobs[0].work();
    const saved = await service.save({
      revision: initial.revision,
      selection: null,
    });
    expect(jobs[0].stopped).toBe(true);
    expect(jobs).toHaveLength(1);
    network.resolve(response(forecast));
    await pending;
    expect((await store.readSnapshot()).weather).toEqual(saved.weather);
  } finally {
    source.stop();
  }
});
it("a delayed earlier save reconciliation cannot activate its superseded revision", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, null);
  const { jobs, schedule } = scheduler();
  const source = createWeatherSource(store, {
    schedule,
    fetch: async () => response(forecast),
  });
  const paused = deferred<void>(),
    release = deferred<void>();
  let calls = 0;
  const service = createWeatherSettings({
    store,
    catalog: catalog(),
    onSaved: async () => {
      if (++calls === 1) {
        paused.resolve();
        await release.promise;
      }
      await source.reconcile();
    },
  });
  try {
    const first = service.save({ revision: initial.revision, selection });
    await paused.promise;
    const committed = (await store.readState()).weatherSettings!;
    const second = await service.save({
      revision: committed.revision,
      selection: otherStation,
    });
    release.resolve();
    await first;
    expect(jobs).toHaveLength(1);
    await jobs[0].work();
    expect((await store.readSnapshot()).weather).toMatchObject({
      configurationRevision: second.settings.revision,
      temperatureStationLabel: "別地点",
    });
  } finally {
    release.resolve();
    source.stop();
  }
});
it("reconciliation activation shares the store queue and observes intervening saves", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, selection);
  const { jobs, schedule } = scheduler();
  const paused = deferred<void>(),
    release = deferred<void>();
  const guarded = {
    ...store,
    inspect: async <T>(fn: Parameters<typeof store.inspect<T>>[0]) => {
      paused.resolve();
      await release.promise;
      return store.inspect(fn);
    },
  };
  const source = createWeatherSource(guarded, {
    schedule,
    fetch: async () => response(forecast),
  });
  try {
    const pending = source.reconcile();
    await paused.promise;
    const saved = await createWeatherSettings({
      store,
      catalog: catalog(),
    }).save({ revision: initial.revision, selection: otherStation });
    release.resolve();
    await pending;
    await jobs[0].work();
    expect((await store.readSnapshot()).weather).toMatchObject({
      configurationRevision: saved.settings.revision,
      temperatureStationLabel: "別地点",
    });
  } finally {
    release.resolve();
    source.stop();
  }
});
it("stop prevents a same-revision in-flight job committing after shutdown", async () => {
  const store = createMemoryStore();
  await initializeWeatherSettings(store, selection);
  const before = await store.readSnapshot();
  const { jobs, schedule } = scheduler();
  const network = deferred<Awaited<ReturnType<typeof safeFetch>>>();
  const source = createWeatherSource(store, {
    schedule,
    fetch: async () => network.promise,
  });
  await source.reconcile();
  const pending = jobs[0].work();
  source.stop();
  network.resolve(response(forecast));
  await pending;
  expect(await store.readSnapshot()).toEqual(before);
});
it.each(["success", "error"])(
  "revision guard rejects late %s even before scheduler replacement",
  async (outcome) => {
    const store = createMemoryStore();
    const initial = await initializeWeatherSettings(store, selection);
    const { jobs, schedule } = scheduler();
    const network = deferred<Awaited<ReturnType<typeof safeFetch>>>();
    const source = createWeatherSource(store, {
      schedule,
      fetch: async () => network.promise,
    });
    try {
      await source.reconcile();
      const pending = jobs[0].work();
      const saved = await createWeatherSettings({
        store,
        catalog: catalog(),
      }).save({ revision: initial.revision, selection: otherStation });
      expect(jobs[0].stopped).toBe(false);
      if (outcome === "success") network.resolve(response(forecast));
      else network.reject(Error("network"));
      await pending;
      expect((await store.readSnapshot()).weather).toEqual(saved.weather);
    } finally {
      source.stop();
    }
  },
);
