// 06B 전용 읽기 검증 — DB 계약·스냅샷·drift 비교 [PMQA-048-B0].
// 이 파일은 어떤 DB 변경 경로도 호출하지 않는다 — restricted reset/evaluate/
// seed 등 mutation 연결 경로는 이 모듈에 존재하지 않는다.
//
// URL 계약: postgres://…@localhost:5432/{commerce_test|commerce} 만 허용하고,
// query param은 default_transaction_read_only=on 하나만 통과한다(database= 등
// override 금지). 최종 URL은 래퍼·감사 연결 모두가 사용해 startup GUC가 모든
// 연결에 적용된다.
//
// 스냅샷: B1 실행 직전 현재 상태를 RR READONLY 트랜잭션에서 13테이블 전체 내용
// 지문+건수로 예약 증거로 저장하고, 종료 후 같은 스냅샷과 exact 비교해 변화 0을
// 요구한다. commerce_test(서버 대상)와 commerce(dev, 감시 전용) 둘 다 잰다.
// 043 dump와 live 내용 비교는 하지 않는다 — dump는 verifyBackupFile의 파일
// 무결성(존재+SHA) 확인에만 쓴다.
//
// before gate: 047 최종 승인 강화 감사 — 정확히 하나의 고정 증거 파일
// (run-8a3b977d…/facts.json, SHA256 pin)이 정한 '실제 보존 집합/지문'과
// live를 대조한다 — 보호 77행 지문(carts.updated_at 제외), 보존 36 action
// 전체 내용 지문(payload 변조 탐지), 신규 12 orders·2 cancels·116 actions의
// ID 집합+종속 연결+건수. 하나라도 빠지면 child를 시작하지 않는다.
// 대조 범위 주의: 신규 116 actions는 047 승인 시점의 전체 payload 지문 증거가
// 없으므로 ID 집합·order_ref 연결·건수만 본다 — '047 이후 전체 payload
// 불변' 주장은 하지 않는다. B1이 실제 증명하는 것은 실행 직전 before ↔
// 종료 후 after의 13테이블 전체 지문 0 변화다 [Luna B0 재검수].
// pmqa047-b3 아래의 나머지 run 디렉터리는 이력 보존 자료다 — 오류 정정 전
// 감사·필드 미포함 구버전·facts 없는 E2E 산출물이 섞여 있어 검증 기준에서
// 제외한다(삭제는 하지 않는다) [PM B0 정정].
import type { ProtectedRow } from "../helpers/testdb.ts";

export type Q = {
  unsafe: <T = Record<string, unknown>[]>(
    q: string,
    p?: unknown[],
  ) => Promise<T>;
};

export const RO_DB = "commerce_test";
export const RO_DB_OID = 16516; // commerce_test의 pg_database.oid
export const RO_DEV_DB = "commerce";
export const RO_DEV_DB_OID = 16384; // dev DB — 서버는 붙지 않고 감시 대상이다
const RO_HOSTS = new Set(["localhost", "127.0.0.1"]);
const RO_PORT = "5432";
const RO_GUC_KEY = "default_transaction_read_only";
const RO_GUC_VAL = "on";

// DATABASE_URL → readonly GUC가 보장된 최종 URL. 허용 범위 밖이면 즉시 throw.
// expectedDb는 호출자가 의도한 대상 — URL pathname과 정확히 일치해야 한다.
export function parseRoDbUrl(
  raw: string | undefined | null,
  expectedDb: string = RO_DB,
): string {
  if (!raw) throw new Error("readonly: DATABASE_URL 없음 — embedded/.env fallback 금지");
  const u = new URL(raw);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
    throw new Error("readonly: postgres URL 아님: " + u.protocol);
  if (!RO_HOSTS.has(u.hostname))
    throw new Error("readonly: 허용 호스트 아님 — localhost/127.0.0.1만: " + u.hostname);
  if (u.port !== RO_PORT)
    throw new Error("readonly: 허용 포트 아님 — " + RO_PORT + "만: " + u.port);
  if (u.pathname !== "/" + expectedDb)
    throw new Error(
      "readonly: 대상 DB pathname 불일치 — /" + expectedDb + "만: " + u.pathname,
    );
  for (const [k, v] of u.searchParams)
    if (k !== RO_GUC_KEY || v !== RO_GUC_VAL)
      throw new Error(
        "readonly: 허용되지 않는 URL param " + k + "=" + v +
          " — " + RO_GUC_KEY + "=on 만 허용",
      );
  u.searchParams.set(RO_GUC_KEY, RO_GUC_VAL);
  return u.toString();
}

// 전체 내용 지문 대상 — 스키마 12테이블 + _migrations = 13. 고정 목록이라
// 테이블명 인젝션 경로가 없다.
export const RO_TABLES = [
  "users", "products", "product_variants", "reviews",
  "carts", "cart_items", "action_requests",
  "orders", "order_items", "payments", "shipments", "cancel_requests",
  "_migrations",
] as const;

// write 가능 세션 탐지 — backend_xid 보유(FOR UPDATE 포함, state 무관) 또는
// '지금 활성'인 write 쿼리. 쿼리 텍스트는 마지막 실행문을 남기므로 idle
// 세션의 과거 write를 오탐하지 않게 state='active'를 명시한다 [PM B0 검수].
// word boundary는 backslash 계열(\m)이 아니라 POSIX [[:<:]]/[[:>:]]를 쓴다 —
// 도구·인코딩 경로에서 backslash가 소실되면 정규식이 조용히 죽기 때문에
// 경계 문자가 없는 형태를 택한다.
// 이 쿼리 자체가 실패하면 탐지 불능이다 — 통과로 간주하지 않고 writersError로
// 기록한다.
export const RO_WRITER_SQL =
  "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND (backend_xid IS NOT NULL OR (state = 'active' AND query ~* '[[:<:]](INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|LOCK|GRANT|REVOKE|VACUUM)[[:>:]]'))";

// 권한상 query 텍스트를 열람할 수 없는 '활성' 세션 — 무엇을 실행 중인지
// 증명할 수 없으므로 안전 통과로 간주하지 않고 별도로 보고한다.
export const RO_UNREADABLE_SQL =
  "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND query IS NULL";

export type TableSnap = { n: number; h: string };
export type DbSnap = {
  db: string;
  oid: number;
  at: string;
  tables: Record<string, TableSnap>;
  writers: number[];
  writersError: string | null; // 탐지 쿼리 실패 — 성공 0건과 구분한다
  unreadableActive: number[];  // query 열람 불가 활성 세션 — 안전 PASS 아님
};

// REPEATABLE READ READ ONLY 트랜잭션 안에서 호출한다 — 모든 SELECT가 같은
// 스냅샷을 본다.
export async function snapDb(q: Q): Promise<DbSnap> {
  const [id] = await q.unsafe<{ d: string; oid: number }[]>(
    "SELECT current_database() AS d, (SELECT oid::int FROM pg_database WHERE datname = current_database()) AS oid",
  );
  const tables: Record<string, TableSnap> = {};
  for (const t of RO_TABLES) {
    const [r] = await q.unsafe<{ n: number; h: string | null }[]>(
      "SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text))), '') AS h FROM " + t + " x",
    );
    tables[t] = { n: r.n, h: r.h ?? "" };
  }
  let writers: number[] = [];
  let writersError: string | null = null;
  try {
    const rows = await q.unsafe<{ pid: number }[]>(RO_WRITER_SQL);
    writers = rows.map((w) => w.pid);
  } catch (e) {
    writersError = String(e); // 탐지 실패를 PASS와 혼동하지 않는다 [Luna B0]
  }
  let unreadableActive: number[] = [];
  try {
    const rows = await q.unsafe<{ pid: number }[]>(RO_UNREADABLE_SQL);
    unreadableActive = rows.map((w) => w.pid);
  } catch (e) {
    writersError = (writersError ?? "") + " | unreadable: " + String(e);
  }
  return {
    db: id.d,
    oid: id.oid,
    at: new Date().toISOString(),
    tables,
    writers,
    writersError,
    unreadableActive,
  };
}

// before/after exact 비교 — 어떤 테이블의 건수·내용 지문·DB identity라도
// 다르면 drift로 보고한다(순수 함수 — DB 없이 검증 가능).
export function diffSnaps(a: DbSnap, b: DbSnap): string[] {
  const out: string[] = [];
  if (a.db !== b.db || a.oid !== b.oid)
    out.push("DB identity 변경 " + a.db + "#" + a.oid + " → " + b.db + "#" + b.oid);
  for (const t of RO_TABLES) {
    const x = a.tables[t];
    const y = b.tables[t];
    if (!x || !y) {
      out.push(
        "테이블 " + t + " 스냅 부재 (before=" + (x ? "ok" : "없음") +
          "/after=" + (y ? "ok" : "없음") + ")",
      );
      continue;
    }
    if (x.n !== y.n) out.push(t + " count " + x.n + " → " + y.n);
    else if (x.h !== y.h) out.push(t + " 내용 지문 변경 (count 동일 " + x.n + ")");
  }
  // writer 탐지 자체가 실패하면 'write 세션 없음'을 증명하지 못한다 — 실패로.
  if (a.writersError || b.writersError)
    out.push(
      "writer 세션 탐지 실패 (before=" + (a.writersError ?? "ok") +
        ", after=" + (b.writersError ?? "ok") + ")",
    );
  if (a.writers.length || b.writers.length)
    out.push(
      "write 가능 세션 존재: before [" + a.writers.join(",") +
        "] after [" + b.writers.join(",") + "]",
    );
  // query 열람 불가 활성 세션은 '없음'이 아니라 '증명 불가'다 — 보고한다.
  if (a.unreadableActive.length || b.unreadableActive.length)
    out.push(
      "query 열람 불가 활성 세션 존재(안전 PASS 아님): before [" +
        a.unreadableActive.join(",") + "] after [" +
        b.unreadableActive.join(",") + "]",
    );
  return out;
}

// 승인 baseline 무결성 — 047 감사의 보존 action 36 ID가 스냅 안에 그대로
// 있는지. 내용 변조는 지문 검증이 보장하고, 여기선 '존재 지속'만 본다.
export function preservedActionsPresent(
  snapRows: { id: string }[],
  preserved: readonly string[],
): string[] {
  const have = new Set(snapRows.map((r) => r.id));
  return preserved
    .filter((id) => !have.has(id))
    .map((id) => "보존 action 부재: " + id);
}

// ── 047 승인 증거 기준 live gate ─────────────────────────────────────
// 기준은 043 dump가 아니라 047 실행 직후 승인된 facts.json의 post 검증값이다.
// carts.updated_at 변화는 043→047 승인 차이 이력으로 분리한다(보호 지문에서
// 제외한 NoCartTs 변형이 승인된 비교 형태다). B1 before↔after는 어느 필드도
// 0 변화를 요구한다.

export function stripCartTs(rows: ProtectedRow[]): ProtectedRow[] {
  return rows.map((r) =>
    r.src === "carts" && r.j && typeof r.j === "object"
      ? {
          ...r,
          j: Object.fromEntries(
            Object.entries(r.j as Record<string, unknown>).filter(
              ([k]) => k !== "updated_at",
            ),
          ),
        }
      : r,
  );
}

export type FactsNewOrder = {
  id: string;
  user_id: string;
  status: string;
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  items: string[];
  payments: string[];
  shipments: string[];
  cancels: string[];
  actions: string[];
};
export type FactsCancel = {
  id: string;
  order_id: string;
  status: string;
  action_request_id: string;
};
export type RoBaseline = {
  protectedFpNoCartTs: string;
  preservedActionsFp: string;
  rowCounts: Record<string, number>;
  newOrders: FactsNewOrder[];
  cancels: FactsCancel[];
  sourceRuns: string[];
};

// 승인된 047 최종 강화 감사 — 정확히 이 한 파일만이 검증 기준이다.
// 같은 디렉터리의 다른 run 산출물은 이력 보존이며 기준이 아니다 [PM B0 정정].
export const RO_FACTS_PATH =
  "shots/06a/pmqa047-b3/run-8a3b977d-205c-494a-9ba1-7ab3c4f65a69/facts.json";
export const RO_FACTS_SHA256 =
  "27c476f3ba8b51325b2fba1da32dad439eaadf2510bc64faa26380bd11962de5";

// 승인 facts의 고정 기대값 — 파일 구조·관계가 하나라도 다르면 기준 자체를
// 신뢰할 수 없어 중단한다(임의 완화·부분 일치 허용 없음).
const EXPECTED_ROW_COUNTS: Record<string, number> = {
  orders: 16,
  order_items: 17,
  payments: 16,
  shipments: 15,
  cancel_requests: 2,
  action_requests: 152,
  cart_items: 0,
};

// 승인 facts.json의 구조·불변관계를 검증하고 baseline을 추출한다(순수 함수).
// 확인하는 것: auditFail=false·kind·postFp 승인 지문·rowCounts 정확 일치·
// 신규 주문 12 전 필드·cancels 2의 order_id↔newOrders.cancels 상호 참조·
// 152-36=116 신규 action 관계. SHA256은 호출자가 파일 바이트로 별도 확인한다.
export function parseApprovedFacts(
  f: Record<string, unknown>,
): { ok: true; baseline: RoBaseline } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!f || typeof f !== "object")
    return { ok: false, reasons: ["047 facts가 객체가 아니다"] };
  if (f.auditFail !== false) reasons.push("auditFail != false");
  if (f.kind !== "b3-post-audit") reasons.push("kind != 'b3-post-audit'");
  const p = (f.postFp ?? {}) as Record<string, unknown>;
  if (p.protectedFpNoCartTsMatch !== true)
    reasons.push("postFp.protectedFpNoCartTsMatch != true");
  if (p.preservedActionsFpMatch !== true)
    reasons.push("postFp.preservedActionsFpMatch != true");
  if (typeof p.protectedFpNoCartTs !== "string" || !p.protectedFpNoCartTs)
    reasons.push("postFp.protectedFpNoCartTs 부재");
  if (typeof p.preservedActionsFp !== "string" || !p.preservedActionsFp)
    reasons.push("postFp.preservedActionsFp 부재");
  const rc = (f.rowCounts ?? {}) as Record<string, number>;
  for (const [k, want] of Object.entries(EXPECTED_ROW_COUNTS))
    if (rc[k] !== want)
      reasons.push("rowCounts." + k + " " + rc[k] + " != " + want);
  // 신규 12 orders·2 cancels·116 actions의 관계 — 건수뿐 아니라 상호 참조까지.
  const newOrders = (f.newOrders ?? []) as FactsNewOrder[];
  if (newOrders.length !== 12)
    reasons.push("newOrders " + newOrders.length + " != 12");
  const REQ: (keyof FactsNewOrder)[] = [
    "id", "user_id", "status", "items_total_won", "shipping_fee_won",
    "total_won", "items", "payments", "shipments", "cancels", "actions",
  ];
  const ids = new Set<string>();
  for (const o of newOrders) {
    for (const k of REQ)
      if ((o as Record<string, unknown>)[k] === undefined)
        reasons.push("newOrders." + o.id + " 필드 부재: " + k);
    if (typeof o.id === "string") {
      if (ids.has(o.id)) reasons.push("newOrders id 중복: " + o.id);
      ids.add(o.id);
    }
    for (const a of ["items", "payments", "shipments", "cancels", "actions"] as const)
      if (!Array.isArray(o[a]) || o[a].some((x) => typeof x !== "string"))
        reasons.push("newOrders." + o.id + "." + a + "가 string 배열이 아니다");
  }
  const cancels = (f.cancels ?? []) as FactsCancel[];
  if (cancels.length !== 2) reasons.push("cancels " + cancels.length + " != 2");
  for (const c of cancels) {
    if (!ids.has(c.order_id))
      reasons.push("cancel " + c.id + "의 order_id가 신규 주문이 아니다");
    else {
      const o = newOrders.find((x) => x.id === c.order_id);
      if (o && !o.cancels.includes(c.id))
        reasons.push("cancel " + c.id + "↔" + c.order_id + " 상호 참조 불일치");
    }
    if (typeof c.action_request_id !== "string" || !c.action_request_id)
      reasons.push("cancel " + c.id + " action_request_id 부재");
  }
  // 152 actions = 보존 36 + 신규 116 — 관계가 깨지면 기준이 아니다.
  if (rc.action_requests - 36 !== 116)
    reasons.push("신규 action 관계 불일치: " + rc.action_requests + " - 36 != 116");
  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    baseline: {
      protectedFpNoCartTs: p.protectedFpNoCartTs as string,
      preservedActionsFp: p.preservedActionsFp as string,
      rowCounts: EXPECTED_ROW_COUNTS,
      newOrders,
      cancels,
      sourceRuns: [RO_FACTS_PATH],
    },
  };
}

// before gate의 live 측 입력 — 전부 SELECT 결과다.
export type LiveArtifacts = {
  rowCounts: Record<string, number>;
  orders: {
    id: string; user_id: string; status: string;
    items_total_won: number; shipping_fee_won: number; total_won: number;
  }[];
  items: { id: string; order_id: string }[];
  payments: { id: string; order_id: string }[];
  shipments: { id: string; order_id: string }[];
  cancels: { id: string; order_id: string; status: string; action_request_id: string }[];
  actions: { id: string; order_ref: string | null }[];
  seedOrderIds: string[];
};

// 047 증거의 신규 산출물이 live에 그대로 있는지 검증한다 — ID 집합뿐 아니라
// 주문 본문(소유자·상태·금액)과 종속 ID 집합(items/payments/shipments/cancels/
// actions)까지 대조해 본문 변조·연결 누락을 잡는다(순수 함수). 신규 action의
// 전체 payload 지문은 047 증거가 없어 대조하지 않는다 — 본문 검증은 신규
// 주문과 2 cancels에 한정된다.
export function verifyLiveArtifacts(
  baseline: RoBaseline,
  live: LiveArtifacts,
): string[] {
  const reasons: string[] = [];
  for (const [k, want] of Object.entries(baseline.rowCounts)) {
    const got = live.rowCounts[k];
    if (got !== want)
      reasons.push("rowCounts." + k + " " + got + " != " + want);
  }
  const seed = new Set(live.seedOrderIds);
  const liveNew = live.orders.filter((o) => !seed.has(o.id));
  const liveIds = liveNew.map((o) => o.id).sort();
  const wantIds = baseline.newOrders.map((o) => o.id).sort();
  if (JSON.stringify(liveIds) !== JSON.stringify(wantIds))
    reasons.push(
      "신규 주문 ID 집합 불일치 " + liveIds.length + " != " + wantIds.length,
    );
  const depIds = (
    rows: { id: string; order_id: string }[],
    oid: string,
  ): string[] => rows.filter((r) => r.order_id === oid).map((r) => r.id).sort();
  const cancelIds = (oid: string): string[] =>
    live.cancels.filter((c) => c.order_id === oid).map((c) => c.id).sort();
  const actionIds = (oid: string): string[] =>
    live.actions.filter((a) => a.order_ref === oid).map((a) => a.id).sort();
  for (const eo of baseline.newOrders) {
    const lo = liveNew.find((o) => o.id === eo.id);
    if (!lo) {
      reasons.push("신규 주문 누락: " + eo.id);
      continue;
    }
    if (
      lo.user_id !== eo.user_id || lo.status !== eo.status ||
      lo.total_won !== eo.total_won || lo.items_total_won !== eo.items_total_won ||
      lo.shipping_fee_won !== eo.shipping_fee_won
    )
      reasons.push("신규 주문 " + eo.id + " 본문 불일치(payload 변조 가능)");
    if (JSON.stringify(depIds(live.items, eo.id)) !== JSON.stringify([...eo.items].sort()))
      reasons.push("신규 주문 " + eo.id + " items 연결 불일치");
    if (JSON.stringify(depIds(live.payments, eo.id)) !== JSON.stringify([...eo.payments].sort()))
      reasons.push("신규 주문 " + eo.id + " payments 연결 불일치");
    if (JSON.stringify(depIds(live.shipments, eo.id)) !== JSON.stringify([...eo.shipments].sort()))
      reasons.push("신규 주문 " + eo.id + " shipments 연결 불일치");
    if (JSON.stringify(cancelIds(eo.id)) !== JSON.stringify([...eo.cancels].sort()))
      reasons.push("신규 주문 " + eo.id + " cancels 연결 불일치");
    if (JSON.stringify(actionIds(eo.id)) !== JSON.stringify([...eo.actions].sort()))
      reasons.push("신규 주문 " + eo.id + " actions 연결 불일치");
  }
  const liveCancels = live.cancels
    .map((c) => [c.id, c.order_id, c.status, c.action_request_id].join("|"))
    .sort();
  const wantCancels = baseline.cancels
    .map((c) => [c.id, c.order_id, c.status, c.action_request_id].join("|"))
    .sort();
  if (JSON.stringify(liveCancels) !== JSON.stringify(wantCancels))
    reasons.push(
      "cancel_requests 집합 불일치 " + liveCancels.length +
        " != " + wantCancels.length,
    );
  return reasons;
}
