import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In production the built SPA is served by the in-process UI server (sirv) from
// apps/web/dist, same origin as the API. In dev, Vite serves the SPA and proxies
// the API routes to a running `cogmo serve` so the browser still sees one origin
// — the session cookie and `Sec-Fetch-Site: same-origin` survive the round-trip,
// which the CSRF gate requires.
const API_TARGET = "http://localhost:9090";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/rpc": API_TARGET,
      "/api": API_TARGET,
    },
  },
});
