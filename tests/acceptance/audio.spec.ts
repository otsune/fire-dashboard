import { test, expect } from "@playwright/test";
/** Uses test-only audio media/manifest; it does not claim real recorded audio or Fire validation. */
test("production controller claims one hour across two tabs and reload", async ({
  context,
}) => {
  await context.route("**/audio/manifest.json", (route) =>
    route.fulfill({
      json: {
        hours: {},
        hours24: Object.fromEntries(
          Array.from({ length: 24 }, (_, h) => [
            String(h).padStart(2, "0"),
            { url: `/audio/${h}.mp3`, license: "acceptance fixture only" },
          ]),
        ),
        chime: null,
      },
    }),
  );
  await context.addInitScript(() => {
    const played: string[] = [];
    (window as unknown as { testPlayed: string[] }).testPlayed = played;
    class FixtureAudio {
      src: string;
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(src: string) {
        this.src = src;
      }
      play() {
        played.push(this.src);
        Promise.resolve().then(() => this.onended?.());
        return Promise.resolve();
      }
      pause() {}
      removeAttribute() {}
      load() {}
    }
    Object.defineProperty(window, "Audio", { value: FixtureAudio });
  });
  const pages = [await context.newPage(), await context.newPage()];
  await Promise.all(
    pages.map(async (page) => {
      await page.clock.install({ time: new Date("2026-10-02T00:59:55Z") });
      await page.goto("/");
      await page.getByRole("button", { name: "音声を有効にする" }).click();
      await expect(page.getByText("音声有効", { exact: true })).toBeVisible();
    }),
  );
  await Promise.all(pages.map((page) => page.clock.runFor(6500)));
  const played = await Promise.all(
    pages.map((page) =>
      page.evaluate(
        () => (window as unknown as { testPlayed: string[] }).testPlayed,
      ),
    ),
  );
  expect(played.flat().filter((url) => url === "/audio/10.mp3")).toHaveLength(
    1,
  );
  await pages[0].reload();
  await expect(
    pages[0].getByRole("button", { name: "音声を有効にする" }),
  ).toBeVisible();
  const claims = await pages[0].evaluate(async () => {
    const request = indexedDB.open("fire-dashboard-v1", 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    return new Promise<number>((resolve) => {
      const tx = db.transaction("claims", "readonly");
      const request = tx.objectStore("claims").count();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
    });
  });
  expect(claims).toBe(1);
});

test("bundled original chime decodes and plays only after an explicit tap", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeDisabled();
  const decoded = await page.evaluate(async () => {
    const response = await fetch("/audio/chime_Eb5_C5_Eb5_Ab5.wav");
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(await response.arrayBuffer());
      return { duration: audio.duration, channels: audio.numberOfChannels };
    } finally {
      await context.close();
    }
  });
  expect(decoded.duration).toBeCloseTo(3.2, 2);
  expect(decoded.channels).toBe(1);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("時報の種類").selectOption("chime");
  await page.getByRole("button", { name: "時計に戻る" }).click();
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "音声を有効にする" }).click();
  await expect(page.getByText("音声有効", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
});
