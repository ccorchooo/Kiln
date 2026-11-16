import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: run the backend with KILN_SERVER__DEV_CORS_ORIGIN=http://localhost:5173
const backend = process.env.KILN_BACKEND ?? "https://127.0.0.1:8443";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    sourcemap: false,
    // Keep scripts external: the server's CSP forbids inline scripts.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1000, // three.js is lazy-loaded after first paint
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/three")) return "three";
          if (id.includes("@react-three")) return "r3f";
          if (id.includes("framer-motion") || id.includes("motion-dom")) return "motion";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, secure: false, changeOrigin: true },
      "/ws": { target: backend, secure: false, changeOrigin: true, ws: true },
    },
  },
});
