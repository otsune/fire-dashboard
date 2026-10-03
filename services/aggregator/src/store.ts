import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseDashboard,
  emptyDashboard,
  type Dashboard,
  type UsageEnvelope,
  type Usage,
  usageSchema,
  envelopeSchema,
  weatherSettingsStateSchema,
  type WeatherSettingsState,
} from "../../../packages/contracts/src/index";
export type State = {
  /** Absent only in pre-settings snapshots. Explicit null selection disables weather. */
  weatherSettings?: WeatherSettingsState;
  dashboard: Dashboard;
  usageSequences: Record<string, UsageEnvelope>;
  usageValues: Record<string, Usage>;
  /** Per-source comparison time, fixed at a snapshot's first receipt. */
  usageObservedAt: Record<string, string>;
};
export type Store = {
  /** Serialized read callback; side effects can observe a canonical revision
   * without racing a following update or rewriting the state file. */
  inspect: <T>(fn: (value: State) => T) => Promise<T>;
  readState: () => Promise<State>;
  readSnapshot: () => Promise<Dashboard>;
  writeSnapshot: (value: Dashboard) => Promise<void>;
  update: <T>(fn: (value: State) => { state: State; result: T }) => Promise<T>;
};
export async function atomicJson(
  path: string,
  value: unknown,
  beforeRename?: () => Promise<void>,
) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await beforeRename?.();
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
function storeEngine(
  load: () => Promise<State>,
  save: (state: State) => Promise<void>,
): Store {
  let queue: Promise<unknown> = Promise.resolve();
  function update<T>(
    fn: (value: State) => { state: State; result: T },
  ): Promise<T> {
    const result = queue.then(async () => {
      const current = await load();
      const next = fn(structuredClone(current));
      await save(next.state);
      return next.result;
    });
    queue = result.catch(() => {});
    return result;
  }
  function inspect<T>(fn: (value: State) => T): Promise<T> {
    const result = queue.then(async () => fn(structuredClone(await load())));
    queue = result.catch(() => {});
    return result;
  }
  return {
    inspect,
    readState: () => inspect((state) => state),
    readSnapshot: () => inspect((state) => state.dashboard),
    writeSnapshot: async (value) => {
      const valid = parseDashboard(value);
      await update((state) => ({
        state: { ...state, dashboard: valid },
        result: undefined,
      }));
    },
    update,
  };
}
export function createMemoryStore(): Store {
  let state: State = {
    dashboard: emptyDashboard(),
    usageSequences: {},
    usageValues: {},
    usageObservedAt: {},
  };
  return storeEngine(
    async () => state,
    async (v) => {
      state = v;
    },
  );
}
export function createFileStore(
  path: string,
  options: { beforeRename?: () => Promise<void> } = {},
): Store {
  return storeEngine(
    async () => {
      try {
        const raw = JSON.parse(await readFile(path, "utf8"));
        const dashboard = parseDashboard(raw.dashboard);
        const usageValues: Record<string, Usage> = {};
        for (const [key, value] of Object.entries(raw.usageValues ?? {})) {
          const parsed = usageSchema.parse(value);
          if (key !== `${parsed.provider}:${parsed.sourceAlias}`)
            throw Error("storage");
          usageValues[key] = parsed;
        }
        // Old files only retain effective values for the displayed source.
        // Seed them before an incoming source can replace that display.
        for (const value of dashboard.usage) {
          if (value.sourceAlias)
            usageValues[`${value.provider}:${value.sourceAlias}`] ??= value;
        }
        // An off-screen legacy successful envelope still contains usable data,
        // but its original server receipt/success time was never persisted.
        for (const [key, value] of Object.entries(raw.usageSequences ?? {})) {
          if (usageValues[key]) continue;
          const parsed = envelopeSchema.parse(value);
          if (key !== `${parsed.payload.provider}:${parsed.sourceAlias}`)
            throw Error("storage");
          if (parsed.payload.status === "ok")
            usageValues[key] = {
              ...parsed.payload,
              receivedAt: null,
              lastSuccessAt: null,
            };
        }
        // Missing or unreadable entries only lose their pinned comparison
        // time; ingest then falls back to the source's previous receipt.
        const usageObservedAt: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw.usageObservedAt ?? {}))
          if (
            usageValues[key] &&
            typeof value === "string" &&
            Number.isFinite(Date.parse(value))
          )
            usageObservedAt[key] = value;
        return {
          ...(Object.hasOwn(raw, "weatherSettings")
            ? {
                weatherSettings: weatherSettingsStateSchema.parse(
                  raw.weatherSettings,
                ),
              }
            : {}),
          dashboard,
          usageSequences: raw.usageSequences ?? {},
          usageValues,
          usageObservedAt,
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return {
            dashboard: emptyDashboard(),
            usageSequences: {},
            usageValues: {},
            usageObservedAt: {},
          };
        throw Error("storage");
      }
    },
    async (state) => atomicJson(path, state, options.beforeRename),
  );
}
