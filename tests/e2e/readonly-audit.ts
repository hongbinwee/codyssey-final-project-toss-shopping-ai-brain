// 06B 읽기 검증 런처 — PMQA-048-B0. 이 파일은 실행 시에만 의미가 있다
// (B0에서는 작성만 하고 실행하지 않는다).
//
// 실행 흐름(B1) [PM/Luna 중간검수 반영]:
//   0) run dir 원자 예약 — shots/06b/ 부모만 recursive, UUID child는
//      recursive:false mkdir(EEXIST면 즉시 중단, 기존 bytes 불변).
//   1) FILE GATE — DB 0 쿼리 단계: 043 dump SHA + 047 승인 facts 고정 경로의
//      SHA256 pin + parseApprovedFacts 구조 검증. 실패 시 파일 오류 evidence만
//      남기고 DB 접속 없이 중단한다(백업 불일치⇒probe 0/child 0).
//   2) 두 readonly 연결 probe — commerce_test(서버 대상)·commerce(dev 감시).
//   3) demo_verify 부재 SELECT 확인 — 존재하면 gate 실패로 child 0 실행.
//   4) before gate — 동일 RR READONLY txn 안에서 047 baseline 대비 live 대조
//      (보호77 NoCartTs 지문·보존36 action 지문·rowCounts·신규 12 orders
//      본문+종속·2 cancels)과 test 13테이블 before 스냅을 함께 수집한다.
//      대조와 기준선을 다른 txn으로 찍으면 사이의 변경이 정상 baseline으로
//      흡수된다 [Luna B0 재검수 MAJOR]. 신규 116 action은 047 승인 시점
//      전체 payload 지문 증거가 없으므로 ID·order 연결·건수만 대조한다 —
//      '047 이후 전체 payload 불변'을 주장하지 않고, B1이 증명하는 것은
//      실행 직전 before ↔ 종료 후 after 13테이블 전체 지문 0 변화다.
//   5) dev(commerce) before 스냅 — 별도 RO txn 허용 → audit-before.json.
//   6) child: node node_modules/playwright/cli.js test -c …(npx.cmd 경로는
//      Windows EINVAL/ENOENT 이력으로 사용하지 않는다 — 동일 승인 CLI의
//      정상 node 실행이고 권한 우회가 아니다). spawn 직전 launcher가 wx로
//      run-owner.json {runId, nonce}를 새기고 nonce를 child env(RO_WORKER_
//      NONCE)에 묶는다 — 상속된 TEST_WORKER_INDEX/TEST_PARALLEL_INDEX는
//      pwChildEnv가 지워 첫 runner가 worker로 오인되지 않는다. config 재평가
//      (worker의 deserializeConfig 재import, TEST_WORKER_INDEX 선설정)는
//      소유 정합으로만 통과하고 runner 첫 평가는 pw-output 부재를 그대로
//      요구한다. 종료 run(audit-after/audit-fail)은 worker 플래그가 있어도
//      거부, audit-before는 parse해 runId·gateOk 정합을 본다 [PMQA-048-B1F].
//   7) after 스냅 exact 비교 — DB에 접속한 경로에서만 시도하며 실패도 evidence.
//   8) verdict — 어떤 실패라도 있으면 PASS 없음. auto-repair/cleanup/재시도 없음.
//
// 주입 구조: runAudit(deps)의 모든 외부 효과(파일·DB·spawn·mkdir·write)는
// 주입 가능하다 — unit 테스트가 부정 시나리오를 DB 없이 실제 orchestrated
// 경로로 검증한다.
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  diffSnaps, parseApprovedFacts, parseRoDbUrl, snapDb, stripCartTs,
  verifyLiveArtifacts, RO_DB, RO_DB_OID, RO_DEV_DB, RO_DEV_DB_OID,
  RO_FACTS_PATH, RO_FACTS_SHA256,
  type DbSnap, type LiveArtifacts, type Q, type RoBaseline,
} from "./readonly-db.ts";
import {
  collectSnap, loadSeedOrderIds, protectedFingerprint, verifyBackupFile,
  RESTRICTED_PRESERVED_ACTIONS,
} from "../helpers/testdb.ts";

const TEST_URL =
  "postgres://commerce:commerce@localhost:5432/commerce_test";
const DEV_URL = "postgres://commerce:commerce@localhost:5432/commerce";
const PW_CLI = join("node_modules", "playwright", "cli.js");

type Pg = Q & {
  begin: <T>(fn: (q: Q) => Promise<T>) => Promise<T>;
  end: () => Promise<unknown>;
};

export type GateResult = {
  ok: boolean;
  reasons: string[];
  detail: Record<string, unknown>;
  // gate가 통과한 동일 RR READONLY txn에서 수집한 test before — 이것만이
  // B1의 유효한 기준선이다(별도 txn before는 gate↔snap 사이 변경을 숨긴다
  // [Luna B0 재검수 MAJOR]).
  before?: DbSnap;
};

export type AuditDeps = {
  mkdirRunDir: (runId: string) => string;
  put: (dir: string, name: string, obj: unknown) => void;
  verifyBackupFile: () => void;
  readFileBytes: (path: string) => Buffer;
  sha256: (b: Buffer) => string;
  loadSeedOrderIds: () => string[];
  connect: (url: string, expectedDb: string) => Pg;
  probeDb: (conn: Pg, db: string, oid: number) => Promise<void>;
  listDatabases: (conn: Pg) => Promise<{ datname: string; oid: number }[]>;
  baselineGate: (
    conn: Pg,
    baseline: RoBaseline,
    seedOrderIds: string[],
  ) => Promise<GateResult>;
  snapInTxn: (conn: Pg) => Promise<DbSnap>;
  spawnPw: (
    runId: string,
    nonce: string,
  ) => { status: number | null; error: string | null };
};

export type AuditVerdict = { pass: boolean; exit: number; reasons: string[] };

// 최종 판정 — 어떤 실패라도 있으면 PASS 없음(순수 함수 — 주입 검증 가능).
export function auditVerdict(v: {
  gateOk: boolean;
  gateReasons: string[];
  spawned: boolean;
  pwStatus: number | null;
  pwError: string | null;
  drift: string[];
  driftDev: string[];
  errors: string[];
}): AuditVerdict {
  const reasons: string[] = [];
  if (!v.gateOk)
    reasons.push("before gate 실패: " + v.gateReasons.join(" | "));
  if (v.spawned) {
    if (v.pwStatus !== 0)
      reasons.push(
        "playwright exit " + String(v.pwStatus) +
          (v.pwError ? " (" + v.pwError + ")" : ""),
      );
  } else if (v.gateOk) {
    reasons.push("playwright 미실행 — gate는 통과했으나 spawn이 안 됐다");
  }
  if (v.drift.length)
    reasons.push("commerce_test drift: " + v.drift.join(" | "));
  if (v.driftDev.length)
    reasons.push("commerce(dev) drift: " + v.driftDev.join(" | "));
  for (const e of v.errors) reasons.push("오류: " + e);
  return { pass: reasons.length === 0, exit: reasons.length ? 2 : 0, reasons };
}

// 실제 오케스트레이션 — 모든 외부 효과는 deps 경유라 DB 없이 부정 경로를
// 그대로 재생 검증할 수 있다.
export async function runAudit(deps: AuditDeps): Promise<AuditVerdict> {
  const runId = randomUUID();
  let dir: string;
  try {
    dir = deps.mkdirRunDir(runId); // EEXIST 등 — 기존 run bytes는 건드리지 않는다
  } catch (e) {
    return {
      pass: false,
      exit: 2,
      reasons: ["run dir 생성 실패 — 기존 evidence 보존: " + e],
    };
  }

  // ── FILE GATE — DB 접속 0단계. 실패 시 파일 오류 evidence만 남긴다.
  const fileErrs: string[] = [];
  let baseline: RoBaseline | null = null;
  try {
    deps.verifyBackupFile();
  } catch (e) {
    fileErrs.push("043 백업 검증 실패: " + e);
  }
  try {
    const bytes = deps.readFileBytes(RO_FACTS_PATH);
    const sha = deps.sha256(bytes);
    if (sha !== RO_FACTS_SHA256)
      fileErrs.push("047 승인 facts SHA256 불일치: " + sha);
    else {
      const pf = parseApprovedFacts(
        JSON.parse(bytes.toString("utf8")) as Record<string, unknown>,
      );
      if (!pf.ok) fileErrs.push(...pf.reasons.map((r) => "047 facts: " + r));
      else baseline = pf.baseline;
    }
  } catch (e) {
    fileErrs.push("047 승인 facts 로드 실패: " + e);
  }
  if (fileErrs.length) {
    try {
      deps.put(dir, "audit-fail.json", {
        runId,
        stage: "file-gate",
        reasons: fileErrs,
      });
    } catch (e) {
      fileErrs.push("file-gate evidence write 실패: " + e);
    }
    return { pass: false, exit: 2, reasons: fileErrs };
  }

  // ── DB 단계 — 여기서부터는 어떤 경로로 끝나도 사후 감사를 시도한다.
  const errors: string[] = [];
  let gateOk = false;
  let gateReasons: string[] = ["gate 미실행"];
  let gateDetail: Record<string, unknown> = {};
  let spawned = false;
  let pwStatus: number | null = null;
  let pwError: string | null = null;
  let before: DbSnap | null = null;
  let beforeDev: DbSnap | null = null;
  let drift: string[] = [];
  let driftDev: string[] = [];
  let proceed = true;

  const testConn = deps.connect(TEST_URL, RO_DB);
  const devConn = deps.connect(DEV_URL, RO_DEV_DB);
  try {
    try {
      await deps.probeDb(testConn, RO_DB, RO_DB_OID);
      await deps.probeDb(devConn, RO_DEV_DB, RO_DEV_DB_OID);
    } catch (e) {
      errors.push("DB probe: " + e);
      proceed = false;
    }

    // demo_verify 부재 — SELECT로만 확인하고, 존재하면 gate 실패다(child 0).
    let databases: { datname: string; oid: number }[] = [];
    let demoVerifyPresent: boolean | null = null;
    if (proceed) {
      databases = await deps.listDatabases(testConn);
      demoVerifyPresent = databases.some(
        (d) => d.datname === "commerce_demo_verify",
      );
      if (demoVerifyPresent) {
        gateReasons = ["commerce_demo_verify 존재 — 예상 밖 DB, child 실행 0"];
        proceed = false;
      }
    }

    if (proceed && baseline) {
      const gate = await deps.baselineGate(
        testConn,
        baseline,
        deps.loadSeedOrderIds(),
      );
      gateOk = gate.ok;
      gateReasons = gate.reasons;
      gateDetail = gate.detail;
      // test before는 gate의 동일 txn 산출물만 유효하다 — 여기서 새 txn으로
      // 다시 찍으면 gate 통과 후의 변경이 정상 baseline으로 흡수된다.
      before = gate.before ?? null;
      if (!gate.ok) proceed = false;
      else if (!before) {
        errors.push("gate가 동일 txn의 test before를 반환하지 않음 — 중단");
        proceed = false;
      }
    }
    if (proceed && before) {
      beforeDev = await deps.snapInTxn(devConn); // dev before는 별도 RO txn 허용
      if (before.writersError || beforeDev.writersError) {
        errors.push("writer 탐지 실패 — before를 신뢰할 수 없어 중단");
        proceed = false;
      } else if (before.writers.length || beforeDev.writers.length) {
        errors.push(
          "write 가능 세션 존재 — 중단: test [" + before.writers.join(",") +
            "] dev [" + beforeDev.writers.join(",") + "]",
        );
        proceed = false;
      } else if (
        before.unreadableActive.length || beforeDev.unreadableActive.length
      ) {
        // query 열람 불가 활성 세션 — write를 증명할 수 없으므로 중단한다.
        errors.push(
          "query 열람 불가 활성 세션 — 중단: test [" +
            before.unreadableActive.join(",") + "] dev [" +
            beforeDev.unreadableActive.join(",") + "]",
        );
        proceed = false;
      }
    }
    if (proceed)
      deps.put(dir, "audit-before.json", {
        runId, before, beforeDev, gateOk, gateDetail, databases,
        demoVerifyPresent,
      });

    if (proceed) {
      // 이번 run 소유 증거 — wx 배타 생성으로 launcher만 만들 수 있고, config
      // 재평가는 이 marker + RO_WORKER_NONCE env 정합을 요구한다 [B1F].
      const nonce = randomUUID();
      deps.put(dir, "run-owner.json", {
        runId, nonce, at: new Date().toISOString(),
      });
      spawned = true;
      const r = deps.spawnPw(runId, nonce);
      pwStatus = r.status;
      pwError = r.error;
    }
  } catch (e) {
    errors.push(String(e));
  } finally {
    // 사후 감사 — DB에 접속한 경로이므로 throw/nonzero/조회 실패 모두 시도한다.
    let after: DbSnap | null = null;
    let afterDev: DbSnap | null = null;
    try {
      after = await deps.snapInTxn(testConn);
      if (before) drift = diffSnaps(before, after);
    } catch (e) {
      errors.push("after 스냅(commerce_test) 실패: " + e);
    }
    try {
      afterDev = await deps.snapInTxn(devConn);
      if (beforeDev) driftDev = diffSnaps(beforeDev, afterDev);
    } catch (e) {
      errors.push("after 스냅(commerce) 실패: " + e);
    }
    const verdict = auditVerdict({
      gateOk, gateReasons, spawned, pwStatus, pwError,
      drift, driftDev, errors,
    });
    try {
      deps.put(dir, "audit-after.json", {
        runId, after, afterDev, drift, driftDev, pwStatus, pwError,
        gateOk, gateReasons, gateDetail, errors, verdict,
      });
    } catch (e) {
      verdict.pass = false;
      verdict.exit = 3;
      verdict.reasons.push("evidence write 실패: " + e);
    }
    await testConn.end().catch(() => {});
    await devConn.end().catch(() => {});
    return verdict;
  }
}

// ── 실제 deps ──────────────────────────────────────────────────────

async function snapInTxn(conn: Pg): Promise<DbSnap> {
  return conn.begin(async (q) => {
    await q.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return snapDb(q);
  });
}

async function probeDb(conn: Pg, db: string, oid: number): Promise<void> {
  const [id] = await conn.unsafe<{ d: string; oid: number }[]>(
    "SELECT current_database() AS d, (SELECT oid::int FROM pg_database WHERE datname = current_database()) AS oid",
  );
  if (id.d !== db || id.oid !== oid)
    throw new Error("대상 DB 불일치 " + id.d + "#" + id.oid + " != " + db + "#" + oid);
  const [g] = await conn.unsafe<{ default_transaction_read_only: string }[]>(
    "SHOW default_transaction_read_only",
  );
  if (g.default_transaction_read_only !== "on")
    throw new Error(db + ": read-only GUC 미적용 — 중단");
}

// before gate — 하나의 RR READONLY 트랜잭션에서 047 승인 baseline과 live를
// 대조하고, 같은 txn에서 test 13테이블 before 스냅을 수집해 돌린다.
// 대조와 기준선이 갈라지면 중간 변경이 정상 baseline으로 흡수된다.
// throw 없이 reasons를 돌린다(실패도 evidence다).
async function baselineGate(
  conn: Pg,
  baseline: RoBaseline,
  seedOrderIds: string[],
): Promise<GateResult> {
  return conn.begin(async (q) => {
    await q.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // 대조와 기준선을 하나의 txn으로 — 별도 txn before는 중간 변경을 숨긴다.
    const before = await snapDb(q);
    const snap = await collectSnap(q as never);
    const preservedRows = snap.protected.filter(
      (r) => r.src === "action_requests",
    );
    const fpStrict = protectedFingerprint(snap.protected);
    const fpNCTS = protectedFingerprint(stripCartTs(snap.protected));
    const fpPres = protectedFingerprint(preservedRows);

    const orders = await q.unsafe<LiveArtifacts["orders"]>(
      "SELECT id, user_id, status, items_total_won, shipping_fee_won, total_won FROM orders",
    );
    const items = await q.unsafe<LiveArtifacts["items"]>(
      "SELECT id, order_id FROM order_items",
    );
    const payments = await q.unsafe<LiveArtifacts["payments"]>(
      "SELECT id, order_id FROM payments",
    );
    const shipments = await q.unsafe<LiveArtifacts["shipments"]>(
      "SELECT id, order_id FROM shipments",
    );
    const cancels = await q.unsafe<LiveArtifacts["cancels"]>(
      "SELECT id, order_id, status, action_request_id FROM cancel_requests",
    );
    const actions = await q.unsafe<LiveArtifacts["actions"]>(
      "SELECT id, result_json->>'order_id' AS order_ref FROM action_requests",
    );
    const [ci] = await q.unsafe<{ n: number }[]>(
      "SELECT count(*)::int AS n FROM cart_items",
    );
    const live: LiveArtifacts = {
      rowCounts: {
        orders: orders.length,
        order_items: items.length,
        payments: payments.length,
        shipments: shipments.length,
        cancel_requests: cancels.length,
        action_requests: actions.length,
        cart_items: ci.n,
      },
      orders, items, payments, shipments, cancels, actions, seedOrderIds,
    };

    const reasons: string[] = [];
    if (fpNCTS !== baseline.protectedFpNoCartTs)
      reasons.push(
        "보호 77 지문(NoCartTs) 불일치 — live " + fpNCTS +
          " != 승인 " + baseline.protectedFpNoCartTs,
      );
    if (fpPres !== baseline.preservedActionsFp)
      reasons.push(
        "보존 36 action 내용 지문 불일치 — payload 변조 가능성: live " + fpPres,
      );
    if (preservedRows.length !== RESTRICTED_PRESERVED_ACTIONS.length)
      reasons.push(
        "보존 action 수 " + preservedRows.length +
          " != " + RESTRICTED_PRESERVED_ACTIONS.length,
      );
    reasons.push(...verifyLiveArtifacts(baseline, live));

    return {
      ok: reasons.length === 0,
      reasons,
      detail: {
        protectedCount: snap.protected.length,
        fpStrict, // carts.updated_at 포함 — 043→047 승인 차이 이력으로 분리 기록
        fpNCTS, fpPres,
        rowCounts: live.rowCounts,
        seedOrderIds,
      },
      before, // 동일 txn 기준선 — runAudit는 이것만 쓴다
    };
  });
}

function realDeps(): AuditDeps {
  return {
    mkdirRunDir: (runId) => {
      mkdirSync(join("shots", "06b"), { recursive: true });
      const dir = join("shots", "06b", runId);
      mkdirSync(dir); // recursive:false — EEXIST면 이미 점유된 run dir
      return dir;
    },
    put: (dir, name, obj) =>
      writeFileSync(join(dir, name), JSON.stringify(obj, null, 2), {
        flag: "wx",
      }),
    verifyBackupFile: () => verifyBackupFile(),
    readFileBytes: (p) => readFileSync(p),
    sha256: (b) => createHash("sha256").update(b).digest("hex"),
    loadSeedOrderIds: () =>
      loadSeedOrderIds(readFileSync("db/seeds/scenarios.json", "utf8")),
    connect: (url, db) =>
      postgres(parseRoDbUrl(url, db), { max: 1 }) as unknown as Pg,
    probeDb,
    listDatabases: (conn) =>
      conn.unsafe<{ datname: string; oid: number }[]>(
        "SELECT datname, oid::int FROM pg_database ORDER BY datname",
      ),
    baselineGate,
    snapInTxn,
    // Windows npx.cmd EINVAL/ENOENT 이력 — 승인된 동일 Playwright CLI를
    // process.execPath로 직접 실행한다(권한 우회 아님, 경로 고정).
    spawnPw: (runId, nonce) => {
      const r = spawnSync(
        process.execPath,
        [PW_CLI, "test", "-c", "playwright.readonly.config.ts"],
        { env: pwChildEnv(runId, nonce), stdio: "inherit" },
      );
      return { status: r.status ?? -1, error: r.error ? String(r.error) : null };
    },
  };
}

// child env — 소유 정합 키(RO_RUN_ID·RO_WORKER_NONCE)를 묶되, 부모 프로세스에
// 상속돼 있을 수 있는 worker 지표는 지운다 — 첫 runner 평가가 worker로
// 오인되면 안 된다(순수 함수 — 주입 검증 가능) [PM B1F 사전검수].
// 출력 경로 override도 모두 지운다 — installed runner/index.js LastRunReporter
// 는 PLAYWRIGHT_LAST_RUN_OUTPUT_FILE이 outputDir보다 우선하여 외부 기존
// 파일을 resolve+writeFile로 덮어쓰고(:6608/:6644), reporter 계열
// PLAYWRIGHT_*_OUTPUT_FILE/_OUTPUT_DIR·HTML_REPORT도 같은 외부 경로
// 패턴이다 [Luna B1F MAJOR]. 상속 env가 shots/06b run 밖 파일을 가리키는
// 경로를 차단한다.
export function pwChildEnv(
  runId: string,
  nonce: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    RO_RUN_ID: runId,
    RO_WORKER_NONCE: nonce,
  };
  delete env.TEST_WORKER_INDEX;
  delete env.TEST_PARALLEL_INDEX;
  for (const k of Object.keys(env)) {
    if (!k.startsWith("PLAYWRIGHT_")) continue;
    if (
      k.endsWith("_OUTPUT_FILE") || k.endsWith("_OUTPUT_DIR") ||
      k === "PLAYWRIGHT_HTML_REPORT" || k === "PLAYWRIGHT_HTML_OPEN"
    )
      delete env[k];
  }
  return env;
}

async function main(): Promise<void> {
  const verdict = await runAudit(realDeps());
  for (const r of verdict.reasons) console.error("[ro-audit]", r);
  console.log(
    verdict.pass ? "[ro-audit] 변화 0 확인" : "[ro-audit] FAIL",
  );
  if (!verdict.pass) process.exitCode = verdict.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
