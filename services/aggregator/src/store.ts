import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseDashboard,
  emptyDashboard,
  type Dashboard,
  type UsageEnvelope,
} from "../../../packages/contracts/src/index";
export type State = {
  dashboard: Dashboard;
  usageSequences: Record<string, UsageEnvelope>;
};
export type Store = {
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
  return {
    readSnapshot: async () => {
      await queue;
      return structuredClone((await load()).dashboard);
    },
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
  let state: State = { dashboard: emptyDashboard(), usageSequences: {} };
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
        return {
          dashboard: parseDashboard(raw.dashboard),
          usageSequences: raw.usageSequences ?? {},
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return { dashboard: emptyDashboard(), usageSequences: {} };
        throw Error("storage");
      }
    },
    async (state) => atomicJson(path, state, options.beforeRename),
  );
}
