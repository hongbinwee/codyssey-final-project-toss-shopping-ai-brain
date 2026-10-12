// PMQA-054 고정 allowlist 커맨드만 실행하고 stdout/stderr를 claim된 로그
// 파일로만 기록하는 검증 runner. 임의 커맨드 인자·generic wrapper는 없다.
//
// 안전 계약:
//   - 커맨드 목록과 로그 파일명은 고정 (인자로 어떤 실행도 추가 불가).
//   - npm.cmd 미사용(Windows EINVAL 이력), shell:true 금지 — argv[0]은
//     항상 process.execPath.
//   - child env는 부모 process.env의 "사본"에서 Node 실행 제어 변수를
//     제거한 것 — 부모 env 전역은 수정하지 않는다 (NODE_OPTIONS 등으로
//     --require/--import 주입되면 고정 allowlist 계약이 무력화된다)
//     [Luna QA].
//   - 로그는 claim된 파일의 Writable에만 파이프된다 — 임의 경로 open·
//     파일 redirection은 없다.
//   - drain 완료와 stream finish를 확인한 뒤에만 다음 커맨드로 진행한다 —
//     로그 스트림 실패 시 이후 커맨드는 실행하지 않고 실패로 기록한다.
//   - result.json은 command 측정 기록이다 — 최종 verdict는 이 프로세스의
//     exit code뿐이다 (측정과 성공 판정 분리) [Luna/PM].
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  reserveEvidenceRun,
  type EvidenceWriter,
} from "../tests/helpers/capture-output.ts";

export type SpawnFn = (
  file: string,
  args: readonly string[],
  opts: { stdio: ["ignore", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => ChildProcess;

// child에서 제거하는 Node 실행 제어 env — 목록은 보수적으로 유지한다.
export const DENIED_CHILD_ENV: readonly string[] = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_INSPECT_RESUME_ON_START",
]);

// 부모 env를 수정하지 않고 사본에서만 제거한다 [Luna QA: env 전역 수정 0].
// Windows env는 case-insensitive — Node_Options 같은 혼합 key도 제거한다.
export function childEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  const denied = new Set(DENIED_CHILD_ENV);
  for (const k of Object.keys(env)) {
    if (denied.has(k.toUpperCase())) delete env[k];
  }
  return env;
}

// 고정 커맨드 — 이름·args 전부 freeze, 외부 주입 경로가 없다.
// check: tsc --noEmit / build: scripts/build-web.ts / unit: node --test.
export const FIXED_COMMANDS: readonly {
  name: string;
  args: readonly string[];
}[] = Object.freeze([
  Object.freeze({
    name: "check",
    args: Object.freeze(["node_modules/typescript/bin/tsc", "--noEmit"]),
  }),
  Object.freeze({
    name: "build",
    args: Object.freeze(["scripts/build-web.ts"]),
  }),
  Object.freeze({
    name: "unit",
    args: Object.freeze(["--test", "tests/unit/*.test.ts"]),
  }),
]);

export type CmdResult = {
  name: string;
  status: number | null;
  error: string | null;
};

// 로그 실패가 child 종료보다 먼저 오면 즉시 unpipe+kill한다 — 로그 오류로
// pipe가 끊긴 child는 stdout backpressure로 영구 대기할 수 있다. kill 후의
// close 대기도 bounded다 [PM/Luna].
const CHILD_KILL_WAIT_MS = 5000;

// 각 커맨드의 stdout·stderr를 claim된 로그로 파이프한다. 로그 스트림의
// error/premature close/finish를 pipe 전부터 추적하고, drain 완료와 finish를
// 확인한 뒤에만 다음 커맨드로 진행한다. 로그 실패 시 이후 커맨드는 실행하지
// 않는다(성공한 척 기록하지 않는다) [Luna QA].
export async function runLoggedCommands(
  writer: EvidenceWriter,
  spawnImpl: SpawnFn = spawn as SpawnFn,
): Promise<CmdResult[]> {
  const results: CmdResult[] = [];
  for (const cmd of FIXED_COMMANDS) {
    const log = writer.stream(cmd.name + ".log");
    // 파이프 전부터 추적 — finish만 나중에 once로 기다리면 error·premature
    // close에서 영구 hang하거나 조용히 성공할 수 있다.
    let logError: unknown = null;
    const logSettled = new Promise<"finish" | "close" | "error">(
      (resolve) => {
        log.once("finish", () => resolve("finish"));
        log.once("close", () => resolve("close"));
        log.once("error", () => resolve("error"));
      },
    );
    log.once("error", (e) => {
      logError = e;
    });
    const child = spawnImpl(process.execPath, cmd.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(),
    });
    // error listener는 spawn 직후 동기 부착 — 'close' 대기 전에 error가
    // 오면 unhandled로 프로세스가 죽는다.
    let error: string | null = null;
    child.once("error", (e) => {
      error = e.message;
    });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    const childClosed = once(child, "close") as Promise<[number | null]>;
    // 로그가 child 종료 전에 settle되는 것은 항상 비정상이다 — finish는
    // child close 후 log.end()로만 온다. 어느 쪽이든 먼저 오면 대응한다.
    const winner = await Promise.race([
      childClosed.then((c) => ({ kind: "child" as const, code: c[0] })),
      logSettled.then((o) => ({ kind: "log" as const, outcome: o })),
    ]);
    if (winner.kind === "log") {
      // 로그 실패 선점 — 즉시 unpipe+kill하고 bounded로 close를 기다린다.
      child.stdout?.unpipe(log);
      child.stderr?.unpipe(log);
      try {
        child.kill();
      } catch {
        // 이미 종료된 child는 무시한다.
      }
      const killWait = await Promise.race([
        childClosed.then(() => "closed" as const),
        delay(CHILD_KILL_WAIT_MS).then(() => "timeout" as const),
      ]);
      results.push({
        name: cmd.name,
        status: null,
        error:
          "log stream failed: " +
          String(logError ?? "outcome=" + winner.outcome) +
          (killWait === "timeout" ? " (child kill timeout)" : ""),
      });
      // 로그 실패를 PASS처럼 넘기지 않는다 — 이후 커맨드는 spawn 0.
      break;
    }
    const code = winner.code;
    // drain 완료 — pipe된 데이터가 모두 기록될 때까지 기다린다.
    log.end();
    const logSettledOutcome = await logSettled;
    if (logError !== null || logSettledOutcome !== "finish") {
      results.push({
        name: cmd.name,
        status: code,
        error:
          error ??
          "log stream failed: " +
            String(logError ?? "outcome=" + logSettledOutcome),
      });
      // 로그 실패를 PASS처럼 넘기지 않는다 — 이후 커맨드는 spawn 0.
      break;
    }
    results.push({ name: cmd.name, status: code, error });
  }
  return results;
}

export const RUN_SLOTS: readonly string[] = Object.freeze([
  "check.log",
  "build.log",
  "unit.log",
  "result.json",
  "README.md",
]);

// 예약→claim→고정 커맨드→기록→해제. reserve가 실패하면 어떤 spawn도 없다 —
// 기존 run/evidence와의 충돌은 spawn 시작 전 거부다. 해제는 성공·실패·중간
// 오류 모든 경로에서 일어나고, 해제 오류는 호출자에게 그대로 전파된다.
export async function run054(
  deps: {
    reserve?: (
      root: string,
      names: readonly string[],
    ) => Promise<EvidenceWriter>;
    spawnImpl?: SpawnFn;
  } = {},
): Promise<{ code: number; dir: string; results: CmdResult[] }> {
  const reserve =
    deps.reserve ??
    ((root: string, names: readonly string[]) =>
      reserveEvidenceRun(root, names));
  const writer = await reserve("shots/pmqa054-runs", RUN_SLOTS);
  try {
    const results = await runLoggedCommands(writer, deps.spawnImpl);
    const code = results.every((r) => r.status === 0 && r.error === null)
      ? 0
      : 1;
    await writer.writeJson("result.json", {
      kind: "pmqa054-evidence-run",
      // 측정 기록만 — 최종 성공 판정(pass 필드)은 파일에 두지 않는다.
      results,
      at: new Date().toISOString(),
    });
    await writer.write(
      "README.md",
      [
        "# PMQA-054 evidence run",
        "",
        "고정 allowlist(check/build/unit)만 실행하고 stdout·stderr를 claim",
        "된 .log로만 기록한 검증 run이다. 커맨드 인자·shell·redirection 없음.",
        "result.json은 command 측정 기록이고 최종 verdict는 exit code뿐이다.",
        "",
      ].join("\n"),
    );
    return { code, dir: writer.dir, results };
  } finally {
    await writer.close();
  }
}

// ── 사고 기록 run — 매 호출 새 UUID dir에 wx로만 생성 ───────────────────
// incident.md는 pmqa054-runs 루트의 고정 파일이 아니라 독립 run 안의 claim된
// 산출물이다(덮어쓰기 불가) [PM 지시].
export const INCIDENT_SLOTS: readonly string[] = Object.freeze([
  "incident.md",
  "original-readme-transcript.txt",
]);

const INCIDENT_MD = [
  "# PMQA-054 사고 기록 및 쓰기 경로 보호 계약",
  "",
  "## 사고 요약",
  "- 대상 run: pmqa052c run-78dbbc2f",
  "- 훼손: unit-2files.log·unit-full.log 덮어쓰기 + README.md 삭제 후 재작성 (PNG 3개 아님)",
  "- 원본 회수 근거: Git tracking 0, .gitignore:9 shots/, git log --all 경로 이력 0, stash 0, repo 사본 현재 3개뿐",
  "- README.md: 읽기 native 출력 transcript만 확보 → original-readme-transcript.txt (transcript-only 후보 — 원본 SHA 없어 byte 완전 원본 주장 불가)",
  "- 두 로그: 원본 bytes 미확보, 출력 횟수 74/283 부분 기록만",
  "- OS 외부 백업 전수 조회는 아님",
  "- 동결 해시(사고 후 상태, 변형 금지): unit-2files.log D62A5F…, unit-full.log 50B83C…, README.md 91E316…",
  "",
  "## 적용 범위",
  "- claim 계층: tests/helpers/capture-output.ts — wx 사전 생성·1회 write·stream·집계 close (async + sync)",
  "- 소비자: scripts/eval.ts, scripts/isolated-smoke.ts, scripts/pmqa054-evidence-run.ts, tests/e2e/readonly-audit.ts, tests/e2e/readonly-orders.spec.ts, tests/e2e/zz-pmqa040-capture.spec.ts",
  "",
  "## NOT-READY (해결한 척하지 않음)",
  "- shoot-themes.mjs 등 고정 파일명 갱신 도구 — claim 계약 미적용",
  "- tmp_* 경로 legacy 산출물 — 보호 없음, 정리 대상",
  "- 부모 DB/Playwright 실행 전 PNG 16 slot 보호 — Luna 설계 결론: parent sole-writer + 로컬 IPC + spawnSync→async 전환이 필요. worker가 fd/path를 재open해 쓰는 방식은 금지 — parent만 자신의 handle로 write. 단순 054 보정 범위를 넘으므로 MAJOR NOT_READY 유지",
  "- RO worker 16 slot cross-process claim — 위와 동일. worker가 parent audit/서버 시작 후 독립 claim하는 경로는 모든 소비자 0을 보장 불가 → NOT_READY",
  "",
  "## 알려진 한계",
  "- Node fs.open은 Windows share mode 제어 불가 — 다른 프로세스의 재open/삭제까지 OS 수준 차단 불가 (계약 보장: O_EXCL 생성·단일 handle 기록·지원 경로 외 재open 거부)",
  "- seal(chmod 0444)은 보조 장치 — claim 후 inode 외부 교체 시 다른 파일 chmod 가능",
  "- claimFor는 프로세스 내 동시성만 차단 — cross-process 쓰기 경합은 위 NOT-READY로 한정",
  "- result.json은 command 측정 기록 — 최종 verdict는 run054 반환 code/exit code뿐",
  "",
].join("\n");

// 사고 README 원본 transcript — PM 제공 텍스트를 가독성 정정·줄바꿈 재해석
// 없이 verbatim 보관한다. 원본 SHA 미확보이므로 byte 완전 원본이 아닌
// transcript-only 후보다.
const TRANSCRIPT = "# PMQA-052-C — DB-free 회귀 재현 및 보정 검증 기록'`n''`n'## 회귀 재현 (구현 전 — 미수정 코드)'`n'node --test tests/unit/isolated-smoke.test.ts tests/unit/scratch-db.test.ts → 21건 신규 테스트 전부 FAIL 확인:'`n'- helper flag 소실 경계 6건 (created/identified/marker CREATE/cleanup identity/marker/end) — mutation 직전 재검증 부재로 CREATE TABLE/INSERT/DROP 실행됨'`n'- helper guard hook 3건 — deps.guard 부재로 즉시 거부되지 않음'`n'- runner ''created''/''identified'' 이벤트 await flag 소실 2건 — stage recheck만 있어 marker write 실행됨'`n'- prepare txn 내부 경계 5건 (verify/advisory lock/migration INSERT/seed/최후 SQL) — stage는 나중(fault-1→prepare-2 등)에 잡히나 주입 직후 실SQL이 계속 실행됨'`n'- fault-2 probe 직전 1건 — probe INSERT가 guard 없이 dispatch됨'`n'- relBase 1건 — extra/missing/kind 불일치를 통과시킴'`n'- evidence 3건 — precleanup/afterDROP이 {pass:true}만 기록하고 실측 스냅·drift 배열 부재'`n''`n'## 보정 후 검증 (exit 확인)'`n'- node --test tests/unit/isolated-smoke.test.ts tests/unit/scratch-db.test.ts → pass 74 / fail 0 (unit-2files.log)'`n'- npm run check (tsc --noEmit) → exit 0'`n'- npm run build → exit 0'`n'- npm run test:unit → pass 283 / fail 0 (unit-full.log — 259 + 신규 24)'`n'- git diff --check → exit 0 (LF→CRLF warning만)'`n''`n'## 변경 4파일 SHA256'`n'- 9A3A6D63B6ABE2F5…  scripts/isolated-smoke.ts (untracked — 052 신규 파일, 커밋 이력 없음)'`n'- A490E416EBA7BCDF…  tests/helpers/scratch-db.ts (tracked — 052 미커밋 + 052-C 누적 diff)'`n'- 559CF80451F9AB23…  tests/unit/isolated-smoke.test.ts (untracked — 052 신규)'`n'- 01A416D5D9C9F25B…  tests/unit/scratch-db.test.ts (tracked — 052 미커밋 + 052-C 누적 diff)'`n''`n'## 미검증 한계'`n'- 실PG/실DB/HTTP/Docker/Integration/E2E/eval 전부 NOT_RUN — mock 계약 증거이며 실DB 롤백 보증 아님'`n'- txn 콜백 반환 후 드라이버가 실행하는 실제 COMMIT 자체는 JS 계약상 guard 불가 (post-callback sync까지가 한계)'`n'";

export async function writeIncidentRun(
  deps: {
    reserve?: (
      root: string,
      names: readonly string[],
    ) => Promise<EvidenceWriter>;
  } = {},
): Promise<{ dir: string }> {
  const reserve =
    deps.reserve ??
    ((root: string, names: readonly string[]) =>
      reserveEvidenceRun(root, names));
  const writer = await reserve("shots/pmqa054-runs", INCIDENT_SLOTS);
  try {
    await writer.write("incident.md", INCIDENT_MD);
    await writer.write("original-readme-transcript.txt", TRANSCRIPT);
    return { dir: writer.dir };
  } finally {
    await writer.close();
  }
}

async function main(): Promise<number> {
  try {
    const r = await run054();
    await writeIncidentRun();
    return r.code;
  } catch (e) {
    console.error(e);
    return 2;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const code = await main();
  process.exit(code);
}

