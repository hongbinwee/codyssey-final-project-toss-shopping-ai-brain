// 06A 주문서/모의결제/결제완료 안전 계약 E2E.
// 전용 사용자 e2e-c(checkout-t2와 공유) — 같은 파일 안 serial로 상태를 직렬화한다.
// 핵심: commit 후 응답 유실 → 카트가 비워져 견적이 VALIDATION이어도
// CHECKOUT pending 복구가 quote와 독립적으로 동작해야 한다 [PM 지침].
import { expect, test, type Page, type Request } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-c");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

async function cartVersion(page: Page) {
  const r = await page.context().request.get("/api/cart");
  const j = await r.json();
  return j.data.version as number;
}

async function clearCartApi(page: Page) {
  for (;;) {
    const r = await page.context().request.get("/api/cart");
    const j = await r.json();
    const it = j.data?.items?.[0];
    if (!it) return;
    const d = await page.context().request.delete(
      "/api/cart/items/" + it.cart_item_id,
      {
        data: {
          expected_cart_version: j.data.version,
          idempotency_key: crypto.randomUUID(),
        },
      },
    );
    if (!(await d.json()).ok) throw new Error("clearCartApi delete failed");
  }
}

async function loginClean(page: Page) {
  await login(page);
  await clearCartApi(page);
  // 이전 테스트의 미확정 intent 흔적이 남지 않게 이 사용자의 pending도 비운다.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith("pending-writes-v1:")) localStorage.removeItem(k);
  });
}

async function addVariant(page: Page, productId: string, variantId: string, qty = 1) {
  const pj = await (await page.context().request.get("/api/products/" + productId)).json();
  const variant = pj.data.variants.find(
    (v: { variant_id: string }) => v.variant_id === variantId,
  );
  if (!variant) throw new Error("missing fixture variant: " + variantId);
  const j = await (
    await page.context().request.post("/api/cart/items", {
      data: {
        product_id: productId,
        variant_id: variantId,
        quantity: qty,
        expected_cart_version: await cartVersion(page),
        expected_variant_version: variant.version,
        idempotency_key: crypto.randomUUID(),
      },
    })
  ).json();
  if (!j.ok) throw new Error("cart add failed: " + JSON.stringify(j));
}

async function variantStock(page: Page, productId: string, variantId: string) {
  const pj = await (await page.context().request.get("/api/products/" + productId)).json();
  return pj.data.variants.find(
    (v: { variant_id: string }) => v.variant_id === variantId,
  ).stock_qty as number;
}

async function orderCount(page: Page) {
  const j = await (await page.context().request.get("/api/orders")).json();
  return (j.data.orders as unknown[]).length;
}

// 쓰기 응답 가로채기 — route.fetch로 서버 commit을 확인한 뒤 클라이언트에게만
// 다른 결과를 보인다. finish="abort"면 응답 유실, "drop"이면 요청 자체 미도착.
async function interceptWrite(
  page: Page,
  pattern: string,
  method: string,
  finish: "abort" | "drop",
) {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  done.catch(() => {});
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) return route.continue();
    try {
      if (finish === "drop") {
        await route.abort(); // 서버에 도달하지 않음 — action_requests에 기록 없음
      } else {
        const res = await route.fetch(); // 서버 commit 확인
        if (!res.ok()) throw new Error("interceptWrite: 서버 응답 " + res.status());
        await route.abort(); // 클라이언트만 응답 유실
      }
      resolve();
    } catch (e) {
      reject(e);
      throw e;
    }
  });
  return { done };
}

async function openCheckout(page: Page) {
  await page.goto("/#/cart");
  await page.getByRole("button", { name: /주문하기/ }).click();
  await expect(page.getByRole("heading", { name: "주문서" })).toBeVisible();
}

// 고정 하단 CTA만 — '다시 결제하기' 같은 복구 버튼과 이름이 겹치지 않게 scope.
const payCta = (page: Page) =>
  page.locator(".bottom-bar").getByRole("button", { name: /결제하기/ });

test("commit-then-abort → reload → 저장 payload 재전송으로 완료 (quote 없이도 동작)", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-b", "v-b-24"); // 149,000 + 3,000 = 152,000
  await openCheckout(page);

  // 서버 commit(주문 생성+카트 비움) 후 응답만 유실시킨다.
  const drop = await interceptWrite(page, "**/api/checkout/confirm", "POST", "abort");
  await payCta(page).click();
  await drop.done; // 실제 commit 확인됨
  await page.unroute("**/api/checkout/confirm");

  // 서버에서는 이미 결제 완료 — 카트가 비어 있다.
  const cartJ = await (await page.context().request.get("/api/cart")).json();
  expect(cartJ.data.items).toHaveLength(0);

  // 복구 스트립이 보인다 — 새 결제 CTA(하단 고정)는 잠긴다.
  await expect(page.getByText("결제 결과를 확인하지 못했어요")).toBeVisible();
  await expect(payCta(page)).toBeDisabled();

  // reload — 견적은 빈 카트 VALIDATION이지만 복구 UI는 남아 있어야 한다 [MJ-06A-PENDING-02].
  await page.reload();
  await expect(page.getByText("결제 결과를 확인하지 못했어요")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("주문서를 새로 불러오지 못했어요")).toBeVisible();

  // 견적이 없어도 저장된 같은 키+같은 payload를 재전송할 수 있어야 한다 —
  // 서버는 replay로 저장된 주문 결과를 돌려준다.
  await page.getByRole("button", { name: "다시 결제하기" }).click();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/152,000원 · 모의 결제/)).toBeVisible();
});

test("미도착 abort → 결과 확인 NOT_FOUND → 같은 키 다시 결제하기로 완료", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-b", "v-b-24");
  await openCheckout(page);

  // 요청 자체가 서버에 도달하지 않게 차단 — action_requests에 기록이 없다.
  const drop = await interceptWrite(page, "**/api/checkout/confirm", "POST", "drop");
  await payCta(page).click();
  await drop.done;
  await page.unroute("**/api/checkout/confirm");

  await expect(page.getByText("결제 결과를 확인하지 못했어요")).toBeVisible();

  // 결과 확인 → NOT_FOUND — 새 키 발급 안내가 아니라 같은 요청 재전송만 제안.
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText("요청 기록이 없어요")).toBeVisible();

  // '다시 결제하기' — 저장된 같은 키+같은 payload로 재전송 → 실제 commit.
  await page.getByRole("button", { name: "다시 결제하기" }).click();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });
});

test("완료 화면 reload 재진입은 조회 전용 — 비-GET 요청 0건", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-b", "v-b-24");
  await openCheckout(page);
  await payCta(page).click();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });

  const writes: string[] = [];
  page.on("request", (r: Request) => {
    if (r.method() !== "GET") writes.push(r.method() + " " + r.url());
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });
  expect(writes).toHaveLength(0);

  // 완료 화면 콘텐츠 — 스냅샷 상품/주소 + 홈/상세 진입.
  await expect(page.getByText("코드뷰 모니터 B")).toBeVisible();
  await expect(page.getByText("배송지")).toBeVisible();
  await expect(page.getByRole("button", { name: "홈으로 가기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "주문 상세 내역 보기" })).toBeVisible();
});

test("stale quote — 결제 중 카트 변경 → STALE_QUOTE 안내 후 새 견적으로 완료", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-b", "v-b-24");
  await openCheckout(page);

  // 견적 발급 후 다른 탭처럼 API로 카트를 변경 → cart.version 상승.
  await addVariant(page, "p-c", "v-c-27");

  await payCta(page).click();
  await expect(page.getByText(/카트가 변경|구성이 변경/)).toBeVisible({ timeout: 15000 });

  // 새 견적(2개 항목)으로 재시도 — CTA가 살아 있고 결제가 완료된다.
  await expect(payCta(page)).toBeEnabled();
  await payCta(page).click();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("코드뷰 모니터 C")).toBeVisible();
});

test("빈 카트는 주문서에 Empty 상태를 보여준다", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/checkout");
  // 서버는 빈 카트를 VALIDATION으로 거절한다 — 재시도가 아니라 Empty 안내다.
  await expect(page.getByText("카트가 비어 있습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "장바구니로" })).toBeVisible();
});

test("연타는 POST 1건·주문 1건·재고 1회 차감만 발생한다", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-a", "v-a-24"); // 180,000 + 3,000 = 183,000
  await openCheckout(page);

  const ordersBefore = await orderCount(page);
  const stockBefore = await variantStock(page, "p-a", "v-a-24");

  // commit 후 응답을 잠깐 hold — 그 사이 같은 DOM 노드에 연속 클릭을 실행한다.
  let posts = 0;
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  await page.route("**/api/checkout/confirm", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const res = await route.fetch(); // 서버 commit
    await held;
    await route.fulfill({ response: res });
  });
  // elementHandle로 실제 DOM 노드를 고정한다 — 첫 클릭 후 라벨이
  // '결제 처리 중…'으로 바뀌어도 같은 노드에 두 번째 클릭이 도달한다.
  const el = await page.locator(".checkout-paybar .btn").elementHandle();
  await el!.evaluate((b) => {
    (b as HTMLButtonElement).click();
    (b as HTMLButtonElement).click();
  });
  await page.waitForTimeout(300);
  release();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });

  expect(posts).toBe(1);
  expect(await orderCount(page)).toBe(ordersBefore + 1);
  expect(await variantStock(page, "p-a", "v-a-24")).toBe(stockBefore - 1);
  const cartJ = await (await page.context().request.get("/api/cart")).json();
  expect(cartJ.data.items).toHaveLength(0);
});

test("주문 금액 패널 토글은 표시 전용 — 비-GET 요청 0건", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-b", "v-b-24");
  await openCheckout(page);

  const toggle = page.getByRole("button", { name: /주문 금액 상세/ });
  const writes: string[] = [];
  page.on("request", (r: Request) => {
    if (r.method() !== "GET") writes.push(r.url());
  });
  await expect(page.locator("#checkout-quote-rows")).toBeHidden();
  await toggle.click();
  await expect(page.locator("#checkout-quote-rows")).toBeVisible();
  await expect(page.locator("#checkout-quote-rows")).toContainText("상품 금액");
  await expect(page.locator("#checkout-quote-rows")).toContainText("배송비");
  await toggle.click();
  await expect(page.locator("#checkout-quote-rows")).toBeHidden();
  expect(writes).toHaveLength(0);
});

test("존재하지 않는 주문의 완료 화면은 NOT_FOUND 에러 상태", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/orders/ord-nonexistent-06a/complete");
  await expect(page.getByText("주문을 찾을 수 없어요")).toBeVisible();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toHaveCount(0);
});

test("완료 화면 GET 실패(NETWORK)는 성공 표시 없이 에러 상태", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/orders/**", (route) => route.abort());
  await page.goto("/#/orders/ord-any/complete");
  await expect(page.getByText("주문을 불러오지 못했어요")).toBeVisible();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toHaveCount(0);
});

test("취소 접수된 주문의 완료 화면은 신규 성공으로 오인시키지 않는다", async ({ page }) => {
  await loginClean(page);
  // API로 주문 생성 → 취소 접수 → complete URL 직접 진입.
  // 재고 격리 — v-c-32(stock 2)는 t4의 수량 경계 테스트가 전량 필요로 한다.
  // 이 테스트는 상품명을 단정하지 않으므로 미사용 v-b-27(stock 3)로 대체한다.
  await addVariant(page, "p-b", "v-b-27");
  const quote = await (
    await page.context().request.get("/api/checkout/quote")
  ).json();
  const confirm = await (
    await page.context().request.post("/api/checkout/confirm", {
      data: {
        quote_token: quote.data.quote_token,
        idempotency_key: crypto.randomUUID(),
      },
    })
  ).json();
  const orderId = confirm.data.order_id as string;
  const cq = await (
    await page.context().request.get(
      "/api/orders/" + orderId + "/cancel/quote?reason_code=CHANGE_OF_MIND",
    )
  ).json();
  const approve = await (
    await page.context().request.post("/api/orders/" + orderId + "/cancel/approve", {
      data: {
        quote_token: cq.data.quote.quote_token,
        reason_code: "CHANGE_OF_MIND",
        action_key: crypto.randomUUID(),
      },
    })
  ).json();
  const cancelRes = await (
    await page.context().request.post("/api/orders/" + orderId + "/cancel/execute", {
      data: {
        confirmation_id: approve.data.confirmation_id,
        reason_code: "CHANGE_OF_MIND",
      },
    })
  ).json();
  expect(cancelRes.ok).toBe(true);

  await page.goto("/#/orders/" + orderId + "/complete");
  await expect(page.getByRole("heading", { name: "주문 상태" })).toBeVisible();
  await expect(page.getByText("취소 요청이 접수된 주문이에요")).toBeVisible();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "주문 상세 내역 보기" })).toBeVisible();
});

test("완료 화면 빠른 주문 전환은 마지막 route의 주문만 표시한다 (read race)", async ({ page }) => {
  await loginClean(page);
  // 두 주문을 연속 생성한다.
  const ids: string[] = [];
  for (const v of ["v-a-24", "v-b-24"] as const) {
    await addVariant(page, v === "v-a-24" ? "p-a" : "p-b", v);
    const q = await (await page.context().request.get("/api/checkout/quote")).json();
    const c = await (
      await page.context().request.post("/api/checkout/confirm", {
        data: { quote_token: q.data.quote_token, idempotency_key: crypto.randomUUID() },
      })
    ).json();
    ids.push(c.data.order_id);
    await clearCartApi(page);
  }
  // 순서를 latch로 증명한다: A fetch가 실제 hold에 진입 → 해시로 B 전환 →
  // B 조회 완료·렌더 → A의 늦은 응답을 클라이언트까지 전달 → B만 유지.
  // 임의 wait으로 A 수신을 가정하지 않는다.
  let releaseA!: () => void;
  let aStarted!: () => void;
  let aDelivered!: () => void;
  const heldA = new Promise<void>((res) => { releaseA = res; });
  const aInFlight = new Promise<void>((res) => { aStarted = res; });
  const aDone = new Promise<void>((res) => { aDelivered = res; });
  await page.route("**/api/orders/" + ids[0], async (route) => {
    aStarted();
    const res = await route.fetch();
    await heldA;
    await route.fulfill({ response: res });
    aDelivered();
  });
  await page.goto("/#/orders/" + ids[0] + "/complete");
  await aInFlight; // A의 fetch가 실제로 hold에 진입했음을 확인
  await page.goto("/#/orders/" + ids[1] + "/complete");
  await expect(page.getByText("코드뷰 모니터 B")).toBeVisible({ timeout: 15000 });
  releaseA();
  await aDone; // 늦은 A 응답이 클라이언트까지 실제 전달됐음을 확인
  await expect(page.getByText("코드뷰 모니터 A")).toHaveCount(0);
  await expect(page.getByText("코드뷰 모니터 B")).toBeVisible();
});

test("order GET에 image/product_id가 additive로 붙는다 (jsonb ->> 0)", async ({ page }) => {
  await loginClean(page);
  // fixture p-b는 image_urls=[] → 첫 URL은 정확히 null이어야 한다(두 번째가 아님).
  await addVariant(page, "p-b", "v-b-24");
  const quote = await (
    await page.context().request.get("/api/checkout/quote")
  ).json();
  const confirm = await (
    await page.context().request.post("/api/checkout/confirm", {
      data: {
        quote_token: quote.data.quote_token,
        idempotency_key: crypto.randomUUID(),
      },
    })
  ).json();
  const order = await (
    await page.context().request.get("/api/orders/" + confirm.data.order_id)
  ).json();
  const item = order.data.items[0];
  expect(item.product_id).toBe("p-b");
  expect(item.image).toBeNull(); // jsonb [] ->> 0 = null — [1]을 읽는 잘못된 접근 아님
  // 스냅샷 필드는 그대로다 — 이름/옵션/수량/가격.
  expect(item.product_name).toBe("코드뷰 모니터 B");
  expect(item.unit_price_won).toBe(149000);
});

test("결제 완료 → 홈 복귀 시 카트 배지 미노출 + 서버 카트 비어 있음", async ({ page }) => {
  await loginClean(page);
  // 재고 격리 — v-b-24는 06a 7건+t2 1건 confirm으로 잔여가 1이다.
  // 이 테스트는 상품명·가격을 단정하지 않으므로 여유 있는 v-a-24를 쓴다.
  await addVariant(page, "p-a", "v-a-24");
  // /#/cart 경유 — Cart의 onCartLoaded가 전역 cartCount를 1로 갱신한다.
  // 수정 전에는 confirm 후에도 이 값이 남아 홈 배지가 1로 표시됐다.
  await openCheckout(page);
  await payCta(page).click();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "홈으로 가기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();

  // 서버 진실 — confirm이 카트를 비웠다.
  const cartJ = await (await page.context().request.get("/api/cart")).json();
  expect(cartJ.data.items).toHaveLength(0);
  // 완료 진입 콜백의 refreshCart(seq 가드 GET)가 적용되면 배지는 사라진다.
  await expect(page.locator(".cart-badge")).toHaveCount(0);
});
