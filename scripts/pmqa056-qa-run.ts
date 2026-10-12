// PMQA-056 — 이번 보완 배치의 단위/tsc/build 실행을 새 UUID run dir의 wx
// claim된 로그로만 기록하는 검증 runner. pmqa054-evidence-run.ts와 동일
// 계약: 고정 allowlist 커맨드만, 임의 인자·generic wrapper·shell 없음.
// 매 실행 호출마다 새 UUID 디렉터리를 원자 예약해 기존 로그를 절대
// 덮어쓰지 않는다 [PM — 로그 재사용/덮어쓰기 금지 지시].
//
// 안전 계약(pmqa054 계승):
//   - 커맨드 목록·로그 파일명 고정. argv[2]는 테이블 키 선택 필터뿐 —
//     임의 실행 인자를 추가할 수 없다.
//   - npm.cmd 미사용, shell:true 금지 — argv[0]은 process.execPath.
//   - child env는 childEnv() 사본 — 부모 env 전역 미수정.
//   - stdout/stderr는 claim된 파일 Writable에만 파이프 — 임의 경로 open·
//     파일 redirection 없음. drain+finish 확인 후 다음 커맨드로 진행.
//   - 커맨드 무한 대기는 bounded kill로 끝낸다 — 조용한 PASS 없음.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  reserveEvidenceRun,
  type EvidenceWriter,
} from "../tests/helpers/capture-output.ts";
import { childEnv } from "./pmqa054-evidence-run.ts";

// PM 지시 순서 — 관련 unit → 전체 unit → typecheck → build.
const COMMANDS = {
  "unit-focused": [
    "--test",
    "tests/unit/evidence-broker.test.ts",
    "tests/unit/readonly-guard.test.ts",
    "tests/unit/readonly-audit.test.ts",
    "tests/unit/capture-output.test.ts",
    "tests/unit/scratch-db.test.ts",
    "tests/unit/isolated-smoke.test.ts",
    "tests/unit/pmqa056-qa-run.test.ts",
  ],
  unit: ["--test", "tests/unit/*.test.ts"],
  check: ["node_modules/typescript/bin/tsc", "--noEmit"],
  build: ["scripts/build-web.ts"],
} as const;
type CmdName = keyof typeof COMMANDS;
const NAMES = Object.keys(COMMANDS) as CmdName[];

// 사용자 인자 검증 — 순수 함수로 분리해 실행·예약 없이 단위 테스트한다.
// [PM 최종검수 ③ 수정]: 기존 `only in COMMANDS`는 toString/constructor
// 같은 상속 키를 통과시켜 NAMES.filter 결과가 빈 배열이 되고, 빈 run의
// results.every([])=true로 검증 없이 exit 0이 가능했다. argv[3..] 추가
// 인자도 무시됐다. NAMES 멤버십 + 사용자 인자 최대 1개만 허용하고,
// 거부는 reserve/spawn 이전에 확정한다.
export type ArgPlan =
  | { ok: true; run: CmdName[] }
  | { ok: false; reason: string };

export function checkArgs(userArgs: readonly string[]): ArgPlan {
  if (userArgs.length > 1)
    return {
      ok: false,
      reason:
        "추가 인자 불가: " +
        userArgs.slice(1).join(" ") +
        " (허용: 인자 없음 또는 키 1개 — " +
        NAMES.join(", ") +
        ")",
    };
  if (userArgs.length === 0) return { ok: true, run: [...NAMES] };
  const key = userArgs[0];
  if (!NAMES.includes(key as CmdName))
    return {
      ok: false,
      reason:
        "허용 커맨드 아님: " + key + " (가능: " + NAMES.join(", ") + ")",
    };
  return { ok: true, run: [key as CmdName] };
}

const RUN_ROOT = "shots/pmqa056-runs";
const CHILD_TIMEOUT_MS = 15 * 60_000; // hang 무한 대기 금지 — bounded kill

async function runOne(
  name: CmdName,
  writer: EvidenceWriter,
): Promise<{ name: string; status: number | null; error: string | null }> {
  const log = writer.stream(name + ".log");
  let logError: unknown = null;
  const logSettled = new Promise<"finish" | "close" | "error">((res) => {
    log.once("finish", () => res("finish"));
    log.once("close", () => res("close"));
    log.once("error", () => res("error"));
  });
  log.once("error", (e) => {
    logError = e;
  });
  const child = spawn(process.execPath, [...COMMANDS[name]], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv(),
  });
  let error: string | null = null;
  child.once("error", (e) => {
    error = e.message;
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const childClosed = once(child, "close") as Promise<[number | null]>;
  const winner = await Promise.race([
    childClosed.then((c) => ({ kind: "child" as const, code: c[0] })),
    logSettled.then((o) => ({ kind: "log" as const, outcome: o })),
    delay(CHILD_TIMEOUT_MS).then(() => ({ kind: "timeout" as const })),
  ]);
  if (winner.kind !== "child") {
    child.stdout?.unpipe(log);
    child.stderr?.unpipe(log);
    try {
      child.kill();
    } catch {
      // 이미 종료된 child는 무시한다.
    }
    const killWait = await Promise.race([
      childClosed.then(() => "closed" as const),
      delay(5000).then(() => "kill-timeout" as const),
    ]);
    return {
      name,
      status: null,
      error:
        winner.kind === "timeout"
          ? "command timeout (bounded kill, wait=" + killWait + ")"
          : "log stream failed: " +
            String(logError ?? "outcome=" + winner.outcome),
    };
  }
  log.end();
  const out = await logSettled;
  return {
    name,
    status: winner.code,
    error:
      logError !== null || out !== "finish"
        ? "log stream failed: " + String(logError ?? "outcome=" + out)
        : error,
  };
}

async function main(): Promise<number> {
  const plan = checkArgs(process.argv.slice(2));
  if (!plan.ok) {
    console.error("[056-qa] " + plan.reason);
    return 2;
  }
  const run = plan.run;
  const writer = await reserveEvidenceRun(RUN_ROOT, [
    ...run.map((n) => n + ".log"),
    "result.json",
  ]);
  const results: { name: string; status: number | null; error: string | null }[] =
    [];
  try {
    for (const n of run) {
      const r = await runOne(n, writer);
      results.push(r);
      console.log("[056-qa]", n, "exit", r.status, r.error ?? "");
      // 실패를 PASS처럼 넘기지 않는다 — 이후 커맨드는 실행하지 않는다.
      if (r.status !== 0 || r.error) break;
    }
    await writer.writeJson("result.json", {
      runDir: writer.dir,
      approval:
        "승인된 exec 경로 — loopback TCP 단위 테스트 샌드박스 제한 해소 목적의 상승 실행",
      results,
    });
  } finally {
    await writer.close();
  }
  return results.every((r) => r.status === 0 && !r.error) ? 0 : 2;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const code = await main();
  process.exit(code);
}
