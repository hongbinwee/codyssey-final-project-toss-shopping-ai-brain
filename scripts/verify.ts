// Phase N까지 누적 검증. 모든 단계를 node로 직접 호출해 shell 의존을 제거한다.
import { spawnSync } from "node:child_process";
import { assertEntryRunnable } from "../tests/helpers/pw-config-gate.ts";

// PMQA-055: 연쇄 동작(누적 test:e2e 등)은 미보호 — 실행 전 거부한다.
assertEntryRunnable("scripts/verify.ts");

const STEPS: Record<number, string[][]> = {
  0: [
    ["node", "node_modules/typescript/bin/tsc", "--noEmit"],
    ["node", "scripts/build-web.ts"],
    ["node", "--test", "tests/unit/*.test.ts"],
    ["node", "--test", "--test-concurrency=1", "--test-force-exit", "tests/integration/*.test.ts"],
    ["node", "node_modules/playwright/cli.js", "test"],
  ],
  1: [
    ["node", "scripts/eval.ts", "--mode=stub", "--split=dev"],
  ],
  // Phase 5: holdout 케이스를 초기화된 상태에서 3회씩 반복 실행한다.
  5: [
    ["node", "scripts/eval.ts", "--mode=stub", "--split=holdout", "--repeat=3"],
  ],
};

const phase = Number(
  process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "0",
);

for (let p = 0; p <= phase; p++) {
  for (const cmd of STEPS[p] ?? []) {
    console.log("$ " + cmd.join(" "));
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("verify failed: " + cmd.join(" "));
      process.exit(r.status ?? 1);
    }
  }
}
console.log("verify phase " + phase + " passed");
