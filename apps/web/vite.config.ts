import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Several Solana deps reference `global` — map it to `globalThis` in the browser.
    global: "globalThis",
    "process.env": {},
  },
  resolve: {
    alias: {
      // Use the browser-friendly `buffer` shim for any package that imports "buffer".
      buffer: "buffer/",
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "es2022",
      define: { global: "globalThis" },
    },
    include: ["buffer"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/ws": { target: "ws://localhost:4000", ws: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
