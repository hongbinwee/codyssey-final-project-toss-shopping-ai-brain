// tests/e2e/readonly-*.ts의 DB-free 검증 — guard allowlist·URL 계약·
// 스냅 diff·047 baseline 파서·live artifact 대조·writer SQL 정확성을
// 실제 DB 없이 단정한다 [PMQA-048-B0].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffSnaps, parseApprovedFacts, parseRoDbUrl, preservedActionsPresent,
  snapDb, stripCartTs, verifyLiveArtifacts, RO_DB, RO_DEV_DB,
  RO_FACTS_SHA256, RO_TABLES, RO_UNREADABLE_SQL, RO_WRITER_SQL,
  type DbSnap, type FactsNewOrder, type LiveArtifacts, type RoBaseline,
} from "../e2e/readonly-db.ts";
import {
  assertFreshRunDir, assertRunAccess, roDecision, RO_ORIGIN,
} from "../e2e/readonly-guard.ts";

// ── run dir·캡처 무결성 (no-overwrite) ────────────────────────────
describe("assertFreshRunDir — run/output 충돌 보호", () => {
  test("run dir 부재 → 거부 (launcher 예약 없는 직접 실행)", () => {
    assert.throws(() =>
      assertFreshRunDir(join(tmpdir(), "ro-no-such-" + randomUUID())),
    );
  });
  test("예약된 run + output 없음 → 허용", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-run-"));
    assert.doesNotThrow(() => assertFreshRunDir(dir));
  });
  test("기존 pw-output → 거부 + 기존 bytes 불변", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-run-"));
    const out = join(dir, "pw-output");
    mkdirSync(out);
    const keep = join(out, "keep.txt");
    writeFileSync(keep, "ORIGINAL");
    assert.throws(() => assertFreshRunDir(dir), /pw-output/);
    assert.equal(readFileSync(keep, "utf8"), "ORIGINAL");
  });
  test("wx write — 이름 중복이면 실패하고 기존 bytes 보존", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-wx-"));
    const p = join(dir, "shot.png");
    writeFileSync(p, "FIRST", { flag: "wx" });
    assert.throws(() => writeFileSync(p, "SECOND", { flag: "wx" }));
    assert.equal(readFileSync(p, "utf8"), "FIRST");
  });
});

// ── runner/worker 재평가 구분 (B1F) ─────────────────────────────
// runner 첫 평가의 거부는 그대로이고, launcher 소유 증거(wx run-owner.json
// marker + RO_WORKER_NONCE env + runId + 승인 before)가 맞는 현재 run의
// worker 재평가만 pw-output을 허용한다. 'worker면 무조건 통과'나 env
// self-approve가 아님을 부정 케이스로 고정한다.
describe("assertRunAccess — runner/worker 재평가 구분 (B1F)", () => {
  const RUN_ID = "11111111-2222-3333-4444-555555555555";
  const OTHER_ID = "99999999-8888-7777-6666-555555555555";
  const NONCE = "nonce-abc";
  // runDir basename === RO_RUN_ID 계약 — 픽스처는 RUN_ID 이름의 dir을 만든다.
  const mkRun = (runId = RUN_ID) => {
    const parent = mkdtempSync(join(tmpdir(), "ro-acc-"));
    const dir = join(parent, runId);
    mkdirSync(dir);
    return dir;
  };
  const owned = (dir: string, runId = RUN_ID, gateOk = true) => {
    writeFileSync(join(dir, "run-owner.json"),
      JSON.stringify({ runId, nonce: NONCE }), { flag: "wx" });
    writeFileSync(join(dir, "audit-before.json"),
      JSON.stringify({ runId, gateOk }), { flag: "wx" });
  };
  const runnerEnv = { RO_RUN_ID: RUN_ID, RO_WORKER_NONCE: NONCE };
  const workerEnv = { ...runnerEnv, TEST_WORKER_INDEX: "0" };

  test("runner 첫 평가 — output 없음 + 소유 정합 → 허용", () => {
    const dir = mkRun();
    owned(dir);
    assert.doesNotThrow(() => assertRunAccess(dir, runnerEnv));
  });
  test("runner 평가 + 기존 pw-output → 거부 + bytes 불변 (같은 실패 run 재시작)", () => {
    const dir = mkRun();
    owned(dir);
    const out = join(dir, "pw-output");
    mkdirSync(out);
    const keep = join(out, "keep.txt");
    writeFileSync(keep, "ORIGINAL");
    assert.throws(() => assertRunAccess(dir, runnerEnv), /pw-output/);
    assert.equal(readFileSync(keep, "utf8"), "ORIGINAL");
  });
  test("동일 run worker 재평가 — runner 산출물 있어도 소유 정합이면 허용", () => {
    const dir = mkRun();
    owned(dir);
    mkdirSync(join(dir, "pw-output")); // 살아있는 runner가 방금 만든 산출물
    assert.doesNotThrow(() => assertRunAccess(dir, workerEnv));
  });
  test("worker + nonce env 부재 → 거부", () => {
    const dir = mkRun();
    owned(dir);
    assert.throws(() =>
      assertRunAccess(dir, { RO_RUN_ID: RUN_ID, TEST_WORKER_INDEX: "0" }),
      /RO_WORKER_NONCE/);
  });
  test("worker + run-owner marker 부재 → 거부", () => {
    const dir = mkRun();
    writeFileSync(join(dir, "audit-before.json"),
      JSON.stringify({ runId: RUN_ID, gateOk: true }), { flag: "wx" });
    assert.throws(() => assertRunAccess(dir, workerEnv), /marker/);
  });
  test("worker + nonce 불일치 → 거부", () => {
    const dir = mkRun();
    owned(dir);
    assert.throws(() =>
      assertRunAccess(dir, { ...workerEnv, RO_WORKER_NONCE: "other" }),
      /nonce/);
  });
  test("worker + 다른 runId marker → 거부", () => {
    const dir = mkRun();
    owned(dir, OTHER_ID);
    assert.throws(() => assertRunAccess(dir, workerEnv), /runId/);
  });
  test("worker + 승인 before 부재 → 거부", () => {
    const dir = mkRun();
    writeFileSync(join(dir, "run-owner.json"),
      JSON.stringify({ runId: RUN_ID, nonce: NONCE }), { flag: "wx" });
    assert.throws(() => assertRunAccess(dir, workerEnv), /audit-before/);
  });
  test("runner + nonce env 부재 → 거부 (launcher 우회 직접 실행)", () => {
    const dir = mkRun();
    owned(dir);
    assert.throws(() =>
      assertRunAccess(dir, { RO_RUN_ID: RUN_ID }), /RO_WORKER_NONCE/);
  });
  test("worker + audit-before runId 불일치 → 거부", () => {
    const dir = mkRun();
    writeFileSync(join(dir, "run-owner.json"),
      JSON.stringify({ runId: RUN_ID, nonce: NONCE }), { flag: "wx" });
    writeFileSync(join(dir, "audit-before.json"),
      JSON.stringify({ runId: OTHER_ID, gateOk: true }), { flag: "wx" });
    assert.throws(() => assertRunAccess(dir, workerEnv), /runId/);
  });
  test("worker + audit-before gateOk != true → 거부", () => {
    const dir = mkRun();
    owned(dir, RUN_ID, false);
    assert.throws(() => assertRunAccess(dir, workerEnv), /gateOk/);
  });
  test("runDir basename이 RO_RUN_ID와 다르면 → 거부", () => {
    const dir = mkRun(OTHER_ID);          // dir 이름은 OTHER_ID
    owned(dir, OTHER_ID);                  // marker·before는 OTHER_ID와 일치
    assert.throws(() => assertRunAccess(dir, workerEnv), /basename|불일치/);
  });
  test("종료 run — audit-after 존재 + worker env 전부 일치 → 거부 + bytes 불변", () => {
    const dir = mkRun();
    owned(dir);
    mkdirSync(join(dir, "pw-output"));
    const after = join(dir, "audit-after.json");
    writeFileSync(after, "RESULT", { flag: "wx" });
    assert.throws(() => assertRunAccess(dir, workerEnv), /종료된 run/);
    assert.equal(readFileSync(after, "utf8"), "RESULT");
  });
  test("실패 run — audit-fail 존재 + runner env → 거부 (output 없어도)", () => {
    const dir = mkRun();
    owned(dir);
    writeFileSync(join(dir, "audit-fail.json"), "FAIL", { flag: "wx" });
    assert.throws(() => assertRunAccess(dir, runnerEnv), /종료된 run/);
  });
  test("TEST_WORKER_INDEX가 숫자 형태가 아니면 worker로 인정하지 않는다", () => {
    const dir = mkRun();
    owned(dir);
    mkdirSync(join(dir, "pw-output"));
    // 'abc'는 worker가 아니다 — runner 경로의 output 거부를 탄다(fail-closed).
    assert.throws(() =>
      assertRunAccess(dir, { ...runnerEnv, TEST_WORKER_INDEX: "abc" }),
      /pw-output/);
  });
});

// ── roDecision ────────────────────────────────────────────────────
describe("roDecision — origin + allowlist", () => {
  const A = (m: string, p: string) => roDecision(m, RO_ORIGIN + p);
  test("허용 경로", () => {
    for (const [m, p] of [
      ["GET", "/health"],
      ["GET", "/api/session"],
      ["POST", "/api/session"],
      ["GET", "/api/orders"],
      ["GET", "/api/orders/ord-a-pre"],
      ["GET", "/api/orders/ord-a-pre/shipping"],
      ["GET", "/api/orders/ord-a-pre/cancel/eligibility"],
      ["GET", "/"],
      ["GET", "/web/app.js"],
      ["GET", "/assets/x.png"],
    ] as const)
      assert.equal(A(m, p).allow, true, m + " " + p);
  });
  test("외부 origin — 같은 pathname도 거부", () => {
    for (const p of ["/health", "/api/orders", "/api/session", "/"])
      assert.equal(
        roDecision("GET", "https://external.example.com" + p).allow,
        false,
        p,
      );
    // 다른 포트의 같은 호스트도 외부다
    assert.equal(
      roDecision("GET", "http://localhost:3000/api/orders").allow,
      false,
    );
  });
  test("GET이지만 write 유발·승인 밖 경로 차단", () => {
    for (const [m, p] of [
      ["GET", "/api/cart"],
      ["GET", "/api/cart/items"],
      ["GET", "/api/checkout/quote"],
      ["GET", "/api/orders/ord-a-pre/cancel/quote"],
      ["GET", "/api/actions"],
      ["GET", "/api/products"],
      ["GET", "/api/products/p-a"],
      ["GET", "/api/agent/turn"],
      ["POST", "/api/cart/items"],
      ["POST", "/api/checkout/confirm"],
      ["POST", "/api/orders/ord-a-pre/cancel/approve"],
      ["POST", "/api/orders/ord-a-pre/cancel/execute"],
      ["POST", "/api/agent/turn"],
      ["PATCH", "/api/cart/items/x"],
      ["PUT", "/api/session"],
      ["DELETE", "/api/session"],
      ["GET", "/api/unknown"],
    ] as const)
      assert.equal(A(m, p).allow, false, m + " " + p);
  });
  test("상대 경로는 RO_ORIGIN으로 resolve된다", () => {
    assert.equal(roDecision("GET", "/api/orders").allow, true);
    assert.equal(roDecision("GET", "/api/cart").allow, false);
  });
});

// ── parseRoDbUrl ──────────────────────────────────────────────────
describe("parseRoDbUrl", () => {
  const base = "postgres://commerce:commerce@localhost:5432/";
  test("commerce_test·commerce 허용 + GUC 추가", () => {
    for (const db of [RO_DB, RO_DEV_DB]) {
      const u = parseRoDbUrl(base + db, db);
      assert.ok(u.includes("default_transaction_read_only=on"), u);
      assert.ok(new URL(u).pathname === "/" + db);
    }
  });
  test("거부 — host·port·db·param", () => {
    assert.throws(() => parseRoDbUrl(undefined));
    assert.throws(() => parseRoDbUrl("http://localhost:5432/" + RO_DB));
    assert.throws(() => parseRoDbUrl("postgres://x@evil.com:5432/" + RO_DB));
    assert.throws(() => parseRoDbUrl(base + RO_DB + "?database=" + RO_DB));
    assert.throws(() => parseRoDbUrl(base + RO_DB + "?sslmode=disable"));
    // 의도한 DB와 pathname이 다르면 거부 — commerce_test URL을 dev로 쓰는 실수 차단
    assert.throws(() => parseRoDbUrl(base + RO_DB, RO_DEV_DB));
    assert.throws(() => parseRoDbUrl(base + "otherdb", RO_DB));
  });
});

// ── writer SQL 정확성 ─────────────────────────────────────────────
describe("writer/unreadable SQL — 경계·조건 정확성", () => {
  test("POSIX word boundary가 실제로 존재한다", () => {
    // backslash 소실 사고 재발 방지 — 경계 없는 'm(INSERT)M' 패턴이 아니다.
    assert.ok(RO_WRITER_SQL.includes("[[:<:]]"));
    assert.ok(RO_WRITER_SQL.includes("[[:>:]]"));
    assert.ok(/\[\[:<:\]\]\(INSERT\|UPDATE/.test(RO_WRITER_SQL));
    // state='active' 조건은 query 텍스트 매칭에만 — backend_xid는 상태 무관.
    assert.ok(RO_WRITER_SQL.includes("state = 'active'"));
    assert.ok(RO_WRITER_SQL.includes("backend_xid IS NOT NULL"));
    assert.ok(RO_WRITER_SQL.includes("pid <> pg_backend_pid()"));
  });
  test("unreadable 탐지는 활성+query NULL 세션만", () => {
    assert.ok(RO_UNREADABLE_SQL.includes("state = 'active'"));
    assert.ok(RO_UNREADABLE_SQL.includes("query IS NULL"));
    assert.ok(RO_UNREADABLE_SQL.includes("pid <> pg_backend_pid()"));
  });
});

// ── snapDb (fake Q) ───────────────────────────────────────────────
function fakeQ(handlers: [RegExp, unknown][], capture?: string[]) {
  return {
    unsafe: async <T = Record<string, unknown>[]>(q: string): Promise<T> => {
      capture?.push(q);
      for (const [re, v] of handlers)
        if (re.test(q))
          return (typeof v === "function" ? (v as () => unknown)() : v) as T;
      throw new Error("fakeQ unmatched: " + q);
    },
  };
}
const DB_ROW = [{ d: "commerce_test", oid: 16516 }];
const TBL_ROW = [{ n: 2, h: "aa" }];

describe("snapDb", () => {
  test("정상 — 13테이블+writer+unreadable 수집", async () => {
    const qs: string[] = [];
    const s = await snapDb(fakeQ([
      [/pg_database/, DB_ROW],
      [/string_agg/, TBL_ROW],
      [/backend_xid/, [{ pid: 111 }]],
      [/query IS NULL/, [{ pid: 222 }]],
    ], qs));
    assert.equal(s.db, "commerce_test");
    assert.deepEqual(s.writers, [111]);
    assert.deepEqual(s.unreadableActive, [222]);
    assert.equal(s.writersError, null);
    assert.equal(Object.keys(s.tables).length, RO_TABLES.length);
    // writer 쿼리에 word boundary가 실제 실렸는지 fake Q로 확인 [PM 검수]
    const wq = qs.find((q) => q.includes("pg_stat_activity") && q.includes("backend_xid"))!;
    assert.ok(wq.includes("[[:<:]]") && wq.includes("[[:>:]]"));
    assert.ok(!wq.includes("'m(INSERT") && !wq.includes("'\\m(INSERT"));
  });
  test("writer 탐지 실패 → writersError (PASS와 구분)", async () => {
    const s = await snapDb(fakeQ([
      [/pg_database/, DB_ROW],
      [/string_agg/, TBL_ROW],
      [/backend_xid/, () => { throw new Error("perm denied"); }],
      [/query IS NULL/, []],
    ]));
    assert.equal(s.writers.length, 0);
    assert.ok(s.writersError!.includes("perm denied"));
  });
});

// ── diffSnaps ─────────────────────────────────────────────────────
const snap = (over: Partial<DbSnap> = {}): DbSnap => ({
  db: "commerce_test",
  oid: 16516,
  at: "t",
  tables: Object.fromEntries(RO_TABLES.map((t) => [t, { n: 1, h: "h" }])),
  writers: [],
  writersError: null,
  unreadableActive: [],
  ...over,
});

describe("diffSnaps", () => {
  test("동일 → drift 없음", () => {
    assert.deepEqual(diffSnaps(snap(), snap()), []);
  });
  test("count·내용 지문·DB identity·writers·unreadable·writersError", () => {
    const ch = (m: (s: DbSnap) => void) => { const s = snap(); m(s); return s; };
    assert.ok(diffSnaps(snap(), ch((s) => { s.tables.orders.n = 2; }))[0].includes("orders count"));
    assert.ok(diffSnaps(snap(), ch((s) => { s.tables.orders.h = "x"; }))[0].includes("orders 내용"));
    assert.ok(diffSnaps(snap(), snap({ db: "commerce", oid: 16384 }))[0].includes("DB identity"));
    assert.ok(diffSnaps(snap(), snap({ writers: [9] }))[0].includes("write 가능 세션"));
    assert.ok(diffSnaps(snap(), snap({ unreadableActive: [7] }))[0].includes("열람 불가"));
    assert.ok(diffSnaps(snap(), snap({ writersError: "x" }))[0].includes("탐지 실패"));
  });
});

// ── preservedActionsPresent ───────────────────────────────────────
test("preservedActionsPresent — 부재 ID만 보고", () => {
  const miss = preservedActionsPresent([{ id: "a" }], ["a", "b", "c"]);
  assert.equal(miss.length, 2);
  assert.ok(miss[0].includes("b"));
});

// ── stripCartTs ───────────────────────────────────────────────────
test("stripCartTs — carts만 updated_at 제거", () => {
  const rows = [
    { src: "carts", id: "c1", j: { id: "c1", updated_at: "t", version: 1 } },
    { src: "orders", id: "o1", j: { id: "o1", updated_at: "t" } },
  ] as never[];
  const s = stripCartTs(rows);
  assert.equal((s[0].j as Record<string, unknown>).updated_at, undefined);
  assert.equal((s[1].j as Record<string, unknown>).updated_at, "t");
});

// ── parseApprovedFacts ────────────────────────────────────────────
function goodFacts() {
  const cancels = [
    { id: "cxl-1", order_id: "ord-n1", status: "REQUESTED", action_request_id: "a-c1" },
    { id: "cxl-2", order_id: "ord-n2", status: "REQUESTED", action_request_id: "a-c2" },
  ];
  const newOrders: FactsNewOrder[] = Array.from({ length: 12 }, (_, i) => ({
    id: "ord-n" + (i + 1),
    user_id: "u-c",
    status: "CONFIRMED",
    items_total_won: 100,
    shipping_fee_won: 0,
    total_won: 100,
    items: ["i-" + (i + 1)],
    payments: ["p-" + (i + 1)],
    shipments: i === 11 ? [] : ["s-" + (i + 1)],
    cancels: i === 0 ? ["cxl-1"] : i === 1 ? ["cxl-2"] : [],
    actions: ["a-" + (i + 1)],
  }));
  return {
    auditFail: false,
    kind: "b3-post-audit",
    postFp: {
      protectedFpNoCartTs: "fp-ncts",
      protectedFpNoCartTsMatch: true,
      preservedActionsFp: "fp-pres",
      preservedActionsFpMatch: true,
    },
    rowCounts: {
      orders: 16, order_items: 17, payments: 16, shipments: 15,
      cancel_requests: 2, action_requests: 152, cart_items: 0,
    },
    newOrders,
    cancels,
  };
}

describe("parseApprovedFacts", () => {
  test("정상 baseline 추출", () => {
    const r = parseApprovedFacts(goodFacts() as never);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.baseline.protectedFpNoCartTs, "fp-ncts");
      assert.equal(r.baseline.newOrders.length, 12);
      assert.equal(r.baseline.cancels.length, 2);
    }
  });
  test("부정 — auditFail·kind·rowCounts·필드·참조·관계", () => {
    const bad = (m: (f: ReturnType<typeof goodFacts>) => void) => {
      const f = goodFacts(); m(f); return parseApprovedFacts(f as never);
    };
    assert.ok(!bad((f) => { f.auditFail = true as never; }).ok);
    assert.ok(!bad((f) => { f.kind = "x"; }).ok);
    assert.ok(!bad((f) => { f.postFp.protectedFpNoCartTsMatch = false; }).ok);
    assert.ok(!bad((f) => { f.rowCounts.orders = 15; }).ok);
    assert.ok(!bad((f) => { f.newOrders.pop(); }).ok);           // 11개
    assert.ok(!bad((f) => { (f.newOrders[0] as unknown as { items?: unknown }).items = undefined; }).ok);
    assert.ok(!bad((f) => { f.cancels[0].order_id = "ord-x"; }).ok); // 비신규
    assert.ok(!bad((f) => { f.newOrders[0].cancels = []; }).ok);     // 상호참조 깨짐
    assert.ok(!bad((f) => { f.rowCounts.action_requests = 151; }).ok); // 116 관계
    assert.equal(RO_FACTS_SHA256.length, 64); // pin 상수 형태
  });
});

// ── verifyLiveArtifacts ───────────────────────────────────────────
function liveOf(baseline: RoBaseline) {
  const live: LiveArtifacts = {
    rowCounts: {
      orders: 16, order_items: 17, payments: 16, shipments: 15,
      cancel_requests: 2, action_requests: 152, cart_items: 0,
    },
    orders: [
      { id: "ord-a-pre", user_id: "u-a", status: "CONFIRMED", items_total_won: 1, shipping_fee_won: 0, total_won: 1 },
      { id: "ord-a-ship", user_id: "u-a", status: "CONFIRMED", items_total_won: 1, shipping_fee_won: 0, total_won: 1 },
      { id: "ord-a-done", user_id: "u-a", status: "CONFIRMED", items_total_won: 1, shipping_fee_won: 0, total_won: 1 },
      { id: "ord-b-none", user_id: "u-b", status: "CONFIRMED", items_total_won: 1, shipping_fee_won: 0, total_won: 1 },
      ...baseline.newOrders.map((o) => ({
        id: o.id, user_id: o.user_id, status: o.status,
        items_total_won: o.items_total_won,
        shipping_fee_won: o.shipping_fee_won, total_won: o.total_won,
      })),
    ],
    items: [
      { id: "si-1", order_id: "ord-a-pre" },
      ...baseline.newOrders.flatMap((o) => o.items.map((id) => ({ id, order_id: o.id }))),
    ],
    payments: [
      { id: "sp-1", order_id: "ord-a-pre" },
      ...baseline.newOrders.flatMap((o) => o.payments.map((id) => ({ id, order_id: o.id }))),
    ],
    shipments: [
      ...baseline.newOrders.flatMap((o) => o.shipments.map((id) => ({ id, order_id: o.id }))),
      { id: "ss-1", order_id: "ord-a-ship" }, { id: "ss-2", order_id: "ord-a-done" },
      { id: "ss-3", order_id: "ord-a-pre" }, { id: "ss-4", order_id: "ord-b-none" },
    ],
    cancels: baseline.cancels.map((c) => ({ ...c })),
    actions: baseline.newOrders.flatMap((o) => o.actions.map((id) => ({ id, order_ref: o.id }))),
    seedOrderIds: ["ord-a-pre", "ord-a-ship", "ord-a-done", "ord-b-none"],
  };
  // actions 152 = 신규 12 + 보존 36 + 나머지 채움 (fixture 크기만 맞추면 됨)
  const pad = 152 - live.actions.length;
  for (let i = 0; i < pad; i++)
    live.actions.push({ id: "pad-" + i, order_ref: null });
  return live;
}

describe("verifyLiveArtifacts", () => {
  const base = (parseApprovedFacts(goodFacts() as never) as { ok: true; baseline: RoBaseline }).baseline;
  test("정상 — 0 reasons", () => {
    assert.deepEqual(verifyLiveArtifacts(base, liveOf(base)), []);
  });
  test("누락·변조·연결·count 불일치 탐지", () => {
    const mod = (m: (l: LiveArtifacts) => void) => {
      const l = liveOf(base); m(l); return verifyLiveArtifacts(base, l);
    };
    assert.ok(mod((l) => { l.orders.pop(); }).some((r) => r.includes("ID 집합") || r.includes("누락")));
    assert.ok(mod((l) => { l.orders.find((o) => o.id === "ord-n1")!.total_won = 999; }).some((r) => r.includes("본문 불일치")));
    assert.ok(mod((l) => { l.items = l.items.filter((i) => i.id !== "i-1"); }).some((r) => r.includes("items 연결") || r.includes("rowCounts.order_items")));
    assert.ok(mod((l) => { l.cancels[0].status = "COMPLETED"; }).some((r) => r.includes("cancel_requests 집합")));
    assert.ok(mod((l) => { l.rowCounts.action_requests = 151; }).some((r) => r.includes("action_requests")));
    assert.ok(mod((l) => { l.actions = l.actions.filter((a) => a.order_ref !== "ord-n1"); }).some((r) => r.includes("actions 연결") || r.includes("rowCounts")));
  });
});
