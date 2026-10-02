import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
const root = "apps/dashboard/dist";
async function files(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map(async (d) =>
        d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
      ),
    )
  ).flat();
}
const paths = (await files(root)).filter((p) => !p.endsWith("/sw.js")).sort();
const hash = createHash("sha256");
for (const p of paths) hash.update(await readFile(p));
const version = hash.digest("hex").slice(0, 16);
const source = await readFile("apps/dashboard/src/sw.ts", "utf8");
await writeFile(
  join(root, "sw.js"),
  source
    .replace("__VERSION__", version)
    .replace(
      "__ASSETS__",
      JSON.stringify(paths.map((p) => "/" + relative(root, p))),
    ),
);
console.log(`Offline shell ${version}: ${paths.length} assets`);
