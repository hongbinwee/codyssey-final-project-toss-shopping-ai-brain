// PMQA-078 — fixed commerce regression path on one execution-owned scratch DB.
// Source preparation only: this runner is not executed without separate approval.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import postgres from "postgres";
import { databaseUrlWithPasswordFile } from "../src/db-url.ts";
import {
  ARTIFACT_FILES,
  PINS,
  APPROVED_AUDIT_RUN_ID,
  parseApprovedAudit,
  planSmokeEnv,
  type Connect,
} from "./isolated-smoke.ts";
import {
  createOwnedScratchDb as defaultCreateOwnedScratchDb,
  scratchDbUrl,
  type ScratchDb,
  type ScratchEvent,
} from "../tests/helpers/scratch-db.ts";
import {
  contractFromScratch,
  buildIsolatedChildEnv,
  type IsolatedContract,
} from "../tests/helpers/isolated-db.ts";
import { prepareIsolatedDb as defaultPrepareIsolatedDb } from "../tests/helpers/isolated-prepare.ts";
import {
  reserveBrokerRun as defaultReserveBrokerRun,
  reservePwWorkdir as defaultReservePwWorkdir,
  assertPwIsolation as defaultAssertPwIsolation,
  type EvidenceBroker,
} from "../tests/helpers/evidence-broker.ts";
import {
  assertEntryRunnable,
  assertExecPlan as defaultAssertExecPlan,
} from "../tests/helpers/pw-config-gate.ts";
import {
  diffSnaps,
  parseRoDbUrl,
  RO_DEV_DB,
  RO_DEV_DB_OID,
  RO_DB,
  RO_DB_OID,
  snapDb,
  type DbSnap,
} from "../tests/e2e/readonly-db.ts";
import {
  E2E_SOURCE_INVENTORY,
  E2E_SPECS,
  E2E_BASELINE_SPECS,
  E2E_ADDITION_SPECS,
  EXCLUDED_INTEGRATION,
  INTEGRATION_SPECS,
} from "../tests/helpers/isolated-suite.ts";

export const ISOLATED_SUITE_ROOT = "shots/isolated-suite";
export const SUITE_SLOTS = Object.freeze([
  "manifest.json",
  "suite-plan.json",
  "source-before.json",
  "source-after.json",
  "gate-pins.json",
  "child-logs.json",
  "protected-before.json",
  "protected-after.json",
  "evidence-before.json",
  "evidence-after.json",
  "scratch-planned.json",
  "scratch-created.json",
  "scratch-identified.json",
  "e2e.json",
  "integration.json",
  "cleanup.json",
  "result.json",
]);

// 검수 범위 동결 — 원래 ARTIFACT_FILES 12개만으로는 078+004/API/web-src 전체를
// 주장할 수 없다. scope 루트 아래 모든 파일을 실행 전/후 sha256로 비교한다.
export const SUITE_SOURCE_DIRS = Object.freeze([
  "db",
  "scripts",
  "src",
  "tests",
]);
// 디렉터리 밖 고정 파일 + gitignored 파생 번들. web/app.js는 서버 시작 시
// 동일 번들이 재생성되는 부작용이 있으므로 pre/post SHA로 별도 관측한다 —
// codeDrift에는 넣지 않고 bundleDrift로만 기록한다.
export const SUITE_SOURCE_FILES = Object.freeze([
  "package.json",
  "tsconfig.json",
  "playwright.config.ts",
  "playwright.isolated.config.ts",
  "playwright.mock.config.ts",
  "web/app.js",
]);
export const SUITE_BUNDLE_PATH = "web/app.js";

// 기존 증거 트리 — 실행 전/후 전체 지문. 이번 run의 산출물(dir은 배타
// 예약됨)만 제외하고 보호 증거의 추가·수정·삭제를 전부 관측한다.
export const SUITE_EVIDENCE_DIRS = Object.freeze(["shots", "reference"]);

export function planSuiteEnv(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): {
  ok: true;
  adminUrl: string;
  protectedAdminUrl: string;
  target: "pg17" | "pg18";
} | { ok: false; reason: string } {
  if (argv.length) return { ok: false, reason: "launcher 인자 허용 외" };
  const smoke = planSmokeEnv(env);
  if (!smoke.ok) return { ok: false, reason: smoke.reasons.join(" | ") };
  if (env.SCRATCH_DB_TESTS !== "1" || env.ISOLATED_STRICT !== "1")
    return { ok: false, reason: "SCRATCH_DB_TESTS/ISOLATED_STRICT opt-in 필요" };
  if (Object.keys(env).some((k) => /^PG(HOST|PORT|DATABASE|USER|PASSWORD|SSLMODE)$/i.test(k) && env[k]))
    return { ok: false, reason: "상속 PG 접속 env 차단" };
  if (Object.keys(env).some((k) => /^(playwright_|output_name|pwio_)/i.test(k)))
    return { ok: false, reason: "상속 Playwright output/runner env 차단" };
  if (env.NODE_OPTIONS || env.NODE_PATH)
    return { ok: false, reason: "Node preload/module env 차단" };
  return {
    ok: true,
    adminUrl: smoke.adminUrl,
    protectedAdminUrl: smoke.protectedAdminUrl,
    target: smoke.target,
  };
}

type ChildResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: boolean;
  // close(프로세스 종료 + stdio 해제)까지 관측됐는가 — 'exit'만으로는
  // 파이프 잔류 좀비를 구분할 수 없어 다음 suite/owned DROP 전에 확인한다.
  closed: boolean;
  // 부모 소유 로그 스트림의 error/flush 실패 — sticky 실패로만 보고하고
  // 조용한 성공으로 넘기지 않는다(logs 없으면 항상 false).
  logError: boolean;
};

export type ChildLogs = { stdout: Writable; stderr: Writable };
export type SpawnNode = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  logs?: ChildLogs,
) => Promise<ChildResult>;
export type OpenLog = (dir: string, name: string) => Promise<Writable>;

// 부모 소유 exclusive 로그 — wx는 이미 존재하면 실패하므로 선점 경합이 없다.
// dir 자체는 reserveBrokerRun이 배타 예약한다.
const defaultOpenLog: OpenLog = async (dir, name) => {
  const fh = await open(join(dir, name), "wx");
  return fh.createWriteStream();
};

// 부모 소유 run-owner marker — wx로만 새긴다. child(config)는 이 파일의
// {runId, nonce, pwWorkdir}가 env·경로와 정확히 일치할 때만 workdir를
// 이번 실행 소유로 인정한다 [readonly-guard run-owner 패턴 재사용].
export type OwnerMarker = {
  runId: string;
  nonce: string;
  pwWorkdir: string;
  // 부모 증거 디렉터리 — child는 여기 result.json이 기록됐는지 봐서
  // '끝난 run'의 env·workdir 재평가를 거부한다 [readonly-guard 종료 run].
  evidenceDir: string;
};
export type WriteOwnerMarker = (
  dir: string,
  marker: OwnerMarker,
) => Promise<void>;
const defaultWriteOwnerMarker: WriteOwnerMarker = async (dir, marker) => {
  const fh = await open(join(dir, "run-owner.json"), "wx");
  try {
    await fh.writeFile(JSON.stringify(marker), "utf8");
  } finally {
    await fh.close();
  }
};

// spawn 주입 — 단위 테스트는 fake EventEmitter child로 실패 경로를 주입한다.
export async function runNode(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  logs?: ChildLogs,
  spawnImpl: typeof spawn = spawn,
): Promise<ChildResult> {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 로그 관측은 spawn 전에 등록한다 — close 이후 등록하면 이미 닫힌
  // 스트림을 기다리는 영구 대기가 된다. error는 별도 sticky로 잡아
  // finish/close '성공'과 섞이지 않게 한다 [pmqa056 runOne 패턴].
  const observeLog = (w: Writable) => {
    const state = {
      error: null as unknown,
      settled: new Promise<"finish" | "close" | "error">((res) => {
        w.once("finish", () => res("finish"));
        w.once("close", () => res("close"));
        w.once("error", () => res("error"));
      }),
    };
    w.once("error", (e) => {
      state.error = e;
    });
    return state;
  };
  const stdoutLog = logs ? observeLog(logs.stdout) : null;
  const stderrLog = logs ? observeLog(logs.stderr) : null;

  let child: ChildProcess;
  try {
    child = spawnImpl(process.execPath, args, {
      env,
      // logs가 있으면 부모 소유 스트림으로 진단 출력을 보존한다 —
      // stdio:"ignore" 단독은 자식이 실제로 무엇을 실행했는지 증거가 없다.
      stdio: logs ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
    });
  } catch {
    return {
      code: null,
      signal: null,
      timedOut: false,
      spawnError: true,
      closed: false,
      logError: false,
    };
  }
  let spawnErr: unknown = null;
  child.once("error", (e) => {
    spawnErr = e;
  });
  if (logs) {
    // end:false — 스트림 마감은 부모가 직접 제어해 flush를 증명한다.
    child.stdout?.pipe(logs.stdout, { end: false });
    child.stderr?.pipe(logs.stderr, { end: false });
  }
  // once(child,'close')는 'error' emit 시 reject한다 — catch로 FAIL 경로를
  // 만들지 않으면 unhandled rejection + 외부 대기 무한정지가 된다.
  const childClosed = once(child, "close").then(
    (c) => ({
      kind: "child" as const,
      code: c[0] as number | null,
      signal: c[1] as NodeJS.Signals | null,
    }),
    () => ({ kind: "spawnErr" as const }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<{ kind: "timeout" }>((res) => {
    timer = setTimeout(() => res({ kind: "timeout" }), timeoutMs);
  });
  const logEarly = stdoutLog
    ? Promise.race([stdoutLog.settled, stderrLog!.settled]).then((outcome) => ({
        kind: "log" as const,
        outcome,
      }))
    : null;
  try {
    const winner = await Promise.race(
      logEarly ? [childClosed, logEarly, timeoutP] : [childClosed, timeoutP],
    );
    if (winner.kind !== "child") {
      if (logs) {
        child.stdout?.unpipe(logs.stdout);
        child.stderr?.unpipe(logs.stderr);
      }
      try {
        child.kill();
      } catch {
        /* 이미 종료된 child는 무시한다 */
      }
      // kill 후에도 close가 안 오는 경로는 bounded — closed:false로
      // 다음 suite·owned DROP을 차단한다.
      const closed = await Promise.race([
        childClosed.then(() => true, () => false),
        delay(5000).then(() => false),
      ]);
      return {
        code: null,
        signal: null,
        timedOut: winner.kind === "timeout",
        spawnError: winner.kind === "spawnErr" || spawnErr !== null,
        closed,
        logError: winner.kind === "log",
      };
    }
    let logError = false;
    if (logs) {
      logs.stdout.end();
      logs.stderr.end();
      // flush도 bounded — 스트림이 붙으면 '영구 대기'가 아니라 실패다.
      const outcomes = (await Promise.race([
        Promise.all([stdoutLog!.settled, stderrLog!.settled]),
        delay(5000).then(() => null),
      ])) as ["finish" | "close" | "error", "finish" | "close" | "error"] | null;
      logError =
        outcomes === null ||
        stdoutLog!.error !== null ||
        stderrLog!.error !== null ||
        outcomes[0] !== "finish" ||
        outcomes[1] !== "finish";
    }
    return {
      code: winner.code,
      signal: winner.signal,
      timedOut: false,
      spawnError: spawnErr !== null,
      closed: true,
      logError,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── readonly 보호 DB 지문 — readonly-db.ts의 기존 검증을 재사용한다 ──
type RoQuery = {
  unsafe: <T = Record<string, unknown>[]>(
    q: string,
    p?: unknown[],
  ) => Promise<T>;
};
export type RoClient = {
  unsafe: RoQuery["unsafe"];
  begin: <T>(fn: (q: RoQuery) => Promise<T>) => Promise<T>;
  end?: () => Promise<unknown>;
};
export type SuiteConnect = (url: string, o?: { max?: number }) => RoClient;

// ── source scope sha — freeze 주장의 근거이므로 missing도 기록한다 ──
export type SourceShaMap = Record<string, string | null>;

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function walkSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(p);
      } else if (e.isFile() && !e.name.startsWith(".")) {
        out.push(p);
      }
    }
  };
  for (const d of SUITE_SOURCE_DIRS) {
    try {
      if (statSync(d).isDirectory()) walk(d);
    } catch {
      /* 루트 부재 — SOURCE_FILES에서 개별 missing 기록 */
    }
  }
  out.sort();
  return out;
}

export function collectSourceSha(): SourceShaMap {
  const map: SourceShaMap = {};
  for (const p of walkSourceFiles())
    try {
      map[p] = sha256Hex(readFileSync(p));
    } catch {
      map[p] = null; // 읽기 실패 — 조용히 넘기지 않고 missing 기록
    }
  for (const p of SUITE_SOURCE_FILES) {
    try {
      map[p] = sha256Hex(readFileSync(p));
    } catch {
      map[p] = null;
    }
  }
  return map;
}

export function diffSourceSha(
  before: SourceShaMap,
  after: SourceShaMap,
): { codeDrift: string[]; bundleDrift: string[] } {
  const codeDrift: string[] = [];
  const bundleDrift: string[] = [];
  const push = (p: string, why: string) =>
    (p === SUITE_BUNDLE_PATH ? bundleDrift : codeDrift).push(p + " " + why);
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[p];
    const b = after[p];
    if (a === b) continue;
    if (a === undefined) push(p, "추가됨");
    else if (b === undefined) push(p, "삭제됨");
    else push(p, "sha 변경 " + (a ?? "missing") + " → " + (b ?? "missing"));
  }
  return { codeDrift, bundleDrift };
}

// ── 증거 트리 지문 — 실행 전/후 비교 대상은 기존 증거뿐이다 ──
function collectEvidenceSha(excludePrefix: string): SourceShaMap {
  const map: SourceShaMap = {};
  const ex = excludePrefix.replace(/\\/g, "/");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (p.replace(/\\/g, "/").startsWith(ex)) continue;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(p);
      } else if (e.isFile() && !e.name.startsWith(".")) {
        try {
          map[p] = sha256Hex(readFileSync(p));
        } catch {
          map[p] = null;
        }
      }
    }
  };
  for (const d of SUITE_EVIDENCE_DIRS) {
    try {
      if (statSync(d).isDirectory()) walk(d);
    } catch {
      /* 루트 부재 — 비교 대상 없음 */
    }
  }
  return map;
}

function diffEvidenceSha(
  before: SourceShaMap,
  after: SourceShaMap,
): string[] {
  const drift: string[] = [];
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[p];
    const b = after[p];
    if (a === b) continue;
    if (a === undefined) drift.push(p + " 추가됨");
    else if (b === undefined) drift.push(p + " 삭제됨");
    else drift.push(p + " 변경 " + (a ?? "missing") + " → " + (b ?? "missing"));
  }
  return drift;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export type SuiteDeps = {
  // readonly 보호 DB 지문용 연결 — 단위 테스트는 mock을 주입한다.
  connect?: SuiteConnect;
  reserveBrokerRun?: typeof defaultReserveBrokerRun;
  createOwnedScratchDb?: typeof defaultCreateOwnedScratchDb;
  prepareIsolatedDb?: typeof defaultPrepareIsolatedDb;
  reservePwWorkdir?: typeof defaultReservePwWorkdir;
  assertPwIsolation?: typeof defaultAssertPwIsolation;
  assertExecPlan?: typeof defaultAssertExecPlan;
  spawnNode?: SpawnNode;
  openLog?: OpenLog;
  writeOwnerMarker?: WriteOwnerMarker;
  // DB-free unit만 고정 evidence snapshot을 주입한다. 기본 CLI는 항상
  // private 실제 collector를 사용한다 — 환경/CLI 플래그 우회 경로는 없다.
  evidenceSnapshot?: (excludePrefix: string) => SourceShaMap;
};

// 기본 pin gate — smoke의 gate-pins와 같은 검증을 재사용한다.
const defaultCheckPins = async () => {
  let auditJson: unknown;
  for (const p of PINS) {
    const buf = readFileSync(p.path);
    if (sha256Hex(buf) !== p.sha256)
      throw new Error("pin sha256 불일치: " + p.key);
    if (p.key === "audit048") auditJson = JSON.parse(buf.toString("utf8"));
  }
  const audit = parseApprovedAudit(auditJson);
  if (!audit.ok)
    throw new Error("048 audit 승인 구조 거부: " + audit.reasons.join(" | "));
  return { after: audit.after, afterDev: audit.afterDev };
};

export async function runIsolatedSuite(deps: SuiteDeps = {}): Promise<{
  ok: boolean;
  stage: string;
  scratchState: string;
  evidenceDir?: string;
}> {
  const connect: SuiteConnect =
    deps.connect ?? ((url, o) => postgres(url, o) as unknown as RoClient);
  // 핀 게이트는 항상 고정 구현만 실행한다 — checkPins를 주입 가능하게 두면
  // 호출자가 임의 baseline을 만들어 fixed PINS 검증 자체를 우회할 수
  // 있다 [③ 백업 gate 우회 차단 — 런타임 경로는 private gate만 통과].
  const checkPins = defaultCheckPins;
  const reserveBrokerRun = deps.reserveBrokerRun ?? defaultReserveBrokerRun;
  const createOwnedScratchDb =
    deps.createOwnedScratchDb ?? defaultCreateOwnedScratchDb;
  const prepareIsolatedDb = deps.prepareIsolatedDb ?? defaultPrepareIsolatedDb;
  const reservePwWorkdir = deps.reservePwWorkdir ?? defaultReservePwWorkdir;
  const assertPwIsolation = deps.assertPwIsolation ?? defaultAssertPwIsolation;
  const assertExecPlan = deps.assertExecPlan ?? defaultAssertExecPlan;
  const spawnNode = deps.spawnNode ?? runNode;
  const openLog = deps.openLog ?? defaultOpenLog;
  const writeOwnerMarker = deps.writeOwnerMarker ?? defaultWriteOwnerMarker;
  const evidenceSnapshot = deps.evidenceSnapshot ?? collectEvidenceSha;

  const initial = planSuiteEnv(process.env, process.argv.slice(2));
  if (!initial.ok) return { ok: false, stage: "preflight", scratchState: "not-created" };

  const adminUrl = initial.adminUrl;
  const protectedAdminUrl = initial.protectedAdminUrl;
  const target = initial.target;
  const recheck = () => {
    const source = planSuiteEnv(process.env, []);
    if (
      !source.ok || source.adminUrl !== adminUrl ||
      source.protectedAdminUrl !== protectedAdminUrl || source.target !== target
    )
      throw new Error("isolated suite env 변경 — 중단");
  };

  const runId = randomUUID();
  let broker: EvidenceBroker | undefined;
  let handle: ScratchDb | undefined;
  let contract: IsolatedContract | undefined;
  let stage = "evidence-reserve";
  let scratchState = "not-created";
  let e2e: ChildResult | undefined;
  let integration: ChildResult | undefined;
  let cleanup = "not-attempted";
  let ok = false;
  let evidenceDir: string | undefined;

  const submit = async (slot: string, value: unknown) => {
    if (!broker) throw new Error("evidence broker 없음");
    await broker.submit({ nonce: broker.nonce, slot, data: json(value) });
  };

  // 보호 DB readonly 지문 — smoke의 roSnap과 같은 검증(identity·writer·
  // unreadable)과 같은 readonly 연결 계약을 재사용한다.
  const roSnap = async (db: string, wantOid: number): Promise<DbSnap> => {
    const url = parseRoDbUrl(scratchDbUrl(protectedAdminUrl, db), db);
    const c = connect(url, { max: 1 });
    try {
      return await c.begin(async (q) => {
        await q.unsafe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const s = await snapDb(q);
        if (s.db !== db || s.oid !== wantOid)
          throw new Error("보호 DB identity 불일치: " + s.db + "#" + s.oid);
        if (s.writersError !== null || s.writers.length)
          throw new Error("보호 DB write 세션 탐지/실패 — STOP");
        if (s.unreadableActive.length)
          throw new Error("보호 DB query 열람 불가 세션 — STOP");
        return s;
      });
    } finally {
      await c.end?.();
    }
  };

  const e2eArgv = ["test", "-c", "playwright.isolated.config.ts"] as const;
  let pwWorkdir: string | undefined;
  let outputDir: string | undefined;
  let protectedBefore: { test: DbSnap; dev: DbSnap } | undefined;
  let sourceBefore: SourceShaMap | undefined;
  let protectedDrift: string[] | undefined;
  let codeDrift: string[] | undefined;
  let bundleDrift: string[] | undefined;
  let evidenceDrift: string[] | undefined;
  let logWriteError: string | null = null;

  // 부모 소유 로그 스트림 감시 — error는 sticky로만 기록한다.
  type WatchedLog = { stream: Writable };
  const watchLog = (stream: Writable): WatchedLog => {
    stream.once("error", (e) => {
      logWriteError = logWriteError ?? String(e);
    });
    return { stream };
  };
  let childLogs:
    | {
        e2eOut: WatchedLog;
        e2eErr: WatchedLog;
        intOut: WatchedLog;
        intErr: WatchedLog;
      }
    | undefined;
  // 로그 스트림 마감 게이트 — finish 이후에도 실제 close가 없거나 close 중
  // 오류가 나면 owned DROP·다음 suite를 진행하지 않는다. 이미 닫힌
  // 스트림은 재대기하지 않고, 미종료는 bounded 대기 뒤 실패다 [④-1].
  const closeLogs = async (): Promise<{ ok: boolean; failures: string[] }> => {
    const failures: string[] = [];
    if (!childLogs) return { ok: true, failures };
    await Promise.all(
      Object.entries(childLogs).map(async ([name, w]) => {
        try {
          if (w.stream.closed) {
            if (w.stream.errored) failures.push(name + " error");
            return; // 이미 닫힘 — 재대기 금지
          }
          if (!w.stream.destroyed && !w.stream.writableFinished)
            w.stream.end();
          const closed = await Promise.race([
            once(w.stream, "close").then(() => true, () => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
          ]);
          if (!closed || w.stream.errored)
            failures.push(
              name + (w.stream.errored ? " error" : " close-timeout"),
            );
        } catch {
          failures.push(name + " close-throw");
        }
      }),
    );
    return { ok: failures.length === 0, failures };
  };

  try {
    // Planned files are exclusively claimed before any database connection.
    broker = await reserveBrokerRun(ISOLATED_SUITE_ROOT, SUITE_SLOTS, runId, {
      required: ["manifest.json", "suite-plan.json", "result.json"],
    });
    evidenceDir = broker.dir;
    await submit("manifest.json", {
      kind: "pmqa078-isolated-suite",
      runId,
      scope: "fixed E2E + fixed integration; execution requires separate approval",
    });
    await submit("suite-plan.json", {
      e2eSpecs: E2E_SPECS,
      // 실행 순서는 testMatch 배열 순서가 아니라 Playwright project
      // dependency로 고정한다 — addition(checkout-c·wishlist)은 e2e-c
      // 카트·A24 재고를 소비하므로 baseline 9 spec 완료 후에만 실행된다.
      e2eSchedule: {
        baseline: E2E_BASELINE_SPECS,
        additionDependsOnBaseline: E2E_ADDITION_SPECS,
      },
      sourceInventoryOnly: E2E_SOURCE_INVENTORY,
      integrationSpecs: INTEGRATION_SPECS,
      excludedIntegration: EXCLUDED_INTEGRATION,
      countsAreCollectedOrExecutedCounts: false,
      legacyCapturePassCredit: false,
    });

    // source scope 지문 — 어떤 PG 접속보다 먼저 freeze 기준을 기록한다.
    stage = "source-before";
    sourceBefore = collectSourceSha();
    await submit("source-before.json", { files: sourceBefore });

    // pin gate — 승인 pin sha·048 audit 구조를 먼저 검증한다. 부합하지
    // 않으면 어떤 DB 접속도 열지 않는다 [smoke gate-pins 재사용].
    stage = "gate-pins";
    const audit = await checkPins();
    await submit("gate-pins.json", { ok: true, auditRunId: APPROVED_AUDIT_RUN_ID });

    // 자식 로그 4개를 wx로 배타 예약한다 — 어떤 PG 작업보다 먼저. 기존 파일과
    // 충돌하면 DB 작업 0건으로 실패한다 [②].
    stage = "child-logs-reserve";
    childLogs = {
      e2eOut: await watchLog(await openLog(broker.dir, "e2e.stdout.log")),
      e2eErr: await watchLog(await openLog(broker.dir, "e2e.stderr.log")),
      intOut: await watchLog(await openLog(broker.dir, "integration.stdout.log")),
      intErr: await watchLog(await openLog(broker.dir, "integration.stderr.log")),
    };
    await submit("child-logs.json", {
      names: ["e2e.stdout.log", "e2e.stderr.log", "integration.stdout.log", "integration.stderr.log"],
    });

    // PW workdir은 parent runId로 첫 PG connect 전에 예약한다 — 경로·파일
    // 충돌 시 connect 0·spawn 0 [①]. DB contract.runId는 아직 모르고,
    // caller env를 믿지도 않는다 — 연결은 아래 run-owner marker 정합이다.
    stage = "pw-workdir-reserve";
    pwWorkdir = await reservePwWorkdir("pw-output", runId);
    assertPwIsolation({
      workDir: pwWorkdir,
      evidenceDirs: [ISOLATED_SUITE_ROOT],
    });
    outputDir = join(pwWorkdir, "playwright");
    // 보유 manifest — parent가 배타 예약된 workdir 안에 wx로 새긴다.
    // {runId, nonce, pwWorkdir} 정합이 child의 소유 증거다 [readonly
    // parent-ownership 패턴 재사용].
    const pwNonce = randomUUID();
    await writeOwnerMarker(pwWorkdir, {
      runId,
      nonce: pwNonce,
      pwWorkdir: resolve(pwWorkdir),
      evidenceDir: resolve(broker.dir),
    });
    // exec 계획의 정적 부분 — workdir/DB명과 무관한 형태는 PG 전에 검증한다.
    assertExecPlan({ entry: "playwright.isolated.config.ts", argv: e2eArgv });

    // 보호 DB 지문 before — owned CREATE 전에 기준을 잡고, 승인 048
    // baseline과 exact match일 때만 진행한다 [smoke snap-protected-before].
    stage = "protected-before";
    recheck();
    protectedBefore = {
      test: await roSnap(RO_DB, RO_DB_OID),
      dev: await roSnap(RO_DEV_DB, RO_DEV_DB_OID),
    };
    const baselineDrift = [
      ...diffSnaps(protectedBefore.test, audit.after),
      ...diffSnaps(protectedBefore.dev, audit.afterDev),
    ];
    await submit("protected-before.json", {
      ...protectedBefore,
      baselineDrift,
    });
    if (baselineDrift.length)
      throw new Error(
        "live 보호 DB가 승인 048 after와 다름 — CREATE 거부: " +
          baselineDrift.join(" | "),
      );

    stage = "scratch-create";
    recheck();
    handle = await createOwnedScratchDb(adminUrl, {
      target,
      guard: recheck,
      events: async (event: ScratchEvent) => {
        // exec 계획의 동적 부분 — 실제 scratch dbName·outputDir 바인딩은
        // CREATE 계획 시점에만 검증 가능하다 [②]. workdir 예약 자체는
        // 첫 PG connect 전 pw-workdir-reserve 단계에서 이미 끝났다.
        if (event.stage === "planned")
          assertExecPlan({
            entry: "playwright.isolated.config.ts",
            argv: e2eArgv,
            dbNames: [event.dbName],
            outputDir,
          });
        const slot =
          event.stage === "planned"
            ? "scratch-planned.json"
            : event.stage === "created"
              ? "scratch-created.json"
              : "scratch-identified.json";
        await submit(
          slot,
          event.stage === "planned"
            ? { ...event, pwWorkdir, outputDir }
            : event,
        );
      },
    });
    contract = contractFromScratch(handle);
    scratchState = "owned";

    stage = "prepare-phase6";
    recheck();
    const sourceEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH ?? process.env.Path,
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      windir: process.env.windir ?? process.env.WINDIR,
      ComSpec: process.env.ComSpec ?? process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      SCRATCH_DB_TESTS: "1",
      ISOLATED_STRICT: "1",
      DATABASE_URL: contract.dbUrl,
      ISOLATED_DB_URL: contract.dbUrl,
      ISOLATED_DB_NAME: contract.dbName,
      ISOLATED_DB_OID: String(contract.dbOid),
      ISOLATED_DB_OWNER: String(contract.dbOwner),
      ISOLATED_RUN_ID: contract.runId,
      TEST_USER_CODES: "e2e-a=u-a,e2e-b=u-b,e2e-c=u-c,e2e-d=u-d",
      LLM_PROVIDER: "stub",
      CI: "1",
    };
    await prepareIsolatedDb(sourceEnv, {}, { phase: 6 });

    const child = buildIsolatedChildEnv(sourceEnv);
    if (!child.ok) throw new Error("isolated child env 거부: " + child.reason);
    const childEnv = {
      ...child.env,
      ISO_PW_WORKDIR: pwWorkdir,
      ISO_PW_RUN_ID: runId,
      ISO_PW_NONCE: pwNonce,
      ISO_EVIDENCE_DIR: resolve(broker.dir),
    } as NodeJS.ProcessEnv;

    // 실행 직전 전체 증거 매니페스트 — 기존 증거 트리를 실행 전 기준으로 잡는다.
    stage = "evidence-before";
    const evidenceBefore = evidenceSnapshot(broker.dir);
    await submit("evidence-before.json", {
      files: evidenceBefore,
      count: Object.keys(evidenceBefore).length,
    });

    stage = "e2e";
    recheck();
    e2e = await spawnNode(
      ["node_modules/playwright/cli.js", ...e2eArgv],
      childEnv,
      20 * 60_000,
      // 로그 핸들은 prePG 예약분만 사용한다 — 실행 중 새 open 경로는 없다.
      { stdout: childLogs.e2eOut.stream, stderr: childLogs.e2eErr.stream },
    );
    await submit("e2e.json", e2e);
    // 자식 완전 종료(stdio 해제·로그 flush) 확인 없이 다음 suite로 진행하지 않는다.
    if (!e2e.closed || e2e.logError)
      throw new Error("isolated E2E child 미종료/로그 실패 — 다음 단계 중단");
    if (e2e.code !== 0 || e2e.signal !== null || e2e.timedOut || e2e.spawnError)
      throw new Error("isolated E2E suite 실패");

    stage = "integration";
    recheck();
    integration = await spawnNode(
      ["--test", "--test-concurrency=1", ...INTEGRATION_SPECS.map((f) => "tests/integration/" + f)],
      childEnv,
      20 * 60_000,
      { stdout: childLogs.intOut.stream, stderr: childLogs.intErr.stream },
    );
    await submit("integration.json", integration);
    if (!integration.closed || integration.logError)
      throw new Error("isolated integration child 미종료/로그 실패 — cleanup 중단");
    if (
      integration.code !== 0 ||
      integration.signal !== null ||
      integration.timedOut ||
      integration.spawnError
    )
      throw new Error("isolated integration suite 실패");

    // 보호 DB 지문 after — suite 실행이 보호 DB를 건드리지 않았음을 증명한다.
    stage = "protected-after";
    recheck();
    const protectedAfter = {
      test: await roSnap(RO_DB, RO_DB_OID),
      dev: await roSnap(RO_DEV_DB, RO_DEV_DB_OID),
    };
    protectedDrift = [
      ...diffSnaps(protectedBefore.test, protectedAfter.test),
      ...diffSnaps(protectedBefore.dev, protectedAfter.dev),
    ];
    await submit("protected-after.json", {
      ...protectedAfter,
      drift: protectedDrift,
    });
    if (protectedDrift.length)
      throw new Error(
        "보호 DB drift — suite 실행 영향 의심: " + protectedDrift.join(" | "),
      );

    // source scope 지문 after — 파생 번들(web/app.js)은 서버 시작 시 동일
    // 번들을 재생성하는 부작용이 있으므로 codeDrift와 분리해 관측한다.
    stage = "source-after";
    const sourceAfter = collectSourceSha();
    ({ codeDrift, bundleDrift } = diffSourceSha(sourceBefore, sourceAfter));
    await submit("source-after.json", {
      files: sourceAfter,
      codeDrift,
      bundleDrift,
    });
    if (codeDrift.length)
      throw new Error(
        "실행 중 source drift — freeze 위반: " + codeDrift.join(" | "),
      );

    // 기존 증거 트리 검증 — 보호 증거의 추가·수정·삭제가 있으면 실패다.
    stage = "evidence-after";
    recheck();
    const evidenceAfter = evidenceSnapshot(broker.dir);
    evidenceDrift = diffEvidenceSha(evidenceBefore, evidenceAfter);
    await submit("evidence-after.json", {
      files: evidenceAfter,
      count: Object.keys(evidenceAfter).length,
      drift: evidenceDrift,
    });
    if (evidenceDrift.length)
      throw new Error(
        "기존 증거 drift — 실행 중 보호 증거 변경: " + evidenceDrift.join(" | "),
      );

    stage = "cleanup";
    recheck();
    // owned DROP 전에 두 자식이 모두 완전 종료됐는지 마지막으로 확인한다.
    if (!e2e?.closed || e2e.logError || !integration?.closed || integration.logError)
      throw new Error("child 잔존/로그 실패 — owned DROP 중단");
    // 부모 소유 로그 스트림의 write 실패는 sticky — 조용한 성공 없음.
    if (logWriteError !== null)
      throw new Error("child log stream write 실패 — " + logWriteError);
    // 로그 finish 후 실제 close까지 게이트한다 — 미마감 스트림이 남아 있으면
    // owned DROP·완료 선언을 하지 않는다 [④-1].
    const logClose = await closeLogs();
    if (!logClose.ok)
      throw new Error(
        "child log close 실패 — " + logClose.failures.join(" | "),
      );
    // cleanup.json은 DROP 완료 선언이 아니라 의도의 pre-commit 기록이다 —
    // 이 submit이 실패하면 DROP 자체를 실행하지 않는다 [④-2].
    await submit("cleanup.json", { intent: "owned-drop-requested" });
    await handle.cleanup();
    handle = undefined;
    scratchState = "dropped";
    cleanup = "owned-drop-complete";
    ok = true;
    stage = "done";
  } catch {
    // External DB/test errors are intentionally not serialized; keep the stage
    // and owned DB state for diagnosis without exposing credentials.
    if (handle && scratchState === "owned") scratchState = "retained-owned";
    if (stage === "cleanup") cleanup = "outcome-unknown";
  } finally {
    try {
      const postClose = await closeLogs();
      if (!postClose.ok) {
        // 정상 경로의 cleanup 게이트를 우회한 실패(e2e 실패 등)라도 로그
        // 미마감은 결과를 실패로 돌린다 — 조용한 성공 없음.
        logWriteError =
          logWriteError ??
          "log close 실패: " + postClose.failures.join(" | ");
        ok = false;
      }
    } catch {
      logWriteError = logWriteError ?? "log close 예외";
      ok = false;
    }
    if (broker) {
      try {
        await submit("result.json", {
          ok,
          stage,
          scratchState,
          e2e: e2e ?? null,
          integration: integration ?? null,
          cleanup,
          protectedDrift: protectedDrift ?? null,
          codeDrift: codeDrift ?? null,
          bundleDrift: bundleDrift ?? null,
          evidenceDrift: evidenceDrift ?? null,
          logWriteError,
          sourceInventory: E2E_SOURCE_INVENTORY,
          evidenceDir,
        });
      } catch {
        ok = false;
      }
      try {
        await broker.close();
      } catch {
        ok = false;
      }
    }
  }
  return { ok, stage, scratchState, evidenceDir };
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  assertEntryRunnable("scripts/isolated-suite.ts");
  try {
    if (!process.env.SCRATCH_ADMIN_URL)
      throw new Error("SCRATCH_ADMIN_URL is required");
    process.env.SCRATCH_ADMIN_URL = databaseUrlWithPasswordFile(
      process.env.SCRATCH_ADMIN_URL,
      ".secrets/pg-password",
    );
    if (process.env.SCRATCH_PROTECTED_ADMIN_URL)
      process.env.SCRATCH_PROTECTED_ADMIN_URL = databaseUrlWithPasswordFile(
        process.env.SCRATCH_PROTECTED_ADMIN_URL,
        ".secrets/pg-password",
      );
  } catch {
    console.error("isolated suite stopped: local database credential unavailable");
    process.exitCode = 2;
    throw new Error("isolated suite credential setup failed");
  }
  const result = await runIsolatedSuite();
  console.log(
    (result.ok ? "PASS " : "NOT_PASS ") +
      result.stage +
      " scratch=" + result.scratchState +
      (result.evidenceDir ? " evidence=" + result.evidenceDir : ""),
  );
  process.exitCode = result.ok ? 0 : 1;
}
