import { expect, it, vi } from "vitest";
import { prepareServer } from "../../services/aggregator/src/start";
import { configSchema } from "../../services/aggregator/src/config";
import { createMemoryStore } from "../../services/aggregator/src/store";
import {
  createWeatherCatalog,
  JMA_AREA_URL,
} from "../../services/aggregator/src/weather/catalog";
import type { startSchedule } from "../../services/aggregator/src/fetch/schedule";
import { forecast, response } from "../helpers/weather-catalog";

const origin = "https://dashboard.example";
const selection = { office: "130000", region: "130010", station: "44132" };

it.each([selection, null])(
  "HTTP 200 preserves committed settings and retries source reconciliation from %j",
  async (initialSelection) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let prepared: Awaited<ReturnType<typeof prepareServer>> | undefined;
    const store = createMemoryStore();
    let failures = 0;
    const guarded = {
      ...store,
      inspect: async <T>(fn: Parameters<typeof store.inspect<T>>[0]) => {
        if (failures > 0) {
          failures--;
          throw Error("storage");
        }
        return store.inspect(fn);
      },
    };
    const jobs: {
      work: Parameters<typeof startSchedule>[0];
      stopped: boolean;
    }[] = [];
    try {
      prepared = await prepareServer({
        store: guarded,
        config: configSchema.parse({ weather: initialSelection }),
        origin,
        authorize: async () => true,
        authorizeAdmin: async () => true,
        sourceDependencies: {
          schedule: (work) => {
            const job = { work, stopped: false };
            jobs.push(job);
            return () => {
              job.stopped = true;
            };
          },
          fetch: async () => response(forecast),
        },
        weatherCatalog: createWeatherCatalog({
          fetch: async (url) =>
            response(
              url.href === JMA_AREA_URL
                ? { offices: { "130000": { name: "東京都" } } }
                : forecast,
            ),
        }),
      });
      const initial = (await store.readState()).weatherSettings!;
      const initialJobs = jobs.length;
      failures = 1;
      const result = await prepared.app.inject({
        method: "PUT",
        url: "/api/v1/weather-settings",
        headers: { origin },
        payload: {
          revision: initial.revision,
          selection: { ...selection, station: "44133" },
        },
      });
      expect(result.statusCode).toBe(200);
      const saved = result.json();
      expect(saved.settings.revision).not.toBe(initial.revision);
      expect((await store.readState()).weatherSettings).toEqual(saved.settings);
      expect((await store.readSnapshot()).weather).toEqual(saved.weather);
      expect(saved.weather.status).toBe("missing");
      expect(jobs).toHaveLength(initialJobs);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60000);
      expect(jobs).toHaveLength(initialJobs + 1);
      if (initialJobs) expect(jobs[0].stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await jobs.at(-1)!.work();
      const dashboard = await prepared.app.inject({
        url: "/api/v1/dashboard",
      });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json().weather).toMatchObject({
        configurationRevision: saved.settings.revision,
        status: "ok",
        temperatureStationLabel: "別地点",
      });
    } finally {
      prepared?.sources.stop();
      await prepared?.app.close();
      vi.useRealTimers();
    }
  },
);
