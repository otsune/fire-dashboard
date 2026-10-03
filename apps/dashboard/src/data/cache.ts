import {
  parseDashboard,
  type Dashboard,
  type Common,
} from "../../../../packages/contracts/src/index";
import { openDatabase } from "./db";
let cacheGeneration = 0;
const writes = new Set<IDBTransaction>();
export function invalidateDashboardCache(): void {
  cacheGeneration++;
  for (const tx of writes) {
    try {
      tx.abort();
    } catch {
      /* A completed transaction is already immutable. */
    }
  }
}
async function cacheTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T | null> {
  const generation = cacheGeneration;
  const db = await openDatabase();
  if (generation !== cacheGeneration) {
    db.close();
    return null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction("cards", mode);
    if (mode === "readwrite") writes.add(tx);
    let result: T;
    const finish = () => {
      writes.delete(tx);
      db.close();
    };
    tx.oncomplete = () => {
      finish();
      resolve(generation === cacheGeneration ? result : null);
    };
    tx.onerror = tx.onabort = () => {
      finish();
      if (generation !== cacheGeneration) resolve(null);
      else reject(Error("storage"));
    };
    try {
      run(tx.objectStore("cards"), (value) => {
        result = value;
      });
    } catch {
      tx.abort();
    }
  });
}
function mergeCard<T extends Common>(previous: T | undefined, next: T): T {
  return previous &&
    (next.status === "error" || next.status === "stale") &&
    previous.lastSuccessAt
    ? { ...previous, status: next.status, errorCode: next.errorCode }
    : previous && next.status === "error"
      ? { ...previous, status: "error", errorCode: next.errorCode }
      : next;
}
export function mergeDashboard(
  previous: Dashboard | null,
  next: Dashboard,
): Dashboard {
  if (!previous) return next;
  return {
    ...next,
    weather:
      previous.weather.configurationRevision ===
        next.weather.configurationRevision &&
      previous.weather.regionId === next.weather.regionId &&
      previous.weather.temperatureStationLabel ===
        next.weather.temperatureStationLabel
        ? mergeCard(previous.weather, next.weather)
        : next.weather,
    rss: next.rss.map((f) =>
      mergeCard(
        previous.rss.find((p) => p.id === f.id),
        f,
      ),
    ),
    usage: next.usage.map((u) =>
      mergeCard(
        previous.usage.find(
          (p) => p.provider === u.provider && p.sourceAlias === u.sourceAlias,
        ),
        u,
      ),
    ),
  };
}
export async function saveDashboard(value: Dashboard): Promise<void> {
  const valid = parseDashboard(value);
  await cacheTransaction<void>("readwrite", (s, done) => {
    s.put(valid.weather, "weather");
    s.put(valid.rss, "rss");
    s.put(valid.usage, "usage");
    done();
  });
}
export function loadDashboard(): Promise<Dashboard | null> {
  return cacheTransaction<Dashboard | null>("readonly", (store, done) => {
    const requests = ["weather", "rss", "usage"].map((key) => store.get(key));
    let count = 0;
    for (const request of requests) {
      request.onsuccess = () => {
        if (++count === 3) {
          try {
            done(
              parseDashboard({
                schemaVersion: 1,
                weather: requests[0].result,
                rss: requests[1].result,
                usage: requests[2].result,
              }),
            );
          } catch {
            done(null);
          }
        }
      };
    }
  });
}
