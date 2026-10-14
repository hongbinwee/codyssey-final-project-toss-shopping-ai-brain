// PMQA-055 — 엔트리 disposition 및 설정 평가 단계 사전 거부.
// 이번 지원이 미완인 입구(capture.config 늦은 예약·standard.config
// globalSetup reset·verify 연쇄 등)는 실행 전 여기서 거부된다.
// 기존 DB guard는 삭제·약화하지 않는다.
import { basename, dirname, resolve } from "node:path";

export type EntryDisposition =
  | "protected" // 이번 라운드 broker/claim 보호 적용
  | "not-ready" // 보호 설계만 존재 — 실행 금지
  | "blocked"; // 미지원/알 수 없음 — default-deny

export const ENTRY_TABLE: Readonly<
  Record<string, { disposition: EntryDisposition; note: string }>
> = Object.freeze({
  "tests/e2e/readonly-orders.spec.ts": {
    disposition: "protected",
    note: "PMQA-056 — parent channel worker (경로·handle 비소유)",
  },
  "tests/e2e/readonly-audit.ts": {
    disposition: "protected",
    note: "PMQA-056 — parent broker launcher (전체 slot claim+채널)",
  },
  "tests/e2e/zz-pmqa040-capture.spec.ts": {
    disposition: "not-ready",
    note: "spec 내 자체 claim — parent broker 통합 전 실행 금지",
  },
  "scripts/pmqa054-evidence-run.ts": {
    disposition: "protected",
    note: "claim runner",
  },
  "scripts/eval.ts": {
    disposition: "protected",
    note: "claim+close 소비자",
  },
  "scripts/isolated-smoke.ts": {
    disposition: "not-ready",
    note: "standalone 실행 미지원 — broker 통합 전 실행 금지",
  },
  "playwright.config.ts": {
    disposition: "not-ready",
    note: "globalSetup reseed·DB 경로 — 설정 평가에서 사전 거부",
  },
  "playwright.capture.config.ts": {
    disposition: "not-ready",
    note: "spec 내 늦은 예약(캡처 전용) — 설정 평가에서 사전 거부",
  },
  "playwright.readonly.config.ts": {
    disposition: "protected",
    note: "PMQA-056 — 부모 runner spawn 대상 (env·marker 정합 요구)",
  },
  "tests/e2e/mock-audit.ts": {
    disposition: "protected",
    note: "PMQA-062 — mock parent launcher (DB 0, claim+channel 재사용)",
  },
  "tests/e2e/mock-cancel.spec.ts": {
    disposition: "protected",
    note: "PMQA-062 — mock worker (가상 origin catch-all, 부모 submit)",
  },
  "playwright.mock.config.ts": {
    disposition: "protected",
    note: "PMQA-062 — mock runner spawn 대상 (env·marker 정합 요구)",
  },
  "playwright.isolated.config.ts": {
    disposition: "protected",
    note: "PMQA-078 — fixed E2E suite, owned scratch contract only",
  },
  "scripts/isolated-suite.ts": {
    disposition: "protected",
    note: "PMQA-078 — owned scratch runner, fixed E2E + integration lists",
  },
  "scripts/verify.ts": {
    disposition: "not-ready",
    note: "연쇄 동작 미보호 — 사전 거부",
  },
  "scripts/shoot-themes.mjs": {
    disposition: "not-ready",
    note: "고정명 갱신 도구 — 보호 전환 필요, 전환 전 실행 금지",
  },
  "tmp_*": {
    disposition: "not-ready",
    note: "legacy 산출물 보존, 재설계 없음",
  },
});

export function entryDisposition(name: string): EntryDisposition {
  const e = ENTRY_TABLE[name];
  if (e) return e.disposition;
  return "blocked"; // default-deny — 알 수 없는 엔트리는 거부
}

// 설정 평가 단계에서 미지원 입구를 실행 전에 거부한다.
export function assertEntryRunnable(name: string): void {
  const d = entryDisposition(name);
  if (d !== "protected") throw new Error("entry " + d + ": " + name);
}

// PMQA-056 ③ — 부모 spawn/exec 계획의 strict 사전 검증.
// 허용된 entry·정확한 argv 형태·DB 대상·소유 run dir 안 output만 통과하고,
// unknown/bare arg·duplicate·conflict·보호 밖 output은 connect/spawn 전에
// 거부한다. "-c"는 이 부모 경로에서만 허용된다 (config eval은 자체 argv
// allowlist로 별도 통제한다).
const EXEC_DB_ALLOW: ReadonlySet<string> = new Set([
  "commerce_test",
  "commerce",
]);

export function assertExecPlan(opts: {
  entry: string;
  argv: readonly string[];
  dbNames?: readonly string[];
  outputDir?: string;
}): void {
  assertEntryRunnable(opts.entry); // protected만 통과
  // argv — 허용 형태는 정확히 ["test","-c",entry]. 결합/중복/미지 인자·
  // bare arg·다른 -c 대상은 전부 거부다.
  const a = opts.argv;
  if (
    a.length !== 3 ||
    a[0] !== "test" ||
    a[1] !== "-c" ||
    a[2] !== opts.entry
  )
    throw new Error(
      "exec argv 허용 형태 외: " + JSON.stringify(a),
    );
  for (const d of opts.dbNames ?? [])
    if (
      !EXEC_DB_ALLOW.has(d) &&
      !(
        opts.entry === "playwright.isolated.config.ts" &&
        /^scratch_[0-9a-f]{16}$/.test(d)
      )
    )
      throw new Error("exec 대상 DB 허용 외: " + d);
  if (opts.outputDir !== undefined) {
    // PMQA-057-1 — 실제 outputDir은 부모 예약 envelope의 고정 하위
    // "playwright" child다: pw-output/run-pw-*/playwright 형태만 허용.
    // runner의 outputDir cleanup은 child만 삭제하고 envelope root는
    // 생존한다. envelope 자체(구형 계약)·evidence 영역(shots)·임의
    // 경로·child 내부 중첩은 거부다.
    const out = resolve(opts.outputDir).toLowerCase();
    const parent = dirname(out);
    if (
      basename(out) !== "playwright" ||
      !basename(parent).startsWith("run-pw-") ||
      dirname(parent) !== resolve("pw-output").toLowerCase()
    )
      throw new Error(
        "exec output이 승인된 envelope 하위 output이 아님: " + opts.outputDir,
      );
  }
}

