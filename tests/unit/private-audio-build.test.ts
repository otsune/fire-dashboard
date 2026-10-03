import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { parseSettings } from "../../packages/contracts/src/index";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readPrivateAudio,
  installPrivateAudio,
} from "../../scripts/build-private-audio";
import {
  modeReady,
  parseManifest,
} from "../../apps/dashboard/src/audio/manifest";

let root: string;
let source: string;
const license = "Synthetic test fixture only; no real voice assets";
const chime = {
  url: "/audio/chime_Eb5_C5_Eb5_Ab5.wav",
  license: "Unlicense; original synthesized chime",
};
const hours = () =>
  Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, "0");
      return [key, { url: `/audio/hour-${key}.mp3`, license }];
    }),
  );
async function manifest(value: unknown = { hours: hours(), chime: null }) {
  await writeFile(join(source, "manifest.json"), JSON.stringify(value));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fire-private-audio-test-"));
  source = join(root, "source");
  await mkdir(source);
  await manifest();
  for (let hour = 0; hour < 24; hour++) {
    // Deliberately not real MP3 audio; installer checks layout, not decoding.
    await writeFile(
      join(source, `hour-${String(hour).padStart(2, "0")}.mp3`),
      `synthetic-hour-${hour}`,
    );
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("imports all hours into private output, preserving licenses and the bundled chime", async () => {
  const bundle = await readPrivateAudio(source);
  const output = join(root, "dist", "audio");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ hours: {}, chime }),
  );
  await writeFile(
    join(source, "provenance.json"),
    "private metadata must stay out of output",
  );
  await installPrivateAudio(bundle, output);
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  expect(modeReady(deployed, "both")).toBe(true);
  expect(deployed.chime).toEqual(chime);
  for (let hour = 0; hour < 24; hour++) {
    const key = String(hour).padStart(2, "0");
    expect(deployed.hours[key]).toEqual({
      url: `/audio/private/hour-${key}.mp3`,
      license,
    });
    expect(
      await readFile(join(output, "private", `hour-${key}.mp3`), "utf8"),
    ).toBe(`synthetic-hour-${hour}`);
  }
  await expect(readFile(join(output, "provenance.json"))).rejects.toThrow();
  expect(
    JSON.parse(await readFile(join(source, "manifest.json"), "utf8")).chime,
  ).toBeNull();
});
it("rejects a missing hour instead of installing a partial voice set", async () => {
  const value = hours();
  delete value["23"];
  await manifest({ hours: value, chime: null });
  await expect(readPrivateAudio(source)).rejects.toThrow(/24/);
});
it("rejects a missing source file before the build", async () => {
  await rm(join(source, "hour-23.mp3"));
  await expect(readPrivateAudio(source)).rejects.toThrow(/hour-23/);
});
it("rejects an empty source file", async () => {
  await writeFile(join(source, "hour-00.mp3"), "");
  await expect(readPrivateAudio(source)).rejects.toThrow(/empty|size/i);
});
it.each([
  "/audio/../secret.mp3",
  "https://example.com/voice.mp3",
  "/audio/hour-01.mp3",
])("rejects unsafe or mismatched input URL %s", async (url) => {
  const value = hours();
  value["00"].url = url;
  await manifest({ hours: value, chime: null });
  await expect(readPrivateAudio(source)).rejects.toThrow();
});
it("rejects missing license metadata", async () => {
  const value = hours();
  value["00"].license = "";
  await manifest({ hours: value, chime: null });
  await expect(readPrivateAudio(source)).rejects.toThrow();
});
it.skipIf(process.platform === "win32")(
  "rejects symlinked voice files",
  async () => {
    await rm(join(source, "hour-00.mp3"));
    await symlink(join(source, "hour-01.mp3"), join(source, "hour-00.mp3"));
    await expect(readPrivateAudio(source)).rejects.toThrow(/regular|symlink/i);
  },
);
it("rejects an oversized manifest", async () => {
  await writeFile(join(source, "manifest.json"), " ".repeat(65537));
  await expect(readPrivateAudio(source)).rejects.toThrow(/size|large/i);
});

// An in-repository source could be copied by Vite before the private overlay.
it.each([".", "apps/dashboard/public/audio"])(
  "CLI rejects input inside the repository: %s",
  (path) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-private-audio.ts", resolve(path)],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the repository");
  },
);
it("CLI resolves symlinks before enforcing the external-source boundary", async () => {
  const alias = join(root, "alias");
  await symlink(resolve("apps/dashboard/public/audio"), alias, "junction");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/build-private-audio.ts", alias],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("outside the repository");
});

it("plays the bundled chime, 300 ms gap, then the imported hour at midnight and 23:00", async () => {
  const output = join(root, "dist", "audio");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ hours: {}, chime }),
  );
  await installPrivateAudio(await readPrivateAudio(source), output);
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  const sequence: (string | number)[] = [];
  const controller = createAudioController(
    () => parseSettings({ audioMode: "both" }),
    deployed,
    {
      play: async (url) => {
        sequence.push(url);
      },
      delay: async (ms) => {
        sequence.push(ms);
      },
    },
  );
  try {
    expect(controller.state().enabled).toBe(false);
    expect(await controller.enable()).toBe(true);
    await controller.preview(23);
    expect(sequence).toEqual([
      chime.url,
      300,
      "/audio/private/hour-00.mp3",
      chime.url,
      300,
      "/audio/private/hour-23.mp3",
    ]);
  } finally {
    controller.dispose();
  }
});
