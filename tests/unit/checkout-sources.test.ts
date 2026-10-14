// src/checkout.ts의 DB-free 검증 — PMQA-067 직접 구매(DIRECT)·부분 선택 주문
// (CART_SELECTED)·legacy 전체 카트(CART_FULL) 계약을 mock SQL/tx에 연결해
// 실제 exported checkoutQuote/confirmCheckout + runAction으로 회귀한다.
// 검증: direct 카트 SQL 0 · 선택 행만 삭제·미선택 보존 · 타인/중복/빈 선택 거절
// · 서명/source 변조·만료 거절 · write 전 검증 · 중간 예외 rollback ·
// 멱등 replay/conflict/READY. 실제 SQL·잠금은 NOT_RUN.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { checkoutQuote, confirmCheckout } from "../../src/checkout.ts";
import { payloadHash } from "../../src/actions.ts";
import { config } from "../../src/config.ts";
import type { RequestContext } from "../../src/session.ts";

const CTX: RequestContext = { actorUserId: "u-a", origin: "UI" };
const ADDR = { name: "테스터", phone: "010-0000", address: "서울 강남구", detail: "101" };

// ---- fake DB ----

type Call = { sql: string; params: unknown[]; tx: boolean };
type Resolver = (sql: string, params: unknown[]) => unknown[];

function mkDb(resolve: Resolver) {
  const calls: Call[] = [];
  const stats = { commit: 0, rollback: 0 };
  const run = (s: string, p: unknown[]) => {
    calls.push({ sql: s, params: p, tx: true });
    return resolve(s, p);
  };
  const q = { unsafe: (s: string, p: unknown[] = []) => Promise.resolve(run(s, p) as never[]) };
  const db = {
    unsafe: (s: string, p: unknown[] = []) => {
      calls.push({ sql: s, params: p, tx: false });
      return Promise.resolve(resolve(s, p) as never[]);
    },
    begin: (fn: (qq: typeof q) => Promise<unknown>) =>
      Promise.resolve()
        .then(() => fn(q))
        .then(
          (r) => {
            stats.commit++;
            return r;
          },
          (e) => {
            stats.rollback++;
            throw e;
          },
        ),
  };
  return { db: db as never, q: q as never, calls, stats };
}

// carts/cart_items 대상 SQL 검출 토큰 — 정규식 word-boundary가 제어문자
// (U+0008)로 깨져 DIRECT '카트 SQL 0' assertion이 무력화됐던 결함을
// 명시적 substring 검출로 대체한다 [PMQA-067 Luna 최종정적QA]. 이 파일의 fake-db에서는
// 토큰 등장이 곧 해당 테이블 참조이고, orders 등 타 테이블은 매칭되지 않는다.
const CART_TABLES = ["carts", "cart_items"] as const;

const cartWrites = (calls: Call[]) =>
  calls.filter((c) => CART_TABLES.some((t) => c.sql.includes(t)));
const businessWrites = (calls: Call[]) =>
  calls.filter((c) => /^(INSERT INTO (orders|order_items|payments|shipments)|UPDATE product_variants|DELETE FROM cart_items|UPDATE carts)/.test(c.sql));

// ---- 검출기 자체 검증 — assertion 무력화 재발 방지 ----

describe("cartWrites 검출기 자체 검증", () => {
  const call = (sql: string): Call => ({ sql, params: [], tx: true });

  test("carts/cart_items를 참조하는 SELECT·INSERT·UPDATE·DELETE를 전부 검출", () => {
    const calls = [
      call("SELECT id, version FROM carts WHERE user_id=$1"),
      call("SELECT * FROM cart_items ci WHERE ci.cart_id=$1"),
      call("INSERT INTO carts (id, user_id) VALUES ($1,$2)"),
      call("INSERT INTO cart_items (id, cart_id) VALUES ($1,$2)"),
      call("UPDATE carts SET version=version+1 WHERE id=$1"),
      call("DELETE FROM cart_items WHERE cart_id=$1 AND id = ANY($2)"),
    ];
    assert.equal(cartWrites(calls).length, calls.length);
  });

  test("orders·product_variants 등 다른 테이블 SQL은 검출하지 않는다", () => {
    const calls = [
      call("INSERT INTO orders (id) VALUES ($1)"),
      call("INSERT INTO order_items (id, order_id) VALUES ($1,$2)"),
      call("INSERT INTO payments (id) VALUES ($1)"),
      call("INSERT INTO shipments (id) VALUES ($1)"),
      call("SELECT * FROM orders WHERE id=$1"),
      call("UPDATE product_variants SET stock=stock-$2 WHERE id=$1"),
    ];
    assert.equal(cartWrites(calls).length, 0);
  });
});

// ---- fixture ----

const USERS = [{ test_address_json: ADDR }];
const CART = [{ id: "cart-u-a", version: 5 }];
// cartView 행(선택 견적용 — 넓은 스키마)
const cvA = { cart_item_id: "ci-1", quantity: 2, variant_id: "v-1", product_id: "p-1", option_values_json: { size: "24" }, unit_price_won: 90000, stock_qty: 10, variant_active: true, variant_version: 7, product_name: "모니터A", image_urls: ["/a.webp"], product_active: true };
const cvB = { cart_item_id: "ci-2", quantity: 1, variant_id: "v-2", product_id: "p-2", option_values_json: { size: "27" }, unit_price_won: 50000, stock_qty: 5, variant_active: true, variant_version: 2, product_name: "모니터B", image_urls: ["/b.webp"], product_active: true };
const cvC = { cart_item_id: "ci-3", quantity: 1, variant_id: "v-3", product_id: "p-3", option_values_json: { size: "32" }, unit_price_won: 120000, stock_qty: 0, variant_active: true, variant_version: 1, product_name: "모니터C", image_urls: [], product_active: true };
// confirm cart_items 행
const ci1 = { id: "ci-1", variant_id: "v-1", quantity: 2 };
const ci2 = { id: "ci-2", variant_id: "v-2", quantity: 1 };
// variant 잠금 행
const vv1 = { id: "v-1", version: 7, stock_qty: 10, unit_price_won: 90000, active: true, product_active: true, product_name: "모니터A", option_values_json: { size: "24" } };
const vv2 = { id: "v-2", version: 2, stock_qty: 5, unit_price_won: 50000, active: true, product_active: true, product_name: "모니터B", option_values_json: { size: "27" } };
// DIRECT variant 행(quote — product_id/image 포함)
const dv = { id: "v-9", product_id: "p-9", option_values_json: { color: "black" }, unit_price_won: 30000, stock_qty: 4, active: true, version: 9, product_name: "키보드", image_urls: ["/k.webp"], product_active: true };

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()) as Record<string, unknown>;
const sign = (body: string) =>
  createHmac("sha256", config.sessionSecret).update("checkout:" + body).digest("base64url");
const mkToken = (p: unknown) => {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  return body + "." + sign(body);
};
const tokenHash = (token: string) =>
  createHmac("sha256", config.sessionSecret).update("hash:" + token).digest("hex");

// ---- 견적 ----

describe("checkoutQuote — DIRECT 바로 구매", () => {
  const route: Resolver = (s) => {
    if (s.includes("FROM product_variants")) return [dv] as never[];
    if (s.includes("FROM users")) return USERS as never[];
    return [];
  };

  test("성공 — 카트 SQL 0건, 토큰은 v2 DIRECT, 서버 가격·수량 정규화", async () => {
    const { db, calls } = mkDb(route);
    const r = await checkoutQuote(CTX, { kind: "DIRECT", variant_id: "v-9", quantity: 2 }, db);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.source, "DIRECT");
    assert.equal(r.data.cart, null);
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.items[0].variant_id, "v-9");
    assert.equal(r.data.items[0].cart_item_id, null);
    assert.equal(r.data.items_total_won, 60000);
    assert.equal(r.data.shipping_fee_won, 3000);
    assert.equal(r.data.total_won, 63000);
    const p = decode(r.data.quote_token);
    assert.equal(p.v, 2);
    assert.equal(p.source, "DIRECT");
    assert.equal(p.cart_version, undefined); // direct는 카트 버전을 만들지 않는다
    assert.equal(cartWrites(calls).length, 0); // carts/cart_items/getCart upsert 0
  });

  test("수량 비정형(0·음수·소수·문자·NaN·안전정수 초과) → VALIDATION·쿼리 0", async () => {
    for (const qty of [0, -1, 1.5, "2", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const { db, calls } = mkDb(route);
      const r = await checkoutQuote(CTX, { kind: "DIRECT", variant_id: "v-9", quantity: qty }, db);
      assert.equal(r.ok, false, String(qty));
      if (!r.ok) assert.equal(r.error.code, "VALIDATION", String(qty));
      assert.equal(calls.length, 0, String(qty)); // 형식 검증이 쿼리보다 먼저다
    }
  });

  test("variant 부재 NOT_FOUND · 비활성 UNAVAILABLE · 재고 부족 OUT_OF_STOCK", async () => {
    const cases: [unknown[], string][] = [
      [[], "NOT_FOUND"],
      [[{ ...dv, active: false }], "UNAVAILABLE"],
      [[{ ...dv, product_active: false }], "UNAVAILABLE"],
      [[{ ...dv, stock_qty: 1 }], "OUT_OF_STOCK"],
    ];
    for (const [rows, code] of cases) {
      const { db } = mkDb((s) =>
        s.includes("FROM product_variants") ? (rows as never[]) : USERS as never[]);
      const r = await checkoutQuote(CTX, { kind: "DIRECT", variant_id: "v-9", quantity: 2 }, db);
      assert.equal(r.ok, false, code);
      if (!r.ok) assert.equal(r.error.code, code, code);
    }
  });

  test("배송지 없음 → VALIDATION", async () => {
    const { db } = mkDb((s) =>
      s.includes("FROM product_variants") ? [dv] as never[] : []);
    const r = await checkoutQuote(CTX, { kind: "DIRECT", variant_id: "v-9", quantity: 1 }, db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "VALIDATION");
  });
});

describe("checkoutQuote — CART_SELECTED 부분 선택 주문", () => {
  const route =
    (viewRows: unknown[] = [cvA, cvB], cartRow: unknown[] = CART): Resolver =>
    (s) => {
      if (s.includes("FROM carts")) return cartRow as never[];
      if (s.includes("FROM cart_items ci")) return viewRows as never[];
      if (s.includes("FROM users")) return USERS as never[];
      return [];
    };

  test("성공 — 카트 upsert 없이 선택 부분집합 견적, 소유 행으로 정규화", async () => {
    const { db, calls } = mkDb(route());
    const r = await checkoutQuote(CTX, { kind: "CART_SELECTED", cart_item_ids: ["ci-2", "ci-1"] }, db);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.source, "CART_SELECTED");
    assert.equal(r.data.cart?.version, 5); // 실제 카트 버전 유지
    assert.equal(r.data.items.length, 2);
    assert.equal(r.data.total_won, 230000 + 3000);
    const p = decode(r.data.quote_token);
    assert.deepEqual([...p.cart_item_ids as string[]].sort(), ["ci-1", "ci-2"]);
    assert.equal(p.cart_version, undefined); // 선택 견적은 행 검증이라 버전 미서명
    assert.equal(calls.filter((c) => c.sql.includes("INSERT INTO carts")).length, 0);
  });

  test("빈 선택·중복·비문자열 ID → VALIDATION·카트 쿼리 전 거절", async () => {
    for (const ids of [[], ["ci-1", "ci-1"], ["ci-1", 7], null, "ci-1"]) {
      const { db, calls } = mkDb(route());
      const r = await checkoutQuote(CTX, { kind: "CART_SELECTED", cart_item_ids: ids }, db);
      assert.equal(r.ok, false, JSON.stringify(ids));
      if (!r.ok) assert.equal(r.error.code, "VALIDATION");
      assert.equal(cartWrites(calls).length, 0, JSON.stringify(ids));
    }
  });

  test("카트 없음 VALIDATION · 일부 ID 소유 불일치 VALIDATION · 품절 포함 CART_BLOCKED", async () => {
    const noCart = mkDb(route([cvA], []));
    const r1 = await checkoutQuote(CTX, { kind: "CART_SELECTED", cart_item_ids: ["ci-1"] }, noCart.db);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.error.code, "VALIDATION");

    const missing = mkDb(route([cvA])); // ci-2 행이 카트에 없음
    const r2 = await checkoutQuote(CTX, { kind: "CART_SELECTED", cart_item_ids: ["ci-1", "ci-9"] }, missing.db);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.error.code, "VALIDATION");

    const sold = mkDb(route([cvA, cvC]));
    const r3 = await checkoutQuote(CTX, { kind: "CART_SELECTED", cart_item_ids: ["ci-1", "ci-3"] }, sold.db);
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.error.code, "CART_BLOCKED");
  });

  test("알 수 없는 source·source 누락 → VALIDATION (전체 카트로 추정 안 함)", async () => {
    for (const input of [{ kind: "X" }, {}, { kind: undefined }]) {
      const { db } = mkDb(route());
      const r = await checkoutQuote(CTX, input, db);
      assert.equal(r.ok, false, JSON.stringify(input));
      if (!r.ok) assert.equal(r.error.code, "VALIDATION");
    }
  });
});

describe("checkoutQuote — CART_FULL legacy 호환", () => {
  test("전체 카트 견적 — getCart upsert 1회·cart_version 서명", async () => {
    const { db, calls } = mkDb((s) => {
      if (s.includes("INSERT INTO carts")) return CART as never[];
      if (s.includes("FROM cart_items ci")) return [cvA, cvB] as never[];
      if (s.includes("FROM users")) return USERS as never[];
      return [];
    });
    const r = await checkoutQuote(CTX, { kind: "CART_FULL" }, db);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.source, "CART_FULL");
    assert.equal(calls.filter((c) => c.sql.includes("INSERT INTO carts")).length, 1);
    const p = decode(r.data.quote_token);
    assert.equal(p.v, 2);
    assert.equal(p.cart_version, 5);
  });
});

// ---- 확인 실행 ----

describe("confirmCheckout — DIRECT", () => {
  const base = (variantRows: unknown[] = [dv], extra?: Resolver): Resolver => (s, p) => {
    if (s.startsWith("SELECT * FROM action_requests")) return [];
    if (s.includes("FROM product_variants")) {
      // quote 단계(비tx)와 confirm 잠금(FOR UPDATE) 모두 같은 행을 돌려준다
      const ids = (p[0] ?? p[0]) as string | string[];
      const vid = Array.isArray(ids) ? ids[0] : ids;
      if (s.includes("v.id=$1")) return variantRows as never[]; // quote 단건
      return (variantRows as { id: string }[]).filter((v) => (p[0] as string[]).includes(v.id)) as never[];
    }
    if (extra) return extra(s, p);
    return [];
  };

  async function directToken(qty = 2) {
    const { db } = mkDb((s) =>
      s.includes("FROM product_variants") ? [dv] as never[]
        : s.includes("FROM users") ? USERS as never[] : []);
    const r = await checkoutQuote(CTX, { kind: "DIRECT", variant_id: "v-9", quantity: qty }, db);
    if (!r.ok) throw new Error("quote failed");
    return r.data.quote_token;
  }

  test("성공 — carts/cart_items SQL 0건·주문/결제/배송 생성·커밋 1", async () => {
    const token = await directToken();
    const { db, calls, stats } = mkDb(base([{ ...vv1, id: "v-9", version: 9, unit_price_won: 30000, stock_qty: 4, product_name: "키보드", option_values_json: { color: "black" } }]));
    const r = await confirmCheckout(token, CTX, "k-direct-1", db);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.data.order_id, /^ord-/);
    assert.equal(r.data.total_won, 63000);
    assert.equal(cartWrites(calls).length, 0); // 카트 읽기·쓰기 전무
    assert.ok(calls.some((c) => c.sql.startsWith("INSERT INTO orders")));
    assert.ok(calls.some((c) => c.sql.startsWith("INSERT INTO payments")));
    assert.ok(calls.some((c) => c.sql.startsWith("INSERT INTO shipments")));
    assert.ok(calls.some((c) => c.sql.startsWith("UPDATE action_requests")));
    assert.deepEqual(stats, { commit: 1, rollback: 0 });
  });

  test("재고 부족(확인 시점) → REJECTED OUT_OF_STOCK·업무 write 0·커밋", async () => {
    const token = await directToken();
    const { db, calls, stats } = mkDb(
      base([{ ...vv1, id: "v-9", version: 9, unit_price_won: 30000, stock_qty: 1, product_name: "키보드", option_values_json: {} }]),
    );
    const r = await confirmCheckout(token, CTX, "k-direct-oos", db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "OUT_OF_STOCK");
    assert.equal(businessWrites(calls).length, 0);
    assert.deepEqual(stats, { commit: 1, rollback: 0 }); // REJECTED 감사 커밋
  });

  test("write 중 예외(payments INSERT) → 예외 전파·rollback·commit 0", async () => {
    const token = await directToken();
    const { db, stats } = mkDb((s, p) => {
      if (s.startsWith("INSERT INTO payments")) throw new Error("db gone");
      return base([{ ...vv1, id: "v-9", version: 9, unit_price_won: 30000, stock_qty: 4, product_name: "k", option_values_json: {} }])(s, p);
    });
    await assert.rejects(confirmCheckout(token, CTX, "k-direct-err", db), /db gone/);
    assert.deepEqual(stats, { commit: 0, rollback: 1 });
  });

  test("토큰 변조·타인 토큰 → VALIDATION·업무 SQL 0", async () => {
    const token = await directToken();
    const forged = decode(token);
    forged.total_won = 1; // 총액 위조
    const badSig = mkToken(forged); // 재서명해도 v2 정합 검사(총액 불일치)로 거절
    const forgedNoSig = token.split(".")[0] + ".forgedsig"; // 서명 위조
    const otherUser = mkToken({ ...decode(token), user_id: "u-b" });
    for (const t of [badSig, forgedNoSig, otherUser]) {
      const { db, calls } = mkDb(base());
      const r = await confirmCheckout(t, CTX, "k-x", db);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, "VALIDATION");
      assert.equal(businessWrites(calls).length, 0);
    }
  });
});

describe("confirmCheckout — CART_SELECTED", () => {
  async function selToken() {
    const { db } = mkDb((s) => {
      if (s.includes("FROM carts")) return CART as never[];
      if (s.includes("FROM cart_items ci")) return [cvA, cvB] as never[];
      if (s.includes("FROM users")) return USERS as never[];
      return [];
    });
    const r = await checkoutQuote(CTX, { kind: "CART_SELECTED", cart_item_ids: ["ci-1", "ci-2"] }, db);
    if (!r.ok) throw new Error("quote failed");
    return r.data.quote_token;
  }

  const confirmRoute =
    (itemRows: unknown[] = [ci1, ci2], variantRows: unknown[] = [vv1, vv2]): Resolver =>
    (s, p) => {
      if (s.startsWith("SELECT * FROM action_requests")) return [];
      if (s.includes("FROM carts")) return CART as never[];
      if (s.includes("FROM cart_items") && s.includes("id = ANY"))
        return (itemRows as { id: string }[]).filter((r) => (p[1] as string[]).includes(r.id)) as never[];
      if (s.includes("FROM product_variants"))
        return (variantRows as { id: string }[]).filter((v) => (p[0] as string[]).includes(v.id)) as never[];
      return [];
    };

  test("성공 — 선택 행만 검증·삭제, 미선택 ci-3는 어디에도 포함되지 않음", async () => {
    const token = await selToken();
    const { db, calls, stats } = mkDb(confirmRoute());
    const r = await confirmCheckout(token, CTX, "k-sel-1", db);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.total_won, 233000);
    // 선택 행만 ANY로 잠그고 삭제 — 미선택 ci-3는 params에도 없다
    const lockSel = calls.find((c) => c.sql.includes("FROM cart_items") && c.sql.includes("id = ANY"));
    assert.deepEqual(lockSel?.params[1], ["ci-1", "ci-2"]);
    const del = calls.find((c) => c.sql.startsWith("DELETE FROM cart_items"));
    assert.ok(del?.sql.includes("id = ANY"));
    assert.deepEqual(del?.params, ["cart-u-a", ["ci-1", "ci-2"]]);
    assert.equal(JSON.stringify(calls.map((c) => c.params)).includes("ci-3"), false);
    // 전체 삭제 쿼리가 아니다 — 미선택 보존
    assert.ok(!calls.some((c) => c.sql === "DELETE FROM cart_items WHERE cart_id=$1"));
    assert.ok(calls.some((c) => c.sql.startsWith("UPDATE carts SET version")));
    assert.deepEqual(stats, { commit: 1, rollback: 0 });
  });

  test("선택 행 수량 변경·행 삭제 → REJECTED·업무 write 0", async () => {
    const token = await selToken();
    const qtyChanged = mkDb(confirmRoute([{ ...ci1, quantity: 5 }, ci2]));
    const r1 = await confirmCheckout(token, CTX, "k-sel-qty", qtyChanged.db);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.error.code, "STALE_QUOTE");
    assert.equal(businessWrites(qtyChanged.calls).length, 0);

    const rowGone = mkDb(confirmRoute([ci1])); // ci-2 행이 사라짐
    const r2 = await confirmCheckout(token, CTX, "k-sel-gone", rowGone.db);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.error.code, "STALE_QUOTE");
    assert.equal(businessWrites(rowGone.calls).length, 0);
  });

  test("미선택 행 변경은 무효화하지 않는다 — 카트 버전 서명 없음", async () => {
    const token = await selToken();
    // 카트 버전이 5→9로 바뀌어도(미선택 수량 변경 등) 선택 행만 일치하면 통과한다.
    // 카트 FOR UPDATE 읽기는 tx 안의 q.unsafe로 실행되므로 — resolver 자체가
    // version 9를 돌려줘야 실제 관측이 시험된다 (db.unsafe만 override하면
    // 비tx 경로만 바뀌고 tx는 원 resolver=5를 탄다) [PMQA-067-R2].
    let cartVersionObserved: number | null = null;
    const { db, calls } = mkDb((s, p) => {
      if (s.includes("FROM carts")) {
        cartVersionObserved = 9;
        return [{ id: "cart-u-a", version: 9 }] as never[];
      }
      return confirmRoute([ci1, ci2], [vv1, vv2])(s, p);
    });
    const r = await confirmCheckout(token, CTX, "k-sel-ver", db);
    assert.equal(r.ok, true);
    // tx 안의 카트 잠금 읽기가 실제로 버전 9를 관측했고 그래도 통과했다
    assert.equal(cartVersionObserved, 9);
    assert.ok(calls.some((c) => c.tx && c.sql.includes("FROM carts")));
    assert.ok(calls.some((c) => c.sql.startsWith("INSERT INTO orders")));
  });
});

describe("confirmCheckout — CART_FULL legacy + 토큰 형식", () => {
  const items = [
    { variant_id: "v-1", cart_item_id: "ci-1", quantity: 2, unit_price_won: 90000, variant_version: 7 },
    { variant_id: "v-2", cart_item_id: "ci-2", quantity: 1, unit_price_won: 50000, variant_version: 2 },
  ];
  const v2full = {
    v: 2, user_id: "u-a", source: "CART_FULL", cart_version: 5, items,
    items_total_won: 230000, shipping_fee_won: 3000, total_won: 233000,
    address: ADDR, expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const fullRoute = (cartVer = 5, itemRows: unknown[] = [ci1, ci2]): Resolver => (s, p) => {
    if (s.startsWith("SELECT * FROM action_requests")) return [];
    if (s.includes("FROM carts")) return [{ id: "cart-u-a", version: cartVer }] as never[];
    if (s.includes("FROM cart_items")) return itemRows as never[];
    if (s.includes("FROM product_variants"))
      return ([vv1, vv2] as { id: string }[]).filter((v) => (p[0] as string[]).includes(v.id)) as never[];
    return [];
  };

  test("v2 전체 카트 — 전체 삭제 + 버전 증가(기존 동작 보존)", async () => {
    const { db, calls } = mkDb(fullRoute());
    const r = await confirmCheckout(mkToken(v2full), CTX, "k-full-1", db);
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => c.sql === "DELETE FROM cart_items WHERE cart_id=$1"));
    assert.ok(calls.some((c) => c.sql.startsWith("UPDATE carts SET version")));
  });

  test("legacy v1 토큰(v/source 부재·cart_version 보유) — 명시적 전체 카트 호환", async () => {
    const v1 = {
      user_id: "u-a", cart_version: 5,
      items: items.map(({ cart_item_id: _c, ...rest }) => rest), // v1은 cart_item_id 없음
      items_total_won: 230000, shipping_fee_won: 3000, total_won: 233000,
      address: ADDR, expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    const { db, calls } = mkDb(fullRoute());
    const r = await confirmCheckout(mkToken(v1), CTX, "k-full-v1", db);
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => c.sql === "DELETE FROM cart_items WHERE cart_id=$1"));
  });

  test("v2 토큰의 source 누락·혼합 형식은 legacy로 해석하지 않고 거절", async () => {
    const noSource = { ...v2full, source: undefined };
    const unknownSource = { ...v2full, source: "SELECTED" };
    for (const p of [noSource, unknownSource]) {
      const { db, calls } = mkDb(fullRoute());
      const r = await confirmCheckout(mkToken(p), CTX, "k-full-bad", db);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error.code, "VALIDATION");
      assert.equal(businessWrites(calls).length, 0);
    }
  });

  test("카트 버전 불일치·만료 토큰 → STALE_QUOTE·업무 write 0", async () => {
    const { db, calls } = mkDb(fullRoute(99)); // 버전 어긋남
    const r = await confirmCheckout(mkToken(v2full), CTX, "k-full-stale", db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "STALE_QUOTE");
    assert.equal(businessWrites(calls).length, 0);

    const expired = { ...v2full, expires_at: new Date(Date.now() - 1000).toISOString() };
    const m2 = mkDb(fullRoute());
    const r2 = await confirmCheckout(mkToken(expired), CTX, "k-full-exp", m2.db);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.error.code, "STALE_QUOTE");
    assert.equal(businessWrites(m2.calls).length, 0);
  });
});

describe("confirmCheckout — 멱등성·응답 유실", () => {
  const v2direct = {
    v: 2, user_id: "u-a", source: "DIRECT",
    items: [{ variant_id: "v-9", quantity: 1, unit_price_won: 30000, variant_version: 9 }],
    items_total_won: 30000, shipping_fee_won: 3000, total_won: 33000,
    address: ADDR, expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  const rowFor = (token: string, status: string, result: unknown, hash = true) => [{
    id: "op-1",
    kind: "CHECKOUT",
    payload_hash: hash
      ? payloadHash({ quote_token_hash: tokenHash(token) })
      : "other-hash",
    status,
    result_json: result,
    error_code: null,
  }];
  const replayRoute = (row: unknown[]): Resolver => (s) =>
    s.startsWith("SELECT * FROM action_requests") ? (row as never[]) : [];

  test("SUCCEEDED 행 replay — 저장 결과 복원·업무 callback 0회", async () => {
    const token = mkToken(v2direct);
    const { db, calls } = mkDb(replayRoute(rowFor(token, "SUCCEEDED", { order_id: "ord-done", total_won: 33000 })));
    const r = await confirmCheckout(token, CTX, "k-rep-1", db);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.order_id, "ord-done"); // 저장된 주문 ID
    assert.equal(r.replayed, true);
    assert.equal(businessWrites(calls).length, 0); // fn 자체가 실행되지 않음
  });

  test("같은 키+다른 견적 → IDEMPOTENCY_CONFLICT", async () => {
    const token = mkToken(v2direct);
    const other = mkToken({ ...v2direct, items: [{ ...v2direct.items[0], quantity: 2 }], items_total_won: 60000, total_won: 63000 });
    const { db } = mkDb(replayRoute(rowFor(token, "SUCCEEDED", { order_id: "ord-done" })));
    const r = await confirmCheckout(other, CTX, "k-rep-1", db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "IDEMPOTENCY_CONFLICT");
  });

  test("READY 행 → OUTCOME_UNKNOWN(두 번째 주문 생성 금지)", async () => {
    const token = mkToken(v2direct);
    const { db, calls } = mkDb(replayRoute(rowFor(token, "READY", null)));
    const r = await confirmCheckout(token, CTX, "k-rep-1", db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "OUTCOME_UNKNOWN");
    assert.equal(businessWrites(calls).length, 0);
  });

  test("SUCCEEDED 행은 만료된 토큰으로 replay돼도 저장 결과를 복원한다 — callback 0", async () => {
    // replay는 견적 디코딩·만료 검증보다 먼저다 — 이미 커밋된 주문의 결과를
    // 돌려주는 경로이므로 토큰 만료와 무관하게 성공하고 fn은 실행되지 않는다.
    const expiredToken = mkToken({
      ...v2direct,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const { db, calls } = mkDb(
      replayRoute(rowFor(expiredToken, "SUCCEEDED", { order_id: "ord-done", total_won: 33000 })),
    );
    const r = await confirmCheckout(expiredToken, CTX, "k-rep-exp", db);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.order_id, "ord-done");
    assert.equal(r.replayed, true);
    assert.equal(businessWrites(calls).length, 0);
  });

  test("같은 idempotency key라도 actor가 다르면 격리된다 — 조회·insert가 actor 스코프", async () => {
    // u-a에게만 'k-same'의 SUCCEEDED 행이 있다. u-b가 같은 키로 요청하면
    // u-a의 결과를 보지 않고 자기 스코프로 새 실행을 기록·진행한다.
    const tokenA = mkToken(v2direct);
    const tokenB = mkToken({ ...v2direct, user_id: "u-b" });
    const CTX_B: RequestContext = { actorUserId: "u-b", origin: "UI" };
    const selectSeen: unknown[][] = [];
    const insertSeen: unknown[][] = [];
    const biz: Resolver = (s, p) => {
      if (s.includes("FROM product_variants")) {
        const ids = Array.isArray(p[0]) ? (p[0] as string[]) : [p[0] as string];
        return [{ id: "v-9", version: 9, stock_qty: 4, unit_price_won: 30000, active: true, product_active: true, product_name: "키보드", option_values_json: {} }]
          .filter((v) => ids.includes(v.id)) as never[];
      }
      return [];
    };
    const { db } = mkDb((s, p) => {
      if (s.startsWith("SELECT * FROM action_requests")) {
        selectSeen.push([...p]);
        return (p[0] === "u-a"
          ? rowFor(tokenA, "SUCCEEDED", { order_id: "ord-a", total_won: 33000 })
          : []) as never[]; // u-b 조회에는 u-a의 행이 나오지 않는다
      }
      if (s.startsWith("INSERT INTO action_requests")) insertSeen.push([...p]);
      return biz(s, p);
    });

    const rA = await confirmCheckout(tokenA, CTX, "k-same", db);
    assert.equal(rA.ok, true);
    if (rA.ok) assert.equal(rA.data.order_id, "ord-a"); // 저장된 u-a 결과 복원
    assert.equal(rA.replayed, true);

    const rB = await confirmCheckout(tokenB, CTX_B, "k-same", db);
    assert.equal(rB.ok, true);
    if (rB.ok) assert.notEqual(rB.data.order_id, "ord-a"); // 새 주문이 생성됐다
    assert.equal(rB.replayed, undefined); // 타인 결과 재생 아님
    // 조회·기록 모두 actor_user_id를 파라미터로 스코프한다
    assert.deepEqual(selectSeen.map((p) => p[0]), ["u-a", "u-b"]);
    assert.ok(insertSeen.some((p) => p[1] === "u-b" && p[3] === "k-same"));
  });
});
