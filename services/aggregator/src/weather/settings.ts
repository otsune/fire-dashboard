import { randomUUID } from "node:crypto";
import {
  emptyWeather,
  weatherSettingsStateSchema,
  type Weather,
  type WeatherOffice,
  type WeatherSelection,
  type WeatherSettingsState,
  type WeatherSaveResult,
} from "../../../../packages/contracts/src/index";
import type { Store, State } from "../store";
import type { WeatherCatalog } from "./catalog";

function currentSettings(state: State): WeatherSettingsState {
  const parsed = weatherSettingsStateSchema.safeParse(state.weatherSettings);
  if (!parsed.success) throw Error("storage_unavailable");
  return parsed.data;
}
function blankWeather(
  settings: WeatherSettingsState,
  catalog?: WeatherOffice,
): Weather {
  const selected = settings.selection;
  return {
    ...emptyWeather(),
    configurationRevision: settings.revision,
    ...(selected
      ? {
          status: "missing" as const,
          regionId: selected.region,
          regionLabel:
            catalog?.regions.find((value) => value.id === selected.region)
              ?.label ?? selected.region,
          temperatureStationLabel:
            catalog?.stations.find((value) => value.id === selected.station)
              ?.label ?? selected.station,
        }
      : {}),
  };
}
function matchesSettings(
  weather: Weather,
  settings: WeatherSettingsState,
): boolean {
  return (
    weather.configurationRevision === settings.revision &&
    weather.regionId === (settings.selection?.region ?? null) &&
    (settings.selection !== null ||
      (weather.status === "unconfigured" && weather.periods.length === 0))
  );
}
/** Local startup migration never depends on JMA availability. */
export async function initializeWeatherSettings(
  store: Store,
  selection: WeatherSelection | null,
): Promise<WeatherSettingsState> {
  try {
    const state = await store.readState();
    if (Object.hasOwn(state, "weatherSettings")) {
      const settings = currentSettings(state);
      if (matchesSettings(state.dashboard.weather, settings)) return settings;
    }
    return structuredClone(
      await store.update((state) => {
        const settings = Object.hasOwn(state, "weatherSettings")
          ? currentSettings(state)
          : weatherSettingsStateSchema.parse({
              revision: randomUUID(),
              selection,
            });
        state.weatherSettings = settings;
        if (!matchesSettings(state.dashboard.weather, settings))
          state.dashboard.weather = blankWeather(settings);
        return { state, result: settings };
      }),
    );
  } catch {
    throw Error("storage_unavailable");
  }
}
export type WeatherSettingsService = {
  read(): Promise<WeatherSaveResult>;
  save(input: unknown): Promise<WeatherSaveResult>;
};
export function createWeatherSettings(options: {
  store: Store;
  catalog: WeatherCatalog;
  onSaved?: () => Promise<void>;
}): WeatherSettingsService {
  return {
    read: async () => {
      try {
        const state = await options.store.readState();
        return {
          settings: currentSettings(state),
          weather: state.dashboard.weather,
        };
      } catch {
        throw Error("storage_unavailable");
      }
    },
    save: async (input) => {
      const parsed = weatherSettingsStateSchema.safeParse(input);
      if (!parsed.success) throw Error("invalid_data");
      const catalog = parsed.data.selection
        ? await options.catalog.validate(parsed.data.selection)
        : undefined;
      let saved: WeatherSaveResult;
      try {
        saved = await options.store.update((state) => {
          const previous = currentSettings(state);
          if (previous.revision !== parsed.data.revision)
            throw Error("revision_conflict");
          const settings = {
            revision: randomUUID(),
            selection: parsed.data.selection,
          };
          const weather = blankWeather(settings, catalog);
          state.weatherSettings = settings;
          state.dashboard.weather = weather;
          return { state, result: { settings, weather } };
        });
      } catch (error) {
        if ((error as Error).message === "revision_conflict") throw error;
        throw Error("storage_unavailable");
      }
      // Persistence is authoritative even if a local scheduler cannot be started.
      // A stale job is separately revision-guarded; later reconciliation/restart
      // always reads the canonical settings rather than the submitted selection.
      await options.onSaved?.().catch(() => {});
      return structuredClone(saved);
    },
  };
}
