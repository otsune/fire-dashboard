import { expect, it } from "vitest";
import { build } from "esbuild";
import {
  usageConfigSchema,
  resolveUsageEnvironment,
} from "../../services/usage/src/config";

it("builds without Fire, weather, RSS, or display contracts", async () => {
  const result = await build({
    entryPoints: ["services/usage/src/start.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
  });
  expect(
    Object.keys(result.metafile!.inputs).filter((p) =>
      /^(apps\/|services\/aggregator\/|packages\/contracts\/)/.test(p),
    ),
  ).toEqual([]);
});
it("requires explicit migration of FIRE configuration instead of silently changing state", () => {
  expect(() =>
    resolveUsageEnvironment({ FIRE_STATE_FILE: "/old/state.json" }),
  ).toThrow("legacy_environment");
  expect(() =>
    resolveUsageEnvironment({
      USAGE_STATE_FILE: "/new/state.json",
      FIRE_PORT: "8787",
    }),
  ).toThrow("legacy_environment");
  expect(resolveUsageEnvironment({}).port).toBe(8788);
  expect(usageConfigSchema.parse({}).mqtt.topicPrefix).toBe("ai-usage/v1/main");
  expect(() =>
    usageConfigSchema.parse({ mqtt: { url: "mqtt://0.0.0.0:1883" } }),
  ).toThrow();
});
