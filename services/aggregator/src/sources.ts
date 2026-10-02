import { safeFetch } from "./fetch/safe-fetch";
import { startSchedule } from "./fetch/schedule";
import { normalizeWeather } from "./weather/jma";
import { normalizeFeed } from "./rss/parse";
import type { Config } from "./config";
import type { Store } from "./store";
import {
  emptyCommon,
  type Feed,
  type Weather,
} from "../../../packages/contracts/src/index";
export function startSources(config: Config, store: Store) {
  const stops: (() => void)[] = [];
  type Target = {
    url: string;
    kind: "weather" | "rss";
    id: string;
    normalize: (raw: string, at: string) => Weather | Feed;
  };
  const targets: Target[] = config.feeds.map((feed) => ({
    url: feed.url,
    kind: "rss",
    id: feed.id,
    normalize: (xml, at) => normalizeFeed(xml, feed.id, feed.label, at),
  }));
  if (config.weather) {
    const w = config.weather;
    targets.push({
      url: `https://www.jma.go.jp/bosai/forecast/data/forecast/${w.office}.json`,
      kind: "weather",
      id: "weather",
      normalize: (json, at) =>
        normalizeWeather(JSON.parse(json), w.region, at, {
          stationId: w.station,
        }),
    });
  }
  for (const target of targets) {
    let etag: string | null = null,
      lastModified: string | null = null;
    stops.push(
      startSchedule(
        async () => {
          const at = new Date().toISOString();
          let result: Awaited<ReturnType<typeof safeFetch>> | undefined;
          try {
            result = await safeFetch(
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
              const previous =
                target.kind === "weather"
                  ? state.dashboard.weather
                  : state.dashboard.rss.find((f) => f.id === target.id);
              let value: Weather | Feed;
              if (result!.status === 304) {
                if (!previous || !previous.lastSuccessAt)
                  throw Error("invalid_data");
                value = {
                  ...previous,
                  status: "ok",
                  errorCode: null,
                  lastSuccessAt: at,
                };
              } else {
                value = target.normalize(
                  Buffer.from(result!.body).toString("utf8"),
                  at,
                );
                if (value.status !== "ok") throw Error("invalid_data");
              }
              if (target.kind === "weather")
                state.dashboard.weather = value as Weather;
              else
                state.dashboard.rss = [
                  ...state.dashboard.rss.filter((f) => f.id !== target.id),
                  value as Feed,
                ];
              return { state, result: undefined };
            });
            etag = result.etag ?? etag;
            lastModified = result.lastModified ?? lastModified;
            return { ok: true };
          } catch {
            await store.update((state) => {
              if (target.kind === "weather")
                state.dashboard.weather = {
                  ...state.dashboard.weather,
                  status: "error",
                  errorCode: "network",
                };
              else {
                const previous = state.dashboard.rss.find(
                  (f) => f.id === target.id,
                );
                state.dashboard.rss = [
                  ...state.dashboard.rss.filter((f) => f.id !== target.id),
                  previous
                    ? { ...previous, status: "error", errorCode: "network" }
                    : {
                        ...emptyCommon("error"),
                        errorCode: "network",
                        id: target.id,
                        label: config.feeds.find((f) => f.id === target.id)!
                          .label,
                        items: [],
                      },
                ];
              }
              return { state, result: undefined };
            });
            return { ok: false, retryAfterMs: result?.retryAfterMs };
          }
        },
        target.kind === "weather" ? 1800000 : 900000,
      ),
    );
  }
  return () => stops.forEach((stop) => stop());
}
