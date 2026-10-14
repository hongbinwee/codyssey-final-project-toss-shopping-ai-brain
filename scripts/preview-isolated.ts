// PMQA-079 — 승인된 실제 Commerce Preview 런처.
//
// owned scratch_<16hex> DB 1개(전체 생성 상한 2개 중 Preview 몫)에 phase6
// schema(001~004)와 canonical fixture를 atomic으로 채운 뒤, 같은 owned
// 검증 트랜잭션 안에서 승인된 demo json의 지정 데이터(25 제품 / 55 variant /
// 80 리뷰)만 upsert하고, ISOLATED 소유 계약을 명시 전달받은
// 127.0.0.1:3105 loopback 서버를 기동한다.
//
// 안전 계약:
// - env 게이트는 suite와 동일 — SCRATCH_DB_TESTS=1 + ISOLATED_STRICT=1 +
//   SCRATCH_ADMIN_URL(로컬 /postgres). DATABASE_URL·ISO_*·PG* 상속 차단
//   (planSmokeEnv의 blocked 목록 그대로).
// - 자격 증명은 .secrets/pg-password 경유 — URL·비밀 값은 어떤 증거에도
//   기록하지 않는다. 실패 기록은 고정 stage + 범주뿐(오류 원문 금지).
// - Preview DB·서버는 보존이다: 자동 DROP·자동 종료 경로가 없다.
// - 서버는 부모(이 런처) 생존 동안 살아 있는 자식이다 — detached/fd 공유를
//   쓰지 않고 자식 출력은 claim된 server.log의 보유 Writable에만 pipe한다.
// - 증거는 reserveEvidenceRun 배타 예약 — DB 접속·포트 검사 전에 claim되며
//   server.log도 실행 전 SLOTS에 포함된다.
// - seed.ts --demo 경로(DEMO_DBS allowlist)는 사용하지 않는다 — demo
//   upsert는 이 파일 안에서 owned 검증 트랜잭션으로만 수행한다.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { databaseUrlForName, databaseUrlWithPasswordFile } from "../src/db-url.ts";
import { planSmokeEnv } from "./isolated-smoke.ts";
import {
  createOwnedScratchDb,
  type ScratchDb,
} from "../tests/helpers/scratch-db.ts";
import {
  contractFromScratch,
  buildIsolatedChildEnv,
  verifyOwnedExec,
  verifyOwnedTransaction,
  type IsolatedContract,
} from "../tests/helpers/isolated-db.ts";
import { prepareIsolatedDb } from "../tests/helpers/isolated-prepare.ts";
import { reserveEvidenceRun } from "../tests/helpers/capture-output.ts";
import type { SeedExec } from "./base-seed.ts";

// 오류 범주 분류 — scripts/pmqa079-tcp-audit.ts의 probeErrorCategory와
// 동일 규칙이다. 그 파일을 import하면 top-level src/config.ts가 함께
// 로드돼 .env의 DATABASE_URL이 process.env에 주입되고, 아래 planSmokeEnv의
// blocked-key 검사가 자기 차단된다(tcp-audit은 정적검수 핀고정이라 함수를
// 옮길 수 없어 로컬 복제한다).
export function errorCategory(raw: string): string {
  if (/\b28[0-9A-Z]{3}\b/.test(raw)) return "auth";
  if (/\b25[0-9A-Z]{3}\b/.test(raw)) return "transaction-state";
  if (/\b42[0-9A-Z]{3}\b/.test(raw)) return "schema-object";
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(raw))
    return "connection";
  return "other";
}

// 자식 수명 관측 결과 — exit(코드/null+signal)·error·unknown(미등록 경로).
export type ChildOutcome =
  | { kind: "exit"; code: number | null; signal: string | null }
  | { kind: "error"; category: string }
  | { kind: "unknown"; code: null; signal: null };

// spawn 직후 — writer.stream/pipe 등 다른 실패 가능 작업보다 먼저 등록한다.
// 등록 전 실패는 살아있는 자식을 감시 없이 남긴다 [Luna ①].
//   done:   exit(error)/종료 판정.
//   closed: 'close' 이벤트 — exit 이후에도 stdio가 잔여 데이터를 운반할 수
//           있어 server.log 증거 마감(writer.close) 전에 기다려야 한다.
//           spawn 직후 함께 등록해 이벤트 누락을 막는다. 실제 'close'
//           이벤트에서만 해소되고(error로 해소되지 않음), 미도착 상한은
//           finalizePreviewRun의 bounded timeout이 관리한다.
export function watchChild(child: ChildProcess): {
  done: Promise<ChildOutcome>;
  closed: Promise<void>;
} {
  // 'error' emit 시 once(exit)의 내부 error-reject 리스너가 once(error)보다
  // 먼저 등록돼 있으면 race가 raw error로 reject한다 — once(error)를 배열
  // 앞쪽에 둬 resolver가 먼저 등록되게 하고, 잔여 reject 경로는 catch에서
  // error outcome으로 매핑해 done은 항상 ChildOutcome으로 settle된다.
  const done = Promise.race<ChildOutcome>([
    once(child, "error").then(([e]) => ({
      kind: "error" as const,
      category: errorCategory(e instanceof Error ? e.message : String(e)),
    })),
    once(child, "exit").then(
      ([code, signal]) => ({ kind: "exit" as const, code, signal }),
    ),
  ]).catch((e) => ({
    kind: "error" as const,
    category: errorCategory(e instanceof Error ? e.message : String(e)),
  }));
  done.catch(() => {}); // 이중 방어 — 소비 전 unhandled rejection 방지
  // closed는 실제 'close' 이벤트에서만 해소된다 — once() 헬퍼의 error 자동
  // reject 경로를 쓰면 error만으로 closed가 해소돼, 살아있는 자식의 stdio가
  // 아직 열려 있는데 drain 완료로 오인된다 [PM]. Node의 error는 종료가
  // 아닐 수 있으므로(kill/send 실패 포함) 직접 once 리스너를 등록한다.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  return { done, closed };
}

// 자식 spawn + 즉시 감시 등록 + 로그 pipe. stream/pipe 실패는 throw 대신
// pipeError로 돌려보낸다 — caller가 childDone/childClosed를 계속 보유해야 한다.
export function startPreviewChild(deps: {
  spawn: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string>; stdio: ("ignore" | "pipe")[] },
  ) => ChildProcess;
  writer: { stream(name: string): Writable };
  env: Record<string, string>;
}): {
  child: ChildProcess;
  childDone: Promise<ChildOutcome>;
  childClosed: Promise<void>;
  serverPid: number | null;
  pipeError: unknown | null;
} {
  const child = deps.spawn(process.execPath, ["src/server.ts"], {
    env: deps.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverPid = child.pid ?? null;
  const { done: childDone, closed: childClosed } = watchChild(child);
  let pipeError: unknown | null = null;
  try {
    const logStream = deps.writer.stream("server.log");
    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
  } catch (e) {
    pipeError = e;
  }
  return { child, childDone, childClosed, serverPid, pipeError };
}

// 준비 판정(READY/FAIL)과 자식 종료 판정(childTerminationStatus)의 분리
// [Luna ②]. shutdown.json은 close 이전에 기록되므로 최종 runner 판정을
// 담지 않는다 — 최종 runner PASS는 이 파일 기록 성공 + writer.close() 성공 +
// native exit 0으로만 판정된다(파일로는 close 후 상태를 남길 수 없다).
// 살아있는 자식은 kill하지 않고 수명이 끝날 때까지 기다려 writer/로그 핸들을
// 유지하고, 'close'(stdio drain 완료) 이후에 writer를 close한다.
export async function finalizePreviewRun(d: {
  writer: {
    writeJson(name: string, obj: unknown): Promise<void>;
    close(): Promise<void>;
  };
  readiness: "READY" | "FAIL";
  child: ChildProcess | null;
  childDone: Promise<ChildOutcome> | null;
  childClosed: Promise<void> | null;
  serverPid: number | null;
  resultOk: boolean;
  closeTimeoutMs?: number;
}): Promise<0 | 1> {
  let outcome: ChildOutcome | null = null;
  if (d.childDone !== null) {
    outcome = await d.childDone.catch(() => ({
      kind: "unknown" as const,
      code: null,
      signal: null,
    }));
  }
  // stdio drain — 'close'가 오지 않는 경로(spawn 직후 error 등) 대비 상한.
  let stdioClosed: boolean | null = null;
  if (d.childClosed !== null && outcome !== null) {
    const r = await Promise.race([
      d.childClosed.then(() => "closed" as const),
      new Promise<"timeout">((res) =>
        setTimeout(() => res("timeout"), d.closeTimeoutMs ?? 2000),
      ),
    ]);
    stdioClosed = r === "closed";
  }
  const childTerminationStatus =
    outcome !== null &&
      outcome.kind === "exit" &&
      outcome.code === 0 &&
      stdioClosed === true
      ? "clean"
      : "abnormal";
  let shutdownOk = true;
  try {
    await d.writer.writeJson("shutdown.json", {
      at: new Date().toISOString(),
      pid: d.serverPid,
      readiness: d.readiness,
      childTerminationStatus,
      stdioClosed,
      note: "최종 runner 판정은 이 기록 성공 + writer.close() 성공 + native exit 0으로만 판정 — 이 파일의 childTerminationStatus는 자식 종료 판정뿐이다",
      ...(outcome ?? {
        state: d.child !== null ? "child-outcome-missing" : "no-running-child",
      }),
    });
  } catch {
    shutdownOk = false;
  }
  let closeOk = true;
  try {
    await d.writer.close();
  } catch {
    closeOk = false;
  }
  const finalOk =
    d.resultOk &&
    d.readiness === "READY" &&
    childTerminationStatus === "clean" &&
    shutdownOk &&
    closeOk;
  return finalOk ? 0 : 1;
}

const RUN_ROOT = "shots/isolated-preview";
const SLOTS = [
  "plan.json",
  "scratch.json",
  "prepare.json",
  "demo.json",
  "server.json",
  "health.json",
  "shutdown.json",
  "server.log",
  "result.json",
] as const;
const PREVIEW_PORT = 3105;
const SCRATCH_CAP = 2;

// 점유 중이면 true — 포트를 비우지 않고 즉시 중단한다(no kill/reuse).
function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connectTcp({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

// 승인된 Preview demo — db/seeds/demo-*.json의 지정 행만 upsert한다.
// 컬럼 매핑은 seed.ts의 demo upsert와 동일하다. reconcile은 생략한다 —
// 이 대상은 방금 생성된 빈 owned DB로 stale p-d-*/v-d-*/r-d-*가 없다.
export async function seedPreviewDemo(
  q: SeedExec,
): Promise<{ products: number; variants: number; reviews: number }> {
  const cat = JSON.parse(readFileSync("db/seeds/demo-catalog.json", "utf8")) as {
    products: {
      id: string; name: string; brand: string; category: string;
      description: string; image_urls: string[]; specs: Record<string, unknown>;
    }[];
    variants: {
      id: string; product_id: string; option_values: Record<string, unknown>;
      spec_overrides: Record<string, unknown>; unit_price_won: number; stock_qty: number;
    }[];
  };
  const rev = JSON.parse(readFileSync("db/seeds/demo-reviews.json", "utf8")) as {
    id: string; product_id: string; variant_id: string | null; rating: number;
    body: string; source_kind: string; source_ref: string; written_at: string;
  }[];
  for (const p of cat.products) {
    await q.unsafe(
      "INSERT INTO products (id, name, brand, category, description, image_urls, specs_json, active) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,true) " +
        "ON CONFLICT (id) DO UPDATE SET name=$2, brand=$3, category=$4, description=$5, image_urls=$6::jsonb, specs_json=$7::jsonb, active=true",
      [p.id, p.name, p.brand, p.category, p.description, p.image_urls, p.specs],
    );
  }
  for (const v of cat.variants) {
    await q.unsafe(
      "INSERT INTO product_variants (id, product_id, option_values_json, spec_overrides_json, unit_price_won, stock_qty, active) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,true) " +
        "ON CONFLICT (id) DO UPDATE SET product_id=$2, option_values_json=$3::jsonb, spec_overrides_json=$4::jsonb, unit_price_won=$5, stock_qty=$6, active=true, version=1",
      [v.id, v.product_id, v.option_values, v.spec_overrides, v.unit_price_won, v.stock_qty],
    );
  }
  for (const r of rev) {
    await q.unsafe(
      "INSERT INTO reviews (id, product_id, variant_id, rating, body, source_kind, source_ref, written_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) " +
        "ON CONFLICT (id) DO UPDATE SET product_id=$2, variant_id=$3, rating=$4, body=$5, source_kind=$6, source_ref=$7, written_at=$8",
      [r.id, r.product_id, r.variant_id, r.rating, r.body, r.source_kind, r.source_ref, r.written_at],
    );
  }
  return {
    products: cat.products.length,
    variants: cat.variants.length,
    reviews: rev.length,
  };
}

type PreviewIdentity = Pick<IsolatedContract, "dbName" | "dbOid" | "dbOwner" | "runId">;

// 기존 생성 증거에서만 복원하며, 실제 DB 검증은 아래 재접속 시 다시 수행한다.
export function resumePreviewContract(record: {
  dbName: string; runId: string; oid: number; owner: number;
}, adminUrl: string): IsolatedContract {
  return contractFromScratch({
    dbName: record.dbName, runId: record.runId,
    dbUrl: databaseUrlForName(record.dbName, adminUrl),
    createdIdentity: { oid: record.oid, owner: record.owner },
  });
}

export function previewHealthMatches(body: unknown, expected: PreviewIdentity): boolean {
  if (!body || typeof body !== "object") return false;
  const result = body as { ok?: unknown; db?: unknown; isolated?: Partial<PreviewIdentity> };
  return result.ok === true && result.db === "connected" &&
    result.isolated?.dbName === expected.dbName &&
    result.isolated.dbOid === expected.dbOid &&
    result.isolated.dbOwner === expected.dbOwner &&
    result.isolated.runId === expected.runId;
}

async function waitHealth(url: string, expected: PreviewIdentity, tries = 60): Promise<number> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return previewHealthMatches(await r.json(), expected) ? r.status : 0;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return 0;
}

async function main(): Promise<void> {
  const resumeRun = process.argv[3] === "--resume" ? process.argv[4] : undefined;
  if (process.argv[2] !== "--execute" ||
    !(process.argv.length === 3 || (process.argv.length === 5 && resumeRun &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(resumeRun)))) {
    console.error("preview requires --execute");
    process.exitCode = 2;
    return;
  }

  // suite entry와 같은 순서 — 자격 파일을 먼저 해석해 env 게이트에 넘긴다.
  try {
    if (!process.env.SCRATCH_ADMIN_URL)
      throw new Error("SCRATCH_ADMIN_URL is required");
    process.env.SCRATCH_ADMIN_URL = databaseUrlWithPasswordFile(
      process.env.SCRATCH_ADMIN_URL,
      ".secrets/pg-password",
    );
  } catch {
    console.error("preview stopped: local database credential unavailable");
    process.exitCode = 2;
    return;
  }

  // DB 접속·포트 검사 전에 전체 산출물을 배타 예약한다 — server.log 포함.
  const writer = await reserveEvidenceRun(RUN_ROOT, [...SLOTS]);
  let failedStage: string | null = null;
  let failedCategory: string | null = null;
  let serverPid: number | null = null;
  let dbName: string | null = null;
  let child: ChildProcess | null = null;
  let childDone: Promise<ChildOutcome> | null = null;
  let childClosed: Promise<void> | null = null;
  const fail = (stage: string, e: unknown) => {
    failedStage = stage;
    failedCategory = errorCategory(
      e instanceof Error ? e.message : String(e),
    );
  };

  try {
    const gate = planSmokeEnv(process.env);
    if (!gate.ok) throw new Error("env gate");
    const adminUrl = gate.adminUrl;
    if (await portOccupied(PREVIEW_PORT))
      throw new Error("port occupied");

    // cap-2 관리: 생성 전 보유 수를 같은 admin 연결로 읽어 기록한다.
    const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
    let preExisting = 0;
    try {
      const [row] = await admin.unsafe<{ c: number }[]>(
        "SELECT count(*)::int AS c FROM pg_database WHERE datname LIKE 'scratch_%'",
      );
      preExisting = row.c;
    } finally {
      await admin.end();
    }
    if (!resumeRun && preExisting >= SCRATCH_CAP)
      throw new Error("scratch cap reached");
    await writer.writeJson("plan.json", {
      at: new Date().toISOString(),
      port: PREVIEW_PORT,
      phase: 6,
      portOccupied: false,
      scratchPreExisting: preExisting,
      scratchCap: SCRATCH_CAP,
      resumeRun: resumeRun ?? null,
      note: "owned scratch + phase6 fixture + owned-txn demo upsert(25/55/80) + child server on held server.log stream; no auto-drop",
    });

    let contract: IsolatedContract;
    if (resumeRun) {
      const previous = RUN_ROOT + "/run-" + resumeRun + "/";
      const record = JSON.parse(readFileSync(previous + "scratch.json", "utf8"));
      const readiness = JSON.parse(readFileSync(previous + "result.json", "utf8"));
      if (readiness.status !== "READY" || readiness.dbName !== record.dbName)
        throw new Error("previous Preview was not ready");
      contract = resumePreviewContract(record, adminUrl);
      const pool = postgres(contract.dbUrl, { max: 1, connect_timeout: 10 });
      try {
        const owned = await verifyOwnedTransaction(
          pool as unknown as Parameters<typeof verifyOwnedTransaction>[0], contract,
        );
        if (!owned.ok) throw new Error("resume Preview identity mismatch");
      } finally {
        await pool.end();
      }
      dbName = contract.dbName;
      await writer.writeJson("scratch.json", {
        ...record, stages: [], createdThisRun: 0, scratchTotal: preExisting,
        resumedFrom: previous,
      });
      await writer.writeJson("prepare.json", { skipped: "resume existing verified Preview; no migration or fixture writes" });
      await writer.writeJson("demo.json", { skipped: "resume existing Preview; no reseeding" });
    } else {
    const stages: unknown[] = [];
    let scratch: ScratchDb;
    try {
      scratch = await createOwnedScratchDb(adminUrl, {
        events: (e) => {
          stages.push(e);
        },
      });
    } catch (e) {
      fail("scratch-create", e);
      throw e;
    }
    dbName = scratch.dbName;
    await writer.writeJson("scratch.json", {
      dbName: scratch.dbName,
      runId: scratch.runId,
      oid: scratch.createdIdentity.oid,
      owner: scratch.createdIdentity.owner,
      stages,
      createdThisRun: 1,
      scratchTotal: preExisting + 1,
    });
    contract = contractFromScratch(scratch);

    const prepEnv = {
      ISOLATED_DB_URL: contract.dbUrl,
      ISOLATED_DB_NAME: contract.dbName,
      ISOLATED_DB_OID: String(contract.dbOid),
      ISOLATED_DB_OWNER: String(contract.dbOwner),
      ISOLATED_RUN_ID: contract.runId,
      SCRATCH_DB_TESTS: "1",
      ISOLATED_STRICT: "1",
    };
    try {
      const prepared = await prepareIsolatedDb(prepEnv, {}, { phase: 6 });
      await writer.writeJson("prepare.json", prepared);
    } catch (e) {
      fail("prepare", e);
      throw e;
    }

    // 승인 demo — 같은 owned 계약의 verifyOwnedExec 트랜잭션 안에서만
    // 쓴다. seed.ts --demo(DEMO_DBS) 경로는 사용하지 않는다.
    try {
      const demoClient = postgres(scratch.dbUrl, {
        max: 1,
        connect_timeout: 10,
      });
      try {
        const counts = await demoClient.begin(async (q) => {
          const owned = await verifyOwnedExec(
            q as unknown as Parameters<typeof verifyOwnedExec>[0],
            contract as IsolatedContract,
          );
          if (!owned.ok) throw new Error("demo owned check: " + owned.reason);
          return await seedPreviewDemo(q as unknown as SeedExec);
        });
        await writer.writeJson("demo.json", {
          ...counts,
          source: "db/seeds/demo-catalog.json + demo-reviews.json (designated only)",
          reconcile: "skipped — fresh owned DB, no stale p-d/v-d/r-d rows",
        });
      } finally {
        await demoClient.end();
      }
    } catch (e) {
      fail("demo-seed", e);
      throw e;
    }
    }

    // 자식 env — buildIsolatedChildEnv가 계약+strict+opt-in+allowlist만
    // 전달한다. 관리자 SCRATCH_ADMIN_URL은 자식에 넘기지 않는다.
    const childSource = {
      ISOLATED_DB_URL: contract.dbUrl,
      ISOLATED_DB_NAME: contract.dbName,
      ISOLATED_DB_OID: String(contract.dbOid),
      ISOLATED_DB_OWNER: String(contract.dbOwner),
      ISOLATED_RUN_ID: contract.runId,
      SCRATCH_DB_TESTS: "1",
      ISOLATED_STRICT: "1",
      PATH: process.env.PATH,
      Path: process.env.Path,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      ComSpec: process.env.ComSpec,
      TEST_USER_CODES: "demo-a=u-a,demo-b=u-b,demo-c=u-c,demo-d=u-d",
      LLM_PROVIDER: "stub",
      CI: "1",
    };
    const built = buildIsolatedChildEnv(childSource);
    if (!built.ok) throw new Error("child env: " + built.reason);
    const serverEnv = { ...built.env, PORT: String(PREVIEW_PORT) };

    let started: ReturnType<typeof startPreviewChild>;
    try {
      // spawn → 감시 등록 → stream/pipe 순서는 startPreviewChild가 고정한다.
      // pipe 실패는 throw가 아니라 pipeError로 돌아온다 — childDone 보유.
      started = startPreviewChild({
        spawn: (cmd, args, opts) => spawn(cmd, args, opts),
        writer,
        env: serverEnv,
      });
    } catch (e) {
      fail("server-spawn", e);
      throw e;
    }
    child = started.child;
    serverPid = started.serverPid;
    childDone = started.childDone;
    childClosed = started.childClosed;
    if (started.pipeError !== null) {
      fail("server-log-pipe", started.pipeError);
      throw started.pipeError;
    }

    const healthCode = await waitHealth("http://127.0.0.1:3105/health", contract);
    let htmlOk = false;
    if (healthCode === 200) {
      const r = await fetch("http://127.0.0.1:3105/");
      const body = await r.text();
      htmlOk = r.ok && /<html|app|root/i.test(body);
    }
    await writer.writeJson("server.json", {
      pid: serverPid,
      port: PREVIEW_PORT,
      bind: "127.0.0.1",
      supervisedBy: "preview-isolated.ts parent (child dies with launcher)",
      isolatedContractPassed: true,
      url: "http://127.0.0.1:3105",
      demoCodes: ["demo-a", "demo-b", "demo-c", "demo-d"],
      demoSubjectsVerified: "users.json auth_subject u-a..u-d — direct compare",
    });
    await writer.writeJson("health.json", {
      healthCode,
      isolatedIdentityMatched: healthCode === 200,
      htmlOk,
      checkedAt: new Date().toISOString(),
    });
    if (healthCode !== 200) failedStage = "health";
    else if (!htmlOk) failedStage = "html";
  } catch (e) {
    if (failedStage === null) fail("runner", e);
  }

  // 준비 판정과 최종 종료 판정을 분리한다 [Luna ②] — result.json은
  // 준비·헬스 결과(READY/FAIL)만 담고, 자식 종료 판정은 shutdown.json의
  // childTerminationStatus에 기록된다. 최종 runner PASS는 shutdown 기록
  // 성공 + writer.close() 성공 + native exit 0으로만 판정된다 —
  // close 이전에는 어떤 파일에도 최종 PASS를 쓰지 않는다.
  const readiness: "READY" | "FAIL" = failedStage === null ? "READY" : "FAIL";
  let resultOk = true;
  try {
    await writer.writeJson("result.json", {
      status: readiness,
      verdictScope: "readiness-only — 자식 종료 판정은 shutdown.json.childTerminationStatus, 최종 runner 판정은 close 성공 + native exit 0",
      at: new Date().toISOString(),
      dbName,
      serverPid,
      url: "http://127.0.0.1:3105",
      demoAccounts: "demo-a..demo-d -> users u-a..u-d",
      preserved: "Preview DB/서버 보존 — 자동 DROP/종료 없음",
      failedStage,
      failedCategory,
    });
  } catch {
    resultOk = false;
  }

  console.log(
    readiness === "READY"
      ? "preview READY db=" + String(dbName) +
          " pid=" + String(serverPid) +
          " url=http://127.0.0.1:3105"
      : "preview FAIL db=" + String(dbName) +
          " pid=" + String(serverPid) +
          (failedStage ? " failedStage=" + failedStage : ""),
  );
  // 살아있는 자식은 kill하지 않는다 — writer/로그 핸들은 자식 수명 동안 유지,
  // 종료 후 shutdown.json 기록 → close 순서를 READY/FAIL 모두 동일하게 따른다.
  process.exitCode = await finalizePreviewRun({
    writer,
    readiness,
    child,
    childDone,
    childClosed,
    serverPid,
    resultOk,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
