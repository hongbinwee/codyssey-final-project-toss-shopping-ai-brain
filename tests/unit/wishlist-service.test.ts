// src/wishlist.ts의 DB-free 검증 — mock SqlDb를 runAction에 주입해
// pre-validation no-write·READY 충돌·active 판정·replay를 회귀한다 [PMQA-070].
//
// [증명 범위 — PM070 테스트 정적 QA]
// 이 파일이 증명하는 것은 SQL 잠금 문구·호출 절차·파라미터 바인딩이다.
// 실제 동시성 직렬화·트랜잭션 rollback·장기 durability는 mock으로 재현할 수
// 없어 실DB 통합 검증(NOT_RUN)의 범위로 분리한다 — 이 파일의 PASS를 실DB
// 동시성 증거로 해석하면 안 된다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWishlistPut, setWishlistInputError, setWishlist, getWishlist,
  type SetWishlistInput,
} from "../../src/wishlist.ts";
import { payloadHash, type SqlDb } from "../../src/actions.ts";
import type { RequestContext } from "../../src/session.ts";

const ctx = (uid = "u-a"): RequestContext => ({ actorUserId: uid, origin: "UI" });

type Rec = { q: string; p: unknown[] | undefined };

// runAction의 쿼리 순서는 고정이다 — SELECT(키 조회) → INSERT(action_requests)
// → fn(비즈니스: users 잠금 → READY 잠금 → products 후판정 → items 쓰기 → count)
// → UPDATE(상태 확정). 쿼리 문자열로 분기하고 **파라미터를 함께 수집**해
// actor 바인딩을 실제로 검증한다(_p를 버리면 WHERE 값 검증이 불가 [PM070 QA]).
function mkDb(opts: {
  existing?: Record<string, unknown>[];
  pendings?: Record<string, unknown>[];
  users?: Record<string, unknown>[];
  products?: Record<string, unknown>[];
  wishCount?: number;
  getRows?: Record<string, unknown>[];
} = {}) {
  const queries: Rec[] = [];
  let began = 0;
  const run = async (q: string, p?: unknown[]): Promise<unknown[]> => {
    queries.push({ q, p });
    // 같은 상품의 READY SET_WISHLIST 잠금 조회 (fn 내부)
    if (q.includes("status=" + String.fromCharCode(39) + "READY" + String.fromCharCode(39)))
      return opts.pendings ?? [];
    // getWishlist의 목록 join
    if (q.includes("JOIN products")) return opts.getRows ?? [];
    if (q.includes("count(*)")) return [{ n: opts.wishCount ?? 1 }];
    if (q.startsWith("SELECT") && q.includes("action_requests"))
      return opts.existing ?? [];
    if (q.includes("FROM users")) return opts.users ?? [{ id: "u-a" }];
    if (q.includes("FROM products")) return opts.products ?? [{ id: "p-x", active: true }];
    return [];
  };
  const db = {
    unsafe: run,
    begin: async (fn: (q: { unsafe: typeof run }) => Promise<unknown>) => {
      began++;
      return fn({ unsafe: run });
    },
  } as unknown as SqlDb;
  return { db, queries, began: () => began };
}

// 찜 실행 SQL이 읽기·쓰기 어떤 형태로도 건드리면 안 되는 테이블 —
// cart/order/payment/배송/취소/리뷰는 찜 경로에 존재 자체가 계약 위반이다.
const NEVER_TOUCH = [
  "carts", "cart_items", "orders", "order_items", "payments",
  "shipments", "cancel_requests", "reviews", "_migrations",
];
// products·users·variants는 읽기(FOR SHARE/NO KEY UPDATE 잠금·join)만 허용 —
// 가격·재고·상품·사용자 데이터의 실제 변경(write)은 없어야 한다.
const NO_WRITE =
  /(insert\s+into|delete\s+from|update)\s+(users|products|product_variants|reviews|orders|order_items|payments|carts|cart_items|shipments|cancel_requests)\b/i;

const assertBoundary = (queries: Rec[]) => {
  for (const { q } of queries) {
    for (const tbl of NEVER_TOUCH)
      assert.ok(!q.includes(tbl), "protected table touched: " + tbl);
    assert.ok(!NO_WRITE.test(q), "write outside wishlist/action_requests: " + q);
  }
};

// actor 바인딩 위치 — users 잠금·READY 잠금·items 쓰기·count·action_requests
// 조회의 $1, action_requests INSERT의 $2는 전부 세션 actor여야 한다.
const assertActorParams = (queries: Rec[], actor: string) => {
  const at = (frag: string) => queries.find(({ q }) => q.includes(frag));
  assert.equal(at("FROM users")?.p?.[0], actor, "users lock actor");
  assert.equal(at("FOR NO KEY UPDATE")?.p?.[0], actor, "actor serialize lock");
  assert.equal(
    queries.find(({ q }) => q.includes("status=" + String.fromCharCode(39) + "READY" + String.fromCharCode(39)))?.p?.[0],
    actor,
    "READY pendings actor",
  );
  const items = queries.find(({ q }) =>
    (q.includes("INSERT INTO wishlist_items") || q.includes("DELETE FROM wishlist_items")),
  );
  assert.equal(items?.p?.[0], actor, "wishlist_items actor");
  assert.equal(at("count(*)")?.p?.[0], actor, "count actor");
  assert.equal(at("idempotency_key=$3")?.p?.[0], actor, "action lookup actor");
  assert.equal(
    queries.find(({ q }) => q.includes("INSERT INTO action_requests"))?.p?.[1],
    actor,
    "action_requests insert actor",
  );
};

describe("parseWishlistPut / setWishlistInputError — 입력 검증", () => {
  test("비정형 body는 거절한다", () => {
    for (const b of [
      null, undefined, [], "x",
      { saved: "yes", idempotency_key: "k" },
      { saved: true },                                   // key 부재
      { saved: true, idempotency_key: "" },
      { saved: true, idempotency_key: "   " },           // 공백만
      { saved: true, idempotency_key: 1 },               // 비문자열
      { saved: true, idempotency_key: "k".repeat(201) }, // 과대
    ])
      assert.equal(parseWishlistPut(b).ok, false, JSON.stringify(b));
    assert.deepEqual(
      parseWishlistPut({ saved: true, idempotency_key: "k1" }),
      { ok: true, saved: true, idempotency_key: "k1" },
    );
  });

  test("setWishlistInputError — product_id/saved만 검증한다", () => {
    assert.ok(setWishlistInputError(null));
    assert.ok(setWishlistInputError({}));
    assert.ok(setWishlistInputError({ product_id: "", saved: true }));
    assert.ok(setWishlistInputError({ product_id: "p", saved: "yes" }));
    assert.equal(setWishlistInputError({ product_id: "p", saved: false }), null);
  });
});

describe("setWishlist — runAction 오케스트레이션", () => {
  test("invalid payload는 runAction 이전에 거절 — action_requests 기록 0", async () => {
    const { db, queries, began } = mkDb();
    const r = await setWishlist({ product_id: "", saved: true }, ctx(), "k1", db);
    assert.equal(r.ok, false);
    assert.equal(began(), 0);              // 트랜잭션 자체를 열지 않는다
    assert.equal(queries.length, 0);
  });

  test("같은 상품의 READY 반대 saved → OPERATION_IN_FLIGHT", async () => {
    const { db, queries } = mkDb({
      pendings: [{ id: "op-1", payload_saved: "false" }],
    });
    const r = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k-new", db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "OPERATION_IN_FLIGHT");
    // wishlist_items 쓰기는 실행되지 않는다
    assert.ok(
      !queries.some(
        ({ q }) => q.includes("wishlist_items") &&
          (q.includes("INSERT") || q.includes("DELETE")),
      ),
    );
  });

  test("같은 방향 saved의 READY는 차단하지 않는다", async () => {
    const { db } = mkDb({ pendings: [{ id: "op-1", payload_saved: "true" }] });
    const r = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k-new", db);
    assert.equal(r.ok, true); // 같은 의도 — 진행 허용
  });

  test("판매 중단 상품 — 새 저장은 UNAVAILABLE, 해제는 허용", async () => {
    const { db: d1 } = mkDb({ products: [{ id: "p-x", active: false }] });
    const save = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k1", d1);
    assert.equal(save.ok, false);
    if (!save.ok) assert.equal(save.error.code, "UNAVAILABLE");
    const { db: d2, queries } = mkDb({ products: [{ id: "p-x", active: false }] });
    const unsave = await setWishlist({ product_id: "p-x", saved: false }, ctx(), "k2", d2);
    assert.equal(unsave.ok, true);
    assert.ok(queries.some(({ q }) => q.includes("DELETE FROM wishlist_items")));
  });

  test("미존재 상품 → NOT_FOUND / 미존재 사용자 → NOT_FOUND", async () => {
    const { db: d1 } = mkDb({ products: [] });
    const r1 = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k1", d1);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.error.code, "NOT_FOUND");
    const { db: d2 } = mkDb({ users: [] });
    const r2 = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k1", d2);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.error.code, "NOT_FOUND");
  });

  test("정상 저장 — INSERT ON CONFLICT + wishlist_count + SUCCEEDED 확정", async () => {
    const { db, queries } = mkDb({ wishCount: 3 });
    const r = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k1", db);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.saved, true);
      assert.equal(r.data.wishlist_count, 3);
    }
    assert.ok(
      queries.some(
        ({ q }) => q.includes("INSERT INTO wishlist_items") && q.includes("ON CONFLICT"),
      ),
    );
    assert.ok(queries.some(({ q }) => q.includes("status=" + String.fromCharCode(39) + "SUCCEEDED" + String.fromCharCode(39))));
  });

  test("replay — 같은 키 SUCCEEDED는 저장 결과를 재생한다 (재실행 없음)", async () => {
    const input = { product_id: "p-x", saved: true };
    const row = {
      id: "op-1", kind: "SET_WISHLIST",
      payload_hash: payloadHash(input),
      status: "SUCCEEDED",
      result_json: { product_id: "p-x", saved: true, wishlist_count: 2 },
      error_code: null,
    };
    const { db, queries } = mkDb({ existing: [row] });
    const r = await setWishlist(input, ctx(), "k1", db);
    assert.equal(r.ok, true);
    assert.equal(r.replayed, true);
    if (r.ok) assert.equal(r.data.wishlist_count, 2);
    // 재실행은 없다 — users 잠금조차 가지 않는다
    assert.ok(!queries.some(({ q }) => q.includes("FROM users")));
  });

  test("replay — 같은 키 다른 payload → IDEMPOTENCY_CONFLICT", async () => {
    const row = {
      id: "op-1", kind: "SET_WISHLIST",
      payload_hash: payloadHash({ product_id: "p-x", saved: false }),
      status: "SUCCEEDED", result_json: {}, error_code: null,
    };
    const { db } = mkDb({ existing: [row] });
    const r = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k1", db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "IDEMPOTENCY_CONFLICT");
  });

  test("replay — 같은 키 READY → OUTCOME_UNKNOWN (재실행 없음)", async () => {
    const row = {
      id: "op-1", kind: "SET_WISHLIST",
      payload_hash: payloadHash({ product_id: "p-x", saved: true }),
      status: "READY", result_json: null, error_code: null,
    };
    const { db, queries } = mkDb({ existing: [row] });
    const r = await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k1", db);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "OUTCOME_UNKNOWN");
    assert.ok(!queries.some(({ q }) => q.includes("FROM users")));
  });
});

describe("actor 바인딩·테이블 격리 — 실질 계약 회귀 [PM070 테스트 QA]", () => {
  test("GET은 세션 actor만 조회한다 — u-a/u-b 각각 WHERE $1에 자기 id", async () => {
    for (const uid of ["u-a", "u-b"]) {
      const { db, queries } = mkDb();
      await getWishlist(ctx(uid), db as never);
      assert.equal(queries.length, 1);
      assert.equal(queries[0].p?.[0], uid, "wishlist WHERE user_id=$1");
      assertBoundary(queries);
    }
  });

  test("PUT 전 쿼리의 actor 파라미터는 세션 주체 — 저장·해제 양쪽", async () => {
    for (const saved of [true, false]) {
      const { db, queries } = mkDb();
      await setWishlist({ product_id: "p-x", saved }, ctx("u-a"), "k1", db);
      assertActorParams(queries, "u-a");
      // 상품 후판정만 actor가 아니라 대상 상품을 잠근다
      const prod = queries.find(({ q }) => q.includes("FOR SHARE"));
      assert.equal(prod?.p?.[0], "p-x", "product 후판정 대상");
      assertBoundary(queries);
    }
  });

  test("input의 user_id 주장 필드는 무시 — 모든 actor 파라미터는 세션 주체", async () => {
    const { db, queries } = mkDb();
    await setWishlist(
      { product_id: "p-x", saved: true, user_id: "u-b" } as unknown as SetWishlistInput,
      ctx("u-a"),
      "k1",
      db,
    );
    assertActorParams(queries, "u-a");
    // u-b가 어떤 바인딩 위치에도 들어가지 않는다 — 기록되는 payload 객체는
    // 요청 원문 보존이며 행동 파라미터는 세션에서만 온다
    const scalars = queries.flatMap(({ p }) => (p ?? []).filter((v) => typeof v === "string"));
    assert.ok(!scalars.includes("u-b"), "claimed user_id leaked into a bound param");
  });

  test("wishlist 실행 SQL은 cart/order/price/stock 등 다른 데이터를 변경하지 않는다", async () => {
    const { db, queries } = mkDb();
    await setWishlist({ product_id: "p-x", saved: true }, ctx(), "k1", db);
    await setWishlist({ product_id: "p-x", saved: false }, ctx(), "k2", db);
    await getWishlist(ctx(), db as never);
    assertBoundary(queries);
  });
});

describe("getWishlist — 읽기 전용 목록", () => {
  test("목록 매핑 — 비활성 보존·표시 정보 정본 (트랜잭션·잠금·쓰기 0)", async () => {
    const { db, queries, began } = mkDb({
      getRows: [
        { product_id: "p-1", created_at: "2026-10-01T00:00:00Z", name: "모니터", image_urls: ["/a.webp"], active: true, min_price_won: 10000 },
        { product_id: "p-2", created_at: "2026-10-02T00:00:00Z", name: "중단 상품", image_urls: null, active: false, min_price_won: null },
      ],
    });
    const r = await getWishlist(ctx("u-a"), db as never);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.items.length, 2);
      assert.equal(r.data.items[1].active, false);   // 비활성도 보존·표시
      assert.equal(r.data.items[1].image, null);
      assert.equal(r.data.items[1].min_price_won, null);
    }
    assert.equal(began(), 0);
    assertBoundary(queries);
    assert.ok(
      queries.every(
        ({ q }) => !q.includes("FOR UPDATE") &&
          !q.includes("INSERT") && !q.includes("DELETE"),
      ),
    );
  });

  test("최저가는 활성 variant만 집계 [MAJOR070-PRICE] — catalog active=true 정합", async () => {
    const { db, queries } = mkDb({
      getRows: [
        // 활성 옵션이 0개면 집계는 null — 카드는 가격을 숨긴다(가격 미확인)
        { product_id: "p-3", created_at: "2026-10-03T00:00:00Z", name: "전량비활성 상품", image_urls: null, active: true, min_price_won: null },
      ],
    });
    const r = await getWishlist(ctx("u-a"), db as never);
    const listQ = queries.find(({ q }) => q.includes("JOIN products"));
    assert.ok(listQ, "list query recorded");
    // 비활성 옵션이 더 저렴해도 찜 최저가는 판매 가능 옵션 기준이어야 한다 —
    // catalog.ts 목록·상세의 active=true 계약과 같은 정본.
    assert.ok(
      /v\.active\s*=\s*true/.test(listQ.q),
      "min_price 서브쿼리에 활성 variant 필터 없음",
    );
    if (r.ok) assert.equal(r.data.items[0].min_price_won, null);
    assertBoundary(queries);
  });
});
