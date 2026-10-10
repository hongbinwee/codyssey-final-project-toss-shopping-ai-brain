// 미확정 쓰기 intent 보관소 — 사용자 스코프 격리·storage fallback 검증.
// Node에는 localStorage가 없으므로 in-memory stub을 심어 동작을 재현한다.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
let failWrites = false;

(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error("QuotaExceededError");
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};

const {
  bindPendingUser, listPending, putPending, removePending,
  // storage stub을 심은 뒤 import해야 module 평가 시 참조가 맞는다.
} = await import("../../src/web/pending.ts");

const intent = (uiKey: string, product = "p-d-e1") => ({
  uiKey,
  kind: "ADD_CART" as const,
  path: "/api/cart/items",
  method: "POST" as const,
  payload: { product_id: product, idempotency_key: uiKey },
  label: "테스트 상품",
  at: 1,
});

beforeEach(() => {
  store.clear();
  failWrites = false;
  bindPendingUser(null);
});

describe("pending writes — user scope", () => {
  test("세션 미바인딩: 노출·저장 모두 없음", () => {
    putPending(intent("k1"));
    assert.equal(listPending().length, 0);
  });

  test("A의 intent는 B에게 보이지 않고, A 복귀 시 복구된다", () => {
    bindPendingUser("u-a");
    putPending(intent("k-a"));
    bindPendingUser("u-b");
    assert.equal(listPending().length, 0, "B는 A의 intent를 볼 수 없다");
    putPending(intent("k-b"));
    assert.deepEqual(listPending().map((p) => p.uiKey), ["k-b"]);
    bindPendingUser("u-a");
    assert.deepEqual(listPending().map((p) => p.uiKey), ["k-a"], "A는 자기 intent만 복구");
  });

  test("removePending은 현재 scope 버킷만 건드린다", () => {
    bindPendingUser("u-a");
    putPending(intent("k-a"));
    bindPendingUser("u-b");
    removePending("k-a"); // B scope에서 A의 키 삭제 시도 — 무해해야 함
    bindPendingUser("u-a");
    assert.equal(listPending().length, 1);
  });
});

describe("pending writes — storage fallback", () => {
  test("write 실패(QuotaExceeded)해도 intent가 유실되지 않는다", () => {
    bindPendingUser("u-a");
    putPending(intent("k1")); // storage에 정상 기록
    failWrites = true;
    putPending(intent("k2")); // setItem throw → memory fallback
    const keys = listPending().map((p) => p.uiKey);
    assert.ok(keys.includes("k1") && keys.includes("k2"), "read-ok/write-fail에서도 두 intent 유지");
  });

  test("memory fallback 이후 write 성공 시 storage로 승격된다", () => {
    bindPendingUser("u-a");
    failWrites = true;
    putPending(intent("k1"));
    failWrites = false;
    putPending(intent("k2")); // 성공 → mem 버킷 해제
    // mem 대신 storage에서 읽어도 두 intent가 모두 있어야 한다.
    const raw = JSON.parse(store.get("pending-writes-v1:u-a") ?? "[]") as { uiKey: string }[];
    assert.deepEqual(raw.map((p) => p.uiKey).sort(), ["k1", "k2"]);
  });

  test("손상된 JSON·형식 불량 항목은 버린다", () => {
    bindPendingUser("u-a");
    store.set("pending-writes-v1:u-a", "{not json");
    assert.equal(listPending().length, 0);
    store.set(
      "pending-writes-v1:u-a",
      JSON.stringify([intent("k1"), { uiKey: 1 }, null, { kind: "HACK" }]),
    );
    assert.deepEqual(listPending().map((p) => p.uiKey), ["k1"]);
  });
});
