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

export type PrivateAudioFormat = "12h" | "24h";
type PrivateAudioSources = Partial<Record<PrivateAudioFormat, string>>;
type PrivateAudio = { hour: string; asset: AudioAsset; bytes: Buffer }[];
const root = fileURLToPath(new URL("..", import.meta.url));
const formats: PrivateAudioFormat[] = ["12h", "24h"];
const usage =
  "Usage: npm run build:private-audio -- /path/to/12h/audio OR --12h /path/to/12h/audio [--24h /path/to/24h/audio] OR --24h /path/to/24h/audio";

/** One legacy positional source means 12h; named flags select each set explicitly. */
export function parsePrivateAudioArgs(args: string[]): PrivateAudioSources {
  if (args.length === 1 && args[0].trim() && !args[0].startsWith("-")) {
    return { "12h": args[0] };
  }
  if (args.length === 0) throw Error(usage);
  const sources: PrivateAudioSources = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (flag !== "--12h" && flag !== "--24h") {
      throw Error(`Unknown argument ${flag}. ${usage}`);
    }
    const format: PrivateAudioFormat = flag === "--12h" ? "12h" : "24h";
    if (sources[format] !== undefined) {
      throw Error(`Duplicate ${format} source. ${usage}`);
    }
    const source = args[index + 1];
    if (!source?.trim() || source.startsWith("-")) {
      throw Error(`Missing source for ${flag}. ${usage}`);
    }
    sources[format] = source;
  }
  return sources;
}

function privateFilename(hour: string, asset: AudioAsset): string {
  const prefix = `/audio/hour-${hour}`;
  if (
    !/^(0\d|1\d|2[0-3])$/.test(hour) ||
    (asset.url !== `${prefix}.mp3` && asset.url !== `${prefix}.wav`)
  ) {
    throw Error(`Hour ${hour} must reference ${prefix}.mp3 or ${prefix}.wav`);
  }
  return asset.url.slice("/audio/".length);
}

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
    const filename = privateFilename(key, asset);
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
  format: PrivateAudioFormat = "12h",
): Promise<void> {
  const manifest = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  if (!modeReady(manifest, "chime"))
    throw Error("Built distribution is missing its chime");
  const subdirectory = format === "24h" ? "private/24h" : "private";
  const hours = format === "24h" ? (manifest.hours24 ??= {}) : manifest.hours;
  await mkdir(join(output, subdirectory), { recursive: true });
  for (const clip of clips) {
    const filename = privateFilename(clip.hour, clip.asset);
    await writeFile(join(output, subdirectory, filename), clip.bytes);
    hours[clip.hour] = {
      url: `/audio/${subdirectory}/${filename}`,
      license: clip.asset.license,
    };
  }
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/** Rejects all repository sources and reads both complete sets before any build. */
export async function preparePrivateAudio(
  sources: PrivateAudioSources,
): Promise<Partial<Record<PrivateAudioFormat, PrivateAudio>>> {
  const repository = await realpath(root);
  const resolved: PrivateAudioSources = {};
  for (const format of formats) {
    const source = sources[format];
    if (source === undefined) continue;
    const path = await realpath(resolve(source));
    const inside = relative(repository, path);
    if (
      inside === "" ||
      (inside.split(sep)[0] !== ".." && !isAbsolute(inside))
    ) {
      throw Error("Audio source must be outside the repository");
    }
    resolved[format] = path;
  }
  const bundles: Partial<Record<PrivateAudioFormat, PrivateAudio>> = {};
  for (const format of formats) {
    const source = resolved[format];
    if (source !== undefined) bundles[format] = await readPrivateAudio(source);
  }
  return bundles;
}

async function main(): Promise<void> {
  const sources = parsePrivateAudioArgs(process.argv.slice(2));
  const dist = resolve(root, "apps/dashboard/dist");
  // Validate and read everything before Vite clears the previous output.
  const bundles = await preparePrivateAudio(sources);
  await build({ configFile: resolve(root, "apps/dashboard/vite.config.ts") });
  for (const format of formats) {
    const clips = bundles[format];
    if (clips !== undefined)
      await installPrivateAudio(clips, join(dist, "audio"), format);
  }
  // Private clips and their manifest must participate in the versioned offline cache.
  execFileSync(process.execPath, [resolve(root, "scripts/build-sw.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(
    `Private build ready: ${formats.filter((format) => bundles[format]).join(" + ")} hourly clips + bundled chime. Keep this dist private; deploy only to your authorized home server. Sound still requires a tap.`,
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
