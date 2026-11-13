import { expect, it } from "vitest";
import { build } from "esbuild";

it("bundles usage collectors without Fire API, dashboard or weather contracts", async () => {
  const result = await build({
    entryPoints: [
      "collectors/antigravity/statusline.ts",
      "collectors/codex/api-service.ts",
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: "unused",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(
    inputs.some((path) =>
      /^(apps\/|services\/aggregator\/|packages\/contracts\/)/.test(path),
    ),
  ).toBe(false);
});
