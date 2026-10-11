// tests/helpers/testdb.ts restricted reset의 DB-free 검증(PMQA-044-A).
// 실제 DB 없이 상태를 가진 가짜 DB를 주입해, 승인 범위·보존·rollback을 증명한다.
//
// mock 한계: FakeDb는 SQL 패턴 라우팅으로 상태를 변경하고 begin은
// structuredClone 복원으로 rollback을 시뮬레이션한다. 실제 PostgreSQL의
// FK 제약·REPEATABLE READ 격리·테이블 잠금·RETURNING 의미론·실제 13행
// row data와의 일치는 이 mock으로 증명할 수 없다 — 실제 검증은 PM gate
// 이후 live DB 대조다. 상태 fixture는 덤프의 실제 메타데이터를 따른다
// (CANCEL_ORDER action도 result_json.order_id를 가진다).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRestrictedReset,
  restrictedE2EReset,
  verifyBackupFile,
  protectedFingerprint,
  loadDumpProtectedRows,
  loadDumpResetBaseline,
  RESTRICTED_APPROVED_ORDERS,
  RESTRICTED_PRESERVED_ACTIONS,
  RESTRICTED_BACKUP,
  RESTRICTED_TEST_DB_OID,
  TEST_DB,
} from "../helpers/testdb.ts";
import * as testdbModule from "../helpers/testdb.ts";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
type State = {
  db: string;
  oid: number;
  orders: Row[];
  cancels: Row[];
  items: Row[];
  payments: Row[];
  shipments: Row[];
  actions: Row[];
  variants: Row[];
  carts: Row[];
  cartItems: Row[];
  products: Row[];
  reviews: Row[];
  users: Row[];
};

const SEED4 = ["ord-a-pre", "ord-a-ship", "ord-a-done", "ord-b-none"];
const TSD = "2026-10-11 08:49:00+00"; // 덤프 COPY 형식 timestamptz

function mkOrder(id: string, uid: string, items: number, ship = 3000): Row {
  return {
    id,
    user_id: uid,
    status: "CONFIRMED",
    items_total_won: items,
    shipping_fee_won: ship,
    total_won: items + ship,
    address_snapshot_json: { name: "x", phone: "0", address: "a", detail: "1" },
    version: 1,
    created_at: TSD,
    cancelled_at: null,
  };
}

function approvedBaseline() {
  const dump = readFileSync(RESTRICTED_BACKUP.path);
  assert.equal(
    createHash("sha256").update(dump).digest("hex"),
    RESTRICTED_BACKUP.sha256,
    "test fixture는 SHA 검증된 승인 043 dump에서만 파생한다",
  );
  return loadDumpResetBaseline(dump.toString("utf8"));
}

// Fake DB 상태는 임의 재구성이 아니라 승인된 043 dump에서 파생한다.
function auditState(): State {
  const baseline = approvedBaseline();
  const rows = [...baseline.protectedRows, ...baseline.deleteRows];
  const table = (src: string) =>
    rows
      .filter((row) => row.src === src)
      .map((row) => structuredClone(row.j as Row));
  return {
    db: TEST_DB,
    oid: RESTRICTED_TEST_DB_OID,
    orders: table("orders"),
    cancels: table("cancel_requests"),
    items: table("order_items"),
    payments: table("payments"),
    shipments: table("shipments"),
    actions: table("action_requests"),
    variants: table("product_variants"),
    carts: table("carts"),
    cartItems: table("cart_items"),
    products: table("products"),
    reviews: table("reviews"),
    users: table("users"),
  };
}

// state에서 보호 행 집합을 만든다 — /*snap:protected*/ 라우트와
// expectedFp 계산이 이 함수를 공유한다(실제 SQL scope와 동일).
function protectedRowsOf(s: State) {
  const rows: { src: string; id: string; j: Row }[] = [];
  const seed = new Set(SEED4);
  const uids = new Set(["u-a", "u-b", "u-c", "u-d"]);
  const preserved = new Set(RESTRICTED_PRESERVED_ACTIONS);
  const push = (src: string, arr: Row[], keep: (r: Row) => boolean, minus: string[] = []) => {
    for (const r of arr)
      if (keep(r)) {
        const j = { ...r };
        for (const k of minus) delete j[k];
        rows.push({ src, id: String(r.id), j });
      }
  };
  push("orders", s.orders, (r) => seed.has(r.id as string));
  push("order_items", s.items, (r) => seed.has(r.order_id as string));
  push("payments", s.payments, (r) => seed.has(r.order_id as string));
  push("shipments", s.shipments, (r) => seed.has(r.order_id as string));
  push("cancel_requests", s.cancels, (r) => seed.has(r.order_id as string));
  push("action_requests", s.actions, (r) => preserved.has(r.id as string));
  push("product_variants", s.variants, () => true, ["stock_qty", "version"]);
  push("carts", s.carts, (r) => uids.has(r.user_id as string), ["version"]);
  push("cart_items", s.cartItems, () => true);
  push("products", s.products, () => true);
  push("reviews", s.reviews, () => true);
  push("users", s.users, (r) => uids.has(r.id as string));
  return rows;
}

// 덤프 baseline 지문 — 실제 경로는 덤프 COPY를 파싱해 만들고,
// 테스트는 state에서 동일 scope로 만든다(파서와 별도 증명은 아래 덤프 테스트).
function expectedFp(s: State): string {
  return protectedFingerprint(protectedRowsOf(s));
}

function deleteRowsOf(s: State) {
  const approved = new Set(RESTRICTED_APPROVED_ORDERS);
  const cancelActions = new Set(
    s.cancels
      .filter((r) => approved.has(r.order_id as string))
      .map((r) => r.action_request_id as string),
  );
  const rows: { src: string; id: string; j: Row }[] = [];
  const push = (src: string, arr: Row[], keep: (r: Row) => boolean) => {
    for (const row of arr)
      if (keep(row)) rows.push({ src, id: String(row.id), j: { ...row } });
  };
  push("orders", s.orders, (r) => approved.has(r.id as string));
  push("order_items", s.items, (r) => approved.has(r.order_id as string));
  push("payments", s.payments, (r) => approved.has(r.order_id as string));
  push("shipments", s.shipments, (r) => approved.has(r.order_id as string));
  push("cancel_requests", s.cancels, (r) => approved.has(r.order_id as string));
  push("action_requests", s.actions, (r) => {
    const result = r.result_json as Row | null;
    return approved.has(String(result?.order_id ?? "")) || cancelActions.has(r.id as string);
  });
  return rows;
}

const TABLE_KEY: Record<string, keyof State> = {
  cancel_requests: "cancels",
  order_items: "items",
  payments: "payments",
  shipments: "shipments",
  orders: "orders",
  action_requests: "actions",
};

// SQL 패턴 라우팅으로 state를 실제로 변경하는 executor.
function route(q: string, p: unknown[] | undefined, s: State): Row[] {
  if (q.includes("/*snap:db*/")) return [{ db: s.db, oid: s.oid }];
  if (q.includes("/*snap:orders*/"))
    return s.orders.map((r) => ({ id: r.id, status: r.status, total_won: r.total_won }));
  if (q.includes("/*snap:cancels*/"))
    return s.cancels.map((r) => ({
      id: r.id,
      order_id: r.order_id,
      action_request_id: r.action_request_id,
    }));
  if (q.includes("/*snap:items*/"))
    return s.items.map((r) => ({ id: r.id, order_id: r.order_id }));
  if (q.includes("/*snap:payments*/"))
    return s.payments.map((r) => ({ id: r.id, order_id: r.order_id }));
  if (q.includes("/*snap:shipments*/"))
    return s.shipments.map((r) => ({ id: r.id, order_id: r.order_id }));
  if (q.includes("/*snap:actions*/"))
    return s.actions.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      order_ref: (r.result_json as Row | null)?.order_id ?? null,
    }));
  if (q.includes("/*snap:variants*/"))
    return s.variants.map((r) => ({
      id: r.id,
      stock_qty: r.stock_qty,
      version: r.version,
    }));
  if (q.includes("/*snap:carts*/")) {
    const uids = p?.[0] as string[];
    return s.carts
      .filter((r) => uids.includes(r.user_id as string))
      .map((r) => ({ user_id: r.user_id, version: r.version }));
  }
  if (q.includes("/*snap:cart_items*/")) return [{ n: s.cartItems.length }];
  if (q.includes("/*snap:protected*/")) return protectedRowsOf(s);
  if (q.includes("/*snap:delete*/")) return deleteRowsOf(s);
  // 트랜잭션 설정·잠금 — no-op.
  if (q.startsWith("SET TRANSACTION") || q.startsWith("LOCK TABLE")) return [];
  // DELETE ... WHERE x = ANY($1) RETURNING id
  const dm = q.match(/DELETE FROM (\w+)/);
  if (dm) {
    const key = TABLE_KEY[dm[1]];
    const first = p?.[0];
    const arr = s[key] as Row[];
    const removed: Row[] = [];
    if (dm[1] === "orders") {
      // 행별 checked-value predicate: id=$1 AND status=$2 AND total_won=$3
      const [id, status, total] = p as [string, string, number];
      const i = arr.findIndex(
        (r) => r.id === id && r.status === status && r.total_won === total,
      );
      if (i < 0) return [];
      const [r] = arr.splice(i, 1);
      return [{ id: r.id }];
    }
    // cancel_requests는 id=ANY($1) AND order_id=ANY($2) 이중 조건.
    const ids = new Set(
      Array.isArray(first) ? (first as string[]) : [first as string],
    );
    const orderIds = dm[1] === "cancel_requests" ? new Set(p?.[1] as string[]) : null;
    const col = dm[1] === "action_requests" ? "id" : dm[1] === "cancel_requests" ? "id" : "order_id";
    for (let i = arr.length - 1; i >= 0; i--) {
      const row = arr[i];
      const keyMatch = ids.has(row[col] as string);
      const orderMatch =
        dm[1] === "cancel_requests" ? orderIds!.has(row.order_id as string) : ids.has(row[col] as string);
      if (keyMatch && orderMatch) {
        removed.push({ id: row.id });
        arr.splice(i, 1);
      }
    }
    return removed;
  }
  // UPDATE product_variants — checked-value predicate
  if (q.startsWith("UPDATE product_variants")) {
    const [id, stock, version, expStock, expVersion] = p as [
      string,
      number,
      number,
      number,
      number,
    ];
    const v = s.variants.find(
      (r) => r.id === id && r.stock_qty === expStock && r.version === expVersion,
    );
    if (!v) return [];
    v.stock_qty = stock;
    v.version = version;
    return [{ id }];
  }
  // UPDATE carts — checked-value predicate
  if (q.startsWith("UPDATE carts")) {
    const [uid, expVersion] = p as [string, number];
    const c = s.carts.find(
      (r) => r.user_id === uid && r.version === expVersion,
    );
    if (!c) return [];
    c.version = 1;
    return [{ id: uid }];
  }
  return [];
}

// begin은 진입 시 상태를 복제하고 실패 시 복원한다 — 실제 rollback 시뮬레이션.
function fakeDb(
  state: State,
  opts: { failAt?: RegExp; tamperAt?: RegExp; tamper?: (s: State) => void } = {},
) {
  const log: string[] = [];
  const exec = {
    unsafe: async <T = Row[]>(q: string, p?: unknown[]): Promise<T> => {
      log.push(q);
      if (opts.failAt && opts.failAt.test(q))
        throw new Error("injected failure: " + q.slice(0, 40));
      if (opts.tamperAt && opts.tamperAt.test(q) && opts.tamper)
        opts.tamper(state);
      return route(q, p, state) as T;
    },
  };
  const db = {
    unsafe: exec.unsafe,
    begin: async <T>(fn: (q: typeof exec) => Promise<T>): Promise<T> => {
      const backup = structuredClone(state);
      try {
        return await fn(exec);
      } catch (e) {
        for (const k of Object.keys(state) as (keyof State)[])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (state as any)[k] = backup[k];
        throw e;
      }
    },
  };
  return { db, state, log };
}

const writes = (log: string[]) =>
  log.filter((q) => /^(DELETE|UPDATE)/.test(q.trim()));

const run = (db: ReturnType<typeof fakeDb>["db"], _state: State) =>
  restrictedE2EReset(db);

describe("restricted reset — DB-free (PMQA-044-A)", () => {
  test("restricted transaction helper is not exported", () => {
    assert.equal("restrictedResetTxn" in testdbModule, false);
  });

  test("remediate: 감사 baseline → 승인 13+종속 삭제·fixture 복원·보존 유지", async () => {
    const state = auditState();
    const { db } = fakeDb(state);
    const plan = await run(db, state);
    assert.equal(plan.mode, "remediate");
    if (plan.mode !== "remediate") return;
    assert.equal(plan.orderIds.length, 13);
    assert.equal(plan.cancelIds.length, 2);
    assert.equal(plan.linkedActionIds.length, 15);
    assert.equal(plan.variantRestore.length, 4); // v-a-27·v-c-32는 이미 seed
    assert.equal(plan.cartRestore.length, 4);
    // 최종 상태 — seed만 남는다
    assert.deepEqual(
      state.orders.map((o) => o.id).sort(),
      ["ord-a-done", "ord-a-pre", "ord-a-ship", "ord-b-none"],
    );
    assert.equal(state.cancels.length, 0);
    assert.equal(state.items.length, 4);
    assert.equal(state.payments.length, 4);
    assert.equal(state.shipments.length, 3);
    assert.equal(state.actions.length, 36);
    assert.deepEqual(
      state.actions.map((a) => a.id).sort(),
      [...RESTRICTED_PRESERVED_ACTIONS].sort(),
    );
    const seedVar: Record<string, number> = {
      "v-a-24": 5,
      "v-a-27": 0,
      "v-b-24": 8,
      "v-b-27": 3,
      "v-c-27": 4,
      "v-c-32": 2,
    };
    for (const v of state.variants) {
      assert.equal(v.stock_qty, seedVar[v.id as string]);
      assert.equal(v.version, 1);
    }
    for (const c of state.carts) assert.equal(c.version, 1);
  });

  test("remediate: 삭제는 FK 순서 — cancels→actions→items→payments→shipments→orders", async () => {
    const state = auditState();
    const { db, log } = fakeDb(state);
    await run(db, state);
    const w = writes(log);
    const idx = (re: RegExp) => w.findIndex((q) => re.test(q));
    const order = [
      idx(/DELETE FROM cancel_requests/),
      idx(/DELETE FROM action_requests/),
      idx(/DELETE FROM order_items/),
      idx(/DELETE FROM payments/),
      idx(/DELETE FROM shipments/),
      idx(/DELETE FROM orders/),
    ];
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      "FK 순서가 아니다: " + JSON.stringify(order),
    );
    assert.ok(order.every((i) => i >= 0));
  });

  test("abort: 미감사 비-seed 주문이 있으면 write 0건", async () => {
    const state = auditState();
    state.orders.push(mkOrder("ord-unknown", "u-c", 1, 0));
    const before = structuredClone(state);
    const { db, log } = fakeDb(state);
    await assert.rejects(() => run(db, state), /미감사 주문/);
    assert.equal(writes(log).length, 0);
    assert.deepEqual(state, before);
  });

  test("abort: 승인 주문 부분 존재(12) → 중단", async () => {
    const state = auditState();
    state.orders = state.orders.filter(
      (o) => o.id !== RESTRICTED_APPROVED_ORDERS[0],
    );
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /부분 존재/);
  });

  test("abort: 승인 주문 status가 CONFIRMED가 아니면 중단", async () => {
    const state = auditState();
    state.orders.find((o) => o.id === RESTRICTED_APPROVED_ORDERS[0])!.status =
      "CANCELLED";
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /status=CANCELLED/);
  });

  test("abort: 종속 건수 불일치(order_items 13) → 중단", async () => {
    const state = auditState();
    state.items.pop();
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /order_items 13/);
  });

  test("abort: seed 종속 전제 위반(seed payment 부재) → write 0건", async () => {
    const state = auditState();
    const seedPaymentId = state.payments.find((r) => SEED4.includes(r.order_id as string))!.id;
    state.payments = state.payments.filter((r) => r.id !== seedPaymentId);
    const { db, log } = fakeDb(state);
    await assert.rejects(() => run(db, state), /seed payments/);
    assert.equal(writes(log).length, 0, "preflight에서 중단돼야 한다");
  });

  test("abort: seed 주문에 취소 요청이 있으면 중단", async () => {
    const state = auditState();
    state.cancels.push({
      id: "cxl-seed",
      order_id: "ord-a-pre",
      action_request_id: "act-x",
      reason_code: "OTHER",
      status: "REQUESTED",
      refund_amount_won: 1,
      requested_at: TSD,
      completed_at: null,
    });
    const { db, log } = fakeDb(state);
    await assert.rejects(() => run(db, state), /seed 주문에 취소/);
    assert.equal(writes(log).length, 0);
  });

  test("abort: 미감사 action(보존36·연결15 외) → 중단", async () => {
    const state = auditState();
    state.actions.push({
      ...structuredClone(state.actions[0]),
      id: "act-new",
      idempotency_key: "new-action",
    });
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /미감사 action/);
  });

  test("abort: 보존 action 1건 부재 → 중단", async () => {
    const state = auditState();
    state.actions = state.actions.filter(
      (a) => a.id !== RESTRICTED_PRESERVED_ACTIONS[0],
    );
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /보존 action/);
  });

  test("abort: 취소 연결 action kind가 CANCEL_ORDER가 아니면 중단", async () => {
    const state = auditState();
    const a = state.actions.find((x) => x.id === state.cancels[0].action_request_id)!;
    a.kind = "CHECKOUT"; // 실제 메타데이터와 다른 상태
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /취소 연결 action/);
  });

  test("abort: 취소 연결 action의 order_ref가 다르면 중단", async () => {
    const state = auditState();
    const a = state.actions.find((x) => x.id === state.cancels[0].action_request_id)!;
    a.result_json = { order_id: "ord-e0eab123" }; // c.order_id와 불일치
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /order_ref/);
  });

  test("abort: variant가 measured·seed 둘 다 아니면 중단", async () => {
    const state = auditState();
    state.variants.find((v) => v.id === "v-a-24")!.stock_qty = 3;
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /v-a-24 baseline/);
  });

  test("abort: cart_items가 있으면 임의 삭제 없이 중단", async () => {
    const state = auditState();
    state.cartItems.push({ id: "ci-1", cart_id: "cart-u-a", variant_id: "v-a-24", quantity: 1 });
    const before = structuredClone(state);
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /cart_items/);
    assert.deepEqual(state, before);
  });

  test("abort: 대상 DB·oid 불일치 → 중단", async () => {
    const wrong = auditState();
    wrong.db = "commerce";
    const { db: db1 } = fakeDb(wrong);
    await assert.rejects(() => run(db1, wrong), /대상 DB/);
    const wrongOid = auditState();
    wrongOid.oid = 999;
    const { db: db2 } = fakeDb(wrongOid);
    await assert.rejects(() => run(db2, wrongOid), /oid/);
  });

  test("abort: 보존 action ID는 같은데 payload/result 내용이 다르면 지문 불일치", async () => {
    const state = auditState();
    const a = state.actions.find(
      (x) => x.id === RESTRICTED_PRESERVED_ACTIONS[0],
    )!;
    a.payload_json = { k: "tampered" };
    a.result_json = { ok: false, extra: 1 };
    const { db, log } = fakeDb(state);
    await assert.rejects(() => run(db, state), /보호 행 내용 지문이 승인 백업 baseline과 불일치/);
    assert.equal(writes(log).length, 0);
  });

  test("abort: variant 비대상 필드(unit_price) 변경도 지문 불일치", async () => {
    const state = auditState();
    state.variants.find((v) => v.id === "v-b-24")!.unit_price_won = 1;
    const { db } = fakeDb(state);
    await assert.rejects(() => run(db, state), /보호 행 내용 지문이 승인 백업 baseline과 불일치/);
  });

  test("rollback: 중간 write 실패 시 상태가 전부 복원된다", async () => {
    const state = auditState();
    const before = structuredClone(state);
    // shipments 삭제 시점에 실패 주입 — 앞선 cancels/actions/items/payments도 복원돼야 한다
    const { db } = fakeDb(state, { failAt: /DELETE FROM shipments/ });
    await assert.rejects(() => run(db, state), /injected failure/);
    assert.deepEqual(state, before);
  });

  test("rollback: postcheck까지 진행 후 보호 행이 변하면 전부 복원된다", async () => {
    const state = auditState();
    const before = structuredClone(state);
    // 삭제는 전부 성공하지만 보호 행이 오염된 상태 — postcheck가 잡아야 한다
    const { db } = fakeDb(state, {
      tamperAt: /DELETE FROM orders/,
      tamper: (s) => {
        const a = s.actions.find(
          (x) => x.id === RESTRICTED_PRESERVED_ACTIONS[0],
        )!;
        a.payload_json = { k: "corrupted" };
      },
    });
    await assert.rejects(() => run(db, state), /(지문|postcheck)/);
    assert.deepEqual(state, before);
  });

  test("verify: 정리 상태에서는 write 0건으로 통과", async () => {
    const state = auditState();
    // 정리 후 상태 — 승인 13·종속·연결 action 제거, fixture는 seed 값
    state.orders = state.orders.filter(
      (o) => !RESTRICTED_APPROVED_ORDERS.includes(o.id as string),
    );
    state.cancels = [];
    state.items = state.items.filter((i) => SEED4.includes(i.order_id as string));
    state.payments = state.payments.filter((i) => SEED4.includes(i.order_id as string));
    state.shipments = state.shipments.filter((i) => SEED4.includes(i.order_id as string));
    state.actions = state.actions.filter((a) =>
      RESTRICTED_PRESERVED_ACTIONS.includes(a.id as string),
    );
    const seedVar: Record<string, number> = {
      "v-a-24": 5,
      "v-a-27": 0,
      "v-b-24": 8,
      "v-b-27": 3,
      "v-c-27": 4,
      "v-c-32": 2,
    };
    for (const v of state.variants) {
      v.stock_qty = seedVar[v.id as string];
      v.version = 1;
    }
    for (const c of state.carts) c.version = 1;
    const { db, log } = fakeDb(state);
    const plan = await run(db, state);
    assert.equal(plan.mode, "verify");
    assert.equal(writes(log).length, 0, "verify에서 write가 실행됐다");
  });

  test("verify: 비-seed 주문 잔존은 전체 정리 승인 밖 — 중단", async () => {
    const clean = auditState();
    clean.orders = clean.orders.filter(
      (o) => !RESTRICTED_APPROVED_ORDERS.includes(o.id as string),
    );
    clean.orders.push(mkOrder("ord-new", "u-c", 1, 0));
    clean.cancels = [];
    const { db } = fakeDb(clean);
    await assert.rejects(() => run(db, clean), /비-seed 주문/);
  });

  test("backup gate: 백업 부재·잘못된 SHA는 DB query 전에 거부", async () => {
    const state = auditState();
    const { db, log } = fakeDb(state);
    const prior = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "restricted-reset-gate-"));
    try {
      process.chdir(temp);
      await assert.rejects(() => restrictedE2EReset(db), /승인 백업 파일 부재/);
      assert.equal(log.length, 0);

      const backupPath = join(temp, RESTRICTED_BACKUP.path);
      mkdirSync(join(temp, "shots", "06a", "pmqa043"), { recursive: true });
      writeFileSync(backupPath, "not the approved 043 dump");
      await assert.rejects(() => restrictedE2EReset(db), /SHA256 불일치/);
      assert.equal(log.length, 0);
    } finally {
      process.chdir(prior);
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("backup gate: SHA 검증된 실제 043 baseline만 transaction에 진입", async () => {
    const state = auditState();
    state.db = "not_commerce_test"; // 백업 통과 후 대상 검증에서 중단
    const { db, log } = fakeDb(state);
    await assert.rejects(() => restrictedE2EReset(db), /대상 DB/);
    assert.ok(log.length > 0, "실제 승인 dump를 읽은 뒤 transaction preflight까지 도달");
    assert.equal(writes(log).length, 0);
  });

  test("security: caller가 baseline을 주입할 수 없고 보호 행 불일치면 첫 write 전에 abort", async () => {
    const state = auditState();
    const preserved = state.actions.find((a) => RESTRICTED_PRESERVED_ACTIONS.includes(a.id as string))!;
    preserved.payload_json = { changed: "caller omitted baseline" };
    const { db, log } = fakeDb(state);
    await assert.rejects(() => restrictedE2EReset(db), /보호 행 내용 지문|승인 백업 baseline/);
    assert.equal(writes(log).length, 0);
  });

  test("security: 삭제 예정 결제 환불 메타데이터가 승인 baseline과 다르면 첫 write 전에 abort", async () => {
    const state = auditState();
    const pay = state.payments.find((p) => RESTRICTED_APPROVED_ORDERS.includes(p.order_id as string))!;
    pay.refund_status = "REFUNDED";
    const { db, log } = fakeDb(state);
    await assert.rejects(() => restrictedE2EReset(db), /삭제 대상.*baseline|삭제 행.*불일치/);
    assert.equal(writes(log).length, 0);
  });

  test("security: lock 이후 삭제 대상 결제 metadata 변조는 snapshot에서 잡혀 write 0건", async () => {
    const state = auditState();
    const before = structuredClone(state);
    const { db, log } = fakeDb(state, {
      tamperAt: /^LOCK TABLE/,
      tamper: (s) => {
        const payment = s.payments.find((p) =>
          RESTRICTED_APPROVED_ORDERS.includes(p.order_id as string),
        )!;
        payment.refund_status = "REFUNDED";
        payment.refunded_amount_won = payment.paid_amount_won;
      },
    });
    await assert.rejects(
      () => run(db, state),
      /삭제 대상 전체 행이 승인 043 baseline과 불일치/,
    );
    assert.ok(log.some((q) => q.includes("/*snap:delete*/")));
    assert.equal(writes(log).length, 0);
    assert.deepEqual(state, before, "transaction 실패 후 tamper와 write 모두 rollback");
  });

  test("security: lock 이후 보존 action metadata 변조는 snapshot에서 잡혀 write 0건", async () => {
    const state = auditState();
    const before = structuredClone(state);
    const { db, log } = fakeDb(state, {
      tamperAt: /^LOCK TABLE/,
      tamper: (s) => {
        const action = s.actions.find(
          (a) => a.id === RESTRICTED_PRESERVED_ACTIONS[0],
        )!;
        action.payload_json = { changed_after_lock: true };
      },
    });
    await assert.rejects(
      () => run(db, state),
      /보호 행 내용 지문이 승인 백업 baseline과 불일치/,
    );
    assert.ok(log.some((q) => q.includes("/*snap:protected*/")));
    assert.equal(writes(log).length, 0);
    assert.deepEqual(state, before, "transaction 실패 후 tamper와 write 모두 rollback");
  });

  const lockedDeleteTamperCases: { name: string; mutate: (s: State) => void }[] = [
    {
      name: "주문 actor",
      mutate: (s) => {
        s.orders.find((o) => RESTRICTED_APPROVED_ORDERS.includes(o.id as string))!.user_id = "u-tampered";
      },
    },
    {
      name: "상품 옵션 스냅샷",
      mutate: (s) => {
        const item = s.items.find((i) => RESTRICTED_APPROVED_ORDERS.includes(i.order_id as string))!;
        item.option_snapshot_json = { ...(item.option_snapshot_json as Row), altered: true };
      },
    },
    {
      name: "배송 events",
      mutate: (s) => {
        const shipment = s.shipments.find((x) => RESTRICTED_APPROVED_ORDERS.includes(x.order_id as string))!;
        shipment.events_json = [{ tampered: true }];
      },
    },
    {
      name: "주문 연결 action payload",
      mutate: (s) => {
        const action = s.actions.find((a) =>
          RESTRICTED_APPROVED_ORDERS.includes(
            String((a.result_json as Row | null)?.order_id ?? ""),
          ),
        )!;
        action.payload_json = { tampered: true };
      },
    },
  ];

  for (const scenario of lockedDeleteTamperCases) {
    test(`security: lock 이후 ${scenario.name} 변조는 첫 write 전에 abort`, async () => {
      const state = auditState();
      const before = structuredClone(state);
      const { db, log } = fakeDb(state, {
        tamperAt: /^LOCK TABLE/,
        tamper: scenario.mutate,
      });
      await assert.rejects(
        () => run(db, state),
        /삭제 대상 전체 행이 승인 043 baseline과 불일치/,
      );
      assert.ok(log.some((q) => q.includes("/*snap:delete*/")));
      assert.equal(writes(log).length, 0);
      assert.deepEqual(state, before, "transaction 실패 후 tamper와 write 모두 rollback");
    });
  }

  test("evaluate: 순수 판정 — abort 사유를 수집하고 write와 분리된다", () => {
    const s = auditState();
    const snap = {
      db: s.db,
      oid: s.oid,
      orders: s.orders.map((o) => ({
        id: o.id as string,
        status: o.status as string,
        total_won: o.total_won as number,
      })),
      cancels: s.cancels.map((c) => ({
        id: c.id as string,
        order_id: c.order_id as string,
        action_request_id: c.action_request_id as string,
      })),
      items: s.items.map((i) => ({ id: i.id as string, order_id: i.order_id as string })),
      payments: s.payments.map((i) => ({ id: i.id as string, order_id: i.order_id as string })),
      shipments: s.shipments.map((i) => ({ id: i.id as string, order_id: i.order_id as string })),
      actions: s.actions.map((a) => ({
        id: a.id as string,
        kind: a.kind as string,
        status: a.status as string,
        order_ref: (a.result_json as Row)?.order_id as string | null,
      })),
      variants: s.variants.map((v) => ({
        id: v.id as string,
        stock_qty: v.stock_qty as number,
        version: v.version as number,
      })),
      carts: s.carts.map((c) => ({ user_id: c.user_id as string, version: c.version as number })),
      cartItemCount: 0,
      protected: protectedRowsOf(s),
      deleteRows: deleteRowsOf(s),
    };
    const plan = evaluateRestrictedReset(snap, { baseline: approvedBaseline() });
    assert.equal(plan.mode, "remediate");
  });

  test("verifyBackupFile: 부재·sha 불일치는 거부, 일치는 통과", () => {
    assert.throws(
      () => verifyBackupFile("no/such/backup.sql", RESTRICTED_BACKUP.sha256),
      /부재/,
    );
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    try {
      const file = join(dir, "dump.sql");
      writeFileSync(file, "SELECT 1;");
      assert.throws(
        () => verifyBackupFile(file, RESTRICTED_BACKUP.sha256),
        /불일치/,
      );
      const sha = createHash("sha256").update("SELECT 1;").digest("hex");
      verifyBackupFile(file, sha); // 일치 — 통과
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("덤프 COPY 파싱 + 지문이 live 경로와 일치한다", () => {
    const s = auditState();
    // state의 보호 행을 COPY 텍스트로 직렬화 — 파서의 복원 검증
    const escapeCell = (v: unknown): string => {
      if (v === null || v === undefined) return "\\N";
      if (typeof v === "number") return String(v);
      if (typeof v === "boolean") return v ? "t" : "f";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v).replace(/\\/g, "\\\\");
    };
    const tableCols: Record<string, string[]> = {
      orders: ["id", "user_id", "status", "items_total_won", "shipping_fee_won", "total_won", "address_snapshot_json", "version", "created_at", "cancelled_at"],
      order_items: ["id", "order_id", "variant_id", "product_name_snapshot", "option_snapshot_json", "unit_price_won", "quantity", "line_total_won"],
      payments: ["id", "order_id", "method", "status", "paid_amount_won", "paid_at", "refund_status", "refunded_amount_won", "refunded_at"],
      shipments: ["id", "order_id", "status", "events_json", "estimated_arrival_at", "updated_at"],
      cancel_requests: ["id", "order_id", "action_request_id", "reason_code", "status", "refund_amount_won", "requested_at", "completed_at"],
      action_requests: ["id", "actor_user_id", "kind", "idempotency_key", "payload_json", "payload_hash", "status", "confirmed_at", "expires_at", "result_json", "error_code", "created_at", "completed_at"],
      product_variants: ["id", "product_id", "option_values_json", "spec_overrides_json", "unit_price_won", "stock_qty", "active", "version"],
      carts: ["id", "user_id", "version", "updated_at"],
      cart_items: ["id", "cart_id", "variant_id", "quantity"],
      products: ["id", "name", "brand", "category", "description", "image_urls", "specs_json", "active", "version"],
      reviews: ["id", "product_id", "variant_id", "rating", "body", "source_kind", "source_ref", "written_at"],
      users: ["id", "auth_subject", "display_name", "test_address_json", "created_at"],
    };
    const tblRows: Record<string, Row[]> = {
      orders: s.orders,
      order_items: s.items,
      payments: s.payments,
      shipments: s.shipments,
      cancel_requests: s.cancels,
      action_requests: s.actions,
      product_variants: s.variants,
      carts: s.carts,
      cart_items: s.cartItems,
      products: s.products,
      reviews: s.reviews,
      users: s.users,
    };
    let dump = "";
    for (const [t, cols] of Object.entries(tableCols)) {
      dump += "COPY public." + t + " (" + cols.join(", ") + ") FROM stdin;\n";
      for (const r of tblRows[t])
        dump += cols.map((c) => escapeCell(r[c])).join("\t") + "\n";
      dump += "\\.\n";
    }
    const parsed = loadDumpProtectedRows(dump);
    // 파서 지문 == live 라우트 지문 — COPY 복원과 canon이 일치해야 한다.
    assert.equal(protectedFingerprint(parsed), expectedFp(s));
  });

  test("승인 043 dump에서 파싱한 삭제 70행 지문이 PMQA-045 측정값과 일치한다", () => {
    const baseline = approvedBaseline();
    assert.equal(baseline.deleteRows.length, 70);
    assert.equal(
      protectedFingerprint(baseline.deleteRows),
      "ad27268b1cf278f5e8662b34336cc9fa819bed5051256d0ebc1547314cd1de54",
    );
  });
});
