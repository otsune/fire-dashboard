import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireSnapshotLock } from "../../collectors/shared/snapshot-lock";

const path = process.argv[2];
await mkdir(dirname(path), { recursive: true });
try {
  const release = await acquireSnapshotLock(path);
  process.on("message", (message) => {
    if (message === "release") {
      void release().then(() => process.exit(0));
    }
  });
  process.send!({ state: "acquired" });
} catch {
  process.send!({ state: "blocked" }, () => process.exit(0));
}
