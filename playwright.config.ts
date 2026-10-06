import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:3100" },
  globalSetup: "./tests/e2e/global-setup.ts",
  webServer: {
    command: "node src/server.ts",
    url: "http://localhost:3100/health",
    env: {
      ...process.env,
      PORT: "3100",
      DATABASE_URL: "postgres://commerce:commerce@localhost:5432/commerce_test",
      TEST_USER_CODES: "e2e-a=u-a,e2e-b=u-b,e2e-c=u-c,e2e-d=u-d",
      LLM_PROVIDER: "stub",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
