import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite handles the React build (output → dist/). The API server runs
// separately on :3000 in dev (see server/local.ts) — vite proxies
// /api/* to it so the frontend can call relative URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
