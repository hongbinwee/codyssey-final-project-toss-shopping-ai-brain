// 요청 세대 가드 — MyShop의 orders/products 병렬 로드가 서로를 무효화하지
// 않고, 재시도·unmount가 늦은 응답 적용을 차단하는지 mock 로더로 검증한다
// (DB-free, 실제 네트워크 없음).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { createRequestGate } = await import("../../src/web/request-gate.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("request-gate", () => {
  test("같은 게이트의 새 begin은 이전 세대를 무효화한다", () => {
    const g = createRequestGate();
    const live1 = g.begin();
    const live2 = g.begin();
    assert.equal(live1(), false);
    assert.equal(live2(), true);
  });

  test("별도 게이트는 서로를 무효화하지 않는다(orders/products 병렬)", async () => {
    const ord = createRequestGate();
    const prod = createRequestGate();
    // MyShop 패턴: 두 로더를 연속으로 시작해 둘 다 응답을 적용해야 한다.
    let ordersApplied = 0;
    let productsApplied = 0;
    const loadOrders = async () => {
      const live = ord.begin();
      await tick();
      if (live()) ordersApplied++;
    };
    const loadProducts = async () => {
      const live = prod.begin();
      await tick();
      if (live()) productsApplied++;
    };
    await Promise.all([loadOrders(), loadProducts()]);
    assert.equal(ordersApplied, 1, "orders 첫 응답이 적용돼야 한다");
    assert.equal(productsApplied, 1, "products 첫 응답이 적용돼야 한다");
  });

  test("재시도는 같은 게이트 안에서만 이전 세대를 무효화한다", async () => {
    const g = createRequestGate();
    const other = createRequestGate();
    let applied: string[] = [];
    const load = async (tag: string, delay: number) => {
      const live = g.begin();
      await new Promise((r) => setTimeout(r, delay));
      if (live()) applied.push(tag);
    };
    // 첫 요청이 늦게 도착하고 재시도가 먼저 오면 첫 응답은 버려야 한다.
    const slow = load("first", 5);
    const fast = load("retry", 0);
    await Promise.all([slow, fast]);
    assert.deepEqual(applied, ["retry"]);
    // 다른 게이트 응답은 영향 없음
    const liveOther = other.begin();
    assert.equal(liveOther(), true);
  });

  test("kill 이후 진행 중이던 응답은 적용되지 않는다(unmount 차단)", async () => {
    const g = createRequestGate();
    let applied = 0;
    const p = (async () => {
      const live = g.begin();
      await tick();
      if (live()) applied++;
    })();
    g.kill();
    await p;
    assert.equal(applied, 0);
  });
});
