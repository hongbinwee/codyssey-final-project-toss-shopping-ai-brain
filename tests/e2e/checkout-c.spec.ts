// PMQA-077-A — C 구매 계약 E2E (DIRECT 바로 구매 + CART_SELECTED 선택 주문).
// ⚠ SOURCE-ONLY — 실행 금지. playwright.config.ts는 pw-config-gate에서
// 'not-ready'로 사전 거부된다(globalSetup reseed·실DB 경로). 이 파일의 실행은
// 별도 승인된 launcher/config 경로가 열린 뒤에만 가능하며, 현재 목적은 승인된
// 회귀 시나리오의 정적 소스 준비다 [PMQA-077-A 위임].
//
// checkout-06a.spec.ts의 interceptWrite 패턴을 그대로 재사용한다. 현재
// helpers/config는 commerce_test로 고정돼 있다 — 보호 DB에 대한 실행은
// 미승인이며, 본 spec의 실제 실행은 격리(owned scratch) DB 연결 보완 승인 +
// 별도 실행 승인 후에만 가능하다(fixture 계약: e2e-c→u-c, n env 매핑).
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

async function orderCount(page: Page) {
  const j = await (await page.context().request.get("/api/orders")).json();
  return (j.data.orders as unknown[]).length;
}

// 카트 행의 관련 필드 전체 — DIRECT 무접촉·CART_SELECTED 미선택 보존의
// 전/후 비교용 (선택 상태는 서버 필드가 아니라 클라이언트 Set이라 대상 아님).
async function cartRows(page: Page) {
  const j = await (await page.context().request.get("/api/cart")).json();
  return {
    version: j.data.version as number,
    items: (
      j.data.items as {
        cart_item_id: string;
        variant_id: string;
        quantity: number;
        variant_version: number;
      }[]
    ).map((i) => ({
      cart_item_id: i.cart_item_id,
      variant_id: i.variant_id,
      quantity: i.quantity,
      variant_version: i.variant_version,
    })),
  };
}

// 실제 product GET 기준 옵션별 재고 — 견적 무차감·commit 1회·retry 추가 0의
// 3지점 비교에 쓴다.
async function stockMap(page: Page, productId: string) {
  const j = await (
    await page.context().request.get("/api/products/" + productId)
  ).json();
  const m: Record<string, number> = {};
  for (const v of j.data.variants as {
    variant_id: string;
    stock_qty: number;
  }[])
    m[v.variant_id] = v.stock_qty;
  return m;
}

// 서버가 서명한 견적 본문 — 구매 대상(variant·수량·단가·금액)을 실값으로 읽는다.
function decodeQuote(token: string) {
  return JSON.parse(
    Buffer.from(token.split(".")[0], "base64url").toString(),
  ) as {
    source: string;
    items: {
      variant_id: string;
      quantity: number;
      unit_price_won: number;
    }[];
    items_total_won: number;
    shipping_fee_won: number;
    total_won: number;
  };
}

// 쓰기 응답 가로채기 — route.fetch로 서버 commit을 확인한 뒤 클라이언트에게만
// 다른 결과를 보인다. finish="abort"면 응답 유실, "drop"이면 요청 자체 미도착.
async function interceptWrite(
  page: Page,
  pattern: string,
  method: string,
  finish: "abort" | "drop",
  onRequest?: (req: Request) => void,
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
      onRequest?.(route.request());
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

// 고정 하단 CTA만 — '다시 결제하기' 같은 복구 버튼과 이름이 겹치지 않게 scope.
const payCta = (page: Page) =>
  page.locator(".bottom-bar").getByRole("button", { name: /결제하기/ });

test("DIRECT commit+응답 유실 → 카트 무접촉·주문 1건·같은 키 재전송으로 완료", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-c", "v-c-27"); // 카트의 미선택 항목 — DIRECT가 건드리지 않아야 한다
  // 견적(구매하기 진입) 이전의 기준선 — 견적 발급 자체는 무상태다
  const ordersBefore = await orderCount(page);
  const cartBefore = await cartRows(page);
  const stockBefore = await stockMap(page, "p-a");
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "구매하기" }).click();
  await expect(page.getByRole("heading", { name: "주문서" })).toBeVisible();
  // DIRECT 주문서는 선택 옵션만 담는다 — 카트 상품이 섞이지 않는다
  await expect(page.getByText("코드뷰 모니터 A")).toBeVisible();
  await expect(page.getByText("코드뷰 모니터 C")).toHaveCount(0);
  // 견적 발급은 주문·카트·재고를 바꾸지 않는다 — quote 전 기준선과 완전 일치
  expect(await orderCount(page)).toBe(ordersBefore);
  expect(await cartRows(page)).toEqual(cartBefore);
  expect(await stockMap(page, "p-a")).toEqual(stockBefore);

  // 최초 confirm 요청을 캡처한다 — 재전송이 같은 키+같은 토큰인지 대조
  let firstConfirm: { quote_token: string; idempotency_key: string } | null =
    null;
  const drop = await interceptWrite(
    page,
    "**/api/checkout/confirm",
    "POST",
    "abort",
    (req) => {
      firstConfirm = req.postDataJSON() as typeof firstConfirm;
    },
  );
  await payCta(page).click();
  await drop.done; // 실제 commit 확인됨
  await page.unroute("**/api/checkout/confirm");
  const quote = decodeQuote(firstConfirm!.quote_token);
  const bought = quote.items[0];
  expect(quote.source).toBe("DIRECT");
  expect(bought.quantity).toBe(1);
  expect(bought.unit_price_won).toBe(180000); // v-a-24 정본 fixture 단가

  // 서버 상태 — 주문은 1건 생성됐지만 카트는 그대로다 (DIRECT 무접촉 계약)
  expect(await orderCount(page)).toBe(ordersBefore + 1);
  expect(await cartRows(page)).toEqual(cartBefore);
  // 구매 옵션만 1회 차감 — 다른 옵션은 차감되지 않는다
  const stockCommitted = await stockMap(page, "p-a");
  expect(stockCommitted[bought.variant_id]).toBe(
    stockBefore[bought.variant_id] - bought.quantity,
  );
  for (const [vid, s] of Object.entries(stockBefore))
    if (vid !== bought.variant_id) expect(stockCommitted[vid]).toBe(s);

  await expect(page.getByText("결제 결과를 확인하지 못했어요")).toBeVisible();
  await expect(payCta(page)).toBeDisabled();

  // reload — DIRECT 견적은 여전히 유효하지만 pending 복구가 최우선으로 보인다.
  await page.reload();
  await expect(page.getByText("결제 결과를 확인하지 못했어요")).toBeVisible({ timeout: 15000 });

  // 저장된 같은 키+같은 payload 재전송 — 서버는 replay로 저장된 주문을 돌려준다.
  const confirmResp = page.waitForResponse(
    (r) =>
      r.url().includes("/api/checkout/confirm") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "다시 결제하기" }).click();
  const resp = await confirmResp;
  const retryBody = resp.request().postDataJSON() as {
    quote_token: string;
    idempotency_key: string;
  };
  // '같은 키 재전송'의 실제 단정 — 최초 confirm과 idempotency_key·
  // quote_token이 같아야 한다
  expect(retryBody.idempotency_key).toBe(firstConfirm!.idempotency_key);
  expect(retryBody.quote_token).toBe(firstConfirm!.quote_token);
  const respJ = await resp.json();
  expect(respJ.ok).toBe(true);
  const orderId = respJ.data.order_id as string;
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });

  // 끝까지 카트는 보존 — replay는 주문을 새로 만들지도 재고를 더 차감하지도 않는다
  expect(await cartRows(page)).toEqual(cartBefore);
  expect(await stockMap(page, "p-a")).toEqual(stockCommitted);
  expect(await orderCount(page)).toBe(ordersBefore + 1);

  // 서버 주문 조회 — 견적과 품목·수량·금액·결제가 정합해야 한다
  const orderJ = await (
    await page.context().request.get("/api/orders/" + orderId)
  ).json();
  expect(orderJ.ok).toBe(true);
  const o = orderJ.data;
  expect(o.items).toHaveLength(1);
  expect(o.items[0].variant_id).toBe(bought.variant_id);
  expect(o.items[0].quantity).toBe(bought.quantity);
  expect(o.items[0].unit_price_won).toBe(bought.unit_price_won);
  expect(o.items[0].line_total_won).toBe(
    bought.unit_price_won * bought.quantity,
  );
  expect(o.items_total_won).toBe(quote.items_total_won);
  expect(o.shipping_fee_won).toBe(quote.shipping_fee_won); // 3,000 fixture
  expect(o.total_won).toBe(quote.total_won);
  expect(o.payment?.status).toBe("PAID");
  expect(o.payment?.paid_amount_won).toBe(quote.total_won);
});

test("DIRECT 미도착 → 결과 확인 NOT_FOUND → 같은 키 재전송으로 완료", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-c", "v-c-27");
  const ordersBefore = await orderCount(page);
  const cartBefore = await cartRows(page);
  const stockBefore = await stockMap(page, "p-a");
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "구매하기" }).click();
  await expect(page.getByRole("heading", { name: "주문서" })).toBeVisible();

  // 요청 자체가 서버에 도달하지 않게 차단 — action_requests에 기록이 없다.
  const drop = await interceptWrite(page, "**/api/checkout/confirm", "POST", "drop");
  await payCta(page).click();
  await drop.done;
  await page.unroute("**/api/checkout/confirm");

  await expect(page.getByText("결제 결과를 확인하지 못했어요")).toBeVisible();
  // 서버에 기록이 없으므로 주문·카트·재고 모두 불변
  expect(await orderCount(page)).toBe(ordersBefore);
  expect(await cartRows(page)).toEqual(cartBefore);
  expect(await stockMap(page, "p-a")).toEqual(stockBefore);

  // 결과 확인 → NOT_FOUND — 같은 요청 재전송만 제안한다
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText("요청 기록이 없어요")).toBeVisible();

  await page.getByRole("button", { name: "다시 결제하기" }).click();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });
  expect(await orderCount(page)).toBe(ordersBefore + 1);
});

test("CART_SELECTED — 선택 항목만 주문되고 미선택 카트 행은 보존된다", async ({ page }) => {
  await loginClean(page);
  await addVariant(page, "p-a", "v-a-24");
  await addVariant(page, "p-b", "v-b-24");
  await page.goto("/#/cart");

  // p-b만 선택 해제 — p-a만 주문한다 (항목은 기본 선택 상태로 들어온다)
  await page.getByRole("checkbox", { name: "코드뷰 모니터 B 선택" }).click();
  await page.getByRole("button", { name: /1건 · .*주문하기/ }).click();

  await expect(page.getByRole("heading", { name: "주문서" })).toBeVisible();
  // 주문서는 선택 행만 표시한다
  await expect(page.getByText("코드뷰 모니터 A")).toBeVisible();
  await expect(page.getByText("코드뷰 모니터 B")).toHaveCount(0);

  const ordersBefore = await orderCount(page);
  // 미선택 행(p-b)의 사전 스냅샷 — 선택 주문이 이 행을 건드리지 않아야 한다
  const cartPre = await cartRows(page);
  const unselected = cartPre.items.find((i) => i.variant_id === "v-b-24");
  expect(unselected).toBeTruthy();
  await payCta(page).click();
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });

  // 미선택 행은 id·variant·수량·variant_version 그대로 남는다 — 선택 행만 삭제
  const cartJ = await cartRows(page);
  expect(cartJ.items).toHaveLength(1);
  expect(cartJ.items[0]).toEqual(unselected);
  expect(await orderCount(page)).toBe(ordersBefore + 1);
});
