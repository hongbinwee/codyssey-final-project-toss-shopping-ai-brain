// src/web/cart-scope.ts의 순수 검증 — actor 소유 스냅샷의 렌더 시점
// owner 필터를 회귀한다 [069-06]. DB·React 없이 첫 렌더 누출 차단을 증명한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { visibleCart, type OwnedCart } from "../../src/web/cart-scope.ts";
import type { CartView } from "../../src/contracts.ts";

const view = (n: number): CartView =>
  ({ items: Array.from({ length: n }, (_, i) => ({ variant_id: "v" + i })) } as unknown as CartView);

describe("visibleCart — actor 소유 카트 필터", () => {
  test("owner===userId일 때만 스냅샷을 노출한다", () => {
    const snap: OwnedCart = { owner: "u-a", v: view(3) };
    assert.equal(visibleCart(snap, "u-a")?.items.length, 3);
    // 계정 전환 첫 렌더 — 부모 effect가 setCartState(null)을 실행하기
    // 전이라도 이전 actor 카트가 자식·배지에 새지 않는다
    assert.equal(visibleCart(snap, "u-b"), null);
    assert.equal(visibleCart(snap, null), null);
  });

  test("스냅샷 부재·미로그인 경계", () => {
    assert.equal(visibleCart(null, "u-a"), null);
    assert.equal(visibleCart(null, null), null);
    // owner=null 스냅샷은 actor=null(미로그인)에서만 노출된다 —
    // 로그인 직후 첫 렌더에는 노출되지 않는다
    const anon: OwnedCart = { owner: null, v: view(1) };
    assert.equal(visibleCart(anon, null)?.items.length, 1);
    assert.equal(visibleCart(anon, "u-a"), null);
  });
});
