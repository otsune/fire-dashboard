export type AudioAsset = { url: string; license: string };
export type AudioManifest = {
  hours: Record<string, AudioAsset>;
  chime: AudioAsset | null;
};
const empty = (): AudioManifest => ({ hours: {}, chime: null });
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assetValid(value: unknown): value is AudioAsset {
  return (
    object(value) &&
    typeof value.url === "string" &&
    value.url.length <= 2048 &&
    /^\/audio\/[a-zA-Z0-9_./-]+$/.test(value.url) &&
    !value.url.includes("..") &&
    typeof value.license === "string" &&
    value.license.trim().length > 0 &&
    value.license.length <= 2048
  );
}
export function parseManifest(value: unknown): AudioManifest {
  if (
    !object(value) ||
    !object(value.hours) ||
    Object.keys(value.hours).length > 24
  )
    return empty();
  const hours: Record<string, AudioAsset> = {};
  for (const [hour, asset] of Object.entries(value.hours)) {
    if (!/^(0\d|1\d|2[0-3])$/.test(hour) || !assetValid(asset)) return empty();
    hours[hour] = { url: asset.url, license: asset.license };
  }
  if (value.chime !== null && !assetValid(value.chime)) return empty();
  return {
    hours,
    chime:
      value.chime === null
        ? null
        : { url: value.chime.url, license: value.chime.license },
  };
}
export function modeReady(manifest: AudioManifest, mode: string): boolean {
  const valid = parseManifest(manifest);
  if (mode === "off" || !["voice", "chime", "both"].includes(mode))
    return false;
  const voice = Array.from(
    { length: 24 },
    (_, h) => valid.hours[String(h).padStart(2, "0")],
  ).every(assetValid);
  return mode === "voice"
    ? voice
    : mode === "chime"
      ? assetValid(valid.chime)
      : voice && assetValid(valid.chime);
}
export async function loadManifest(): Promise<AudioManifest> {
  try {
    const response = await fetch("/audio/manifest.json", {
      cache: "no-cache",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Error();
    const text = await response.text();
    if (text.length > 65536) return empty();
    return parseManifest(JSON.parse(text));
  } catch {
    return empty();
  }
}
