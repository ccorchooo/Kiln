import { defineConfig } from "@playwright/test";

// Runs against a live Kiln server:
//   KILN_URL=https://127.0.0.1:8443 KILN_TEST_PASSWORD="…" npm run e2e
// CHROMIUM_PATH=/path/to/chrome reuses an existing browser instead of `npx playwright install`.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL: process.env.KILN_URL ?? "https://127.0.0.1:8443",
    ignoreHTTPSErrors: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
    },
  },
});
