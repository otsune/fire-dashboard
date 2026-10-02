import { transaction } from "../data/db";
export function claimHour(key: string): Promise<boolean> {
  return transaction("claims", "readwrite", (s, done) => {
    const r = s.index("key").get(key);
    r.onsuccess = () => {
      if (r.result) {
        done(false);
        return;
      }
      const add = s.add({ key });
      add.onsuccess = () => {
        const all = s.getAllKeys();
        all.onsuccess = () => {
          all.result
            .slice(0, Math.max(0, all.result.length - 256))
            .forEach((k) => s.delete(k));
          done(true);
        };
      };
    };
  });
}
export function claimCount(): Promise<number> {
  return transaction("claims", "readonly", (s, done) => {
    const r = s.count();
    r.onsuccess = () => done(r.result);
  });
}
export type Lease = {
  owner: string;
  kind: "hourly" | "preview";
  expires: number;
};
export function acquireLease(
  owner: string,
  kind: Lease["kind"],
  now = Date.now(),
  exclusiveBrowserLock = false,
): Promise<boolean> {
  return transaction("leases", "readwrite", (s, done) => {
    const r = s.get("audio");
    r.onsuccess = () => {
      const lease = r.result as Lease | undefined;
      if (lease && lease.owner !== owner && !exclusiveBrowserLock) {
        done(false);
        return;
      }
      s.put({ owner, kind, expires: now + 30000 }, "audio");
      done(true);
    };
  });
}
export function renewLease(owner: string, now = Date.now()): Promise<boolean> {
  return transaction("leases", "readwrite", (s, done) => {
    const r = s.get("audio");
    r.onsuccess = () => {
      const v = r.result as Lease | undefined;
      if (!v || v.owner !== owner || v.expires <= now) {
        done(false);
        return;
      }
      s.put({ ...v, expires: now + 30000 }, "audio");
      done(true);
    };
  });
}
export function releaseLease(owner: string): Promise<void> {
  return transaction("leases", "readwrite", (s, done) => {
    const r = s.get("audio");
    r.onsuccess = () => {
      if (r.result?.owner === owner) s.delete("audio");
      done();
    };
  });
}
