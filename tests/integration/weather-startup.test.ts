import { expect, it } from "vitest";
import { prepareServer } from "../../services/aggregator/src/start";
import { configSchema } from "../../services/aggregator/src/config";
import { createMemoryStore } from "../../services/aggregator/src/store";
import {
  createWeatherCatalog,
  JMA_AREA_URL,
} from "../../services/aggregator/src/weather/catalog";
import { forecast, response } from "../helpers/weather-catalog";
const selection = { office: "130000", region: "130010", station: "44132" };
it("prepares canonical migration and lifecycle before listen without waiting for JMA", async () => {
  const store = createMemoryStore();
  let requests = 0;
  const prepared = await prepareServer({
    store,
    config: configSchema.parse({ weather: selection }),
    origin: "https://dashboard.example",
    authorize: async () => true,
    authorizeAdmin: async () => true,
    sourceDependencies: {
      fetch: async () => {
        requests++;
        return new Promise(() => {});
      },
    },
    weatherCatalog: createWeatherCatalog({
      fetch: async (url) =>
        response(
          url.href === JMA_AREA_URL
            ? { offices: { "130000": { name: "東京都" } } }
            : forecast,
        ),
    }),
  });
  try {
    expect(requests).toBe(1);
    expect(prepared.app.server.listening).toBe(false);
    const settings = (
      await prepared.app.inject({ url: "/api/v1/weather-settings" })
    ).json();
    expect(settings).toMatchObject({
      selection,
      canEdit: true,
      weather: { regionId: selection.region, periods: [] },
    });
    expect(settings.weather.configurationRevision).toBe(settings.revision);
    const saved = await prepared.app.inject({
      method: "PUT",
      url: "/api/v1/weather-settings",
      headers: { origin: "https://dashboard.example" },
      payload: {
        revision: settings.revision,
        selection: { ...selection, station: "44133" },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(requests).toBe(2);
    expect(saved.json().weather.temperatureStationLabel).toBe("別地点");
  } finally {
    prepared.sources.stop();
    await prepared.app.close();
  }
});
it("settings storage failure blocks preparation before API startup", async () => {
  const store = {
    ...createMemoryStore(),
    readState: async () => {
      throw Error("storage");
    },
  };
  await expect(
    prepareServer({
      store,
      config: configSchema.parse({}),
      origin: "https://dashboard.example",
      authorize: async () => true,
    }),
  ).rejects.toThrow("storage_unavailable");
});
it("invalid FIRE_PORT exits without starting sources or writing state", async () => {
  const { mkdtemp, writeFile, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "fire-invalid-port-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const auth = join(directory, "auth.mjs"),
      config = join(directory, "config.json"),
      state = join(directory, "state.json");
    // The fixture makes attempted source lookups observable without network IO.
    await writeFile(
      auth,
      `
      import dns from "node:dns/promises";
      import {syncBuiltinESMExports} from "node:module";
      dns.lookup=async () => {process.stderr.write("background-fetch-attempt\\n");return [];};
      syncBuiltinESMExports();
      export const authorize=async () => true;
      export const sourceAlias=async () => "fixture";
    `,
    );
    await writeFile(config, JSON.stringify({ weather: selection, feeds: [] }));
    child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("services/aggregator/src/start.ts")],
      {
        env: {
          ...process.env,
          FIRE_AUTH_MODULE: auth,
          FIRE_PUBLIC_ORIGIN: "https://dashboard.example",
          FIRE_CONFIG: config,
          FIRE_STATE_FILE: state,
          FIRE_PORT: "invalid",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const running = child;
    let stderr = "",
      stdout = "";
    const exited = new Promise<number | null>((resolve) =>
      running.once("exit", resolve),
    );
    running.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const blocked = new Promise<void>((resolve, reject) => {
      running.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes("startup blocked")) resolve();
      });
      running.once("error", reject);
      running.once("exit", (code) => {
        if (!stderr.includes("startup blocked"))
          reject(Error(`startup did not reach validation: ${code}: ${stderr}`));
      });
    });
    await blocked;
    const outcome = await Promise.race([
      exited.then((code) => ({ exited: true, code })),
      new Promise<{ exited: boolean; code: null }>((resolve) =>
        setTimeout(() => resolve({ exited: false, code: null }), 200),
      ),
    ]);
    expect(stderr).not.toContain("background-fetch-attempt");
    expect(stdout).not.toContain("listening");
    expect(outcome).toEqual({ exited: true, code: 1 });
    await expect(access(state)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    child?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
