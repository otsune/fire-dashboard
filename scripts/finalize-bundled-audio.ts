import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Remove only the 48 redundant bundled PCM copies from generated output.
 * Vite calls this for both standard and private-audio builds, before overrides.
 * Source originals, chime and private WAV overrides are never touched.
 */
export async function finalizeBundledAudio(dist: string): Promise<void> {
  const audio = join(dist, "audio");
  const manifest = JSON.parse(await readFile(join(audio, "manifest.json"), "utf8"));
  const wavs: string[] = [];
  for (const [format, key] of [["12h", "hours"], ["24h", "hours24"]] as const) {
    for (let hour = 0; hour < 24; hour++) {
      const stem = `gemini/${format}/hour-${String(hour).padStart(2, "0")}`;
      if (manifest[key]?.[String(hour).padStart(2, "0")]?.url !== `/audio/${stem}.ogg`) {
        throw Error(`Bundled hourly Ogg manifest mismatch: ${stem}`);
      }
      const ogg = await readFile(join(audio, `${stem}.ogg`));
      if (ogg.toString("ascii", 0, 4) !== "OggS" || !ogg.includes(Buffer.from("OpusHead"))) {
        throw Error(`Missing or invalid bundled Opus: ${stem}`);
      }
      wavs.push(join(audio, `${stem}.wav`));
    }
  }
  // Validate the full delivery set before removing any build-only originals.
  for (const wav of wavs) {
    try { await unlink(wav); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
