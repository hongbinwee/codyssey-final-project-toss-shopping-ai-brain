// PMQA-078 — fixed commerce E2E list on the runner-owned scratch database.
// No globalSetup: schema/fixture preparation belongs to scripts/isolated-suite.ts.
import { defineConfig } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  assertNoPwOverrides,
  assertPwIsolation,
} from "./tests/helpers/evidence-broker.ts";
import {
  assertEntryRunnable,
  assertExecPlan,
} from "./tests/helpers/pw-config-gate.ts";
import { planIsolatedConnect } from "./tests/helpers/isolated-db.ts";
import { evidenceWritten } from "./tests/e2e/readonly-guard.ts";
import {
  E2E_BASELINE_SPECS,
  E2E_ADDITION_SPECS,
} from "./tests/helpers/isolated-suite.ts";

const ENTRY = "playwright.isolated.config.ts";
assertNoPwOverrides({
  env: process.env,
  argv: process.argv,
  allowedConfig: ENTRY,
});
assertEntryRunnable("playwright.isolated.config.ts");

const plan = planIsolatedConnect(process.env);
if (!plan.ok) throw new Error("isolated Playwright 거부: " + plan.reason);
if (
  process.env.DATABASE_URL !== undefined &&
  process.env.DATABASE_URL !== plan.contract.dbUrl
)
  throw new Error("isolated Playwright 거부: DATABASE_URL 불일치");

// workdir 소유 정합 — 부모가 첫 PG connect 전에 예약한 run-pw-<suite runId>
// 디렉터리이고, 부모가 wx로 새긴 run-owner.json의 {runId, nonce, pwWorkdir}가
// env·경로와 정확히 일치해야 한다. basename만 보는 구 계약(contract.runId)
// 대신 부모 nonce 바인딩이다 [readonly-guard run-owner 패턴 재사용].
const workDir = process.env.ISO_PW_WORKDIR;
const isoRunId = process.env.ISO_PW_RUN_ID;
const isoNonce = process.env.ISO_PW_NONCE;
if (
  !workDir ||
  !isoRunId ||
  !isoNonce ||
  !existsSync(workDir) ||
  basename(resolve(workDir)) !== "run-pw-" + isoRunId
)
  throw new Error("isolated Playwright workdir contract 불일치");
let ownerMarker: {
  runId?: string;
  nonce?: string;
  pwWorkdir?: string;
  evidenceDir?: string;
};
try {
  ownerMarker = JSON.parse(
    readFileSync(join(workDir, "run-owner.json"), "utf8"),
  ) as {
    runId?: string;
    nonce?: string;
    pwWorkdir?: string;
    evidenceDir?: string;
  };
} catch {
  throw new Error("isolated Playwright run-owner marker 부재/손상");
}
if (
  ownerMarker.runId !== isoRunId ||
  ownerMarker.nonce !== isoNonce ||
  ownerMarker.pwWorkdir !== resolve(workDir)
)
  throw new Error("isolated Playwright run-owner 정합 불일치");
// 부모 증거 경로 정합 — marker가 묶인 부모 증거 dir과 env가 정확히 일치해야
// 한다. 부모 result.json이 기록된(종료·실패) run의 env·workdir 재평가는
// runner·worker 어떤 플래그로도 거부한다 [readonly-guard 종료 run 차단].
const isoEvidenceDir = process.env.ISO_EVIDENCE_DIR;
if (
  !isoEvidenceDir ||
  ownerMarker.evidenceDir !== resolve(isoEvidenceDir)
)
  throw new Error("isolated Playwright 부모 증거 정합 불일치");
if (evidenceWritten(join(isoEvidenceDir, "result.json")))
  throw new Error("종료된 부모 suite run — 재평가·재사용 금지");
assertPwIsolation({ workDir, evidenceDirs: ["shots/isolated-suite"] });

const outputDir = join(workDir, "playwright");
// runner 첫 평가는 outputDir 부재(신규)만 허용한다 — 끝나지 않은 동일
// env로 직접 CLI를 재실행해 기존 PW outputDir을 재정리하는 경로를 차단.
// 정확히 검증된 fork worker 재평가(TEST_WORKER_INDEX 숫자)만 존재를
// 허용한다 [readonly-guard assertRunAccess와 같은 소유 판정].
const wi = process.env.TEST_WORKER_INDEX;
const isWorker =
  wi !== undefined &&
  wi.length > 0 &&
  [...wi].every((c) => c >= "0" && c <= "9");
if (!isWorker && existsSync(outputDir))
  throw new Error(
    "isolated Playwright 첫 평가는 신규 outputDir만 허용 — 기존 PW output 재사용·직접 재실행 거부: " +
      outputDir,
  );
assertExecPlan({
  entry: ENTRY,
  argv: ["test", "-c", ENTRY],
  dbNames: [plan.contract.dbName],
  outputDir,
});

export default defineConfig({
  testDir: "./tests/e2e",
  // Fixed list already omits these; explicit deny keeps future list edits visible.
  testIgnore: [
    "**/readonly-*.spec.ts",
    "**/mock-*.spec.ts",
    "**/zz-pmqa040-capture.spec.ts",
  ],
  // 실행 순서는 파일명 정렬·testMatch 배열 순서가 아니라 project
  // dependency로 고정한다. addition(checkout-c·wishlist)은 e2e-c 카트와
  // A24 재고를 소비하므로, 카트·재고 전제를 가진 baseline 9 spec이 전부
  // 끝난 뒤에만 실행되어야 한다 [Luna fixture order 검토 — 한 CLI,
  // 새 PW workdir, fixture 값 불변].
  projects: [
    {
      name: "baseline",
      testMatch: E2E_BASELINE_SPECS.map((name) => "**/" + name),
    },
    {
      name: "addition",
      testMatch: E2E_ADDITION_SPECS.map((name) => "**/" + name),
      dependencies: ["baseline"],
    },
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  outputDir,
  use: {
    baseURL: "http://localhost:3104",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node src/server.ts",
    url: "http://localhost:3104/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      PORT: "3104",
      TEST_USER_CODES: "e2e-a=u-a,e2e-b=u-b,e2e-c=u-c,e2e-d=u-d",
      LLM_PROVIDER: "stub",
      CI: "1",
    },
  },
});
