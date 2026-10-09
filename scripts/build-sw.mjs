import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
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
const paths = (await files(root))
  .map((path) => ({
    path,
    url: "/" + relative(root, path).split(sep).join("/"),
  }))
  .filter((asset) => asset.url !== "/sw.js")
  .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
const source = await readFile("apps/dashboard/src/sw.ts", "utf8");
const assetHashes = await Promise.all(
  paths.map(async (asset) => [
    asset.url,
    createHash("sha256")
      .update(await readFile(asset.path))
      .digest("hex"),
  ]),
);
const version = createHash("sha256")
  .update(JSON.stringify({ source, assets: assetHashes }))
  .digest("hex")
  .slice(0, 16);
await writeFile(
  join(root, "sw.js"),
  source
    .replace("__VERSION__", version)
    .replace("__ASSETS__", JSON.stringify(paths.map((asset) => asset.url))),
);
console.log(`Offline shell ${version}: ${paths.length} assets`);
