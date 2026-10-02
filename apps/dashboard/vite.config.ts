import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// frame-ancestors requires an HTTP header; the HTML meta CSP still restricts
// resources. Production static hosts must set these headers independently.
const frameProtectionHeaders = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: { target: "es2020" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    headers: frameProtectionHeaders,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    headers: frameProtectionHeaders,
  },
});
