import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import {
  modeReady,
  parseManifest,
  type AudioAsset,
} from "../apps/dashboard/src/audio/manifest";

type PrivateAudio = { hour: string; asset: AudioAsset; bytes: Buffer }[];
const root = fileURLToPath(new URL("..", import.meta.url));

async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile())
    throw Error(`Expected a regular file (no symlinks): ${path}`);
  if (stat.size < 1 || stat.size > maxBytes)
    throw Error(`Invalid file size: ${path}`);
  return readFile(path);
}

/** Reads only the 24 manifest-referenced hourly files, never private metadata. */
export async function readPrivateAudio(source: string): Promise<PrivateAudio> {
  const raw = await readRegularFile(join(source, "manifest.json"), 65536);
  const manifest = parseManifest(JSON.parse(raw.toString("utf8")));
  if (!modeReady(manifest, "voice")) {
    throw Error(
      "A valid manifest with all 24 hours and license metadata is required",
    );
  }
  const clips: PrivateAudio = [];
  for (let hour = 0; hour < 24; hour++) {
    const key = String(hour).padStart(2, "0");
    const asset = manifest.hours[key];
    const filename = `hour-${key}.mp3`;
    if (asset.url !== `/audio/${filename}`) {
      throw Error(`Hour ${key} must reference /audio/${filename}`);
    }
    clips.push({
      hour: key,
      asset,
      bytes: await readRegularFile(join(source, filename), 5 * 1024 * 1024),
    });
  }
  return clips;
}

/** Installs into an already-built private distribution, leaving source files alone. */
export async function installPrivateAudio(
  clips: PrivateAudio,
  output: string,
): Promise<void> {
  const manifest = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  if (!modeReady(manifest, "chime"))
    throw Error("Built distribution is missing its chime");
  await mkdir(join(output, "private"), { recursive: true });
  for (const clip of clips) {
    const filename = `hour-${clip.hour}.mp3`;
    await writeFile(join(output, "private", filename), clip.bytes);
    manifest.hours[clip.hour] = {
      url: `/audio/private/${filename}`,
      license: clip.asset.license,
    };
  }
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw Error(
      "Usage: npm run build:private-audio -- /path/to/ayana-hourly-private/audio",
    );
  }
  const source = await realpath(resolve(process.argv[2]));
  const dist = resolve(root, "apps/dashboard/dist");
  const inside = relative(await realpath(root), source);
  if (inside === "" || (inside.split(sep)[0] !== ".." && !isAbsolute(inside))) {
    throw Error("Audio source must be outside the repository");
  }
  // Validate and read everything before Vite clears the previous output.
  const clips = await readPrivateAudio(source);
  await build({ configFile: resolve(root, "apps/dashboard/vite.config.ts") });
  await installPrivateAudio(clips, join(dist, "audio"));
  // Private clips and their manifest must participate in the versioned offline cache.
  execFileSync(process.execPath, [resolve(root, "scripts/build-sw.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(
    "Private build ready: 24 hourly clips + bundled chime. Keep this dist private; deploy only to your authorized home server. Sound still requires a tap.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Private audio build failed",
    );
    process.exitCode = 1;
  });
}
