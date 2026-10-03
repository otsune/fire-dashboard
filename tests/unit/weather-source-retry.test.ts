import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const retryDelay = 60000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function harness(initialSelection: typeof selection | null = selection) {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, initialSelection);
  const reads = {
    failures: 0,
    calls: 0,
    before: undefined as (() => Promise<void>) | undefined,
  };
  const guarded = {
    ...store,
    inspect: async <T>(fn: Parameters<typeof store.inspect<T>>[0]) => {
      reads.calls++;
      await reads.before?.();
      if (reads.failures > 0) {
        reads.failures--;
        throw Error("storage");
      }
      return store.inspect(fn);
    },
  };
  const jobs: {
    work: Parameters<typeof startSchedule>[0];
    stopped: boolean;
  }[] = [];
  const scheduling = { failures: 0 };
  const schedule: typeof startSchedule = (work, base) => {
    expect(base).toBe(1800000);
    if (scheduling.failures > 0) {
      scheduling.failures--;
      throw Error("scheduler");
    }
    const job = { work, stopped: false };
    jobs.push(job);
    return () => {
      job.stopped = true;
    };
  };
  const network = {
    fetch: (async () => response(forecast)) as typeof safeFetch,
  };
  const source = createWeatherSource(guarded, {
    schedule,
    fetch: (...args) => network.fetch(...args),
  });
  const service = createWeatherSettings({
    store,
    catalog: createWeatherCatalog({
      fetch: async (url) =>
        response(
          url.href === JMA_AREA_URL
            ? { offices: { "130000": { name: "東京都" } } }
            : forecast,
        ),
    }),
    onSaved: source.reconcile,
  });
  await source.reconcile();
  return { store, initial, reads, jobs, scheduling, network, source, service };
}

it.each([
  ["an existing weather job", selection],
  ["no weather job", null],
] as const)(
  "repeated reconciliation failures recover a committed save independently of %s",
  async (_label, initialSelection) => {
    const { store, initial, reads, jobs, source, service } =
      await harness(initialSelection);
    const initialJobs = jobs.length;
    try {
      reads.failures = 3;
      const saved = await service.save({
        revision: initial.revision,
        selection: otherStation,
      });
      expect((await store.readState()).weatherSettings).toEqual(saved.settings);
      expect((await store.readSnapshot()).weather).toEqual(saved.weather);
      expect(saved.weather.status).toBe("missing");
      expect(jobs).toHaveLength(initialJobs);
      expect(vi.getTimerCount()).toBe(1);
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = reads.calls;
        await vi.advanceTimersByTimeAsync(retryDelay - 1);
        expect(reads.calls).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(reads.calls).toBe(before + 1);
        expect(jobs).toHaveLength(initialJobs);
        expect(vi.getTimerCount()).toBe(1);
      }
      await vi.advanceTimersByTimeAsync(retryDelay);
      expect(jobs).toHaveLength(initialJobs + 1);
      if (initialJobs) expect(jobs[0].stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await jobs.at(-1)!.work();
      expect((await store.readSnapshot()).weather).toMatchObject({
        configurationRevision: saved.settings.revision,
        status: "ok",
        temperatureStationLabel: "別地点",
      });
      const before = reads.calls;
      await vi.advanceTimersByTimeAsync(retryDelay * 3);
      expect(reads.calls).toBe(before);
      expect(jobs).toHaveLength(initialJobs + 1);
    } finally {
      source.stop();
    }
  },
);

it.each([
  ["success", otherStation],
  ["error", otherStation],
  ["success", null],
  ["error", null],
] as const)(
  "old in-flight %s leaves the committed selection %j untouched while reconciliation retries",
  async (outcome, nextSelection) => {
    const { store, initial, reads, jobs, network, source, service } =
      await harness();
    const pendingFetch = deferred<Awaited<ReturnType<typeof safeFetch>>>();
    network.fetch = async () => pendingFetch.promise;
    try {
      const pending = jobs[0].work();
      reads.failures = 1;
      const saved = await service.save({
        revision: initial.revision,
        selection: nextSelection,
      });
      expect(jobs[0].stopped).toBe(false);
      if (outcome === "success") pendingFetch.resolve(response(forecast));
      else pendingFetch.reject(Error("network"));
      await pending;
      expect((await store.readSnapshot()).weather).toEqual(saved.weather);
      network.fetch = async () => response(forecast);
      await jobs[0].work();
      expect((await store.readSnapshot()).weather).toEqual(saved.weather);
      await vi.advanceTimersByTimeAsync(retryDelay);
      expect(jobs[0].stopped).toBe(true);
      expect(jobs).toHaveLength(nextSelection ? 2 : 1);
      expect(vi.getTimerCount()).toBe(0);
      if (nextSelection) {
        await jobs[1].work();
        expect((await store.readSnapshot()).weather).toMatchObject({
          configurationRevision: saved.settings.revision,
          status: "ok",
          temperatureStationLabel: "別地点",
        });
      } else {
        expect((await store.readSnapshot()).weather).toEqual(saved.weather);
      }
    } finally {
      source.stop();
    }
  },
);

it("a failed disable and re-enable recover without an existing job", async () => {
  const { initial, reads, jobs, source, service } = await harness();
  try {
    reads.failures = 1;
    const disabled = await service.save({
      revision: initial.revision,
      selection: null,
    });
    await vi.advanceTimersByTimeAsync(retryDelay);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    reads.failures = 1;
    await service.save({
      revision: disabled.settings.revision,
      selection: otherStation,
    });
    expect(jobs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(retryDelay);
    expect(jobs).toHaveLength(2);
    expect(jobs[1].stopped).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    source.stop();
  }
});

it("a successful newer save clears the retry and repeated reconciliations create one worker", async () => {
  const { store, initial, reads, jobs, source, service } = await harness();
  try {
    reads.failures = 1;
    const first = await service.save({
      revision: initial.revision,
      selection: otherStation,
    });
    expect(vi.getTimerCount()).toBe(1);
    const latest = await service.save({
      revision: first.settings.revision,
      selection,
    });
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all(Array.from({ length: 4 }, () => source.reconcile()));
    expect(jobs).toHaveLength(2);
    expect(jobs[0].stopped).toBe(true);
    await jobs[1].work();
    expect((await store.readSnapshot()).weather).toMatchObject({
      configurationRevision: latest.settings.revision,
      temperatureStationLabel: "東京",
    });
    const before = reads.calls;
    await vi.advanceTimersByTimeAsync(retryDelay * 3);
    expect(reads.calls).toBe(before);
  } finally {
    source.stop();
  }
});

it.each(["success", "error"])(
  "a pending retry read %s observes a newer save without duplicate workers",
  async (outcome) => {
    const { store, initial, reads, jobs, source, service } = await harness();
    const entered = deferred<void>(),
      release = deferred<void>();
    try {
      reads.failures = 1;
      const first = await service.save({
        revision: initial.revision,
        selection: otherStation,
      });
      expect(vi.getTimerCount()).toBe(1);
      reads.before = async () => {
        reads.before = undefined;
        entered.resolve();
        await release.promise;
      };
      await vi.advanceTimersByTimeAsync(retryDelay);
      await entered.promise;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(retryDelay * 3);
      expect(jobs).toHaveLength(1);
      const latest = service.save({
        revision: first.settings.revision,
        selection: null,
      });
      expect((await store.readState()).weatherSettings?.selection).toBeNull();
      if (outcome === "error") reads.failures = 1;
      release.resolve();
      const saved = await latest;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect((await store.readSnapshot()).weather).toEqual(saved.weather);
    } finally {
      release.resolve();
      source.stop();
    }
  },
);

it("concurrent failed reconciliations share one bounded retry timer", async () => {
  const { initial, reads, jobs, source, service } = await harness(null);
  try {
    reads.failures = 5;
    await service.save({ revision: initial.revision, selection });
    await Promise.allSettled(
      Array.from({ length: 4 }, () => source.reconcile()),
    );
    expect(vi.getTimerCount()).toBe(1);
    expect(jobs).toHaveLength(0);
    const before = reads.calls;
    await vi.advanceTimersByTimeAsync(retryDelay);
    expect(reads.calls).toBe(before + 1);
    expect(jobs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    source.stop();
  }
});

it("stop cancels a pending reconciliation timer", async () => {
  const { initial, reads, jobs, source, service } = await harness(null);
  reads.failures = 1;
  await service.save({ revision: initial.revision, selection });
  expect(vi.getTimerCount()).toBe(1);
  source.stop();
  expect(vi.getTimerCount()).toBe(0);
  const before = reads.calls;
  await vi.advanceTimersByTimeAsync(retryDelay * 3);
  await source.reconcile();
  expect(reads.calls).toBe(before);
  expect(jobs).toHaveLength(0);
});

it.each(["success", "error"])(
  "stop during a pending retry read %s cannot start a worker or re-arm the timer",
  async (outcome) => {
    const { initial, reads, jobs, source, service } = await harness(null);
    const entered = deferred<void>(),
      release = deferred<void>();
    try {
      reads.failures = 1;
      await service.save({ revision: initial.revision, selection });
      expect(vi.getTimerCount()).toBe(1);
      reads.before = async () => {
        reads.before = undefined;
        entered.resolve();
        await release.promise;
      };
      await vi.advanceTimersByTimeAsync(retryDelay);
      await entered.promise;
      source.stop();
      if (outcome === "error") reads.failures = 1;
      release.resolve();
      await source.reconcile();
      expect(jobs).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      const before = reads.calls;
      await vi.advanceTimersByTimeAsync(retryDelay * 3);
      expect(reads.calls).toBe(before);
    } finally {
      release.resolve();
      source.stop();
    }
  },
);

it("a schedule-start failure retries the committed revision until a worker actually starts", async () => {
  const { store, initial, scheduling, jobs, source, service } =
    await harness(null);
  try {
    scheduling.failures = 2;
    const saved = await service.save({ revision: initial.revision, selection });
    expect((await store.readState()).weatherSettings).toEqual(saved.settings);
    expect(jobs).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(retryDelay);
    expect(jobs).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(retryDelay);
    expect(jobs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await jobs[0].work();
    expect((await store.readSnapshot()).weather).toMatchObject({
      configurationRevision: saved.settings.revision,
      status: "ok",
    });
  } finally {
    source.stop();
  }
});
