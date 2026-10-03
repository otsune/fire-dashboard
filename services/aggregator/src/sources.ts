import { safeFetch } from "./fetch/safe-fetch";
import { startSchedule } from "./fetch/schedule";
import { normalizeWeather } from "./weather/jma";
import { jmaForecastUrl } from "./weather/catalog";
import { normalizeFeed } from "./rss/parse";
import type { Config } from "./config";
import type { Store, State } from "./store";
import {
  emptyCommon,
  weatherSettingsStateSchema,
  type WeatherSettingsState,
} from "../../../packages/contracts/src/index";

export type SourceDependencies = {
  fetch?: typeof safeFetch;
  schedule?: typeof startSchedule;
  now?: () => string;
};
export function createWeatherSource(
  store: Store,
  deps: SourceDependencies = {},
) {
  const fetch = deps.fetch ?? safeFetch;
  const schedule = deps.schedule ?? startSchedule;
  const now = deps.now ?? (() => new Date().toISOString());
  let stopped = false,
    activeRevision: string | null = null,
    stopActive: (() => void) | undefined;
  let queue: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const clearRetry = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  function start(settings: WeatherSettingsState) {
    const selected = settings.selection!;
    const url = jmaForecastUrl(selected.office);
    let cancelled = false,
      etag: string | null = null,
      lastModified: string | null = null;
    const current = (state: State) =>
      !cancelled &&
      !stopped &&
      state.weatherSettings?.revision === settings.revision &&
      state.dashboard.weather.configurationRevision === settings.revision;
    const stopSchedule = schedule(async () => {
      const at = now();
      let result: Awaited<ReturnType<typeof safeFetch>> | undefined;
      try {
        result = await fetch(
          new URL(url),
          {
            allowedHostsPaths: [url],
            timeoutMs: 10000,
            maxBytes: 2 * 1024 * 1024,
          },
          { etag, lastModified },
        );
        if (result.status !== 200 && result.status !== 304)
          throw Error("network");
        const accepted = await store.update((state) => {
          if (!current(state)) return { state, result: false };
          const previous = state.dashboard.weather;
          if (result!.status === 304) {
            if (!previous.lastSuccessAt) throw Error("invalid_data");
            state.dashboard.weather = {
              ...previous,
              status: "ok",
              errorCode: null,
              lastSuccessAt: at,
            };
          } else {
            const value = normalizeWeather(
              JSON.parse(Buffer.from(result!.body).toString("utf8")),
              selected.region,
              at,
              { stationId: selected.station },
            );
            if (value.status !== "ok") throw Error("invalid_data");
            state.dashboard.weather = {
              ...value,
              configurationRevision: settings.revision,
            };
          }
          return { state, result: true };
        });
        if (accepted) {
          etag = result.etag ?? etag;
          lastModified = result.lastModified ?? lastModified;
        }
        return { ok: true };
      } catch {
        await store.update((state) => {
          if (current(state))
            state.dashboard.weather = {
              ...state.dashboard.weather,
              status: "error",
              errorCode: "network",
            };
          return { state, result: undefined };
        });
        return { ok: false, retryAfterMs: result?.retryAfterMs };
      }
    }, 1800000);
    return () => {
      cancelled = true;
      stopSchedule();
    };
  }
  const reconcile = () => {
    const work = queue.then(async () => {
      if (stopped) return;
      // Activation is synchronous inside the serialized read callback. A later
      // settings transaction cannot commit between observing and activating a
      // revision, and a delayed earlier save never supplies its own old state.
      await store.inspect((state) => {
        if (stopped) return;
        const settings = weatherSettingsStateSchema.parse(
          state.weatherSettings,
        );
        if (settings.revision === activeRevision) return;
        stopActive?.();
        stopActive = undefined;
        if (settings.selection) stopActive = start(settings);
        activeRevision = settings.revision;
      });
      clearRetry();
    });
    queue = work.catch(() => {
      // A committed save may have no weather job to drive recovery. Retry the
      // canonical read independently, with one timer and no overlapping work.
      if (!stopped && retryTimer === undefined)
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void reconcile().catch(() => {});
        }, 60000);
    });
    return work;
  };
  return {
    reconcile,
    stop: () => {
      stopped = true;
      clearRetry();
      stopActive?.();
      stopActive = undefined;
    },
  };
}

/** RSS polling remains independent from weather revision changes. */
export function startRssSources(
  config: Config,
  store: Store,
  deps: SourceDependencies = {},
) {
  const fetch = deps.fetch ?? safeFetch,
    schedule = deps.schedule ?? startSchedule;
  const now = deps.now ?? (() => new Date().toISOString());
  const stops = config.feeds.map((target) => {
    let etag: string | null = null,
      lastModified: string | null = null;
    return schedule(async () => {
      const at = now();
      let result: Awaited<ReturnType<typeof safeFetch>> | undefined;
      try {
        result = await fetch(
          new URL(target.url),
          {
            allowedHostsPaths: [target.url],
            timeoutMs: 10000,
            maxBytes: 2 * 1024 * 1024,
          },
          { etag, lastModified },
        );
        if (result.status !== 200 && result.status !== 304)
          throw Error("network");
        await store.update((state) => {
          const previous = state.dashboard.rss.find(
            (feed) => feed.id === target.id,
          );
          const value =
            result!.status === 304
              ? previous?.lastSuccessAt
                ? {
                    ...previous,
                    status: "ok" as const,
                    errorCode: null,
                    lastSuccessAt: at,
                  }
                : null
              : normalizeFeed(
                  Buffer.from(result!.body).toString("utf8"),
                  target.id,
                  target.label,
                  at,
                );
          if (!value || value.status !== "ok") throw Error("invalid_data");
          state.dashboard.rss = [
            ...state.dashboard.rss.filter((feed) => feed.id !== target.id),
            value,
          ];
          return { state, result: undefined };
        });
        etag = result.etag ?? etag;
        lastModified = result.lastModified ?? lastModified;
        return { ok: true };
      } catch {
        await store.update((state) => {
          const previous = state.dashboard.rss.find(
            (feed) => feed.id === target.id,
          );
          state.dashboard.rss = [
            ...state.dashboard.rss.filter((feed) => feed.id !== target.id),
            previous
              ? {
                  ...previous,
                  status: "error" as const,
                  errorCode: "network" as const,
                }
              : {
                  ...emptyCommon("error"),
                  errorCode: "network" as const,
                  id: target.id,
                  label: target.label,
                  items: [],
                },
          ];
          return { state, result: undefined };
        });
        return { ok: false, retryAfterMs: result?.retryAfterMs };
      }
    }, 900000);
  });
  return () => stops.forEach((stop) => stop());
}
export function startSources(
  config: Config,
  store: Store,
  deps: SourceDependencies = {},
) {
  const weather = createWeatherSource(store, deps);
  const stopRss = startRssSources(config, store, deps);
  return {
    reconcileWeather: weather.reconcile,
    stop: () => {
      weather.stop();
      stopRss();
    },
  };
}
