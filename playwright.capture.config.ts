// PMQA-040-B1 capture-only 설정 — globalSetup을 생략해 DB reseed/cleanUserData를
// 실행하지 않는다. 직전 suite 실행이 만든 u-c 주문(CONFIRMED+PAID)을 그대로
// GET 재사용해 완료 화면을 캡처하는 명시적 서브셋이다 [PM 승인 경로].
// 동일 안전 경계: test-server.ts 래퍼가 commerce_test를 실측 확인 후에만 listen.
// reuseExistingServer=false — dev 서버 위에서 돌지 않고 자체 3101을 쓴다.
import { defineConfig } from "@playwright/test";
import "./src/config.ts";
import { assertEntryRunnable } from "./tests/helpers/pw-config-gate.ts";
import { databaseUrlForName } from "./src/db-url.ts";

// PMQA-055: capture 전용 늦은 예약 경로는 이번 지원 미완 — 설정 평가에서 거부.
assertEntryRunnable("playwright.capture.config.ts");

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl) throw new Error("DATABASE_URL is required");
const testDatabaseUrl = databaseUrlForName("commerce_test", baseDatabaseUrl);

export default defineConfig({
  testDir: "tests/e2e",
  // testMatch 고정 — 이 config는 zz 캡처 spec 단독 실행 전용이다.
  // (globalSetup이 없어 전체 스위트를 이 config로 돌리면 fixture 가정이 깨진다 —
  //  PMQA-040-B1에서 필터 없는 실행으로 69건이 도는 실수가 있었음. 재발 방지.)
  testMatch: /zz-pmqa040-capture\.spec\.ts/,
  timeout: 30_000,
  workers: 1,
  retries: 0,
  use: { baseURL: "http://localhost:3101" },
  // globalSetup 생략 — setupTestDb(reseed)+cleanUserData(주문 삭제)를 돌리지 않아
  // 직전 suite가 만든 주문이 보존된다. capture spec은 confirm 없이 GET만 읽는다.
  webServer: {
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
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
