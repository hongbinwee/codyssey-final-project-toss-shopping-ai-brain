// PMQA-062 — Mock 전용 parent launcher.
// readonly-audit.ts와 같은 부모 broker·claim·loopback 채널을 재사용하되,
// DB 접속 경로가 구조적으로 없다: probe·baseline·snap·backup 검증은
// 모두 mock 모드에 해당하지 않아 제거했고, 상속 DATABASE_URL·PG* env는
// preflight가 시작 전에 거부한다 (실수로 DB env가 새는 경로 차단).
//
// 실행 흐름:
//   0) entry gate + env preflight (인자·DATABASE_URL·PG*·preload·PW override 0)
//   1) run dir 원자 예약(shots/06c/<uuid>) + pw workdir + slot claim + 채널
//   2) static 자산 gate — index.html·web/app.js·styles.css 존재+SHA256 기록
//   3) run-owner.json marker (runId·nonce·pwWorkdir)
//   4) spawn playwright -c playwright.mock.config.ts (pwChildEnv 격리)
//   5) audit-after.json 또는 audit-fail.json — broker close까지 확인
// 실제 취소 POST·환불 전환·주문 변경은 mock 자체가 생성하지 않고, 브라우저
// 쪽 실서버 도달은 spec의 catch-all이 abort로 차단해 network.json에 남긴다.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  claimEvidenceFiles,
  type EvidenceWriter,
} from "../helpers/capture-output.ts";
import {
  EvidenceBroker,
  reservePwWorkdir,
  assertNoPwOverrides,
} from "../helpers/evidence-broker.ts";
import { startBrokerChannel } from "../helpers/ipc-channel.ts";
import { assertReadonlyPreflight } from "../helpers/readonly-broker.ts";
import {
  assertEntryRunnable,
  assertExecPlan,
} from "../helpers/pw-config-gate.ts";
import { pwChildEnv } from "./readonly-audit.ts";

const PW_CLI = join("node_modules", "playwright", "cli.js");
// child 무한 대기 금지 — pmqa056-qa-run.ts와 같은 bounded kill 계약.
const PW_CHILD_TIMEOUT_MS = 15 * 60_000;
export const MOCK_ROOT = join("shots", "06c");
export const MOCK_AUDIT_SLOTS: readonly string[] = Object.freeze([
  "run.log",
  "audit-before.json",
  "run-owner.json",
  "audit-after.json",
  "audit-fail.json",
]);
// worker(spec) 산출물 — captures/ 아래. slot 이름과 spec의 submit 이름은
// 이 목록과 정확히 일치해야 한다(claim은 고정 이름).
export const MOCK_CAPTURE_SLOTS: readonly string[] = Object.freeze([
  "network.json",
  "mock-notes.md",
  "cancel_reason_dark.png",
  "cancel_reason_light.png",
  "cancel_confirm_dark.png",
  "cancel_confirm_light.png",
  "cancel_accepted_dark.png",
  "cancel_accepted_light.png",
  // 실패·복구 상태 — Reference 비교가 아닌 Project Mock UX 기록 [PM preflight].
  "mock_recovery_lost.png",
  "mock_recovery_rejected.png",
]);

// static 게이트 대상 — mock 환경이 fulfill로 서빙하는 실제 입력물.
export const MOCK_STATIC_INPUTS: readonly string[] = Object.freeze([
  "index.html",
  join("web", "app.js"),
  join("src", "web", "styles.css"),
]);

// readonly-broker.routedWriter와 동일 계약의 최소 합성 writer.
function routedWriter(
  fallback: EvidenceWriter,
  routes: { names: ReadonlySet<string>; w: EvidenceWriter }[],
): EvidenceWriter {
  const pick = (n: string) => {
    for (const r of routes) if (r.names.has(n)) return r.w;
    return fallback;
  };
  const writers = [fallback, ...routes.map((r) => r.w)];
  return {
    dir: fallback.dir,
    write: (n, d) => pick(n).write(n, d),
    writeJson: (n, o) => pick(n).writeJson(n, o),
    stream: (n) => pick(n).stream(n),
    seal: (n) => pick(n).seal(n),
    close: async () => {
      const errs: unknown[] = [];
      for (const w of writers)
        try { await w.close(); } catch (e) { errs.push(e); }
      if (errs.length)
        throw new Error(errs.map((e) => String(e)).join(" | "));
    },
  };
}

export type MockPlan = {
  readonly runId: string;
  readonly dir: string;
  readonly broker: EvidenceBroker;
  readonly channel: { port: number; close(): Promise<void> };
  readonly nonce: string;
  readonly workDir: string;
  readonly rootW: EvidenceWriter; // run.log 등 루트 claim handle — spawn 로그 기록용
};

// run dir 원자 예약 → slot claim → broker + loopback 채널.
// planReadonlyRun의 DB-free 변형 — 동일 예약 의미(EEXIST fail-closed).
export async function planMockRun(
  runId: string = randomUUID(),
  root: string = MOCK_ROOT,
  workRoot: string = "pw-output",
): Promise<MockPlan> {
  if (!/^[a-zA-Z0-9-]+$/.test(runId))
    throw new Error("invalid capture run id");
  await mkdir(root, { recursive: true });
  const dir = join(root, runId);
  await mkdir(dir); // exclusive — EEXIST면 이미 점유된 run dir
  if ((await readdir(dir)).length !== 0)
    throw new Error("run dir가 비어있지 않음: " + dir);
  const workDir = await reservePwWorkdir(workRoot, runId);
  const rootW = await claimEvidenceFiles(dir, MOCK_AUDIT_SLOTS);
  const capW = await claimEvidenceFiles(join(dir, "captures"), MOCK_CAPTURE_SLOTS);
  const broker = new EvidenceBroker({
    dir,
    writer: routedWriter(rootW, [
      { names: new Set(MOCK_CAPTURE_SLOTS), w: capW },
    ]),
    slots: [...MOCK_AUDIT_SLOTS, ...MOCK_CAPTURE_SLOTS],
    nonce: randomUUID(),
    required: [],
    oneOf: [["audit-after.json", "audit-fail.json"]],
    // run-owner가 기록됐다 = spawn이 실제 시작됐다 — 그 성공 경로는
    // audit-before + worker 산출물 전체가 없으면 완료가 아니다.
    implies: [
      { when: "run-owner.json", require: ["audit-before.json", ...MOCK_CAPTURE_SLOTS] },
    ],
  });
  const channel = await startBrokerChannel(broker);
  return { runId, dir, broker, channel, nonce: broker.nonce, workDir, rootW };
}

export type MockDeps = {
  mkdirRunDir: (runId: string) => string | Promise<string>;
  runNonce?: (dir: string) => string;
  runWorkdir?: (dir: string) => string;
  put: (dir: string, name: string, obj: unknown) => void | Promise<void>;
  closeEvidence?: (dir: string) => void | Promise<void>;
  readStaticAsset: (file: string) => Buffer;
  spawnPw: (
    runId: string,
    nonce: string,
  ) => Promise<{ status: number | null; error: string | null }> | { status: number | null; error: string | null };
};

export type MockVerdict = { pass: boolean; exit: number; reasons: string[] };

// 최종 판정 — 어떤 실패라도 있으면 PASS 없음(순수 함수).
export function mockVerdict(v: {
  spawnError: string | null;
  pwStatus: number | null;
  steps: { ok: boolean; reason: string }[];
}): MockVerdict {
  const reasons: string[] = [];
  for (const s of v.steps) if (!s.ok) reasons.push(s.reason);
  if (v.spawnError) reasons.push("spawn: " + v.spawnError);
  if (v.pwStatus !== 0) reasons.push("pwStatus " + String(v.pwStatus));
  return { pass: reasons.length === 0, exit: reasons.length ? 1 : 0, reasons };
}

export async function runMockAudit(deps: MockDeps): Promise<MockVerdict> {
  const steps: { ok: boolean; reason: string }[] = [];
  const step = async (reason: string, fn: () => unknown | Promise<unknown>) => {
    try {
      await fn();
      steps.push({ ok: true, reason });
      return true;
    } catch (e) {
      steps.push({ ok: false, reason: reason + ": " + String(e) });
      return false;
    }
  };
  const runId = randomUUID();
  const dir = await deps.mkdirRunDir(runId);
  let spawned = false;
  let spawnError: string | null = null;
  let pwStatus: number | null = null;
  try {
    // static 자산 gate — mock이 서빙할 입력물의 존재·지문을 before에 고정.
    const assets: { file: string; sha256: string }[] = [];
    const gateOk = await step("static assets", () => {
      for (const f of MOCK_STATIC_INPUTS)
        assets.push({
          file: f,
          sha256: createHash("sha256").update(deps.readStaticAsset(f)).digest("hex"),
        });
    });
    await deps.put(dir, "audit-before.json", {
      runId,
      gateOk,
      at: new Date().toISOString(),
      gateDetail: { mode: "mock", pg: false, staticAssets: assets },
    });
    if (!gateOk) {
      const v = mockVerdict({ spawnError, pwStatus, steps });
      await deps.put(dir, "audit-fail.json", { runId, reasons: v.reasons });
      return v;
    }
    const nonce = deps.runNonce?.(dir) ?? randomUUID();
    await deps.put(dir, "run-owner.json", {
      runId,
      nonce,
      pwWorkdir: deps.runWorkdir?.(dir) ?? null,
      at: new Date().toISOString(),
    });
    spawned = true;
    const r = await deps.spawnPw(runId, nonce);
    pwStatus = r.status;
    spawnError = r.error;
    const v = mockVerdict({ spawnError, pwStatus, steps });
    await deps.put(dir, v.pass ? "audit-after.json" : "audit-fail.json", {
      runId,
      pwStatus,
      pwError: spawnError,
      verdict: v,
    });
    return v;
  } catch (e) {
    const v = {
      pass: false,
      exit: 1,
      reasons: [String(e)],
    };
    try {
      await deps.put(dir, "audit-fail.json", { runId, reasons: [String(e), "spawned=" + spawned] });
    } catch {
      /* 기록 자체 실패도 증거 — 최선 보존 후 원본 오류를 반환한다 */
    }
    return v;
  } finally {
    await deps.closeEvidence?.(dir);
  }
}

// ── 실제 실행 deps ────────────────────────────────────────────────
function realDeps() {
  let plan: MockPlan | null = null;
  return {
    mkdirRunDir: async (runId: string) => {
      plan = await planMockRun(runId);
      return plan.dir;
    },
    runNonce: (dir: string) => {
      if (!plan || plan.dir !== dir)
        throw new Error("plan 없는 dir — runNonce 거부");
      return plan.nonce;
    },
    runWorkdir: (dir: string) => {
      if (!plan || plan.dir !== dir)
        throw new Error("plan 없는 dir — runWorkdir 거부");
      return plan.workDir;
    },
    put: async (dir: string, name: string, obj: unknown) => {
      if (!plan || plan.dir !== dir)
        throw new Error("plan 없는 dir — put 거부");
      await plan.broker.submit({
        nonce: plan.nonce,
        slot: name,
        data: JSON.stringify(obj, null, 2),
      });
    },
    closeEvidence: async (dir: string) => {
      if (!plan || plan.dir !== dir) return;
      await plan.channel.close();
      await plan.broker.close();
    },
    readStaticAsset: (file: string) => readFileSync(file),
    spawnPw: async (runId: string, nonce: string) => {
      if (!plan) throw new Error("plan 없이 spawnPw — 순서 위반");
      const p = plan;
      assertExecPlan({
        entry: "playwright.mock.config.ts",
        argv: ["test", "-c", "playwright.mock.config.ts"],
        outputDir: join(p.workDir, "playwright"),
      });
      // child stdout/stderr → 사전 claim된 run.log 보호 handle로 기록한다
      // (stdio:"inherit"은 보호 경로 로그가 없고, shell 리다이렉션은 금지다)
      // [PM preflight ①]. 파이프 오류는 spawn 실패로 FAIL에 반영한다.
      // pmqa056-qa-run.ts의 logSettled/finish 패턴을 그대로 쓴다 — child
      // 중단·출력 drain 지연·log.end 오류에도 settle되는 bounded 경로다
      // [PM preflight ②].
      const log = p.rootW.stream("run.log");
      let logError: unknown = null;
      const logSettled = new Promise<"finish" | "close" | "error">((res) => {
        log.once("finish", () => res("finish"));
        log.once("close", () => res("close"));
        log.once("error", () => res("error"));
      });
      log.once("error", (e) => { logError = e; });
      const child = spawn(
        process.execPath,
        [PW_CLI, "test", "-c", "playwright.mock.config.ts"],
        {
          env: pwChildEnv(runId, nonce, p.channel.port, p.workDir),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let childError: string | null = null;
      child.once("error", (e) => { childError = e.message; });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      // 'exit'이 아니라 'close' — stdio 파이프가 닫힌 뒤에만 로그 flush가
      // 완료된다(exit에서 먼저 기록하면 tail이 유실된다).
      const childClosed = once(child, "close") as Promise<[number | null]>;
      const winner = await Promise.race([
        childClosed.then((c) => ({ kind: "child" as const, code: c[0] })),
        logSettled.then((o) => ({ kind: "log" as const, outcome: o })),
        // ref:false — 패배한 timeout 타이머가 event loop를 잡아 정상
        // 종료를 막지 않게 한다(qa-run은 process.exit이지만 여기는
        // exitCode만 설정한다) [PM preflight].
        delay(PW_CHILD_TIMEOUT_MS, undefined, { ref: false }).then(() => ({
          kind: "timeout" as const,
        })),
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
          delay(5000, undefined, { ref: false }).then(
            () => "kill-timeout" as const,
          ),
        ]);
        return {
          status: null,
          error:
            winner.kind === "timeout"
              ? "pw run timeout (bounded kill, wait=" + killWait + ")"
              : "run.log stream failed: " +
                String(logError ?? "outcome=" + winner.outcome),
        };
      }
      log.end();
      const out = await logSettled;
      return {
        status: winner.code,
        error:
          logError !== null || out !== "finish"
            ? "run.log stream failed: " + String(logError ?? "outcome=" + out)
            : childError,
      };
    },
  };
}

async function main(): Promise<void> {
  assertEntryRunnable("tests/e2e/mock-audit.ts");
  // env preflight — 인자·DATABASE_URL·PG*·Node preload·PW override 전부 거부.
  // allowedDbUrls:[] = 상속된 어떤 DATABASE_URL도 이 경로에서는 거부다.
  assertReadonlyPreflight({
    env: process.env,
    argv: process.argv.slice(2),
    allowedDbUrls: [],
  });
  assertNoPwOverrides({ env: process.env, argv: [] });
  const verdict = await runMockAudit(realDeps());
  for (const r of verdict.reasons) console.error("[mock-audit]", r);
  console.log(
    verdict.pass ? "[mock-audit] mock run 완료" : "[mock-audit] FAIL",
  );
  if (!verdict.pass) process.exitCode = verdict.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
