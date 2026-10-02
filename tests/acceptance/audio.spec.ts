import { test, expect } from "@playwright/test";
/** Uses test-only audio media/manifest; it does not claim real recorded audio or Fire validation. */
test("production controller claims one hour across two tabs and reload", async ({
  context,
}) => {
  await context.route("**/audio/manifest.json", (route) =>
    route.fulfill({
      json: {
        hours: Object.fromEntries(
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
