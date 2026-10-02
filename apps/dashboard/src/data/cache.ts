import {
  parseDashboard,
  type Dashboard,
  type Common,
} from "../../../../packages/contracts/src/index";
import { transaction } from "./db";
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
    weather: mergeCard(previous.weather, next.weather),
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
export function saveDashboard(value: Dashboard): Promise<void> {
  const valid = parseDashboard(value);
  return transaction("cards", "readwrite", (s, done) => {
    s.put(valid.weather, "weather");
    s.put(valid.rss, "rss");
    s.put(valid.usage, "usage");
    done();
  });
}
export function loadDashboard(): Promise<Dashboard | null> {
  return transaction("cards", "readonly", (store, done) => {
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
