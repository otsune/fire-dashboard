import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  modeReady,
  parseManifest,
} from "../../apps/dashboard/src/audio/manifest";
import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { parseSettings } from "../../packages/contracts/src/index";

it("keeps both selected OGG chimes and requires an explicit enable tap", async () => {
  const manifest = parseManifest(
    JSON.parse(
      await readFile("apps/dashboard/public/audio/manifest.json", "utf8"),
    ),
  );
  expect(modeReady(manifest, "chime")).toBe(true);
  expect(modeReady(manifest, "voice", true)).toBe(true);
  expect(modeReady(manifest, "voice", false)).toBe(true);
  expect(modeReady(manifest, "both", true)).toBe(true);
  expect(modeReady(manifest, "both", false)).toBe(true);
  for (const { asset, url, blobSha, size, channels, sampleRate } of [
    {
      asset: manifest.chime,
      url: "/audio/chime_Eb5_C5_Eb5_Ab5.ogg",
      blobSha: "c347f4db17c85a09c422df31916504bdd896da96",
      size: 18790,
      channels: 1,
      sampleRate: 48000,
    },
    {
      asset: manifest.chimeOdd,
      url: "/audio/chime_NRT.ogg",
      blobSha: "91f77268f3156a58787502b2975122c602365440",
      size: 48023,
      channels: 2,
      sampleRate: 44100,
    },
  ]) {
    expect(asset?.url).toBe(url);
    const audio = await readFile(`apps/dashboard/public${asset!.url}`);
    expect(audio.length).toBe(size);
    // Pin the supplied Git blob identity as well as its Ogg/Vorbis format.
    expect(
      createHash("sha1")
        .update(`blob ${audio.length}\0`)
        .update(audio)
        .digest("hex"),
    ).toBe(blobSha);
    expect(audio.toString("ascii", 0, 4)).toBe("OggS");
    expect(audio[4]).toBe(0);
    expect(audio[5] & 2).toBe(2);
    const identification = 27 + audio[26];
    expect(audio[identification]).toBe(1);
    expect(audio.toString("ascii", identification + 1, identification + 7)).toBe(
      "vorbis",
    );
    expect(audio.readUInt32LE(identification + 7)).toBe(0);
    expect(audio[identification + 11]).toBe(channels);
    expect(audio.readUInt32LE(identification + 12)).toBe(sampleRate);
  }
  await expect(
    readFile("apps/dashboard/public/audio/chime_Eb5_C5_Eb5_Ab5.wav"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const controller = createAudioController(
    () => parseSettings({ audioMode: "chime" }),
    manifest,
  );
  expect(controller.state().enabled).toBe(false);
  controller.dispose();
});
