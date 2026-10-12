// 격리 DB smoke runner — PMQA-052.
//
// 실제 PostgreSQL에서 이 실행 소유의 scratch_<16hex> 하나를 만들어
// canonical prepare(migration 3 + base seed 4)를 실행하고, fault 주입이
// 실제 ROLLBACK으로 관측되는지를 입증한다 — mock 계약 증거가 아니라
// 실DB 원자성 근거다(09 Freeze 전 요구 항목).
//
// 권한 범위:
// - write: 이 실행이 CREATE한 scratch_*뿐 — CREATE/migration/seed/DROP.
// - read-only: commerce·commerce_test는 startup GUC + txn 첫 query의
//   SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY로만 측정.
//   postgres에는 pg_database 조회·CREATE/DROP scratch만 수행.
// - 금지: HTTP·실결제·mock checkout·외부 API·Integration·E2E·eval.
//   config/devdb/.env/legacy seed/migrate/globalSetup import 없음.
//
// evidence: shots/isolated-smoke/run-<runUUID>/ — 배타 예약(wx) 후 모든
// stage JSON은 flag:'wx'로 새 파일에만 쓴다(덮어쓰기·manifest 갱신 없음).
// runUUID(evidence)와 scratch owner runId(DB 소유권)는 별개 식별자다.
// stdout·evidence에는 credential URL·원문 PG error·stack을 기록하지 않는다.
//
// 정리 원칙(scratch-db와 동일): 모든 검증이 통과해야만 owned DROP을
// 시도하고, 실패/불일치 시 retain해서 진단한다 — 추정 cleanup·recreate·
// 자동 재시도 없음. DROP 후 검증이 실패하면 dropCompleted=true와 함께
// FAIL로 기록하며 'retained'라고 거짓 표기하지 않는다.
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  createOwnedScratchDb,
  scratchDbUrl,
  type ScratchDb,
  type ScratchEvent,
} from "../tests/helpers/scratch-db.ts";
import {
  contractFromScratch,
  verifyOwnedExec,
  type IsolatedContract,
} from "../tests/helpers/isolated-db.ts";
import {
  prepareIsolatedDb,
  type SqlClient,
} from "../tests/helpers/isolated-prepare.ts";
import type { SeedExec } from "./base-seed.ts";
import {
  claimEvidenceFiles,
  reserveCaptureOutput,
  type EvidenceWriter,
} from "../tests/helpers/capture-output.ts";
import {
  snapDb,
  diffSnaps,
  parseRoDbUrl,
  RO_TABLES,
  RO_DB_OID,
  RO_DEV_DB_OID,
  type DbSnap,
} from "../tests/e2e/readonly-db.ts";

export const EVIDENCE_ROOT = "shots/isolated-smoke";

// planned 증거 산출물 전체 — dir 예약 직후 'wx'로 사전 claim한다. 충돌이
// 있으면 connect·scratch CREATE·어떤 DB 작업 전에 실패한다 [PMQA-054].
// fail-<stage>도 writeJson 경유로만 기록되므로 전부 미리 claim 목록에 있다.
export const SMOKE_EVIDENCE_SLOTS: readonly string[] = Object.freeze(
  [
    "manifest",
    "code-sha",
    "gate-pins",
    "snap-protected-before",
    "scratch-planned",
    "scratch-created",
    "scratch-identified",
    "scratch-contract",
    "fault-1",
    "prepare-1",
    "prepare-2",
    "fault-2",
    "precleanup",
    "cleanup",
    "snap-protected-afterdrop",
    "result",
    // fail-<stage> — stage 변수가 가질 수 있는 전체 값(12).
    "fail-manifest",
    "fail-gate-pins",
    "fail-snap-protected-before",
    "fail-scratch-create",
    "fail-owned-verify",
    "fail-fault-1",
    "fail-prepare-1",
    "fail-prepare-2",
    "fail-fault-2",
    "fail-precleanup",
    "fail-cleanup",
    "fail-snap-protected-afterdrop",
  ].map((s) => s + ".json"),
);

// ── 접속 전 env 게이트 ─────────────────────────────────────────────
export const SMOKE_OPTIN_ENV = "SCRATCH_DB_TESTS";
export const SMOKE_STRICT_ENV = "ISOLATED_STRICT";
export const SMOKE_ADMIN_ENV = "SCRATCH_ADMIN_URL";
// 외부 주입을 허용하면 혼동이 생기는 키 — 존재 자체가 거부다.
export const SMOKE_BLOCKED_ENV_KEYS = [
  "DATABASE_URL",
  "TEST_DB_URL",
  "ISOLATED_DB_URL",
  "ISOLATED_DB_NAME",
  "ISOLATED_DB_OID",
  "ISOLATED_DB_OWNER",
  "ISOLATED_RUN_ID",
  "SMOKE_OUTPUT_DIR",
  "SMOKE_EVIDENCE_DIR",
] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type EnvPlan =
  | { ok: true; adminUrl: string }
  | { ok: false; reasons: string[] };

/** raw source env 판정 — connect 전 단계. URL 원문은 reason에 넣지 않는다. */
export function planSmokeEnv(
  env: Record<string, string | undefined>,
): EnvPlan {
  const reasons: string[] = [];
  if (env[SMOKE_OPTIN_ENV] !== "1")
    reasons.push("opt-in 없음: " + SMOKE_OPTIN_ENV + "=1 필요");
  if (env[SMOKE_STRICT_ENV] !== "1")
    reasons.push("strict 없음: " + SMOKE_STRICT_ENV + "=1 필요");
  for (const k of SMOKE_BLOCKED_ENV_KEYS)
    if (env[k] !== undefined)
      reasons.push("외부 주입 env 거부(혼동 방지): " + k);
  const raw = env[SMOKE_ADMIN_ENV];
  if (raw === undefined || raw === "") {
    reasons.push(SMOKE_ADMIN_ENV + " 없음 — 명시 로컬 admin URL 필요");
  } else if (raw.includes("?") || raw.includes("#")) {
    reasons.push(SMOKE_ADMIN_ENV + " query/fragment 금지");
  } else {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      reasons.push(SMOKE_ADMIN_ENV + " 파싱 불가");
      u = null as unknown as URL;
    }
    if (u) {
      if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
        reasons.push(SMOKE_ADMIN_ENV + " 프로토콜 불일치");
      if (!LOCAL_HOSTS.has(u.hostname))
        reasons.push(SMOKE_ADMIN_ENV + " 로컬 호스트 외 거부");
      if (u.port !== "5432")
        reasons.push(SMOKE_ADMIN_ENV + " 포트 5432만 허용");
      if (u.pathname !== "/postgres")
        reasons.push(SMOKE_ADMIN_ENV + " 경로 /postgres만 허용");
    }
  }
  return reasons.length
    ? { ok: false, reasons }
    : { ok: true, adminUrl: raw as string };
}

// ── 승인 pin — 이 실행의 검증 기준(로컬 전용, 09 이식성 해소 아님) ──
// 호출자 주입 경로는 없다 — 이 3개 고정 파일만이 FILE gate다 [MJ052-5].
export const PINS: readonly { key: string; path: string; sha256: string }[] =
  Object.freeze([
    Object.freeze({
      key: "backup043",
      path: "shots/06a/pmqa043/commerce_test_prdump.sql",
      sha256:
        "8ca19650313ddec44b4a83a35afe5ed1d8efc24612ea3adc28b6955d9bdd0b57",
    }),
    Object.freeze({
      key: "facts047",
      path:
        "shots/06a/pmqa047-b3/run-8a3b977d-205c-494a-9ba1-7ab3c4f65a69/facts.json",
      sha256:
        "27c476f3ba8b51325b2fba1da32dad439eaadf2510bc64faa26380bd11962de5",
    }),
    Object.freeze({
      key: "audit048",
      path:
        "shots/06b/711d95bb-8f6a-46f6-a1e5-134a4dd109b9/audit-after.json",
      sha256:
        "b8d8e8594f352e2b8c7042519079ed8c874678970e1cce96d116f3af52d3dbd6",
    }),
  ]);

// 증거 대상 아티팩트 — 실행 전/후 sha256를 기록·재검증한다.
export const ARTIFACT_FILES: readonly string[] = Object.freeze([
  "scripts/isolated-smoke.ts",
  "tests/helpers/scratch-db.ts",
  "tests/helpers/isolated-db.ts",
  "tests/helpers/isolated-prepare.ts",
  "scripts/base-seed.ts",
  "db/migrations/001_catalog_cart_actions.sql",
  "db/migrations/002_orders_payments_shipments.sql",
  "db/migrations/003_cancel_requests.sql",
  "db/seeds/users.json",
  "db/seeds/catalog.json",
  "db/seeds/reviews.json",
  "db/seeds/scenarios.json",
]);

// 승인 048 감사의 고유 식별자 — 다른 run의 감사 파일은 대체 불가다.
export const APPROVED_AUDIT_RUN_ID =
  "711d95bb-8f6a-46f6-a1e5-134a4dd109b9";

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── 승인 048 감사 파일 검증(순수 함수) ─────────────────────────────
export function parseApprovedAudit(
  j: unknown,
):
  | { ok: true; after: DbSnap; afterDev: DbSnap }
  | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const f = j as Record<string, unknown> | null;
  if (!f || typeof f !== "object")
    return { ok: false, reasons: ["048 audit 파일이 객체가 아니다"] };
  // 정확히 승인된 048 run만 검증 기준이다 — 다른 run의 감사로 대체 불가.
  if (f.runId !== APPROVED_AUDIT_RUN_ID)
    reasons.push("runId 불일치 — 승인 048 감사가 아니다");
  const verdict = f.verdict as Record<string, unknown> | undefined;
  if (verdict?.pass !== true) reasons.push("verdict.pass != true");
  if (verdict?.exit !== 0) reasons.push("verdict.exit != 0");
  if (!Array.isArray(f.errors) || f.errors.length !== 0)
    reasons.push("errors가 비어있지 않다");
  if (f.gateOk !== true) reasons.push("gateOk != true");
  if (!Array.isArray(f.drift) || f.drift.length !== 0)
    reasons.push("drift가 비어있지 않다");
  if (!Array.isArray(f.driftDev) || f.driftDev.length !== 0)
    reasons.push("driftDev가 비어있지 않다");
  for (const spec of [
    ["after", "commerce_test", RO_DB_OID],
    ["afterDev", "commerce", RO_DEV_DB_OID],
  ] as const) {
    const [key, wantDb, wantOid] = spec;
    const s = f[key] as DbSnap | undefined;
    if (!s || typeof s !== "object") {
      reasons.push(key + " 스냅 부재");
      continue;
    }
    if (s.db !== wantDb) reasons.push(key + ".db != " + wantDb);
    if (s.oid !== wantOid)
      reasons.push(key + ".oid != " + String(wantOid));
    const tables = (s.tables ?? {}) as DbSnap["tables"];
    for (const t of RO_TABLES) {
      const x = tables[t];
      if (
        !x ||
        !Number.isInteger(x.n) ||
        x.n < 0 ||
        typeof x.h !== "string" ||
        // md5 지문은 32-hex거나 빈 문자열(빈 테이블)이다.
        !(/^[0-9a-f]{32}$/.test(x.h) || x.h === "")
      )
        reasons.push(key + ".tables." + t + " 부재/형식 오류");
    }
    if (!Array.isArray(s.writers) || s.writers.length !== 0)
      reasons.push(key + ".writers 비어있지 않다");
    if (s.writersError !== null)
      reasons.push(key + ".writersError != null");
    if (!Array.isArray(s.unreadableActive) || s.unreadableActive.length !== 0)
      reasons.push(key + ".unreadableActive 비어있지 않다");
  }
  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    after: f.after as DbSnap,
    afterDev: f.afterDev as DbSnap,
  };
}

// ── fault 주입 — 실제 txn q.unsafe 래핑(051 public hook 변경 없음) ──
export type AnyUnsafe = <T = Record<string, unknown>[]>(
  q: string,
  p?: unknown[],
) => Promise<T>;
export type UnsafeHook = (
  sql: string,
  params: unknown[] | undefined,
  orig: AnyUnsafe,
) => Promise<void>;

// canonical SQL이 orig로 실행 완료(await)된 뒤 hook을 호출한다. root
// client.unsafe는 감싸지 않는다 — autocommit write/probe 경로를 만들지 않는다.
export function wrapTxnUnsafe<Q extends { unsafe: AnyUnsafe }>(
  q: Q,
  hook: UnsafeHook,
): { unsafe: AnyUnsafe } {
  const orig = q.unsafe.bind(q) as AnyUnsafe;
  const wrapped: AnyUnsafe = async <T = Record<string, unknown>[]>(
    sql: string,
    params?: unknown[],
  ): Promise<T> => {
    const r = await orig<T>(sql, params);
    await hook(sql, params, orig);
    return r;
  };
  return { unsafe: wrapped };
}

export type FaultHooks = {
  hook: UnsafeHook;
  sentinel: Error;
  fired: () => boolean;
  observed: Record<string, unknown>;
};

// Fault-1: canonical 002 migration 본문 실행 완료 직후 sentinel throw —
// 001·002·_migrations 전체가 롤백되어 _scratch_owner만 남아야 한다.
export function makeFault1(migration002Body: string): FaultHooks {
  const sentinel = new Error("smoke fault-1 sentinel");
  let fired = false;
  return {
    sentinel,
    fired: () => fired,
    observed: {},
    hook: async (sql) => {
      if (fired || sql !== migration002Body) return;
      fired = true; // canonical 002 본문이 방금 실제로 실행 완료됐다
      throw sentinel;
    },
  };
}

// Fault-2: canonical payments INSERT 경계에서 같은 actual q 안에 probe
// products 1행 INSERT + SELECT exists=true 관측 후 sentinel throw —
// 관측 없이는 롤백 증명이 성립하지 않으므로 미관측은 sentinel이 아닌 오류다.
export function makeFault2(probeId: string): FaultHooks {
  const sentinel = new Error("smoke fault-2 sentinel");
  const observed: Record<string, unknown> = {};
  let fired = false;
  return {
    sentinel,
    fired: () => fired,
    observed,
    hook: async (sql, _p, orig) => {
      if (fired || !sql.startsWith("INSERT INTO payments (")) return;
      fired = true; // canonical payments INSERT가 방금 실행 완료됐다
      await orig(
        "INSERT INTO products (id,name,brand,category,description,image_urls,specs_json) " +
          "VALUES ($1,'smoke-probe','smoke','probe','','[]'::jsonb,'{}'::jsonb)",
        [probeId],
      );
      const [r] = await orig<{ e: boolean }[]>(
        "SELECT EXISTS(SELECT 1 FROM products WHERE id=$1) AS e",
        [probeId],
      );
      observed.exists = r.e === true;
      if (observed.exists !== true)
        throw safe(
          "fault-2 probe 행 미관측 — 롤백 검증 조건 불충족(sentinel 아님)",
        );
      throw sentinel;
    },
  };
}

// prepareIsolatedDb용 connect 래퍼 — begin 콜백 안의 txn q만 감싼다.
export type Connect = (url: string, o?: { max?: number }) => SqlClient;
export function faultedConnect(
  connect: Connect,
  fault: FaultHooks,
): Connect {
  return (url, opts) => {
    const c = connect(url, opts);
    return {
      unsafe: ((q: string, p?: unknown[]) =>
        c.unsafe(q, p)) as SqlClient["unsafe"], // root passthrough — 감싸지 않음
      begin: (fn) => c.begin((q) => fn(wrapTxnUnsafe(q, fault.hook))),
      end: c.end ? c.end.bind(c) : undefined,
    };
  };
}

// ── flag 불변 게이트 connect — 모든 unsafe를 동기 live recheck로 감싼다 ──
// prepare/fault 경로의 owned connect에 적용한다. txn 내부의 각 await 경계
// (verify/advisory lock/migration/seed)에서 flag가 소실돼도 다음 SQL dispatch
// 직전에 차단된다 — SQL 문자열 분류로 write만 골라 감싸면 댓글·다중문으로
// 우회되므로 모든 호출을 감싼다 [PMQA-052-C].
// txn 콜백 반환 직전에도 마지막으로 재검증해 '최후 SQL await 중 소실 → 정상
// 반환 → COMMIT' 경로를 닫는다 — 반환 뒤 드라이버가 실행하는 실제 COMMIT은
// JS 계약상 guard 불가(정직한 계약 한계로 기록) [Luna-052-C-a].
// 읽기 전용 roSnap·ownedTxn·사후 감사/probe 확인용 base connect는 감싸지 않는다.
export type GuardFn = () => void;
const isThenable = (v: unknown): boolean =>
  v !== null &&
  (typeof v === "object" || typeof v === "function") &&
  typeof (v as { then?: unknown }).then === "function";
export function guardedConnect(connect: Connect, guard: GuardFn): Connect {
  const sync = () => {
    const r = guard() as unknown;
    if (isThenable(r))
      throw safe("guard hook은 동기 계약 — thenable 반환 금지");
  };
  const gated =
    (orig: AnyUnsafe): AnyUnsafe =>
    (sql, params) => {
      sync(); // dispatch 직전 동기 검사 — 이 줄과 orig 호출 사이에 await 없음
      return orig(sql, params);
    };
  return (url, opts) => {
    const c = connect(url, opts);
    return {
      unsafe: gated(c.unsafe.bind(c) as AnyUnsafe) as SqlClient["unsafe"],
      begin: (fn) =>
        c.begin(async (q) => {
          const r = await fn({
            unsafe: gated(q.unsafe.bind(q) as AnyUnsafe) as SeedExec["unsafe"],
          } as SeedExec);
          sync(); // 콜백 최후 SQL await 중 소실도 COMMIT 전에 차단
          return r;
        }),
      end: c.end ? c.end.bind(c) : undefined,
    };
  };
}

// ── owned snapshot — scratch DB의 13테이블+marker 전체 지문 ────────
export type OwnedSnap = {
  tables: Record<string, { n: number; h: string }>;
  marker: { n: number; h: string };
};
export async function snapOwned(q: { unsafe: AnyUnsafe }): Promise<OwnedSnap> {
  const tables: OwnedSnap["tables"] = {};
  for (const t of RO_TABLES) {
    const [r] = await q.unsafe<{ n: number; h: string | null }[]>(
      "SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text))), '') AS h FROM " +
        t +
        " x",
    );
    tables[t] = { n: r.n, h: r.h ?? "" };
  }
  const [m] = await q.unsafe<{ n: number; h: string | null }[]>(
    "SELECT count(*)::int AS n, coalesce(md5(string_agg(run_id, '' ORDER BY run_id)), '') AS h FROM _scratch_owner",
  );
  return { tables, marker: { n: m.n, h: m.h ?? "" } };
}
export function diffOwned(a: OwnedSnap, b: OwnedSnap): string[] {
  const out: string[] = [];
  for (const t of RO_TABLES) {
    const x = a.tables[t];
    const y = b.tables[t];
    if (!x || !y) {
      out.push("owned 테이블 " + t + " 스냅 부재");
      continue;
    }
    if (x.n !== y.n) out.push(t + " count " + x.n + "→" + y.n);
    else if (x.h !== y.h) out.push(t + " 지문 변경");
  }
  if (a.marker.n !== b.marker.n || a.marker.h !== b.marker.h)
    out.push("marker 지문 변경");
  return out;
}

// ── sanitize — stdout/evidence에 credential·원문·stack 금지 ────────
// 자체 검증 오류(SmokeError)만 detail을 낸다 — 그 안에는 명시 검증된 안전
// 식별자(stage·테이블명·pin key·지문 요약)만 들어간다. 외부 오류(PG 원문·
// connect·readFile·writeJson·helper throw)는 name/message/stack/detail/
// query/params 전부 0이고 고정 category만 보고한다 [MJ052-4].
export class SmokeError extends Error {}
const safe = (m: string) => new SmokeError(m);
export type Sanitized = {
  code: "SMOKE" | "EXTERNAL";
  detail: string | null;
};
export function sanitizeErr(e: unknown): Sanitized {
  if (e instanceof SmokeError)
    return { code: "SMOKE", detail: e.message.slice(0, 300) };
  return { code: "EXTERNAL", detail: null };
}

// ── runner ────────────────────────────────────────────────────────
// user relation 전체 지문 — fault 롤백 검증은 table만이 아니라
// 공개 스키마의 모든 relation kind를 본다 — kind whitelist는 예상외 kind의
// 존재를 숨길 수 있으므로 둘지 않는다 [PMQA-052-C / Luna-052-C-b].
const RELS_SQL =
  "SELECT c.relname AS name, c.relkind AS kind FROM pg_class c " +
  "JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname='public' " +
  "ORDER BY c.relname, c.relkind";

// owner-only relation 기대값 — helper가 CREATE 직후 만드는 정확한 2행.
// 코드에 고정된 기대값이다 — 관측값을 'expected'로 채택하는 순환 검증 금지
// [PMQA-052-C]. extra/missing/kind 불일치는 fault/prepare/DROP 0으로 STOP.
const EXPECTED_OWNED_RELS: readonly { name: string; kind: string }[] = [
  { name: "_scratch_owner", kind: "r" },
  { name: "_scratch_owner_pkey", kind: "i" },
];

export type SmokeDeps = {
  env?: Record<string, string | undefined>;
  connect?: Connect;
  readFile?: (p: string) => Buffer;
  writeJson?: (stage: string, obj: unknown) => Promise<void>;
  // planned 산출물 사전 claim — 주입이 없으면 wx 독점 생성으로 claim한다.
  // claim 실패는 connect·DB 작업 전 'evidence-claim' 실패다 [PMQA-054].
  claimFiles?: (
    dir: string,
    names: readonly string[],
  ) => Promise<EvidenceWriter>;
  reserveDir?: (root: string, runUUID: string) => Promise<string>;
  out?: (line: string) => void;
};

export type SmokeResult = {
  ok: boolean;
  stage: string;
  reason?: string;
  dir?: string;
  dbName?: string;
  retainedDb?: string;
  candidateDbName?: string;
  dropCompleted?: boolean;
  // scratch 생애주기 — retainedDb 거짓 보고 방지 [MJ052-3].
  //   notAttempted            planned 기록 실패 등으로 CREATE 자체 미실행
  //   creationOutcomeUnknown  CREATE 요청은 나갔으나 응답/기록 실패 — 실존 여부 불명
  //   createdKnown            CREATE 관측(또는 handle 보유) 후 실패 — 확정 잔존
  //   dropped                 DROP 완료 — 후속 오류도 'retained'로 표기하지 않는다
  scratchState?:
    | "notAttempted"
    | "creationOutcomeUnknown"
    | "createdKnown"
    | "dropped";
  // evidence handle 해제 자체의 오류 — 미기록 claim retain과 별개로 close
  // 실패를 기록한다(조용한 성공 금지) [PMQA-054/Luna QA-3].
  closeError?: string;
};

export async function runSmoke(deps: SmokeDeps = {}): Promise<SmokeResult> {
  // pins 주입 경로는 없다 — 고정 PINS만이 승인 baseline이다 [MJ052-5].
  if (Object.prototype.hasOwnProperty.call(deps, "pins"))
    return {
      ok: false,
      stage: "gate-env",
      reason: "pins 주입 금지 — 고정 PINS만이 검증 기준",
    };
  const envSource = deps.env ?? process.env;
  const out = deps.out ?? (() => {});
  const read = deps.readFile ?? ((p: string) => readFileSync(p));
  const connect: Connect =
    deps.connect ??
    ((url, o) => postgres(url, o) as unknown as SqlClient);
  const result: SmokeResult = { ok: false, stage: "gate-env" };

  // 1) env 게이트 — connect·evidence보다 먼저. 어떤 DB 접속도 만들지 않는다.
  const plan = planSmokeEnv(envSource);
  if (!plan.ok) {
    result.reason = plan.reasons.join(" | ");
    out("FAIL gate-env: " + result.reason);
    return result;
  }
  const adminUrl = plan.adminUrl;
  // raw source(deps.env)와 실제 global(process.env) 둘 다 매 민감 단계 직전에
  // 재검증한다 — 초기 gate 이후 flag 소실·adminUrl 변화·외부 계약 주입이 있으면
  // STOP이고 후속 write/cleanup은 0이다. source/global env 자체는 절대 쓰지
  // 않고 복원도 하지 않는다 [MJ052-2].
  const recheck = () => {
    const a = planSmokeEnv(envSource);
    if (!a.ok) throw safe("env source 소실: " + a.reasons.join(" | "));
    if (a.adminUrl !== adminUrl)
      throw safe("env source adminUrl 변경 — 초기 승인값과 상이");
    const g = planSmokeEnv(process.env);
    if (!g.ok) throw safe("global env 소실: " + g.reasons.join(" | "));
    if (g.adminUrl !== adminUrl)
      throw safe("global adminUrl 변경 — 초기 승인값과 상이");
  };
  // prepare/fault 경로의 owned connect — 모든 unsafe(root+txn)가 동기
  // recheck로 감싸진다. txn 내부 await 경계(verify/advisory lock/migration/
  // seed·최후 SQL→COMMIT 전)의 flag 소실을 차단한다 [PMQA-052-C / Luna-a].
  // 읽기 전용 roSnap·ownedTxn·probe 확인용 connect는 감싸지 않는다.
  const ownedConnect = guardedConnect(connect, recheck);
  try {
    recheck();
  } catch (e) {
    result.reason = sanitizeErr(e).detail ?? "env 재검증 실패";
    out("FAIL gate-env: " + result.reason);
    return result;
  }

  // 2) evidence dir — collision은 DB 접속 전에 실패한다(기존 증거 덮어쓰기 0).
  const runUUID = randomUUID();
  let dir: string;
  try {
    dir = await (deps.reserveDir ??
      ((root: string, id: string) => reserveCaptureOutput(root, id)))(
      EVIDENCE_ROOT,
      runUUID,
    );
  } catch (e) {
    result.stage = "evidence-reserve";
    result.reason = "EXTERNAL — 원문 미기록(자체 검증 오류만 detail 기록)";
    out("FAIL evidence-reserve: " + result.reason);
    return result;
  }
  result.dir = dir;
  // planned 산출물 전체 사전 claim — 기존 파일과 충돌하면 connect·scratch
  // CREATE·어떤 DB 작업 전에 'evidence-claim'으로 멈춘다 [PMQA-054].
  let evWriter: EvidenceWriter | undefined;
  try {
    evWriter = await (deps.claimFiles ?? claimEvidenceFiles)(
      dir,
      SMOKE_EVIDENCE_SLOTS,
    );
  } catch (e) {
    result.stage = "evidence-claim";
    result.reason = "EXTERNAL — 산출물 claim 실패(원문 미기록으로 detail 기록)";
    out("FAIL evidence-claim: " + result.reason);
    return result;
  }
  const writeJson: NonNullable<SmokeDeps["writeJson"]> =
    deps.writeJson ??
    (async (stage: string, obj: unknown) => {
      await evWriter!.writeJson(stage + ".json", obj);
    });

  let handle: ScratchDb | undefined;
  let contract: IsolatedContract | undefined;
  let plannedDbName: string | undefined;
  let createAttempted = false;
  let createdObserved = false;
  let stage = "manifest";
  const fail = async (e: unknown): Promise<SmokeResult> => {
    const s = sanitizeErr(e);
    result.ok = false;
    result.stage = stage;
    // 외부 오류는 stage+고정 category만 — 원문·credential·stack 기록 0.
    result.reason =
      s.code === "SMOKE"
        ? (s.detail ?? "")
        : "EXTERNAL — 원문 미기록(자체 검증 오류만 detail 기록)";
    result.dbName = contract?.dbName ?? plannedDbName;
    // scratch 생애주기에 따라 잔존 상태를 정확히 구분한다 — planned 기록
    // 실패로 CREATE가 나가지 않았는데 '보존 DB 있다'는 거짓 보고를 하지 않는다
    // [MJ052-3].
    if (result.dropCompleted) {
      result.scratchState = "dropped"; // DROP 완료 후 후속 실패
    } else if (handle || createdObserved) {
      result.retainedDb = contract?.dbName ?? plannedDbName;
      result.scratchState = "createdKnown";
    } else if (createAttempted) {
      // CREATE 요청은 나갔지만 응답이 없다 — 추정 삭제·재생성 0.
      result.candidateDbName = plannedDbName;
      result.scratchState = "creationOutcomeUnknown";
    } else {
      result.scratchState = "notAttempted";
    }
    try {
      await writeJson("fail-" + stage, {
        stage,
        error: s,
        scratchState: result.scratchState,
        retainedDb: result.retainedDb ?? null,
        candidateDbName: result.candidateDbName ?? null,
        dropCompleted: result.dropCompleted ?? false,
      });
    } catch {
      /* evidence 기록 실패는 진단을 덮지 않는다 */
    }
    out("FAIL " + stage + ": " + result.reason);
    return result;
  };

  // 보호 DB RO 스냅 — startup GUC + txn 첫 query SET TRANSACTION,
  // name/OID·writer·unreadable을 매번 검증한다.
  const roSnap = async (db: string, wantOid: number): Promise<DbSnap> => {
    const url = parseRoDbUrl(scratchDbUrl(adminUrl, db), db);
    const c = connect(url, { max: 1 });
    try {
      return await c.begin(async (q) => {
        await q.unsafe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const s = await snapDb(q);
        if (s.db !== db || s.oid !== wantOid)
          throw safe(
            "보호 DB identity 불일치: " + s.db + "#" + s.oid,
          );
        if (s.writersError !== null || s.writers.length)
          throw safe("보호 DB write 세션 탐지/실패 — STOP");
        if (s.unreadableActive.length)
          throw safe("보호 DB query 열람 불가 세션 — STOP");
        return s;
      });
    } finally {
      await c.end?.();
    }
  };

  const ownedTxn = async <T>(fn: (q: { unsafe: AnyUnsafe }) => Promise<T>) => {
    const c = connect(contract!.dbUrl, { max: 1 });
    try {
      return await c.begin(async (q) => {
        await q.unsafe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return await fn(q);
      });
    } finally {
      await c.end?.();
    }
  };

  try {
    // manifest + 코드 sha — 한 번만 쓰고 갱신하지 않는다.
    const codeSha: Record<string, string> = {};
    for (const f of ARTIFACT_FILES) codeSha[f] = sha256Hex(read(f));
    await writeJson("manifest", {
      kind: "isolated-smoke",
      runUUID,
      pins: PINS.map((p) => ({ key: p.key, path: p.path })),
    });
    await writeJson("code-sha", { files: codeSha });

    // pin 검증 — 승인 043/047 파일 sha와 048 audit의 sha·구조·내용.
    stage = "gate-pins";
    let auditJson: unknown;
    for (const p of PINS) {
      const buf = read(p.path);
      if (sha256Hex(buf) !== p.sha256)
        throw safe("pin sha256 불일치: " + p.key);
      if (p.key === "audit048") auditJson = JSON.parse(buf.toString("utf8"));
    }
    const audit = parseApprovedAudit(auditJson);
    if (!audit.ok)
      throw safe("048 audit 승인 구조 거부: " + audit.reasons.join(" | "));
    await writeJson("gate-pins", { ok: true });

    // 보호 before — 승인 048 after/afterDev와 exact match일 때만 CREATE.
    stage = "snap-protected-before";
    const beforeT = await roSnap("commerce_test", RO_DB_OID);
    const beforeD = await roSnap("commerce", RO_DEV_DB_OID);
    const drift = [
      ...diffSnaps(beforeT, audit.after),
      ...diffSnaps(beforeD, audit.afterDev),
    ];
    if (drift.length)
      throw safe(
        "live 보호 DB가 승인 048 after와 다름 — CREATE 거부: " +
          drift.join(" | "),
      );
    {
      const adm = connect(adminUrl, { max: 1 });
      try {
        const rows = await adm.unsafe<{ datname: string }[]>(
          "SELECT datname FROM pg_database WHERE datname=$1",
          ["commerce_demo_verify"],
        );
        if (rows.length !== 0)
          throw safe("demo_verify 존재 — CREATE 거부");
      } finally {
        await adm.end?.();
      }
    }
    await writeJson("snap-protected-before", {
      test: beforeT,
      dev: beforeD,
      pinnedMatch: true,
    });

    // scratch CREATE — 단계 이벤트가 wx로 기록된다. created/identified
    // 기록 실패는 create 자체를 throw시켜 retain+STOP(추정 cleanup 0).
    // 생애주기 추적 [MJ052-3]: createAttempted는 planned 기록 await와
    // env 재검증이 끝난 'CREATE가 실제로 나가는 지점'을 표시한다 — 그 뒤
    // 'created' 이벤트 관측까지가 CREATE 시도 구간이다. planned 기록
    // await 뒤 CREATE 직전에 env source/global을 재검증한다 [MJ052-2].
    stage = "scratch-create";
    recheck();
    const events = async (e: ScratchEvent) => {
      if (e.stage === "planned") plannedDbName = e.dbName;
      if (e.stage === "created") createdObserved = true;
      await writeJson("scratch-" + e.stage, e);
      if (e.stage === "planned") {
        recheck(); // planned 기록 await 직후 — CREATE 직전 재검증
        createAttempted = true;
      }
    };
    handle = await createOwnedScratchDb(adminUrl, {
      // Connect(SqlClient) → scratch Connect(SqlLike) — end 필수 여부만 다르다.
      connect: connect as unknown as NonNullable<
        NonNullable<Parameters<typeof createOwnedScratchDb>[1]>["connect"]
      >,
      events,
      // runner의 source+global 불변 재검증 — helper가 각 mutation SQL 직전에
      // await 없이 동기 호출한다(더 제한하는 hook이며 허용 권한은 없다) [052-C].
      guard: recheck,
    });
    contract = contractFromScratch(handle);
    result.dbName = contract.dbName;
    await writeJson("scratch-contract", {
      dbName: contract.dbName,
      dbOid: contract.dbOid,
      dbOwner: contract.dbOwner,
    });

    // 소유권 실측 — 새 연결의 첫 query가 read-only 검증이다.
    stage = "owned-verify";
    {
      const oc = connect(contract.dbUrl, { max: 1 });
      try {
        const v = await verifyOwnedExec(oc, contract);
        if (!v.ok) throw safe("소유권 실측 거부: " + v.reason);
      } finally {
        await oc.end?.();
      }
    }
    // CREATE 직후 owner-only 상태의 user relation baseline — fault-1 롤백
    // 검증의 기준이다. prepare가 아무것도 만들기 전 최초 1회만 측정한다.
    const relBase = await ownedTxn((q) =>
      q.unsafe<{ name: string; kind: string }[]>(RELS_SQL),
    );
    // baseline은 코드 정의 owner-only 2행과 정확히 같아야 한다 — 관측값을
    // 그대로 'expected'로 채택하는 순환 검증은 금지한다 [PMQA-052-C].
    // RELS_SQL은 public 스키마의 모든 kind를 수집하므로 whitelist 밖의 예상외
    // relation도 누락되지 않는다. 불일치 시 fault/prepare/DROP 0으로 STOP·retain.
    if (
      relBase.length !== EXPECTED_OWNED_RELS.length ||
      !EXPECTED_OWNED_RELS.every(
        (e, i) =>
          relBase[i] !== undefined &&
          relBase[i]!.name === e.name &&
          relBase[i]!.kind === e.kind,
      )
    )
      throw safe(
        "owner-only relation baseline 불일치 — fault/prepare/DROP 0: " +
          JSON.stringify(relBase),
      );
    // 자식 env의 flag는 현재 source에서만 값을 복사한다 — 초기 gate 시점의
    // 하드코딩으로 소실된 권한을 복원하지 않는다 [MJ052-2]. ISOLATED_* 계약
    // 값은 이 실행이 방금 실측한 contract에서만 온다.
    const childEnv = (): Record<string, string> => ({
      [SMOKE_OPTIN_ENV]: envSource[SMOKE_OPTIN_ENV]!,
      [SMOKE_STRICT_ENV]: envSource[SMOKE_STRICT_ENV]!,
      ISOLATED_DB_URL: contract!.dbUrl,
      ISOLATED_DB_NAME: contract!.dbName,
      ISOLATED_DB_OID: String(contract!.dbOid),
      ISOLATED_DB_OWNER: String(contract!.dbOwner),
      ISOLATED_RUN_ID: contract!.runId,
    });

    // Fault-1 — canonical 002 본문 실행 완료 후 sentinel. catch는
    // '동일 객체'만 통과시키고 다른 오류는 그대로 STOP(흡수 금지).
    stage = "fault-1";
    recheck();
    const f1 = makeFault1(
      read("db/migrations/002_orders_payments_shipments.sql").toString("utf8"),
    );
    try {
      await prepareIsolatedDb(childEnv(), {
        connect: faultedConnect(ownedConnect, f1),
      });
      throw safe("fault-1에서 prepare가 성공 — sentinel 미발생");
    } catch (e) {
      if (e !== f1.sentinel) throw e;
    }
    // 롤백 후 user relation은 baseline과 정확히 같아야 한다 — table만이
    // 아니라 view/sequence/index 등 전체 kind를 대조한다 [MJ052 정합].
    const relAfter1 = await ownedTxn((q) =>
      q.unsafe<{ name: string; kind: string }[]>(RELS_SQL),
    );
    if (JSON.stringify(relAfter1) !== JSON.stringify(relBase))
      throw safe(
        "fault-1 롤백 후 user relation 불일치: " + JSON.stringify(relAfter1),
      );
    await writeJson("fault-1", {
      sentinelCaught: true,
      relationsBaseline: relBase,
      relationsAfterRollback: relAfter1,
      equal: true,
    });

    // canonical prepare → owned fp-A.
    stage = "prepare-1";
    recheck();
    const p1 = await prepareIsolatedDb(childEnv(), { connect: ownedConnect });
    const fpA = await ownedTxn((q) => snapOwned(q));
    await writeJson("prepare-1", {
      migrations: p1.migrations,
      seededFiles: p1.seededFiles,
      fp: fpA,
    });

    // 반복 prepare — 결과·지문 모두 동일해야 한다(idempotent).
    stage = "prepare-2";
    recheck();
    const p2 = await prepareIsolatedDb(childEnv(), { connect: ownedConnect });
    const fpB = await ownedTxn((q) => snapOwned(q));
    const dRepeat = diffOwned(fpA, fpB);
    if (dRepeat.length)
      throw safe("반복 prepare 비등冪: " + dRepeat.join(" | "));
    if (
      JSON.stringify(p1.migrations) !== JSON.stringify(p2.migrations) ||
      JSON.stringify(p1.seededFiles) !== JSON.stringify(p2.seededFiles)
    )
      throw safe("반복 prepare 결과 불일치");
    await writeJson("prepare-2", { idempotent: true });

    // Fault-2 — payments INSERT 경계 probe. probe 미관측·sentinel 외
    // 오류는 그대로 STOP이다.
    stage = "fault-2";
    recheck();
    const probeId = "p-smoke-" + runUUID.replaceAll("-", "").slice(0, 12);
    const f2 = makeFault2(probeId);
    try {
      await prepareIsolatedDb(childEnv(), {
        connect: faultedConnect(ownedConnect, f2),
      });
      throw safe("fault-2에서 prepare가 성공 — sentinel 미발생");
    } catch (e) {
      if (e !== f2.sentinel) throw e;
    }
    if (f2.observed.exists !== true)
      throw safe("fault-2 probe 관측 부재 — 롤백 검증 불충분");
    {
      const oc = connect(contract.dbUrl, { max: 1 });
      try {
        const [r] = await oc.unsafe<{ e: boolean }[]>(
          "SELECT EXISTS(SELECT 1 FROM products WHERE id=$1) AS e",
          [probeId],
        );
        if (r.e === true)
          throw safe("fault-2 probe가 롤백되지 않고 잔존");
      } finally {
        await oc.end?.();
      }
    }
    const fpC = await ownedTxn((q) => snapOwned(q));
    const dFault = diffOwned(fpA, fpC);
    if (dFault.length)
      throw safe("fault-2 후 지문 불일치: " + dFault.join(" | "));
    await writeJson("fault-2", {
      sentinelCaught: true,
      probeObservedInsideTxn: true,
      probeRolledBack: true,
    });

    // precleanup — 보호 DB drift 0 + 코드/pin sha 불변. drift가 있어도 실측
    // 2DB 스냅·개별 drift 배열을 먼저 저장한다 — fail을 PASS로 바꾸지 않고
    // 측정 자료를 보존한다 [PMQA-052-C / Luna-052-C-c].
    stage = "precleanup";
    const preT = await roSnap("commerce_test", RO_DB_OID);
    const preD = await roSnap("commerce", RO_DEV_DB_OID);
    const dPreT = diffSnaps(beforeT, preT);
    const dPreD = diffSnaps(beforeD, preD);
    const artifactDrift: string[] = [];
    for (const f of ARTIFACT_FILES)
      if (sha256Hex(read(f)) !== codeSha[f]) artifactDrift.push(f);
    const pinDrift: string[] = [];
    for (const p of PINS)
      if (sha256Hex(read(p.path)) !== p.sha256) pinDrift.push(p.key);
    const preOk =
      dPreT.length === 0 &&
      dPreD.length === 0 &&
      artifactDrift.length === 0 &&
      pinDrift.length === 0;
    await writeJson("precleanup", {
      pass: preOk,
      test: preT,
      dev: preD,
      driftTest: dPreT,
      driftDev: dPreD,
      artifactDrift,
      pinDrift,
    });
    if (!preOk)
      throw safe(
        "precleanup 검증 실패: " +
          [
            ...dPreT,
            ...dPreD,
            ...artifactDrift.map((f) => "artifact 변경 " + f),
            ...pinDrift.map((k) => "pin 변경 " + k),
          ].join(" | "),
      );

    // cleanup — 모든 검증 통과 후에만 owned DROP. 실패 시 retain.
    stage = "cleanup";
    recheck(); // DROP 직전 env source/global 재검증 [MJ052-2]
    await handle.cleanup();
    result.dropCompleted = true;
    {
      const adm = connect(adminUrl, { max: 1 });
      try {
        const rows = await adm.unsafe<{ datname: string }[]>(
          "SELECT datname FROM pg_database WHERE datname=$1",
          [contract.dbName],
        );
        if (rows.length !== 0)
          throw safe("DROP 후에도 DB 잔존: " + contract.dbName);
      } finally {
        await adm.end?.();
      }
    }
    await writeJson("cleanup", { dropped: contract.dbName });

    // afterDROP — 보호 DB 최종 확인. 여기서 실패해도 dropCompleted는 true다.
    // precleanup과 동일하게 실측 스냅·drift 배열을 먼저 저장한다 [052-C].
    stage = "snap-protected-afterdrop";
    const postT = await roSnap("commerce_test", RO_DB_OID);
    const postD = await roSnap("commerce", RO_DEV_DB_OID);
    const dPostT = diffSnaps(beforeT, postT);
    const dPostD = diffSnaps(beforeD, postD);
    const postOk = dPostT.length === 0 && dPostD.length === 0;
    await writeJson("snap-protected-afterdrop", {
      pass: postOk,
      test: postT,
      dev: postD,
      driftTest: dPostT,
      driftDev: dPostD,
    });
    if (!postOk)
      throw safe(
        "DROP 후 보호 DB drift: " + [...dPostT, ...dPostD].join(" | "),
      );

    stage = "done";
    result.stage = "done";
    result.scratchState = "dropped";
    await writeJson("result", {
      ok: true,
      runUUID,
      dbName: contract.dbName,
      dropCompleted: true,
      scratchState: "dropped",
    });
    return result;
  } catch (e) {
    return await fail(e);
  } finally {
    // claim 이후 어떤 경로(PASS·stage 실패·throw)로 끝나도 claim handle을
    // 해제한다. 해제 오류는 삼키지 않고 closeError로 기록한다 — PASS 경로의
    // 해제 실패는 결과를 FAIL로 뒤집는다 [PMQA-054/Luna QA-3].
    if (evWriter) {
      try {
        await evWriter.close();
      } catch (e) {
        const s = sanitizeErr(e);
        result.closeError =
          s.code === "SMOKE"
            ? (s.detail ?? "evidence close 실패")
            : "EXTERNAL — evidence close 실패";
        result.ok = false;
        if (result.stage === "done") {
          result.ok = false;
          result.stage = "evidence-close";
          result.reason = result.closeError;
        }
        out("FAIL evidence-close: " + result.closeError);
      }
    }
    // stdout PASS·result.ok는 drain+close 성공 후에만 표현한다 — close 실패와
    // native exit 전에는 어떤 경로도 최종 PASS를 주장하지 않는다 [PM].
    // ok:true 증거의 모순을 막는다 [PMQA-054/PM 보완]. result.json 파일 자체의
    // 해제 실패까지는 보장 한계다 — verdict는 'write+close 전부 성공'의 더
    // 엄격한 계약이고 파일 존재/내용만으로는 성공 판정이 아니다.
    if (result.stage === "done" && !result.closeError) {
      result.ok = true;
      out("PASS " + contract!.dbName);
    }
  }
}

// CLI — 승인된 실행에서만 사용. credential은 출력하지 않는다.
const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  // PMQA-055: standalone 실행은 broker 통합 전 — NOT_READY로 실행 전 거부.
  const { assertEntryRunnable } = await import(
    "../tests/helpers/pw-config-gate.ts"
  );
  assertEntryRunnable("scripts/isolated-smoke.ts");
  const r = await runSmoke({ env: process.env, out: (l) => console.log(l) });
  process.exit(r.ok ? 0 : 1);
}
