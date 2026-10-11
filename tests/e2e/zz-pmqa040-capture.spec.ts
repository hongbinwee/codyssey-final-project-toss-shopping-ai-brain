// PMQA-040 시각 증거 캡처 — 주문서 default/summary/complete × dark/light ×
// 390x844/390x600. zz- 접두로 suite 마지막에 실행해, 앞 spec들이 만든
// CONFIRMED+PAID 주문을 완료 화면에 재사용한다 — 이 파일은 어떤 주문도
// 생성하지 않는다(confirm 호출 없음, 읽기+카트 fixture만).
// 카트는 1회 준비해 4조합 캡처에 재사용한다(churn 최소). 카트 variant는
// suite 소비 후 실제 GET 재고가 남은 것을 동적 선택하고, 가격·배송비는
// 서버 GET /api/checkout/quote 응답 그대로 facts에 기록한다 [PM 보충].
// 결과물: shots/06a/pmqa040/impl_*.png + facts.json — 기존 파일은 덮지 않고
// 실패 시에도 facts-progress.json으로 증거를 남긴다.
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { reserveCaptureOutput } from "../helpers/capture-output.ts";

test.describe.configure({ mode: "serial" });

let OUT = "";

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

const facts: {
  generatedAt: string;
  cartStart: unknown;
  pickedVariant: unknown;
  paidOkOrder: unknown;
  quote: unknown;
  combos: Record<string, unknown>;
  cartEnd: unknown;
  fails: string[];
  completed: boolean;
} = {
  generatedAt: new Date().toISOString(),
  cartStart: null,
  pickedVariant: null,
  paidOkOrder: null,
  quote: null,
  combos: {},
  cartEnd: null,
  fails: [],
  completed: false,
};
const fail = (k: string, v: unknown) => {
  facts.fails.push(k + ": " + JSON.stringify(v));
  console.log("FAIL", k, JSON.stringify(v));
};

// 측정 헬퍼 — 실측만 기록하고 bool 추정으로 PASS 처리하지 않는다.
async function measureCheckout(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      const b = el?.getBoundingClientRect();
      return b
        ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
        : null;
    };
    const hit = (el: Element | null) => {
      const b = el?.getBoundingClientRect();
      if (!b) return false;
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest("button") === el;
    };
    const ship = document.querySelector(".checkout-ship");
    const shipRows = ship
      ? [...ship.querySelectorAll("div")].map((d) => ({
          cls: d.className, text: d.textContent?.slice(0, 40),
        }))
      : [];
    const card = document.querySelector(".checkout-card");
    const toggle = document.querySelector(".checkout-card .cart-quote-toggle");
    const totalSec = document.querySelector("#checkout-quote-rows");
    const lastRow = totalSec?.querySelector(".cart-quote-row:last-child");
    const bar = document.querySelector(".checkout-paybar");
    const btn = document.querySelector(".checkout-paybar .btn");
    const note = document.querySelector(".checkout-paybar .pay-note");
    const band = document.querySelector(".checkout-band");
    const thumb = document.querySelector(".checkout-card .checkout-thumb");
    const item = document.querySelector(".checkout-card .checkout-item");
    const cs = item ? getComputedStyle(item) : null;
    return {
      scrollY: Math.round(window.scrollY),
      innerH: window.innerHeight,
      shipRect: rect(ship),
      shipRows,
      band: band ? { display: getComputedStyle(band).display, rect: rect(band), borderTop: getComputedStyle(band).borderTopWidth } : null,
      cardRect: rect(card),
      toggleInCard: !!(card && toggle && card.contains(toggle)),
      totalInCard: !!(card && totalSec && card.contains(totalSec)),
      totalHidden: totalSec?.hasAttribute("hidden") ?? null,
      totalRect: rect(totalSec ?? null),
      lastRowRect: rect(lastRow ?? null),
      lastRowInViewport: lastRow ? (() => { const b = lastRow.getBoundingClientRect(); return b.bottom <= innerHeight && b.top >= 0; })() : null,
      // MJ-06A-REACH-040 — innerHeight 비교만으로는 고정 paybar 뒤에 가려진
      // 행을 '보임'으로 오판한다. 진짜 기준: 행 bottom이 bar top 위에 있고,
      // 행 중심의 elementFromPoint가 bar가 아닌 행 자신을 가리켜야 한다.
      barRect: rect(bar),
      lastRowClear: lastRow && bar ? (() => {
        const rb = lastRow.getBoundingClientRect(), bb = bar.getBoundingClientRect();
        const el = document.elementFromPoint(rb.x + rb.width / 2, rb.y + rb.height / 2);
        const inViewport = rb.top >= 0 && rb.bottom <= innerHeight;
        const isRow = el === lastRow || lastRow.contains(el);
        return {
          rowBottomAboveBar: rb.bottom <= bb.top,
          pointIsBar: el === bar || bar.contains(el),
          pointIsRow: isRow,
          rowInViewport: inViewport,
          pointEl: el ? ((el as Element).className || (el as Element).tagName) : null,
          // PM 강화: 'bar가 아님'만으로는 다른 overlay/뷰포트 밖도 통과하므로
          // hit이 실제 마지막 행(자신/자손)이고 행 전체가 viewport 안일 때만 clear.
          clear: rb.bottom <= bb.top && isRow && inViewport,
        };
      })() : null,
      itemFlex: cs ? { display: cs.display, gap: cs.gap } : null,
      thumb: thumb ? rect(thumb) : null,
      cta: btn ? { rect: rect(btn), hit: hit(btn), text: btn.textContent } : null,
      payNote: note ? { text: note.textContent, rect: rect(note) } : null,
    };
  });
}

async function measureComplete(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      const b = el?.getBoundingClientRect();
      return b
        ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
        : null;
    };
    const hit = (el: Element | null) => {
      const b = el?.getBoundingClientRect();
      if (!b) return false;
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest("button") === el;
    };
    const wrap = document.querySelector(".oc-cta");
    const home = document.querySelector(".oc-cta .oc-home");
    const link = document.querySelector(".oc-cta .oc-detail");
    const img = document.querySelector(".oc-screen .cart-item img");
    return {
      scrollY: Math.round(window.scrollY),
      innerH: window.innerHeight,
      wrapRect: rect(wrap),
      home: home ? { rect: rect(home), hit: hit(home) } : null,
      link: link ? { rect: rect(link), hit: hit(link) } : null,
      imgNatural: img ? (img as HTMLImageElement).naturalWidth : null,
      check: !!document.querySelector(".oc-check"),
      title: document.querySelector(".oc-title")?.textContent ?? null,
    };
  });
}

test("PMQA-040 시각 증거 — 주문서·금액패널·완료 4조합 캡처 (주문 생성 없음)", async ({ page }) => {
  test.setTimeout(120_000);
  // 새 UUID 경로를 배타 예약한다. 실패 시 login/cart HTTP/capture 전에 종료.
  OUT = await reserveCaptureOutput("shots/06a/pmqa040-runs");
  try {
    await login(page);
    await clearCartApi(page);

    // confirm POST 카운터 — 이 spec은 주문을 생성하지 않는다는 실행 증거.
    let confirmPosts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/checkout/confirm")) confirmPosts++;
    });
    (facts as { confirmPosts?: number }).confirmPosts = 0;
    facts.cartStart = (await (await page.context().request.get("/api/cart")).json()).data;

    // paidOk 주문 선정 — 최신순 첫 CONFIRMED+PAID+취소요청없음. 목록 요약으로
    // 후보를 고르고 상세 GET으로 paid=total까지 확인한다(둘 다 읽기 전용).
    const list = await (await page.context().request.get("/api/orders?limit=50")).json();
    const candidates = (list.data.orders as { id: string; order_status: string; payment_status: string | null; cancel_status: string | null }[])
      .filter((o) => o.order_status === "CONFIRMED" && o.payment_status === "PAID" && !o.cancel_status);
    let orderId: string | null = null;
    for (const c of candidates) {
      const d = await (await page.context().request.get("/api/orders/" + c.id)).json();
      if (d.ok && d.data.payment?.paid_amount_won === d.data.total_won && !d.data.cancel_request) {
        orderId = c.id;
        facts.paidOkOrder = { id: c.id, status: d.data.status, payment: d.data.payment?.status, paid: d.data.payment?.paid_amount_won, total: d.data.total_won, items: (d.data.items as unknown[]).length };
        break;
      }
    }
    if (!orderId) {
      fail("paidOkOrder", "CONFIRMED+PAID+paid=total 주문 없음 — suite 주문 미생성?");
      throw new Error("no paidOk order for complete capture");
    }

    // 카트 variant 동적 선택 — suite confirm으로 v-b-24 등이 소진됐을 수
    // 있으므로 fixture 3종에서 실제 GET 재고가 가장 많은 variant를 고른다.
    // 가격·배송비는 하드코딩하지 않고 서버 quote 응답으로 기록한다 [PM 보충].
    let pick: { productId: string; variantId: string; stock: number; price: number } | null = null;
    for (const pid of ["p-a", "p-b", "p-c"]) {
      const pj = await (await page.context().request.get("/api/products/" + pid)).json();
      for (const v of pj.data.variants as { variant_id: string; stock_qty: number; unit_price_won: number }[]) {
        if (v.stock_qty >= 1 && (!pick || v.stock_qty > pick.stock))
          pick = { productId: pid, variantId: v.variant_id, stock: v.stock_qty, price: v.unit_price_won };
      }
    }
    if (!pick) {
      fail("stock", "재고>=1인 fixture variant 없음");
      throw new Error("no stocked variant for capture");
    }
    facts.pickedVariant = pick;

    // 카트 1회 준비 — 4조합 캡처가 같은 카트를 재사용한다(churn 최소).
    await addVariant(page, pick.productId, pick.variantId, 1);

    // GET 견적 실응답 — 표시 금액과 서버 값의 정합 증거.
    const quote = await (await page.context().request.get("/api/checkout/quote")).json();
    facts.quote = {
      items: quote.data.cart.items.map((i: { product_id: string; quantity: number; unit_price_won: number }) => ({ product_id: i.product_id, quantity: i.quantity, unit_price_won: i.unit_price_won })),
      items_total_won: quote.data.cart.items_total_won,
      shipping_fee_won: quote.data.cart.shipping_fee_won,
      total_won: quote.data.cart.total_won,
      address: quote.data.address,
    };

    const combos: [string, number][] = [
      ["dark", 844],
      ["light", 844],
      ["dark", 600],
      ["light", 600],
    ];
    for (const [scheme, h] of combos) {
      const tag = scheme + "_" + h;
      await page.setViewportSize({ width: 390, height: h });
      await page.emulateMedia({ colorScheme: scheme as "dark" | "light" });

      const c: Record<string, unknown> = {};
      await page.goto("/#/cart");
      await page.getByRole("button", { name: /주문하기/ }).click();
      await expect(page.locator(".checkout-screen")).toBeVisible({ timeout: 15000 });
      await expect(page.locator(".checkout-ship .ship-addr")).toBeVisible();

      // 1) 주문서 default(접힘) — 실측 + 캡처
      c.checkout = await measureCheckout(page);
      await page.screenshot({ path: OUT + "impl_checkout_" + tag + ".png" });

      // 2) 금액 패널 펼침 — 총 결제 금액이 카드 밖 독립 섹션인지 실측
      await page.locator(".checkout-card").getByRole("button", { name: /주문 금액 상세/ }).click();
      await expect(page.locator("#checkout-quote-rows")).toBeVisible();
      c.summary = await measureCheckout(page);
      if ((c.summary as { totalInCard?: boolean }).totalInCard)
        fail("totalInCard_" + tag, "총 결제 금액 섹션이 카드 안에 있음");
      // MJ-06A-REACH-040 재현 기록 — 600 높이에서 마지막 금액 행이 고정
      // paybar 뒤에 가려지는지 elementFromPoint로 실측한다(오판 금지).
      const sm = c.summary as {
        lastRowClear?: { rowBottomAboveBar: boolean; pointIsBar: boolean; pointIsRow?: boolean; rowInViewport?: boolean; pointEl: string | null; clear: boolean } | null;
        lastRowRect?: { y: number; h: number } | null;
        barRect?: { y: number; h: number } | null;
        payNote?: { text?: string | null } | null;
      };
      (c as { occludedBeforeScroll?: unknown }).occludedBeforeScroll = sm.lastRowClear;
      if (sm.lastRowClear && !sm.lastRowClear.rowBottomAboveBar) {
        // 정밀 스크롤 — scrollIntoViewIfNeeded는 고정 bar를 모르므로, 행 bottom이
        // bar top-8 위로 오게 필요한 만큼만 scrollBy한다 [PM 지시].
        await page.evaluate(() => {
          const row = document.querySelector("#checkout-quote-rows .cart-quote-row:last-child");
          const bar = document.querySelector(".checkout-paybar");
          if (!row || !bar) return;
          const rb = row.getBoundingClientRect();
          const bb = bar.getBoundingClientRect();
          const need = rb.bottom - (bb.top - 8);
          if (need > 0) window.scrollBy(0, need);
        });
        const re = await measureCheckout(page);
        (c as { summaryScrolled?: unknown }).summaryScrolled = re;
        if (re.lastRowClear?.clear !== true)
          fail("lastRowOccluded_" + tag, {
            before: sm.lastRowClear,
            after: re.lastRowClear,
            scrollY: re.scrollY,
          });
      } else if (sm.lastRowClear && sm.lastRowClear.pointIsBar) {
        fail("lastRowCovered_" + tag, sm.lastRowClear);
      }
      if (!sm.payNote?.text)
        fail("payNote_" + tag, "모의결제 안내 문구 없음");
      await page.screenshot({ path: OUT + "impl_checkout_summary_" + tag + ".png" });

      // 3) 결제 완료 — paidOk 주문 GET 재사용(생성 없음)
      await page.goto("/#/orders/" + orderId + "/complete");
      await expect(page.locator(".oc-screen")).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible();
      c.complete = await measureComplete(page);
      await page.screenshot({ path: OUT + "impl_complete_" + tag + ".png" });
      if ((c.complete as { check?: boolean }).check !== true) fail("complete_check_" + tag, "체크 아이콘 없음");

      facts.combos[tag] = c;
    }

    facts.completed = true;
    (facts as { confirmPosts?: number }).confirmPosts = confirmPosts;
    if (confirmPosts !== 0) fail("confirmPosts", "capture spec이 checkout/confirm을 호출했다: " + confirmPosts);
  } finally {
    // 실패해도 여기까지 모은 측정치를 남긴다 — facts.json은 성공 완료 시에만.
    if (!facts.completed) {
      fs.writeFileSync(OUT + "facts-progress.json", JSON.stringify(facts, null, 2));
      console.log("WROTE", OUT + "facts-progress.json (incomplete run)");
    }
  }

  // 카트 정리 — suite가 남긴 상태를 그대로 두지 않는다.
  await clearCartApi(page);
  const endCart = await (await page.context().request.get("/api/cart")).json();
  facts.cartEnd = { items: endCart.data.items.length, version: endCart.data.version };

  fs.writeFileSync(OUT + "facts.json", JSON.stringify(facts, null, 2));
  console.log("WROTE", OUT + "facts.json", "fails:", facts.fails.length);
  expect(facts.fails).toEqual([]);
});
