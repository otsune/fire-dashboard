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
  usageDeliveryMetadataSchema,
} from "../../../packages/contracts/src/index";
export type State = {
  /** Absent only in pre-settings snapshots. Explicit null selection disables weather. */
  weatherSettings?: WeatherSettingsState;
  dashboard: Dashboard;
  usageSequences: Record<string, UsageEnvelope>;
  usageValues: Record<string, Usage>;
  /** Per-source comparison time, fixed at a snapshot's first receipt. */
  usageObservedAt: Record<string, string>;
  /** Stable identity for the persisted usage delivery sequence. */
  streamId: string;
  /** Decimal, monotonic delivery revision. */
  usageRevision: string;
  /** Timestamp associated with the current usage revision. */
  usagePublishedAt: string | null;
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
        state: {
          ...state,
          dashboard: {
            ...valid,
            usageDelivery:
              valid.usageDelivery ?? state.dashboard.usageDelivery,
          },
        },
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
    streamId: randomUUID(),
    usageRevision: "0",
    usagePublishedAt: null,
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
  let migratedStreamId: string | undefined;
  let migratedPublishedAt: string | undefined;
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
        const storedDelivery = usageDeliveryMetadataSchema.safeParse(
          raw.dashboard?.usageDelivery,
        );
        const streamId =
          typeof raw.streamId === "string" &&
          /^[A-Za-z0-9_-]{1,128}$/.test(raw.streamId)
            ? raw.streamId
            : storedDelivery.success
              ? storedDelivery.data.streamId
              : (migratedStreamId ??= randomUUID());
        const usageRevision =
          typeof raw.usageRevision === "string" &&
          /^(?:0|[1-9][0-9]{0,38})$/.test(raw.usageRevision)
            ? raw.usageRevision
            : storedDelivery.success
              ? storedDelivery.data.revision
              : "0";
        const usagePublishedAt =
          typeof raw.usagePublishedAt === "string" &&
          Number.isFinite(Date.parse(raw.usagePublishedAt))
            ? raw.usagePublishedAt
            : storedDelivery.success
              ? storedDelivery.data.publishedAt
              : (migratedPublishedAt ??= new Date().toISOString());
        const delivery =
          usagePublishedAt
            ? {
                schemaVersion: 1 as const,
                streamId,
                revision: usageRevision,
                publishedAt: usagePublishedAt,
              }
            : undefined;
        return {
          ...(Object.hasOwn(raw, "weatherSettings")
            ? {
                weatherSettings: weatherSettingsStateSchema.parse(
                  raw.weatherSettings,
                ),
              }
            : {}),
          dashboard: delivery ? { ...dashboard, usageDelivery: delivery } : dashboard,
          usageSequences: raw.usageSequences ?? {},
          usageValues,
          usageObservedAt,
          streamId,
          usageRevision,
          usagePublishedAt,
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          const streamId = (migratedStreamId ??= randomUUID());
          const usagePublishedAt =
            (migratedPublishedAt ??= new Date().toISOString());
          return {
            dashboard: {
              ...emptyDashboard(),
              usageDelivery: {
                schemaVersion: 1,
                streamId,
                revision: "0",
                publishedAt: usagePublishedAt,
              },
            },
            usageSequences: {},
            usageValues: {},
            usageObservedAt: {},
            streamId,
            usageRevision: "0",
            usagePublishedAt,
          };
        }
        throw Error("storage");
      }
    },
    async (state) => atomicJson(path, state, options.beforeRename),
  );
}
