import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { runInNewContext } from "node:vm";

const script = resolve("scripts/build-sw.mjs");
let root: string;
let workerSource: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fire-offline-build-"));
  workerSource = await readFile("apps/dashboard/src/sw.ts", "utf8");
  await mkdir(join(root, "apps/dashboard/src"), { recursive: true });
  await mkdir(join(root, "apps/dashboard/dist/assets"), { recursive: true });
  await writeFile(join(root, "apps/dashboard/src/sw.ts"), workerSource);
  await writeFile(
    join(root, "apps/dashboard/dist/index.html"),
    "<!doctype html>shell",
  );
  await writeFile(join(root, "apps/dashboard/dist/assets/app.js"), "bootstrap");
  await writeFile(join(root, "apps/dashboard/dist/assets/app.css"), "styles");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function identity(output: string) {
  return {
    cache: output.match(/const CACHE = "([^"]+)";/)![1],
    assets: JSON.parse(output.match(/const ASSETS = (.*);/)![1]) as string[],
  };
}
async function build() {
  execFileSync(process.execPath, [script], { cwd: root });
  return readFile(join(root, "apps/dashboard/dist/sw.js"), "utf8");
}
it("changes cache identity for a worker-only correction", async () => {
  const original = identity(await build());
  await writeFile(
    join(root, "apps/dashboard/src/sw.ts"),
    workerSource + "\n// worker-only correction\n",
  );
  const changed = identity(await build());
  expect(changed.assets).toEqual(original.assets);
  expect(changed.cache).not.toBe(original.cache);
});
it("keeps repeated generation deterministic and excludes its generated worker", async () => {
  const first = await build();
  const second = await build();
  expect(second).toBe(first);
  expect(identity(second).assets).toEqual([
    "/assets/app.css",
    "/assets/app.js",
    "/index.html",
  ]);
});
it("includes asset URL identity even when renamed files have identical bytes", async () => {
  const original = identity(await build());
  await rename(
    join(root, "apps/dashboard/dist/assets/app.js"),
    join(root, "apps/dashboard/dist/assets/renamed.js"),
  );
  const changed = identity(await build());
  expect(changed.assets).toContain("/assets/renamed.js");
  expect(changed.cache).not.toBe(original.cache);
});
it("normalizes Windows asset URLs and excludes sw.js during repeated generation", async () => {
  // This executes actual build source with win32 paths and an in-memory filesystem.
  // It is a portable-path probe on the current OS, not a Windows process run.
  const files = new Map<string, Buffer>([
    ["apps\\dashboard\\src\\sw.ts", Buffer.from(workerSource)],
    ["apps\\dashboard\\dist\\index.html", Buffer.from("shell")],
    ["apps\\dashboard\\dist\\assets\\app.js", Buffer.from("bootstrap")],
    ["apps\\dashboard\\dist\\assets\\app.css", Buffer.from("styles")],
    ["apps\\dashboard\\dist\\sw.js", Buffer.from("old generated worker")],
  ]);
  const source = (await readFile(script, "utf8")).replace(
    /^import[\s\S]*?;\n/gm,
    "",
  );
  const run = async () => {
    await runInNewContext("(async () => {" + source + "})()", {
      join: win32.join,
      relative: win32.relative,
      sep: win32.sep,
      createHash,
      readdir: async (directory: string) => {
        const prefix = win32.normalize(directory) + "\\";
        const names = new Map<string, boolean>();
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) continue;
          const parts = path.slice(prefix.length).split("\\");
          names.set(parts[0], parts.length > 1);
        }
        return [...names].map(([name, directory]) => ({
          name,
          isDirectory: () => directory,
        }));
      },
      readFile: async (path: string, encoding?: string) => {
        const value = files.get(win32.normalize(path));
        if (!value) throw Error("missing fixture: " + path);
        return encoding ? value.toString(encoding as BufferEncoding) : value;
      },
      writeFile: async (path: string, value: string) => {
        files.set(win32.normalize(path), Buffer.from(value));
      },
      console: { log: () => {} },
    });
    return files.get("apps\\dashboard\\dist\\sw.js")!.toString();
  };
  const first = await run();
  expect(identity(first).assets).toEqual([
    "/assets/app.css",
    "/assets/app.js",
    "/index.html",
  ]);
  expect(await run()).toBe(first);
});
