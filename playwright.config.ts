import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const browserExecutable = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].find((path) => path && existsSync(path));

export default defineConfig({
  testDir: "tests/acceptance",
  timeout: 30000,
  fullyParallel: false,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: {
      executablePath: browserExecutable,
    },
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 60000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
