import { defineConfig } from "@playwright/test";
import "./src/config.ts";
import { assertEntryRunnable } from "./tests/helpers/pw-config-gate.ts";
import { databaseUrlForName } from "./src/db-url.ts";

// PMQA-055: 이 config는 globalSetup reseed·실DB 경로 — 지원 미완 입구이므로
// 설정 평가 단계에서 거부된다(webServer·globalSetup·DB 시작 전).
assertEntryRunnable("playwright.config.ts");

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl) throw new Error("DATABASE_URL is required");
const testDatabaseUrl = databaseUrlForName("commerce_test", baseDatabaseUrl);

export default defineConfig({
  testDir: "tests/e2e",
  // readonly-* spec은 playwright.readonly.config.ts + tests/e2e/readonly-audit.ts
  // 전용 경로(RO 서버·읽기 가드·감사 gate)로만 실행한다 — 표준 3101/globalSetup
  // 경로에 섞이지 않도록 수집에서 제외 [PMQA-049-DBFREE].
  testIgnore: /readonly-.*\.spec\.ts/,
  timeout: 30_000,
  workers: 1,
  retries: 0,
  use: { baseURL: "http://localhost:3101" },
  globalSetup: "./tests/e2e/global-setup.ts",
  webServer: {
    // tests/e2e/test-server.ts — 실제 접속 DB가 commerce_test인지 확인한
    // 뒤에만 src/server.ts를 기동한다(PMQA-040-B0). DATABASE_URL 없음·
    // ?database= 우회·다른 DB면 프로세스가 listen 전에 종료된다.
    command: "node tests/e2e/test-server.ts",
    url: "http://localhost:3101/health",
    env: {
      ...process.env,
      PORT: "3101",
      DATABASE_URL: testDatabaseUrl,
      TEST_USER_CODES: "e2e-a=u-a,e2e-b=u-b,e2e-c=u-c,e2e-d=u-d",
      LLM_PROVIDER: "stub",
      CI: "1",
    },
    // 항상 false — 기존 dev 서버(실 DB 대상) 위에서 돌지 않는다.
    // 3101로 고정해 3100 예약 이력과 충돌하지 않게 한다.
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
