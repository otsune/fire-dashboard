import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
const result = await build({
  entryPoints: { migrate: "scripts/migrate-usage-state.ts", start: "services/usage/src/start.ts", "auth-tailscale": "services/usage/src/auth-tailscale-module.ts" },
  outdir: "dist/usage", outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
  banner: { js: "import { createRequire as __usageRequire } from 'node:module'; const require = __usageRequire(import.meta.url);" },
  logLevel: "warning",
});
await writeFile("dist/usage/metafile.json", JSON.stringify(result.metafile, null, 2));
console.log("Usage API and auth -> dist/usage");
