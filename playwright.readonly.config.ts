// PMQA-048-B0 — 06B 읽기 전용 검증 전용 Playwright 설정.
// 기존 playwright.config.ts(69 suite)·playwright.capture.config.ts(zz 캡처)와
// 연결되지 않는다 — globalSetup 없음(reseed/cleanup 0), testMatch는
// readonly-*.spec.ts만, workers 1, retries 0.
//
// readonly-server.ts가 commerce_test·OID·read-only GUC를 실측한 뒤에만
// listen한다. 실행 산출물은 RO_RUN_ID 전용 디렉터리에만 쓴다 — 이 파일을
// RO_RUN_ID 없이 직접 실행하면 기존 evidence 덮어쓰기 방지로 시작부터 거부한다.
import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { assertRunAccess } from "./tests/e2e/readonly-guard.ts";

const RUN_ID = process.env.RO_RUN_ID ?? "";
if (!/^[0-9a-f-]{36}$/.test(RUN_ID))
  throw new Error(
    "playwright.readonly.config: RO_RUN_ID 필수 — readonly-audit.ts 런처로만 실행한다",
  );
// runner 첫 평가는 예약 run + pw-output 부재 + 소유 정합을 요구하고, launcher가
// RO_WORKER_NONCE env로 묶은 현재 run의 worker 재평가만 통과한다 — 실제
// 설치본 기준 config 파일 재import는 deserializeConfig→requireOrImport가
// worker 프로세스에서 일어나고, worker에는 TEST_WORKER_INDEX가 먼저 설정된다.
// 그 재평가는 runner가 방금 만든 pw-output을 보지만 nonce·runId·run-owner
// marker·승인 before 정합이 없으면 거부다 [PMQA-048-B1F].
assertRunAccess(join("shots", "06b", RUN_ID), process.env);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /readonly-.*\.spec\.ts/,
  timeout: 30_000,
  workers: 1,
  retries: 0,
  outputDir: "shots/06b/" + RUN_ID + "/pw-output",
  // baseURL·webServer url은 readonly-guard.ts의 RO_ORIGIN과 반드시 같은 값 —
  // guard가 이 origin 외 모든 요청을 기본 거부한다 [PMQA-048-B0 검수].
  use: { baseURL: "http://localhost:3102" },
  webServer: {
    command: "node tests/e2e/readonly-server.ts",
    url: "http://localhost:3102/health",
    env: {
      ...process.env,
      PORT: "3102",
      DATABASE_URL: "postgres://commerce:commerce@localhost:5432/commerce_test",
      TEST_USER_CODES: "e2e-a=u-a,e2e-b=u-b,e2e-c=u-c,e2e-d=u-d",
      // 명시적 stub — live provider 기동·외부 LLM 전송 없음.
      LLM_PROVIDER: "stub",
      CI: "1",
    },
    reuseExistingServer: false,   // dev/기존 서버 위에서 돌지 않는다
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
