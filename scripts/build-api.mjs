// Bundles the aggregator API and its Tailscale auth module into single ESM
// files that start with plain `node`. Running through `npm run start:api`
// keeps an npm wrapper (~75 MB) and the tsx loader resident for the service's
// whole life; the bundle avoids both.
import { build } from "esbuild";
await build({
  entryPoints: {
    start: "services/aggregator/src/start.ts",
    "auth-tailscale": "services/aggregator/src/auth-tailscale-module.ts",
  },
  outdir: "dist/aggregator",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Fastify and its dependencies are CommonJS and call require() for
  // node builtins, which an ESM bundle does not provide on its own.
  banner: {
    js: "import { createRequire as __fireCreateRequire } from 'node:module'; const require = __fireCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});
console.log("API: start, auth-tailscale -> dist/aggregator");
