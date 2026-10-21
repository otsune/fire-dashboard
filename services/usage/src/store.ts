import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  emptyUsage,
  usageProviders,
  usageDeliverySchema,
  usageSchema,
  envelopeSchema,
  type UsageDelivery,
  type UsageEnvelope,
  type Usage,
} from "../../../packages/usage-contracts/src/index";

export type UsageState = {
  schemaVersion: 1;
  delivery: UsageDelivery;
  usageSequences: Record<string, UsageEnvelope>;
  usageValues: Record<string, Usage>;
  usageObservedAt: Record<string, string>;
};
export type UsageStore = {
  inspect: <T>(fn: (state: UsageState) => T) => Promise<T>;
  readState: () => Promise<UsageState>;
  readDelivery: () => Promise<UsageDelivery>;
  update: <T>(
    fn: (state: UsageState) => { state: UsageState; result: T },
  ) => Promise<T>;
};
export const usageStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    delivery: usageDeliverySchema,
    usageSequences: z.record(z.string(), envelopeSchema),
    usageValues: z.record(z.string(), usageSchema),
    usageObservedAt: z.record(
      z.string(),
      z.string().datetime({ offset: true }),
    ),
  })
  .superRefine((state, ctx) => {
    for (const [key, value] of Object.entries(state.usageSequences))
      if (key !== `${value.payload.provider}:${value.sourceAlias}`)
        ctx.addIssue({ code: "custom", message: "source_key" });
    for (const [key, value] of Object.entries(state.usageValues))
      if (key !== `${value.provider}:${value.sourceAlias}`)
        ctx.addIssue({ code: "custom", message: "source_key" });
  });
export function emptyUsageState(): UsageState {
  return {
    schemaVersion: 1,
    delivery: {
      schemaVersion: 1,
      streamId: randomUUID(),
      revision: "0",
      publishedAt: new Date().toISOString(),
      usage: usageProviders.map(emptyUsage),
    },
    usageSequences: {},
    usageValues: {},
    usageObservedAt: {},
  };
}
function engine(
  load: () => Promise<UsageState>,
  save: (state: UsageState) => Promise<void>,
): UsageStore {
  let queue: Promise<unknown> = Promise.resolve();
  const inspect: UsageStore["inspect"] = (fn) => {
    const result = queue.then(async () => fn(structuredClone(await load())));
    queue = result.catch(() => {});
    return result;
  };
  return {
    inspect,
    readState: () => inspect((s) => s),
    readDelivery: () => inspect((s) => s.delivery),
    update: (fn) => {
      const result = queue.then(async () => {
        const next = fn(structuredClone(await load()));
        await save(usageStateSchema.parse(next.state));
        return next.result;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
export function createMemoryUsageStore(): UsageStore {
  let state = emptyUsageState();
  return engine(
    async () => state,
    async (value) => {
      state = value;
    },
  );
}
/** Each process boot establishes a new delivery epoch, including backup restores. */
export async function beginUsageSession(store: UsageStore): Promise<void> {
  await store.update((state) => ({
    state: {
      ...state,
      delivery: {
        ...state.delivery,
        streamId: randomUUID(),
        publishedAt: new Date().toISOString(),
      },
    },
    result: undefined,
  }));
}
export function createFileUsageStore(
  path: string,
  options: { beforeRename?: () => Promise<void> } = {},
): UsageStore {
  const initial = emptyUsageState();
  let lastDelivery: Pick<UsageDelivery, "streamId" | "revision"> | undefined;
  const save = async (state: UsageState) => {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await options.beforeRename?.();
      await rename(temp, path);
      lastDelivery = {
        streamId: state.delivery.streamId,
        revision: state.delivery.revision,
      };
    } finally {
      await unlink(temp).catch(() => {});
    }
  };
  return engine(async () => {
    try {
      const state = usageStateSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (
        lastDelivery &&
        (lastDelivery.streamId !== state.delivery.streamId ||
          BigInt(state.delivery.revision) < BigInt(lastDelivery.revision))
      ) {
        // An external restore while running must not reuse an old sequence.
        state.delivery = {
          ...state.delivery,
          streamId: randomUUID(),
          publishedAt: new Date().toISOString(),
        };
        await save(state);
      }
      lastDelivery = {
        streamId: state.delivery.streamId,
        revision: state.delivery.revision,
      };
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !lastDelivery)
        return initial;
      throw Error("storage");
    }
  }, save);
}
