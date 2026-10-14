// PMQA-062 — Mock 전용 Playwright 설정. 실제 서버·DB 없음.
// webServer 없음 — 가상 origin(http://mock.local) 위에서 context.route
// catch-all이 정적 자산을 로컬 bytes로 fulfill하고 API를 mock/abort한다.
// globalSetup 없음(reseed/cleanup 0), testMatch는 mock-*.spec.ts만,
// workers 1, retries 0. RO_* env 없는 직접 실행은 시작부터 거부한다.
import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { assertRunAccess } from "./tests/e2e/readonly-guard.ts";
import { assertEntryRunnable } from "./tests/helpers/pw-config-gate.ts";
import { assertNoPwOverrides } from "./tests/helpers/evidence-broker.ts";

// 상속 output/reporter override 차단 → entry gate. 부모 runner 형태
// "-c playwright.mock.config.ts"만 허용한다 [readonly 계약 재사용].
assertNoPwOverrides({
  env: process.env,
  argv: process.argv,
  allowedConfig: "playwright.mock.config.ts",
});
assertEntryRunnable("playwright.mock.config.ts");

const RUN_ID = process.env.RO_RUN_ID ?? "";
if (!/^[0-9a-f-]{36}$/.test(RUN_ID))
  throw new Error(
    "playwright.mock.config: RO_RUN_ID 필수 — mock-audit.ts 런처로만 실행한다",
  );
// PW output은 evidence 영역 밖의 부모 예약 run-pw-<runId> workdir다.
const PW_WORKDIR = process.env.RO_PW_WORKDIR ?? "";
if (!PW_WORKDIR)
  throw new Error(
    "playwright.mock.config: RO_PW_WORKDIR 필수 — 부모 예약 workdir 없음",
  );
// runner 첫 평가는 예약 run + pw-output 부재를, worker 재평가는 소유 정합을
// 요구한다 — 공통 run-access 계약 그대로 재사용 [PMQA-062].
assertRunAccess(join("shots", "06c", RUN_ID), process.env);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /mock-.*\.spec\.ts/,
  timeout: 30_000,
  workers: 1,
  retries: 0,
  // 최초 실패 즉시 중단 — 실패 후 worker 재기동이 같은 run의 afterAll
  // submit을 재실행해 slot 중복 거부→연쇄 실패를 만들므로 막는다 [PM].
  maxFailures: 1,
  // 실제 outputDir은 부모 예약 envelope의 고정 하위 child — cleanup은 child만
  // 삭제하고 envelope root(run-pw-*)는 부모 예약 그대로 생존한다 [PMQA-057-1].
  outputDir: join(PW_WORKDIR, "playwright"),
  // localhost 가상 origin — listen하는 서버는 없지만 secure context가 유지돼
  // 원앱의 crypto.randomUUID 계약이 살아있다. 요청은 mock-cancel.spec.ts의
  // catch-all route에서 로컬 fulfill/abort로만 종결된다 [PM preflight].
  use: { baseURL: "http://localhost:3199" },
});
