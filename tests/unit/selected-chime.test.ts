import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  modeReady,
  parseManifest,
} from "../../apps/dashboard/src/audio/manifest";
import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { parseSettings } from "../../packages/contracts/src/index";

it("keeps the selected original chime and requires an explicit enable tap", async () => {
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
  expect(manifest.chime?.url).toBe("/audio/chime_Eb5_C5_Eb5_Ab5.wav");
  const wave = await readFile(`apps/dashboard/public${manifest.chime!.url}`);
  expect(createHash("sha256").update(wave).digest("hex")).toBe(
    "4486bbe635a74c647621f28c407e8b3067a523c11d0848110008961debcfab11",
  );
  expect(wave.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wave.readUInt16LE(20)).toBe(1);
  expect(wave.readUInt16LE(22)).toBe(1);
  expect(wave.readUInt32LE(24)).toBe(48000);
  expect(wave.readUInt16LE(34)).toBe(16);
  expect(wave.readUInt32LE(40) / 96000).toBe(3.2);
  const controller = createAudioController(
    () => parseSettings({ audioMode: "chime" }),
    manifest,
  );
  expect(controller.state().enabled).toBe(false);
  controller.dispose();
});
