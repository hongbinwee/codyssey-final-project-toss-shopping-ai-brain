// PMQA-077-A — SET_WISHLIST 실DB 통합 계약.
// tests/unit/wishlist-service.test.ts가 mock SqlDb로 증명한 절차(쿼리 순서·
// 파라미터 바인딩·replay 분기)를 실제 PostgreSQL 행·unique 제약·잠금
// 직렬화로 회귀한다. 브라우저 단의 intent/pending 복구는 e2e 소스
// (tests/e2e/wishlist.spec.ts)가 담당한다.
//
// [실행 게이트] 현재 helpers/testdb.ts는 commerce_test로 고정돼 있다
// (TEST_DB 상수). 보호 DB에 migration 004(004_wishlist_items.sql)를 적용하는
// 것은 승인되지 않은 변경이며, 본 suite의 실제 실행은 격리(owned scratch)
// 연결 보완 승인 + 별도 실행 승인 후에만 가능하다. 미승인 상태에서는
// ensureTestDb(6)의 사전 스키마 조회가 throw로 게이트한다 — 본 스코프는
// source-only 승인 범위다.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestDb, cleanUserData } from "../helpers/testdb.ts";
import { getWishlist, setWishlist } from "../../src/wishlist.ts";
import { getActionResult } from "../../src/actions.ts";
import { sql } from "../../src/db.ts";

const A = { actorUserId: "u-a", origin: "UI" as const };
const B = { actorUserId: "u-b", origin: "UI" as const };

const wishRows = (uid: string) =>
  sql.unsafe<{ product_id: string }[]>(
    "SELECT product_id FROM wishlist_items WHERE user_id=$1 ORDER BY product_id",
    [uid],
  );
const actionRows = (uid: string, key: string) =>
  sql.unsafe<
    {
      id: string;
      status: string;
      error_code: string | null;
      payload_saved: string | null;
    }[]
  >(
    "SELECT id, status, error_code, payload_json->>'saved' AS payload_saved " +
      "FROM action_requests " +
      "WHERE actor_user_id=$1 AND kind='SET_WISHLIST' AND idempotency_key=$2",
    [uid, key],
  );

describe("PMQA-077-A wishlist — 실DB 계약", () => {
  before(async () => {
    await ensureTestDb(6);
    await cleanUserData();
    // wishlist_items는 cleanUserData 범위 밖 — 이 suite의 fixture 사용자 행만 정리한다.
    await sql.unsafe(
      "DELETE FROM wishlist_items WHERE user_id = ANY($1)",
      [["u-a", "u-b", "u-c", "u-d"]],
    );
  });

  test("saved=true 저장·목록 반영 / saved=false 해제·행 삭제", async () => {
    const r = await setWishlist({ product_id: "p-a", saved: true }, A, "wl-077-basic-1");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.data.saved, true);
    assert.equal(r.data.wishlist_count, 1);
    assert.equal(r.action_status, "SUCCEEDED");

    const list = await getWishlist(A);
    assert.ok(list.ok);
    assert.equal(list.data.items.length, 1);
    assert.equal(list.data.items[0].product_id, "p-a");
    assert.equal(list.data.items[0].name, "코드뷰 모니터 A");
    assert.equal(list.data.items[0].active, true);
    assert.deepEqual(
      (await wishRows("u-a")).map((x) => x.product_id),
      ["p-a"],
    );

    const un = await setWishlist({ product_id: "p-a", saved: false }, A, "wl-077-basic-2");
    assert.ok(un.ok);
    assert.equal(un.data.saved, false);
    assert.equal(un.data.wishlist_count, 0);
    assert.deepEqual(await wishRows("u-a"), []);

    // 저장한 적 없는 해제도 ok — idempotent delete
    const un2 = await setWishlist({ product_id: "p-b", saved: false }, A, "wl-077-basic-3");
    assert.ok(un2.ok);
    assert.equal(un2.data.saved, false);
  });

  test("같은 키+같은 payload는 replay / 반대 saved는 IDEMPOTENCY_CONFLICT", async () => {
    const input = { product_id: "p-b", saved: true };
    const r1 = await setWishlist(input, A, "wl-077-replay");
    assert.ok(r1.ok, JSON.stringify(r1));
    const r2 = await setWishlist(input, A, "wl-077-replay");
    assert.ok(r2.ok);
    assert.equal(r2.replayed, true);
    assert.equal(r2.data.wishlist_count, r1.data!.wishlist_count);
    assert.equal((await actionRows("u-a", "wl-077-replay")).length, 1);
    assert.equal(
      (await wishRows("u-a")).filter((x) => x.product_id === "p-b").length,
      1,
    );

    // 같은 키에 반대 payload — 해시 충돌로 거절, 기록·행 상태는 유지된다
    const r3 = await setWishlist({ product_id: "p-b", saved: false }, A, "wl-077-replay");
    assert.ok(!r3.ok);
    if (!r3.ok) assert.equal(r3.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(
      (await wishRows("u-a")).filter((x) => x.product_id === "p-b").length,
      1,
    );
  });

  test("getActionResult 복구 — kind+key로 확정 결과를 조회한다", async () => {
    const rec = await getActionResult(A, {
      kind: "SET_WISHLIST",
      idempotency_key: "wl-077-replay",
    });
    assert.ok(rec.ok);
    assert.equal(rec.data.status, "SUCCEEDED");
    assert.equal((rec.data.result as { saved: boolean }).saved, true);
  });

  test("actor 격리 — 세션 주체만 자기 목록을 읽고 쓴다", async () => {
    const la = await getWishlist(A);
    const lb = await getWishlist(B);
    assert.ok(la.ok && lb.ok);
    assert.deepEqual(
      la.data.items.map((i) => i.product_id),
      ["p-b"],
    );
    assert.deepEqual(lb.data.items.map((i) => i.product_id), []);

    // B가 저장해도 A 목록은 변하지 않는다
    const rb = await setWishlist({ product_id: "p-c", saved: true }, B, "wl-077-iso-b");
    assert.ok(rb.ok, JSON.stringify(rb));
    const la2 = await getWishlist(A);
    const lb2 = await getWishlist(B);
    assert.ok(la2.ok && lb2.ok);
    assert.deepEqual(
      la2.data.items.map((i) => i.product_id),
      ["p-b"],
    );
    assert.deepEqual(
      lb2.data.items.map((i) => i.product_id),
      ["p-c"],
    );
  });

  test("유효하지 않은 입력은 action_requests 기록 없이 거절된다", async () => {
    const bad = await setWishlist({ product_id: "", saved: true }, A, "wl-077-bad");
    assert.ok(!bad.ok);
    if (!bad.ok) assert.equal(bad.error.code, "VALIDATION");
    // pre-validation 거절 — action_requests에 어떤 기록도 남지 않는다 [PMQA-070]
    assert.equal((await actionRows("u-a", "wl-077-bad")).length, 0);

    const nf = await setWishlist({ product_id: "p-none", saved: true }, A, "wl-077-none");
    assert.ok(!nf.ok);
    if (!nf.ok) assert.equal(nf.error.code, "NOT_FOUND");
    const rec = await actionRows("u-a", "wl-077-none");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].status, "REJECTED");
    assert.equal(rec[0].error_code, "NOT_FOUND");
  });

  test("판매 중단 상품 — 새 저장은 UNAVAILABLE, 기존 저장은 보존·해제 가능", async () => {
    const pre = await setWishlist({ product_id: "p-c", saved: true }, A, "wl-077-inact-1");
    assert.ok(pre.ok, JSON.stringify(pre));
    // fixture를 테스트 안에서만 비활성화하고 반드시 복원한다
    await sql.unsafe("UPDATE products SET active=false WHERE id='p-c'");
    try {
      const save = await setWishlist({ product_id: "p-c", saved: true }, A, "wl-077-inact-2");
      assert.ok(!save.ok);
      if (!save.ok) assert.equal(save.error.code, "UNAVAILABLE");

      // 기존 행은 active=false 표시 정보로 목록에 보존된다
      const list = await getWishlist(A);
      assert.ok(list.ok);
      const it = list.data.items.find((i) => i.product_id === "p-c");
      assert.ok(it, "비활성 상품이 목록에서 사라짐");
      assert.equal(it.active, false);

      const un = await setWishlist({ product_id: "p-c", saved: false }, A, "wl-077-inact-3");
      assert.ok(un.ok);
      assert.equal(un.data.saved, false);
      const list2 = await getWishlist(A);
      assert.ok(list2.ok);
      assert.ok(!list2.data.items.some((i) => i.product_id === "p-c"));
    } finally {
      await sql.unsafe("UPDATE products SET active=true WHERE id='p-c'");
    }
  });

  test("실SQL 동시 요청 — 같은 키는 unique 직렬화로 수렴한다", async () => {
    const input = { product_id: "p-a", saved: true };
    const [s1, s2] = await Promise.all([
      setWishlist(input, A, "wl-077-conc"),
      setWishlist(input, A, "wl-077-conc"),
    ]);
    // 승자는 SUCCEEDED, 패자는 unique(23505) 경로의 replay — 둘 다 ok다.
    for (const r of [s1, s2])
      assert.ok(r.ok, "unexpected: " + JSON.stringify(r));
    assert.ok(
      [s1, s2].some((r) => r.replayed === true),
      "동시 같은 키의 replay 경로가 관측되지 않음",
    );
    assert.equal((await actionRows("u-a", "wl-077-conc")).length, 1);
    assert.equal(
      (await wishRows("u-a")).filter((x) => x.product_id === "p-a").length,
      1,
    );
  });

  test("실SQL 동시 요청 — 다른 키 반대 방향도 단일 최종 상태로 수렴한다", async () => {
    // actor 직렬화(users FOR NO KEY UPDATE)로 어느 순서든 커밋은 하나씩 된다 —
    // 단, action_requests.completed_at은 트랜잭션 시작 시각(now())이라
    // lock 대기·커밋 순서를 나타내지 못한다 — 타임스탬프 순서를 커밋 순서로
    // 쓰는 판정은 올바른 구현도 false-FAIL시킬 수 있어 쓰지 않는다.
    // 결정적으로 검증 가능한 것: ① 두 의도가 각 키의 terminal 행으로 수렴
    // ② (user_id, product_id) PK 불변 ③ 경합 직후 단독 op의 desired-state
    // 전환. 경합 승자의 커밋 순서 자체는 이 테스트의 커버 범위가 아니다.
    const [x, y] = await Promise.all([
      setWishlist({ product_id: "p-b", saved: true }, A, "wl-077-op-on"),
      setWishlist({ product_id: "p-b", saved: false }, A, "wl-077-op-off"),
    ]);
    for (const r of [x, y])
      assert.ok(
        r.ok || ["OPERATION_IN_FLIGHT", "OUTCOME_UNKNOWN"].includes(r.error.code),
        "unexpected: " + JSON.stringify(r),
      );

    // 두 의도는 각각 자기 키의 terminal 행으로 수렴한다 — actor 직렬화로
    // 정상 완료된 2요청이면 두 행 모두 SUCCEEDED여야 하고 각 키의 저장된
    // 의도(saved true/false)도 정확해야 한다. READY 등 비terminal 행·
    // 미실행(행 부재)을 수렴으로 세지 않는다.
    const acts = await sql.unsafe<
      { idempotency_key: string; status: string; payload_saved: string | null }[]
    >(
      "SELECT idempotency_key, status, payload_json->>'saved' AS payload_saved " +
        "FROM action_requests WHERE actor_user_id='u-a' AND kind='SET_WISHLIST' " +
        "AND idempotency_key = ANY($1)",
      [["wl-077-op-on", "wl-077-op-off"]],
    );
    assert.equal(
      acts.length,
      2,
      "각 키의 action 행이 정확히 1건씩 있어야 한다: " + JSON.stringify(acts),
    );
    for (const r of acts)
      assert.equal(
        r.status,
        "SUCCEEDED",
        "비terminal/REJECTED 행은 수렴이 아니다: " + JSON.stringify(r),
      );
    const byKey = new Map(acts.map((r) => [r.idempotency_key, r]));
    assert.equal(byKey.get("wl-077-op-on")?.payload_saved, "true");
    assert.equal(byKey.get("wl-077-op-off")?.payload_saved, "false");
    const succeeded = acts; // 위에서 전부 SUCCEEDED로 단정했다

    // 최종 행 상태는 성공한 의도들과 일관돼야 한다 — 행이 있으면 saved=true
    // 성공이, 없으면 saved=false 성공이 존재해야 한다(어느 쪽이 마지막
    // 커밋인지는 타임스탬프로 관측 불가 — 순서 단정 대신 일관성만 본다).
    const rowExists = (await wishRows("u-a")).some(
      (r) => r.product_id === "p-b",
    );
    if (rowExists)
      assert.ok(
        succeeded.some((r) => r.payload_saved === "true"),
        "행이 있는데 saved=true 성공이 없다: " + JSON.stringify(acts),
      );
    else
      assert.ok(
        succeeded.some((r) => r.payload_saved === "false"),
        "행이 없는데 saved=false 성공이 없다: " + JSON.stringify(acts),
      );
    // (user_id, product_id) 복합 PK — 어떤 직렬화 순서든 행은 최대 1개다.
    assert.equal(
      (await wishRows("u-a")).filter((r) => r.product_id === "p-b").length,
      rowExists ? 1 : 0,
    );

    // 경합 승자의 순서는 위에서 증명하지 않는다 — 대신 경합 직후 단독 op이
    // 현재 상태를 결정적으로 반전하는지 확인한다(이 값이 이 테스트의
    // '마지막 의도가 이긴다' 계약의 실질적 커버다).
    const flip = await setWishlist(
      { product_id: "p-b", saved: !rowExists },
      A,
      "wl-077-op-final",
    );
    assert.ok(flip.ok, JSON.stringify(flip));
    assert.equal(
      (await wishRows("u-a")).some((r) => r.product_id === "p-b"),
      !rowExists,
    );
  });
});

// sql 풀이 남으면 --test 러너가 종료하지 않는다 (checkout.test.ts와 같은 방어).
after(() => sql?.end());
