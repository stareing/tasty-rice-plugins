import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import manifest from "./manifest.config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // CRXJS auto-processes the popup HTML (declared in manifest.action),
      // but does NOT auto-detect offscreen documents — list it as an entry
      // so Vite transforms its <script src="./index.ts"> reference.
      input: {
        offscreen: resolve(here, "src/offscreen/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
