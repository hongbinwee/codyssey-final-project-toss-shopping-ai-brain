// 05 상품 상세→옵션→담기→카트 안전 계약 E2E.
// 카트 쓰기가 있는 시나리오는 사용자를 공유하지 않게 같은 파일 안에서 serial 실행
// (e2e 실행은 --workers=1 전제 — 다른 파일의 cart-writer와 경합하지 않는다).
import { expect, test, type Page, type Request } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function login(page: Page, code = "e2e-a") {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill(code);
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

const logout = (page: Page) => page.context().request.delete("/api/session");

// actor 격리 — 앞선 spec 파일(같은 commerce_test 공유)이 남긴 카트 잔여물을
// 정상 API로 비운다. 같은 variant는 한 행에 합산되므로 ×1 잔여가 담기 수량
// assertion을 깬다. cleanUserData는 실행 시작 시 1회뿐이다.
async function clearCartApi(page: Page) {
  for (;;) {
    const r = await page.context().request.get("/api/cart");
    const j = await r.json();
    const it = j.data?.items?.[0];
    if (!it) return;
    const d = await page.context().request.delete("/api/cart/items/" + it.cart_item_id, {
      data: {
        expected_cart_version: j.data.version,
        idempotency_key: crypto.randomUUID(),
      },
    });
    if (!(await d.json()).ok) throw new Error("clearCartApi delete failed");
  }
}

// 기본은 로그인 직후 해당 actor의 카트를 비워 독립 fixture로 시작한다.
// clean=false는 drop으로 commit된 상태를 보존해야 하는 재로그인에만 쓴다.
async function loginClean(page: Page, code = "e2e-a", clean = true) {
  await login(page, code);
  if (clean) await clearCartApi(page);
}

// 쓰기 응답 가로채기 — route.fetch로 서버 commit을 확인한 뒤 클라이언트에게만
// 다른 결과를 보인다. finish="abort"면 응답 유실, {status,json}이면 봉투 교체.
// 반환하는 done은 fetch(commit 확인)+finish 완료 후에만 resolve된다.
// 이를 기다리지 않고 unroute하면 Playwright가 진행 중인 route를 자동
// continue로 처리해 "Route is already handled!"로 깨지거나 살아 있는 요청이
// 서버에 commit될 수 있어 반드시 done을 먼저 기다린다.
async function interceptWrite(
  page: Page,
  pattern: string,
  method: string,
  finish: "abort" | { status: number; json: unknown },
  onRequest?: (req: Request) => void,
) {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  done.catch(() => {}); // 테스트가 먼저 실패해도 unhandled rejection 방지
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) return route.continue();
    try {
      onRequest?.(route.request());
      // 실서버 왕복 — 서버가 요청을 처리(commit)했다는 것을 확인한다.
      // 거절/오류 응답이면 시나리오가 아니므로 명시적으로 실패시킨다.
      const res = await route.fetch();
      if (!res.ok()) {
        // PMQA-06A-VERIFY-FIX-035 — 409 재현 시 원인 회수용 최소 진단:
        // 보낸 payload(expected_*_version 등) + 실제 error JSON + 지금 서버 카트 상태.
        let info = "";
        try { info += " req=" + JSON.stringify(route.request().postDataJSON()); }
        catch { info += " req=<none>"; }
        try { info += " res=" + (await res.text()).slice(0, 400); }
        catch { /* 읽기 불가 */ }
        try {
          const c = await page.context().request.get("/api/cart");
          const cj = await c.json();
          info += " cart.version=" + cj.data?.version +
            " items=" + ((cj.data?.items ?? []) as { variant_id: string; quantity: number }[])
              .map((i) => i.variant_id + "x" + i.quantity).join(",");
        } catch { /* best-effort */ }
        throw new Error("interceptWrite: 서버 응답 " + res.status() + info);
      }
      if (finish === "abort") await route.abort();
      else await route.fulfill({ status: finish.status, json: finish.json });
      resolve();
    } catch (e) {
      reject(e);
      throw e; // 예외를 삼키지 않는다 — route 핸들러 오류로도 보고된다.
    }
  });
  return { done };
}

// 응답 유실 시뮬레이션 — 서버에는 도달해 실제 commit되지만 클라이언트는
// 응답을 받지 못한다(route.fetch 후 abort).
const dropWrite = (
  page: Page,
  pattern: string,
  method: string,
  onRequest?: (req: Request) => void,
) => interceptWrite(page, pattern, method, "abort", onRequest);

const emptyCart = async (page: Page) => {
  // locator.all() 스냅샷은 첫 삭제 후 인덱스가 이동해 다음 버튼이 사라질 수
  // 있다. 매번 live 첫 항목을 지우고 개수 감소를 기다린다.
  const del = page.getByRole("button", { name: "삭제" });
  while (await del.count()) {
    const before = await del.count();
    await del.first().click();
    await expect(del).toHaveCount(before - 1);
  }
};

// variant의 현재 version을 상품 API에서 읽는다(후속 쓰기의 expected_variant_version).
async function variantVersion(page: Page, productId: string, variantId: string) {
  const r = await page.context().request.get("/api/products/" + productId);
  const j = await r.json();
  const v = j.data.variants.find(
    (x: { variant_id: string }) => x.variant_id === variantId,
  );
  return v.version as number;
}

// variant version 조회 없이 cart version만 필요한 후속 쓰기를 돕는다.
async function cartVersion(page: Page) {
  const r = await page.context().request.get("/api/cart");
  const j = await r.json();
  return j.data.version as number;
}

async function addFixtureVariant(page: Page, productId: string, variantId: string) {
  const pr = await page.context().request.get("/api/products/" + productId);
  const pj = await pr.json();
  const variant = pj.data.variants.find(
    (v: { variant_id: string }) => v.variant_id === variantId,
  );
  if (!variant) throw new Error("missing fixture variant: " + variantId);
  const r = await page.context().request.post("/api/cart/items", {
    data: {
      product_id: productId,
      variant_id: variantId,
      quantity: 1,
      expected_cart_version: await cartVersion(page),
      expected_variant_version: variant.version,
      idempotency_key: crypto.randomUUID(),
    },
  });
  const j = await r.json();
  if (!j.ok) throw new Error("fixture cart add failed: " + JSON.stringify(j));
}

test("detail: default option → sheet → qty → add → cart ops → empty", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");

  // 구매 가능한 기본 옵션(v-a-24 24인치)이 자동 선택돼 있다
  await expect(page.locator(".option-open")).toContainText("24인치");

  // 옵션 변경은 BottomSheet — 품절 옵션(v-a-27)은 비활성
  await page.locator(".option-open").click();
  // 시트 타이틀은 '옵션 한번에 보기', 옵션 행 클래스는 .opt-item [PMQA-066 계약]
  const sheet = page.getByRole("dialog", { name: "옵션 한번에 보기" });
  await expect(sheet).toBeVisible();
  const soldout = sheet.locator("button.opt-item", { hasText: "27인치" });
  await expect(soldout).toBeDisabled();
  await expect(soldout).toContainText("품절");
  await sheet.getByRole("button", { name: /24인치/ }).click();

  // 수량 +1 → CTA 금액이 즉시 갱신된다
  await page.locator(".qty-ctrl").getByRole("button", { name: "+" }).click();
  await page.getByRole("button", { name: "360,000원 담기" }).click();
  await expect(page.getByText("장바구니에 담았어요")).toBeVisible();

  await page.getByRole("button", { name: "장바구니 보기" }).click();
  await expect(page.locator(".cart-thumb img").first()).toBeVisible();
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("2");

  // 수량 감소 → 1 → 삭제 → 빈 상태
  await page.getByRole("button", { name: /수량 감소/ }).click();
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("1");
  await page.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("장바구니가 비었어요")).toBeVisible();
});

test("detail: 카트 상품명/썸네일 클릭 시 상품 상세로 이동", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-b");
  await page.getByRole("button", { name: "149,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  await page.locator(".cart-name").click();
  await expect(page).toHaveURL(/#\/p\/p-b/);
  await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 B");

  await page.goto("/#/cart");
  await emptyCart(page);
});

test("detail: read failure → retry → default option re-selected", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/products/p-a", (route) =>
    route.request().method() === "GET" ? route.abort() : route.continue());
  await page.goto("/#/p/p-a");
  await expect(page.getByText(/상품을 불러오지 못했어요/)).toBeVisible();
  await page.unroute("**/api/products/p-a");
  await page.getByRole("button", { name: "다시 시도" }).click();
  // 재시도 성공 후에도 동일한 초기화 규칙 — 기본 옵션 재선택
  await expect(page.locator(".option-open")).toContainText("24인치");
  await expect(page.getByRole("button", { name: /담기/ })).toBeEnabled();
});

test("detail: 모든 옵션 품절 → 커버·CTA·옵션 버튼 비활성", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/products/p-b", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const j = await res.json();
    for (const v of j.data.variants) {
      v.stock_qty = 0;
      v.availability = "SOLD_OUT";
    }
    j.data.product.availability = "SOLD_OUT";
    await route.fulfill({ json: j });
  });
  await page.goto("/#/p/p-b");
  await expect(page.locator(".soldout-cover")).toHaveText("품절");
  await expect(page.getByRole("button", { name: "품절" })).toBeDisabled();
  await expect(page.locator(".option-open")).toBeDisabled();
});

test("detail: variants=[] → 허위 가격 없이 판매 불가 유지", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/products/p-a", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const j = await res.json();
    j.data.variants = []; // getProduct는 active variant만 반환 — 유효 응답
    await route.fulfill({ json: j });
  });
  await page.goto("/#/p/p-a");
  await expect(page.locator(".soldout-cover")).toHaveText("품절");
  await expect(page.locator(".option-open")).toBeDisabled();
  await expect(page.getByRole("button", { name: "품절" })).toBeDisabled();
  // Math.min(...[])의 Infinity가 가격에 새면 안 된다
  await expect(page.locator(".price-main")).toHaveCount(0);
  await expect(page.getByText(/Infinity|∞/)).toHaveCount(0);
});

test("detail: 빠른 상품 전환 시 이전 상품의 늦은 응답이 누출되지 않는다", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/products/p-a", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((r) => setTimeout(r, 900)); // 늦은 응답
    return route.continue();
  });
  await page.goto("/#/p/p-a");
  await page.goto("/#/p/p-b");
  await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 B");
  await page.waitForTimeout(1200); // 지연된 p-a 응답이 도착한 뒤에도 B 유지
  await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 B");
});

test("reviews: 출처 칩·실제 행 수·페이지네이션·빈 상태", async ({ page }) => {
  await loginClean(page);

  // p-a: 실제 시드 리뷰 4건 — 전부 SYNTHETIC('시연 리뷰'), 더보기 없음
  await page.goto("/#/p/p-a");
  await expect(page.locator(".review-item")).toHaveCount(4);
  await expect(page.locator(".src-chip").first()).toHaveText("시연 리뷰");
  await expect(page.getByText(/리뷰 4개/)).toBeVisible();
  await expect(page.getByRole("button", { name: "리뷰 더 보기" })).toHaveCount(0);

  // p-b: 응답을 가공해 cursor 페이지네이션과 REAL 칩을 검증한다
  await page.route("**/api/products/p-b/reviews**", async (route) => {
    const url = route.request().url();
    const mk = (id: string, body: string, kind: string, more: boolean) => ({
      ok: true,
      data: {
        reviews: [{
          id, product_id: "p-b", variant_id: null, rating: 5, body,
          source_kind: kind, source_ref: "e2e", written_at: "2026-01-01T00:00:00Z",
        }],
        total_matching: 2, returned_count: 1,
        next_cursor: more ? "c2" : null, has_more: more,
        sort: "LATEST",
      },
    });
    if (!url.includes("cursor=")) return route.fulfill({ json: mk("x1", "첫 페이지 리뷰", "SYNTHETIC", true) });
    return route.fulfill({ json: mk("x2", "두 번째 페이지 리뷰", "REAL", false) });
  });
  await page.goto("/#/p/p-b");
  await expect(page.getByText("첫 페이지 리뷰")).toBeVisible();
  await page.getByRole("button", { name: "리뷰 더 보기" }).click();
  await expect(page.getByText("두 번째 페이지 리뷰")).toBeVisible();
  await expect(page.locator(".src-chip", { hasText: "실사용 리뷰" })).toBeVisible();
  await expect(page.getByRole("button", { name: "리뷰 더 보기" })).toHaveCount(0);
  await page.unroute("**/api/products/p-b/reviews**");

  // 빈 상태 — 실제 fixture에 빈 리뷰 상품이 없으므로 응답을 가공해 검증
  await page.route("**/api/products/p-c/reviews**", (route) =>
    route.fulfill({ json: { ok: true, data: { reviews: [], total_matching: 0, returned_count: 0, next_cursor: null, has_more: false, sort: "LATEST" } } }));
  await page.goto("/#/p/p-c");
  await expect(page.getByText(/아직 리뷰가 없어요/)).toBeVisible();
});

test("response drop POST → pending → 결과 확인 SUCCEEDED → 최신 카트", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  let posts = 0;
  const drop = await dropWrite(page, "**/api/cart/items", "POST", () => posts++);
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await drop.done; // 서버 commit 확인 + 클라이언트 응답 유실 확정
  expect(posts).toBe(1); // 재전송 없이 정확히 1회만 서버에 도달
  await expect(page.getByText("담기 결과를 확인하지 못했어요")).toBeVisible();
  await expect(page.locator(".option-open")).toBeDisabled(); // 전역 잠금
  await page.unroute("**/api/cart/items");

  // 카트에서 복구 — 미확정 intent는 주문 버튼도 잠근다
  await page.getByRole("button", { name: "장바구니에서 확인하기" }).click();
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "주문하기" })).toBeDisabled();
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/완료된 요청/)).toBeVisible();
  // SUCCEEDED 후엔 snapshot이 아니라 최신 카트로 재동기화된다
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");
  await emptyCart(page);
});

test("pending 복구 접근점은 첫 화면 고정바에 노출된다 (PMQA-05-MJ-PENDING-VISIBILITY-02)", async ({ page }) => {
  await loginClean(page);
  await page.setViewportSize({ width: 390, height: 844 }); // QA 기준 실기기 뷰포트
  await page.goto("/#/p/p-a");

  const drop = await dropWrite(page, "**/api/cart/items", "POST");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await drop.done; // 서버 commit + 클라이언트 응답 유실 확정

  // 복구 스트립이 스크롤 없이 첫 viewport 내부에 있어야 한다 — toBeVisible은
  // viewport 밖도 통과하므로 bbox로 기하를 직접 증명한다.
  const note = page.locator(".bar-note");
  await expect(note).toBeVisible();
  const nb = await note.boundingBox();
  expect(nb).not.toBeNull();
  expect(nb!.y).toBeGreaterThanOrEqual(0);
  expect(nb!.y + nb!.height).toBeLessThanOrEqual(844);
  const recover = page.getByRole("button", { name: "장바구니에서 복구" });
  const rb = await recover.boundingBox();
  expect(rb).not.toBeNull();
  expect(rb!.y).toBeGreaterThanOrEqual(0);
  expect(rb!.y + rb!.height).toBeLessThanOrEqual(844);

  // 담기 CTA·옵션 잠금은 유지된다
  await expect(page.getByRole("button", { name: "180,000원 담기" })).toBeDisabled();
  await expect(page.locator(".option-open")).toBeDisabled();
  await page.unroute("**/api/cart/items");

  // 높아진 고정바 아래에서도 문서 끝 복구 상세는 스크롤로 노출된다
  await page.getByText("담기 결과를 확인하지 못했어요").scrollIntoViewIfNeeded();
  const deep = page.getByRole("button", { name: "장바구니에서 확인하기" });
  await expect(deep).toBeVisible();
  const db = await deep.boundingBox();
  expect(db).not.toBeNull();
  expect(db!.y).toBeGreaterThanOrEqual(0);
  expect(db!.y + db!.height).toBeLessThanOrEqual(844);

  // 스크롤 없이 고정바 버튼으로 바로 복구 진입 → 결과 확인 → 최신 카트
  await page.evaluate(() => window.scrollTo(0, 0));
  await recover.click();
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "주문하기" })).toBeDisabled();
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/완료된 요청/)).toBeVisible();
  // SUCCEEDED → snapshot이 아니라 최신 카트 qty·총액으로 재동기화
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("1");
  await expect(page.locator("#cart-quote-rows")).toContainText("상품 금액");
  await expect(page.locator("#cart-quote-rows")).toContainText("180,000원");
  await expect(page.locator("#cart-quote-rows")).toContainText("배송비");
  await expect(page.locator("#cart-quote-rows")).toContainText("3,000원");
  await expect(page.locator(".cart-summary-total b")).toHaveText("183,000원");
  // pending 해제 — 배너 소멸·주문 가능
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "주문하기" })).toBeEnabled();
  await emptyCart(page);
});

test("다른 상품에서 시작된 pending도 상세 진입 즉시 고정바 복구로 연결된다", async ({ page }) => {
  await loginClean(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/p/p-a");
  const drop = await dropWrite(page, "**/api/cart/items", "POST");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await drop.done;
  await page.unroute("**/api/cart/items");

  // 다른 상품으로 이동 — 이 상품의 pendingAdd는 아니지만 anyPending 잠금은 유지
  await page.goto("/#/p/p-b");
  const note = page.locator(".bar-note");
  await expect(note).toBeVisible();
  const nb = await note.boundingBox();
  expect(nb).not.toBeNull();
  expect(nb!.y).toBeGreaterThanOrEqual(0);
  expect(nb!.y + nb!.height).toBeLessThanOrEqual(844);
  await expect(page.getByRole("button", { name: "149,000원 담기" })).toBeDisabled();
  await expect(page.locator(".option-open")).toBeDisabled();

  // 같은 접근점으로 복구 — p-b에서 시작하지 않은 요청도 카트에서 확인 가능
  await page.getByRole("button", { name: "장바구니에서 복구" }).click();
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/완료된 요청/)).toBeVisible();
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");
  await emptyCart(page);
});

test("서버 500 INTERNAL → ambiguous → intent 유지 → 조회 SUCCEEDED(중복 없음)", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  // 서버는 commit까지 완료 — 클라이언트에만 500 INTERNAL 봉투를 보인다
  let posts = 0;
  const hijack = await interceptWrite(page, "**/api/cart/items", "POST", {
    status: 500,
    json: { ok: false, error: { code: "INTERNAL", message: "simulated" } },
  }, () => posts++);
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await hijack.done;
  expect(posts).toBe(1); // 서버 왕복은 1회 — 봉투만 교체됐다
  // INTERNAL은 commit 여부 불확정 — intent가 유지되고 잠금이 걸린다
  await expect(page.getByText("담기 결과를 확인하지 못했어요")).toBeVisible();
  await expect(page.locator(".option-open")).toBeDisabled();
  await page.unroute("**/api/cart/items");
  await page.getByRole("button", { name: "장바구니에서 확인하기" }).click();
  await expect(page.getByRole("button", { name: "주문하기" })).toBeDisabled();
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/완료된 요청/)).toBeVisible();
  // 서버는 한 번만 commit — 동일 상품 행이 중복 생기면 안 된다
  await expect(page.locator(".cart-name")).toHaveCount(1); // 같은 variant는 한 행에 합산 — 수량으로 1회 commit을 검증
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("1");
  const cr = await page.context().request.get("/api/cart");
  expect((await cr.json()).data.items[0].quantity).toBe(1);
  await emptyCart(page);
});

test("cart PATCH drop → 결과 확인 → commit 1회 반영(중복 실행 없음)", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  let key = "";
  let patches = 0;
  const drop = await dropWrite(page, "**/api/cart/items/*", "PATCH", (req) => {
    key = (req.postDataJSON() as { idempotency_key: string }).idempotency_key;
    patches++;
  });
  await page.getByRole("button", { name: /수량 증가/ }).click();
  await drop.done;
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  await page.unroute("**/api/cart/items/*");
  expect(patches).toBe(1); // PATCH는 절대값 setter — 요청 수로 1회 commit을 입증
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/완료된 요청/)).toBeVisible();
  // commit은 정확히 1회 — ×3(재전송)이 아니라 ×2
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("2");

  // 서버 기록도 같은 키로 SUCCEEDED 조회된다(ui- 접두)
  const r = await page.context().request.get(
    "/api/actions?kind=UPDATE_CART&idempotency_key=ui-" + key);
  const j = await r.json();
  expect(j.data.status).toBe("SUCCEEDED");
  await emptyCart(page);
});

test("cart DELETE drop → 결과 확인 → 삭제 확정", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  const drop = await dropWrite(page, "**/api/cart/items/*", "DELETE");
  await page.getByRole("button", { name: "삭제" }).click();
  await drop.done;
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  await page.unroute("**/api/cart/items/*");
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/완료된 요청/)).toBeVisible();
  await expect(page.getByText("장바구니가 비었어요")).toBeVisible();
});

test("replay는 snapshot이 아니라 최신 카트를 표시한다", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  const drop = await dropWrite(page, "**/api/cart/items", "POST");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await drop.done;
  await page.unroute("**/api/cart/items");

  // 유실된 첫 요청 이후 다른 변경이 생긴 상황 — API로 p-b를 직접 추가
  const bv = await variantVersion(page, "p-b", "v-b-24");
  const r2 = await page.context().request.post("/api/cart/items", {
    data: {
      product_id: "p-b", variant_id: "v-b-24", quantity: 1,
      expected_cart_version: await cartVersion(page),
      expected_variant_version: bv,
      // PMQA-044-A — 고정 키가 실행 사이에 보존되면 replay/CONFLICT로 검증이 깨진다.
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect((await r2.json()).ok).toBe(true);

  // '다시 시도' → 같은 키 replay → 서버는 첫 commit의 snapshot을 돌려준다
  // (p-b가 빠진 상태) — UI는 최신 카트를 다시 읽어 두 상품 모두 보여야 한다
  await page.getByRole("button", { name: "장바구니에서 확인하기" }).click();
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText("요청이 반영됐어요")).toBeVisible();
  await expect(page.locator(".cart-name")).toHaveCount(2);
  await emptyCart(page);
});

test("OUT_OF_STOCK 확정 거절 → pending 해제·자동 재실행 없음", async ({ page }) => {
  await loginClean(page);
  // p-c 32인치는 재고 2 — 2개 담은 뒤 +1은 서버가 OUT_OF_STOCK으로 거절한다
  await page.goto("/#/p/p-c");
  await page.locator(".option-open").click();
  await page.getByRole("dialog", { name: "옵션 한번에 보기" })
    .getByRole("button", { name: /32인치/ }).click();
  await page.locator(".qty-ctrl").getByRole("button", { name: "+" }).click();
  await page.getByRole("button", { name: "698,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  await page.getByRole("button", { name: /수량 증가/ }).click();
  await expect(page.getByText(/변경 실패/)).toBeVisible();
  // 확정 거절 → intent 해제됐으므로 pending 박스가 없고 수량도 2 유지
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("2");
  await emptyCart(page);
});

test("VERSION_CONFLICT 확정 거절 → 자동 재실행 없이 최신 재조회", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  // UI가 들고 있는 cart version 뒤에 API로 다른 변경을 넣어 version을 진행시킨다
  const bv = await variantVersion(page, "p-b", "v-b-24");
  const add = await page.context().request.post("/api/cart/items", {
    data: {
      product_id: "p-b", variant_id: "v-b-24", quantity: 1,
      expected_cart_version: await cartVersion(page),
      expected_variant_version: bv,
      // PMQA-044-A — 고정 키가 실행 사이에 보존되면 replay/CONFLICT로 검증이 깨진다.
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect((await add.json()).ok).toBe(true);

  // UI는 아직 옛 version을 들고 있다 — 삭제를 누르면 VERSION_CONFLICT
  await page.getByRole("button", { name: "삭제" }).first().click();
  await expect(page.getByText(/카트가 변경되었어요/)).toBeVisible();
  // 자동 재실행 없음 — pending 박스가 없고 재조회된 최신 카트에 2개 행
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await expect(page.locator(".cart-name")).toHaveCount(2);
  await emptyCart(page);
});

test("비정상 응답 형식 → NETWORK 에러 상태 + 재시도 복구", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/products/p-a", (route) =>
    route.fulfill({ json: { weird: true } }));
  await page.goto("/#/p/p-a");
  await expect(page.getByText(/상품을 불러오지 못했어요 \(NETWORK\)/)).toBeVisible();
  await page.unroute("**/api/products/p-a");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");
});

test("무응답 쓰기 → bounded timeout → NOT_FOUND → 명시 재시도 성공", async ({ page }) => {
  test.setTimeout(75_000); // api timeout(30s)보다 길게
  await loginClean(page);
  await page.goto("/#/p/p-a");
  // 서버에 닿지도 회신도 없는 상황 — 핸들러를 gate로 hold한다.
  // 영구 pending 프로미스는 unroute 정리 경로를 오염시켜 후속 조회를 깨뜨릴 수
  // 있으므로, 죽은 요청임이 확인된 뒤 release해 핸들러를 정상 종료시킨다.
  let releaseHang!: () => void;
  const hang = new Promise<void>((r) => { releaseHang = r; });
  await page.route("**/api/cart/items", async (route) => {
    await hang;
    try { await route.abort(); } catch { /* 이미 죽은 요청 */ }
  });
  let postedKey = "";
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/cart/items"))
      postedKey = (r.postDataJSON() as { idempotency_key: string }).idempotency_key;
  });
  const failed = page.waitForEvent("requestfailed", (r) =>
    r.method() === "POST" && r.url().endsWith("/api/cart/items"));
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  // api 30s bounded timeout → NETWORK → ambiguous → intent 유지
  await expect(page.getByText("담기 결과를 확인하지 못했어요")).toBeVisible({ timeout: 45_000 });
  await failed; // 요청이 죽은 뒤에만 unroute — 죽은 요청은 continue돼도 서버에 닿지 않는다
  releaseHang();
  await page.unroute("**/api/cart/items");

  // owned lookup으로 서버 기록 없음을 실제 API에서 먼저 증명한다
  const lr = await page.context().request.get(
    "/api/actions?kind=ADD_CART&idempotency_key=ui-" + postedKey);
  expect(lr.status()).toBe(404);

  // UI의 결과 확인도 같은 판정 — 명시 재시도 안내
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/요청 기록이 없어요/)).toBeVisible();
  await page.getByRole("button", { name: "다시 담기" }).click();
  await expect(page.getByText("장바구니에 담았어요")).toBeVisible();
  await page.getByRole("button", { name: "장바구니 보기" }).click();
  await emptyCart(page);
});

test("pending intent는 사용자 스코프: B에 안 보이고 A 복귀 시 복구", async ({ page }) => {
  await loginClean(page); // e2e-a
  await page.goto("/#/p/p-a");
  const drop = await dropWrite(page, "**/api/cart/items", "POST");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await drop.done;
  await page.unroute("**/api/cart/items");

  // 로그아웃 → e2e-b — 같은 브라우저 저장소지만 다른 user.id 버킷
  await logout(page);
  await loginClean(page, "e2e-b"); // B의 카트도 비워 깨끗한 상태를 증명한다
  await page.goto("/#/cart");
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await expect(page.getByText("장바구니가 비었어요")).toBeVisible();
  await page.goto("/#/p/p-b");
  await expect(page.getByRole("button", { name: /담기/ })).toBeEnabled(); // B는 잠기지 않는다

  // A로 복귀하면 자기 intent만 복구된다
  await logout(page);
  // clean=false — drop으로 commit된 p-a가 카트에 남아 있어야 복구를 증명할 수 있다
  await loginClean(page, "e2e-a", false);
  await page.goto("/#/cart");
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByText(/완료된 요청/)).toBeVisible();
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");
  await emptyCart(page);
});

test("double-click CTA → intent는 1개만 발행", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/cart/items")) posts += 1;
  });
  await page.getByRole("button", { name: "180,000원 담기" }).dblclick();
  await expect(page.getByText("장바구니에 담았어요")).toBeVisible();
  expect(posts).toBe(1);
  await page.getByRole("button", { name: "장바구니 보기" }).click();
  await emptyCart(page);
});

// PMQA-05-CART-READ-RACE: cached cart로 재진입한 Cart의 mount GET(v1)이
// PATCH(v2) 확정 뒤에 도착해도 UI·배지를 과거로 덮으면 안 된다.
// 응답은 fixture가 아니라 route.fetch의 실제 v1 — release 후 v2가 유지돼야 한다.
test("cart stale-read race: held mount GET v1 must not overwrite committed v2", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");

  // 내부 라우팅으로 카트를 벗어난다 — 상품 상세로 이동(리로드 없이 언마운트)
  await page.locator(".cart-name").click();
  await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");

  // 카트 mount GET만 hold — 이후 GET은 통과시킨다
  let held = false;
  let release!: () => void;
  let heldResolve!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const heldP = new Promise<void>((r) => { heldResolve = r; });
  let delivered = false;
  // route 콜백에서 대입 — TS가 흐름을 못 따라가 any로 둔다
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let v1: any = null;
  await page.route("**/api/cart", async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const res = await route.fetch(); // 실제 v1 응답을 서버에서 확보
    v1 = (await res.json()).data;
    heldResolve();
    await gate; // PATCH v2가 먼저 끝날 때까지 hold
    await route.fulfill({ status: res.status(), json: { ok: true, data: v1 } });
    delivered = true;
  });

  // 뒤로가기(내부 라우팅)로 카트 재진입 — App의 cached cart로 remount + mount GET
  await page.getByRole("button", { name: "뒤로가기" }).click();
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A"); // cached 표시
  await heldP; // mount GET이 잡혀 실제 v1을 확보했다
  expect(v1?.items?.[0]?.quantity).toBe(1);
  const v1Version = v1!.version;

  // GET이 hold된 동안 PATCH v2를 완료한다 — 서버 commit + UI 적용
  await page.getByRole("button", { name: /수량 증가/ }).click();
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("2");
  await expect(page.locator("#cart-quote-rows")).toContainText("상품 금액");
  await expect(page.locator("#cart-quote-rows")).toContainText("360,000원");
  await expect(page.locator("#cart-quote-rows")).toContainText("배송비");
  await expect(page.locator("#cart-quote-rows")).toContainText("3,000원");

  // 늦은 v1 응답을 푼다 — UI가 ×1로 되돌아가면 race 재현
  release();
  await expect.poll(() => delivered, { timeout: 5000 }).toBe(true); // 응답이 실제 전달됐다
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("2");
  await expect(page.locator("#cart-quote-rows")).toContainText("360,000원");
  await expect(page.locator("#cart-quote-rows")).toContainText("3,000원");
  await expect(page.locator("#cart-quote-rows")).not.toContainText("180,000원");
  await expect(page.locator(".cart-summary-total b")).toHaveText("363,000원");

  // backend와 UI가 같은 v2를 본다 — version은 PATCH 1회 bump
  const cr = await page.context().request.get("/api/cart");
  const cj = await cr.json();
  expect(cj.data.items[0].quantity).toBe(2);
  expect(cj.data.version).toBe(v1Version + 1);
  expect(cj.data.items_total_won).toBe(360000);
  expect(cj.data.shipping_fee_won).toBe(3000);
  expect(cj.data.total_won).toBe(363000);
  await page.unroute("**/api/cart");
  await emptyCart(page);
});

// 같은 레이스가 App 레벨에도 있다 — 로그인 직후 refreshCart의 첫 GET(빈 카트)이
// 상세의 실제 담기 성공(v2) 뒤에 도착해도 헤더 배지·카트를 0으로 되돌리면 안 된다.
test("app stale-read race: held login-time empty GET must not clear badge", async ({ page }) => {
  let held = false;
  let release!: () => void;
  let heldResolve!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const heldP = new Promise<void>((r) => { heldResolve = r; });
  let delivered = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let v1: any = null;
  await page.route("**/api/cart", async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const res = await route.fetch(); // 실제 빈 카트 v1
    v1 = (await res.json()).data;
    heldResolve();
    await gate;
    await route.fulfill({ status: res.status(), json: { ok: true, data: v1 } });
    delivered = true;
  });
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  await heldP; // App refreshCart의 첫 GET(빈 카트)을 잡았다
  expect(v1?.items).toHaveLength(0);

  // 내부 라우팅으로 상세 진입 → 실제 담기 성공 → 배지 1
  await page.evaluate(() => { location.hash = "#/p/p-a"; });
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await expect(page.getByText("장바구니에 담았어요")).toBeVisible();
  // 배지 DOM은 shop 헤더/float-nav·search에만 있다 — App 상태를 유지한 채
  // 내부 라우팅으로 홈에 가서 배지를 확인한다.
  await page.evaluate(() => { location.hash = "#/"; });
  await expect(page.locator(".cart-badge").first()).toHaveText("1");

  // 늦은 빈 카트 응답을 푼다 — 배지가 사라지면 race 재현
  release();
  await expect.poll(() => delivered, { timeout: 5000 }).toBe(true);
  await page.waitForTimeout(300); // 응답이 fetch에 도달해 React까지 처리될 시간
  await expect(page.locator(".cart-badge").first()).toHaveText("1");
  await page.unroute("**/api/cart");
  await page.evaluate(() => { location.hash = "#/cart"; });
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");
  await emptyCart(page);
});

// PMQA-05-MJ-CART-REFRESH-01 — 확정 거절(OUT_OF_STOCK 등)에서도 최신 CartView를
// 회수하는지 검증. 거절 PATCH·변경 GET 응답은 route 모킹(mocked)으로 주입한다 —
// 실제 commerce_test/commerce DB의 재고·active는 변경하지 않는다.
const rejectThenStaleGet = async (
  page: Page,
  counters: { patches: number; gets: number },
) => {
  await page.route("**/api/cart/items/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    counters.patches += 1;
    await route.fulfill({
      json: {
        ok: false,
        error: {
          code: "OUT_OF_STOCK",
          message: "재고가 부족합니다 (남은 수량 0)",
          action: "REFRESH_AND_RECONFIRM",
        },
      },
    });
  });
  await page.route("**/api/cart", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    counters.gets += 1;
    const res = await route.fetch();
    const j = await res.json();
    // mocked: 최신 CartView에서 품절 — 실제 계약 필드(availability/block_reason)
    j.data.items[0].availability = "SOLD_OUT";
    j.data.items[0].block_reason = "품절";
    j.data.items[0].purchasable = false;
    j.data.can_checkout = false;
    await route.fulfill({ json: j });
  });
};

test("확정 거절 → 최신 CartView 회수: 초기 쓰기 경로 (PATCH/GET route 모킹)", async ({ page }) => {
  await loginClean(page);
  // p-c 32인치 재고 2를 실제로 2개 담는다 — can_checkout=true 상태에서 시작
  await page.goto("/#/p/p-c");
  await page.locator(".option-open").click();
  await page.getByRole("dialog", { name: "옵션 한번에 보기" })
    .getByRole("button", { name: /32인치/ }).click();
  await page.locator(".qty-ctrl").getByRole("button", { name: "+" }).click();
  await page.getByRole("button", { name: "698,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();
  await expect(page.getByRole("button", { name: "주문하기" })).toBeEnabled();

  const counters = { patches: 0, gets: 0 };
  await rejectThenStaleGet(page, counters);
  await page.getByRole("button", { name: /수량 증가/ }).click();
  await expect(page.getByText(/변경 실패/)).toBeVisible();
  // PATCH 정확히 1회(자동 재시도 없음)·거절 뒤 GET 실제 발생
  expect(counters.patches).toBe(1);
  expect(counters.gets).toBeGreaterThanOrEqual(1);
  // 회수된 최신 CartView가 화면에 반영된다
  await expect(page.locator(".badge-soldout").first()).toBeVisible();
  await expect(page.getByText("품절 — 주문할 수 없어요")).toBeVisible();
  await expect(page.getByText("주문 불가 항목을 삭제해 주세요")).toBeVisible();
  await expect(page.getByRole("button", { name: "주문하기" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /수량 증가/ })).toBeDisabled();
  // 확정 거절 → pending 해제, 삭제는 가능
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "삭제" })).toBeEnabled();
  await page.unroute("**/api/cart/items/*");
  await page.unroute("**/api/cart");
  await emptyCart(page);
});

test("확정 거절 → 최신 CartView 회수: 명시 재시도 경로 동일 기준 (route 모킹)", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  // 수량 PATCH를 commit+drop → 미확정 intent 생성
  const drop = await dropWrite(page, "**/api/cart/items/*", "PATCH");
  await page.getByRole("button", { name: /수량 증가/ }).click();
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  await drop.done;
  await page.unroute("**/api/cart/items/*");

  const counters = { patches: 0, gets: 0 };
  await rejectThenStaleGet(page, counters);
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText(/변경 실패/)).toBeVisible();
  expect(counters.patches).toBe(1);
  expect(counters.gets).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".badge-soldout").first()).toBeVisible();
  await expect(page.getByText("품절 — 주문할 수 없어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "주문하기" })).toBeDisabled();
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await page.unroute("**/api/cart/items/*");
  await page.unroute("**/api/cart");
  // 서버 실제 상태(qty 2 commit분)도 정리한다
  await expect(page.getByRole("button", { name: "삭제" })).toBeEnabled();
  await emptyCart(page);
});

test("상세: overlay navigation, 평점 진입, 리뷰/상품정보 탭과 옵션 라벨", async ({ page }) => {
  await login(page);
  const diagnostics: string[] = [];
  const responseBodies: Promise<void>[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/products")) return;
    const status = response.status();
    responseBodies.push(response.text().then((text) => {
      let envelope: unknown;
      try {
        const body = JSON.parse(text);
        envelope = body.ok === true
          ? { ok: true, product: body.data?.product?.id ?? body.data?.items?.[0]?.product_id }
          : { ok: body.ok, error: body.error?.code };
      } catch {
        envelope = "invalid-json";
      }
      diagnostics.push("response " + url.pathname + url.search + " " + status + " " + JSON.stringify(envelope));
    }).catch((error) => {
      diagnostics.push("response-body " + String(error));
    }));
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/products"))
      diagnostics.push("requestfailed " + request.url() + " " + request.failure()?.errorText);
  });
  page.on("pageerror", (error) => diagnostics.push("pageerror " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push("console " + message.text());
  });
  await page.goto("/#/p/p-a");

  await expect(page.locator(".detail-nav")).toBeVisible();
  await expect(page.locator(".backbar")).toHaveCount(0);
  try {
    await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");
  } catch (error) {
    await Promise.all(responseBodies);
    throw new Error(String(error) + "\nDiagnostics:\n" + (diagnostics.join("\n") || "<none>"));
  }
  await expect(page.locator(".info-row").first()).toContainText("평점 · 리뷰");
  await expect(page.locator(".info-row").first()).toContainText("4개");

  await page.locator(".option-open").click();
  const optionSheet = page.getByRole("dialog", { name: "옵션 한번에 보기" });
  await expect(optionSheet.getByRole("button", { name: /27인치/ })).toBeDisabled();
  // 27인치 fixture 옵션은 품절이므로 선택되지 않고 구매 가능한 기본값 유지.
  await expect(page.locator(".option-open")).toContainText("24인치");
  await optionSheet.getByRole("button", { name: "닫기" }).click();

  await page.locator(".info-row").first().click();
  await expect(page.locator(".detail-tabs")).toBeVisible();
  await expect(page.locator(".review-provenance-note")).toContainText("실사용·시연 리뷰");
  await expect(page.getByRole("tab", { name: /리뷰 \(4개\)/ })).toBeVisible();
  await expect(page.locator(".review-item").first()).toBeVisible();
  const expectedReviewScroll = await page.evaluate(() => {
    const tabs = document.querySelector(".detail-tabs");
    if (!tabs) throw new Error("detail tabs missing after review jump");
    const requested = tabs.getBoundingClientRect().top + scrollY - 56;
    return Math.min(requested, document.documentElement.scrollHeight - innerHeight);
  });
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBe(Math.round(expectedReviewScroll));
  const reviewViewport = await page.evaluate(() => {
    const summary = document.querySelector(".review-summary-head");
    const firstReview = document.querySelector(".review-item");
    const footer = document.querySelector(".bottom-bar");
    if (!summary || !firstReview || !footer) return { found: false };
    const summaryRect = summary.getBoundingClientRect();
    const reviewRect = firstReview.getBoundingClientRect();
    const footerTop = footer.getBoundingClientRect().top;
    return {
      found: true,
      summary: { top: summaryRect.top, bottom: summaryRect.bottom },
      firstReview: { top: reviewRect.top, bottom: reviewRect.bottom },
      footerTop,
      bothAboveFooter:
        summaryRect.top >= 0 && summaryRect.bottom <= footerTop &&
        reviewRect.top >= 0 && reviewRect.bottom <= footerTop,
    };
  });
  expect(reviewViewport, JSON.stringify(reviewViewport)).toMatchObject({ found: true, bothAboveFooter: true });
  await expect(page.locator(".review-option").filter({ hasText: /v-a-\d+/ })).toHaveCount(0);

  await page.getByRole("tab", { name: "상품 정보", exact: true }).click();
  await expect(page.locator(".detail-info-panel")).toBeVisible();
  await expect(page.locator(".detail-info-panel")).toContainText("패널");
  await page.getByRole("tab", { name: /리뷰 \(4개\)/ }).click();
  await expect(page.locator(".review-list")).toBeVisible();
  await expect(page.locator(".review-provenance")).toContainText("모든 출처");
  await Promise.all(responseBodies);
});

  test("cart: 부분 선택은 선택 상품만 주문서로 보내고 선택삭제는 실제 선택만 지운다", async ({ page }) => {
  await loginClean(page);
  await addFixtureVariant(page, "p-a", "v-a-24");
  await addFixtureVariant(page, "p-b", "v-b-24");
  await page.goto("/#/cart");

  await expect(page.locator(".cart-tabs")).toBeVisible();
  await expect(page.getByRole("button", { name: /장바구니 2/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "내 주문", exact: true })).toBeVisible();
  const order = page.getByRole("button", { name: /2건 · .* 주문하기/ });
  await expect(order).toBeEnabled();

  const selectA = page.getByRole("checkbox", { name: "코드뷰 모니터 A 선택" });
  await selectA.uncheck();
  // 부분 선택은 주문을 막지 않는다 — 선택 상품만 견적 대상이다 [PMQA-067 CART_SELECTED].
  const order1 = page.getByRole("button", { name: /1건 · .* 주문하기/ });
  await expect(order1).toBeEnabled();
  await expect(page.locator(".cart-summary")).toContainText("선택 1건 결제 예상 금액");
  await order1.click();
  await page.waitForURL(/#\/checkout\?src=sel&items=/);
  const selIds = new URLSearchParams(page.url().split("?")[1] ?? "").get("items")!.split(",");
  expect(selIds).toHaveLength(1); // 선택한 B의 cart_item_id 하나만 전달된다
  await expect(page.getByText("일반 배송 상품 1건")).toBeVisible();
  await expect(page.locator(".checkout-item-info")).toHaveCount(1);
  await expect(page.locator(".checkout-item-info")).toContainText("코드뷰 모니터 B");

  // 주문하지 않고 돌아오면 두 항목이 그대로다 — 견적은 카트를 변경하지 않는다
  await page.goto("/#/cart");
  await expect(page.locator(".cart-name")).toHaveCount(2);

  // 0선택 안내로 고정 패널이 커진 상태에서도 마지막 카드의 수량 컨트롤에 도달할 수 있다
  await page.getByRole("checkbox", { name: "전체 선택" }).uncheck();
  await expect(page.getByText("주문할 상품을 선택해 주세요")).toBeVisible();
  await page.evaluate(async () => {
    scrollTo(0, document.documentElement.scrollHeight);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const partialCover = await page.evaluate(() => {
    const qtys = document.querySelectorAll(".cart-item .qty-ctrl");
    const last = qtys[qtys.length - 1];
    const bar = document.querySelector(".bottom-bar");
    if (!last || !bar) return { found: false };
    const r = last.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      found: true,
      aboveBar: r.bottom <= bar.getBoundingClientRect().top,
      inside: !!target && last.contains(target),
    };
  });
  expect(partialCover, JSON.stringify(partialCover)).toMatchObject({ found: true, aboveBar: true, inside: true });

  // B만 선택해 삭제 — 실제 선택 항목만 지워진다
  await page.getByRole("checkbox", { name: "코드뷰 모니터 B 선택" }).check();
  await page.getByRole("button", { name: "선택 항목 제거" }).click();
  await expect(page.locator(".cart-name")).toHaveCount(1);
  await expect(page.locator(".cart-name")).toContainText("코드뷰 모니터 A");
  await expect(page.getByRole("checkbox", { name: "코드뷰 모니터 A 선택" })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "전체 선택" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /0건 · .* 주문하기/ })).toBeDisabled();
  await page.getByRole("checkbox", { name: "코드뷰 모니터 A 선택" }).check();
  await expect(page.getByRole("checkbox", { name: "전체 선택" })).toBeChecked();
  await expect(page.getByRole("button", { name: /1건 · .* 주문하기/ })).toBeEnabled();
  await expect(page.locator(".cart-summary-total")).toContainText("선택 1건 결제 예상 금액");
  await emptyCart(page);
});

test("cart: 결제 예상 금액 패널 접기·펼치기 — 서버 금액 그대로, 카트 상태 불변", async ({ page }) => {
  await loginClean(page);
  await addFixtureVariant(page, "p-a", "v-a-24");
  await page.goto("/#/cart");

  const toggle = page.getByRole("button", { name: /결제 예상 금액 상세/ });
  const rows = page.locator("#cart-quote-rows");
  // Ref126 기본 노출: 펼침 상태에서 상품 금액·배송비가 서버값 그대로다
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(rows).toBeVisible();
  await expect(rows).toContainText("상품 금액");
  await expect(rows).toContainText("180,000원");
  await expect(rows).toContainText("배송비");
  await expect(rows).toContainText("3,000원");
  await expect(page.locator(".cart-summary-total b")).toHaveText("183,000원");
  await expect(page.locator(".cart-summary")).toContainText("선택 1건 결제 예상 금액");

  const readCart = () =>
    page.context().request.get("/api/cart").then((r) => r.json());
  const snapshot = (data: {
    version: number;
    items: { cart_item_id: string; variant_id: string; quantity: number; unit_price_won: number }[];
    items_total_won: number;
    shipping_fee_won: number;
    total_won: number;
  }) => ({
    version: data.version,
    items: data.items.map((i) => ({
      cart_item_id: i.cart_item_id,
      variant_id: i.variant_id,
      quantity: i.quantity,
      unit_price_won: i.unit_price_won,
    })),
    items_total_won: data.items_total_won,
    shipping_fee_won: data.shipping_fee_won,
    total_won: data.total_won,
  });
  const before = snapshot((await readCart()).data);

  // toggle 동작 중 카트 쓰기 요청이 없어야 한다 — 표시 상태 전용
  const cartWrites: string[] = [];
  const onWrite = (req: { url: () => string; method: () => string }) => {
    if (req.url().includes("/api/cart") && req.method() !== "GET")
      cartWrites.push(req.method() + " " + req.url());
  };
  page.on("request", onWrite);

  // 접기 — 헤더 총액·주문 CTA는 그대로, 상세 행만 사라진다
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toBeHidden();
  await expect(page.locator(".cart-summary-total b")).toHaveText("183,000원");
  await expect(page.getByRole("button", { name: /1건 · .* 주문하기/ })).toBeEnabled();

  // 다시 펼치기 — 확장 패널이 반영된 뒤 도달성을 측정한다
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(rows).toBeVisible();
  page.off("request", onWrite);
  expect(cartWrites, JSON.stringify(cartWrites)).toEqual([]);

  // render/ResizeObserver/스크롤 반영을 기다린 뒤 확장 패널 아래에서도
  // 마지막 카드의 수량 컨트롤·패널 토글·주문 CTA가 실제 도달·클릭 가능한지 검증
  const assertReachable = async (label: string) => {
    await page.evaluate(async () => {
      scrollTo(0, document.documentElement.scrollHeight);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const cover = await page.evaluate(() => {
      const hit = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const target = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return {
          top: r.top,
          bottom: r.bottom,
          inside: !!target && el.contains(target),
        };
      };
      const qtys = document.querySelectorAll(".cart-item .qty-ctrl");
      return {
        barTop: document.querySelector(".bottom-bar")?.getBoundingClientRect().top ?? null,
        scrollY,
        maxScroll: document.documentElement.scrollHeight - innerHeight,
        qty: hit(qtys[qtys.length - 1] ?? null),
        toggle: hit(document.querySelector(".cart-quote-toggle")),
        cta: hit(document.querySelector(".cart-checkout-action .btn")),
      };
    });
    expect(cover, label + " " + JSON.stringify(cover)).toMatchObject({
      qty: { inside: true },
      toggle: { inside: true },
      cta: { inside: true },
    });
    return cover;
  };

  await assertReachable("390x844 expanded");

  // 낮은 viewport에서도 확장 패널 아래 동일한 도달성
  await page.setViewportSize({ width: 390, height: 600 });
  await assertReachable("390x600 expanded");
  await page.setViewportSize({ width: 390, height: 844 });

  // toggle은 표시 상태만 바꾼다 — 서버 카트 version·items·합계·선택 모두 불변
  const after = snapshot((await readCart()).data);
  expect(after, JSON.stringify({ before, after })).toEqual(before);
  await expect(page.getByRole("checkbox", { name: "코드뷰 모니터 A 선택" })).toBeChecked();
  await emptyCart(page);
});

test("상세 평점: 목록 API 실패와 미매칭은 0개 리뷰로 표시하지 않는다", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/products*", async (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() !== "GET" || u.pathname !== "/api/products" || !u.searchParams.has("limit"))
      return route.continue();
    if (u.searchParams.get("limit") === "50")
      return route.fulfill({ json: { ok: false, error: { code: "TEMPORARY", message: "잠시 후 다시 시도해 주세요" } } });
    return route.continue();
  });
  await page.goto("/#/p/p-a");
  const ratingRow = page.locator(".info-row").first();
  await expect(ratingRow).toContainText("평점 정보를 불러오지 못했어요");
  await expect(ratingRow).not.toContainText("아직 리뷰가 없어요");
  await page.unroute("**/api/products*");

  await page.route("**/api/products*", async (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === "GET" && u.pathname === "/api/products" && u.searchParams.get("limit") === "50")
      return route.fulfill({ json: { ok: true, data: { items: [], shipping_fee_won: 3000, next_cursor: null, has_more: false } } });
    return route.continue();
  });
  await page.reload();
  await expect(ratingRow).toContainText("상품 평점을 확인할 수 없어요");
  await expect(ratingRow).not.toContainText("아직 리뷰가 없어요");
});

test("상세 평점: 전체 리뷰 수와 서버 요약이 다르면 평균을 숨긴다", async ({ page }) => {
  await loginClean(page);
  await page.route("**/api/products*", async (route) => {
    const u = new URL(route.request().url());
    if (route.request().method() === "GET" && u.pathname === "/api/products" && u.searchParams.get("limit") === "50") {
      return route.fulfill({ json: { ok: true, data: { items: [{ product_id: "p-a", name: "코드뷰 모니터 A", brand: "코드뷰", category: "monitor", image: null, matched_variants: [], rating_summary: { avg: 4.5, count: 3 }, availability: "AVAILABLE" }], shipping_fee_won: 3000, next_cursor: null, has_more: false } } });
    }
    return route.continue();
  });
  await page.goto("/#/p/p-a");
  const ratingRow = page.locator(".info-row").first();
  await expect(ratingRow).toContainText("리뷰 4개 · 평점 집계 확인 중");
  await expect(ratingRow).not.toContainText("4.5");
});

test("cart: 선택 삭제는 서버의 최신 cart version을 순서대로 사용한다", async ({ page }) => {
  await loginClean(page);
  await addFixtureVariant(page, "p-a", "v-a-24");
  await addFixtureVariant(page, "p-b", "v-b-24");
  const beforeResponse = await page.context().request.get("/api/cart");
  const before = await beforeResponse.json();
  await page.goto("/#/cart");

  const versions: number[] = [];
  await page.route("**/api/cart/items/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    versions.push(route.request().postDataJSON().expected_cart_version);
    return route.continue();
  });
  await page.getByRole("button", { name: "선택 항목 제거" }).click();
  await expect(page.getByText("장바구니가 비었어요")).toBeVisible();
  expect(versions).toEqual([before.data.version, before.data.version + 1]);
});

test("cart: 첫 선택 삭제 응답 유실은 다음 DELETE를 막고 복구 후 선택을 보존한다", async ({ page }) => {
  await loginClean(page, "e2e-b");
  await addFixtureVariant(page, "p-a", "v-a-24");
  await addFixtureVariant(page, "p-b", "v-b-24");
  await addFixtureVariant(page, "p-c", "v-c-27");
  await page.goto("/#/cart");

  await expect(page.locator(".cart-name")).toHaveCount(3);
  const names = await page.locator(".cart-name").allTextContents();
  expect(names).toHaveLength(3);
  const uncheckedName = names[2];
  await page.getByRole("checkbox", { name: uncheckedName + " 선택" }).uncheck();
  const beforeResponse = await page.context().request.get("/api/cart");
  const before = await beforeResponse.json();
  const selectedItems = before.data.items.filter(
    (item: { product_name: string }) => item.product_name !== uncheckedName,
  );
  expect(selectedItems).toHaveLength(2);
  const firstId = selectedItems[0].cart_item_id as string;
  const secondId = selectedItems[1].cart_item_id as string;
  const uncheckedItem = before.data.items.find(
    (item: { product_name: string }) => item.product_name === uncheckedName,
  );

  const deletes: string[] = [];
  const drop = await dropWrite(page, "**/api/cart/items/*", "DELETE", (req) => {
    deletes.push(new URL(req.url()).pathname.split("/").at(-1)!);
  });
  await page.getByRole("button", { name: "선택 항목 제거" }).click();
  await drop.done;
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toBeVisible();
  expect(deletes).toEqual([firstId]);

  await expect(page.getByRole("checkbox", { name: "전체 선택" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: names[0] + " 선택" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "선택 항목 제거" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "삭제" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: /수량 증가/ }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: /3건 · .* 주문하기/ })).toBeDisabled();

  const serverCartResponse = await page.context().request.get("/api/cart");
  const serverCart = await serverCartResponse.json();
  expect(serverCart.data.items.map((item: { cart_item_id: string }) => item.cart_item_id))
    .toEqual(expect.arrayContaining([secondId, uncheckedItem.cart_item_id]));
  expect(serverCart.data.items.map((item: { cart_item_id: string }) => item.cart_item_id))
    .not.toContain(firstId);

  await page.getByRole("button", { name: "결과 확인" }).click();
  await expect(page.locator(".cart-name")).toHaveCount(2);
  expect(deletes).toEqual([firstId]);
  await expect(page.getByRole("checkbox", { name: selectedItems[1].product_name + " 선택" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: uncheckedName + " 선택" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /2건 · .* 주문하기/ })).toBeDisabled();
  await page.unroute("**/api/cart/items/*");
  await emptyCart(page);
});

test("cart: 첫 선택 삭제의 확정 거절은 다음 DELETE를 보내지 않고 선택을 보존한다", async ({ page }) => {
  await loginClean(page, "e2e-c");
  await addFixtureVariant(page, "p-a", "v-a-24");
  await addFixtureVariant(page, "p-b", "v-b-24");
  await addFixtureVariant(page, "p-c", "v-c-27");
  await page.goto("/#/cart");

  await expect(page.locator(".cart-name")).toHaveCount(3);
  const names = await page.locator(".cart-name").allTextContents();
  await page.getByRole("checkbox", { name: names[2] + " 선택" }).uncheck();
  let deletes = 0;
  await page.route("**/api/cart/items/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes += 1;
    return route.fulfill({
      status: 409,
      json: { ok: false, error: { code: "VERSION_CONFLICT", message: "카트가 변경됐어요" } },
    });
  });

  await page.getByRole("button", { name: "선택 항목 제거" }).click();
  await expect(page.getByText("카트가 변경되었어요. 최신 상태로 다시 불러왔습니다.")).toBeVisible();
  expect(deletes).toBe(1);
  await expect(page.locator(".cart-name")).toHaveCount(3);
  await expect(page.getByRole("checkbox", { name: names[0] + " 선택" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: names[1] + " 선택" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: names[2] + " 선택" })).not.toBeChecked();
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await page.unroute("**/api/cart/items/*");
  await emptyCart(page);
});

test("cart: replay 후 최신 GET 실패 시 과거 cart snapshot으로 다음 삭제를 진행하지 않는다", async ({ page }) => {
  await loginClean(page, "e2e-d");
  await addFixtureVariant(page, "p-a", "v-a-24");
  await addFixtureVariant(page, "p-b", "v-b-24");
  const snapshotResponse = await page.context().request.get("/api/cart");
  const snapshot = await snapshotResponse.json();

  let cartGets = 0;
  let deletes = 0;
  await page.route("**/api/cart", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    cartGets += 1;
    return cartGets === 1 ? route.continue() : route.abort();
  });
  await page.route("**/api/cart/items/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes += 1;
    return route.fulfill({
      status: 200,
      json: { ok: true, data: { cart: snapshot.data }, replayed: true },
    });
  });

  await page.goto("/#/cart");
  await expect(page.locator(".cart-name")).toHaveCount(2);
  await page.getByRole("button", { name: "선택 항목 제거" }).click();
  await expect(page.getByText("이미 처리된 요청이지만 최신 장바구니를 불러오지 못했어요.")).toBeVisible();
  expect(deletes).toBe(1);
  expect(cartGets).toBe(2);
  await expect(page.getByText("카트를 불러오지 못했어요")).toBeVisible();

  await page.unroute("**/api/cart");
  await page.unroute("**/api/cart/items/*");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.locator(".cart-name")).toHaveCount(2);
  await expect(page.getByRole("checkbox", { name: "전체 선택" })).toBeChecked();
  await emptyCart(page);
});

test("상품 상세: dark/light 초기·탭 겹침·sticky 상태에서 CTA가 위에 남고 실제 장바구니에 반영된다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "e2e-d");
  const readCart = async () => {
    const response = await page.context().request.get("/api/cart");
    const json = await response.json();
    if (!json.ok) throw new Error("cart read failed: " + JSON.stringify(json));
    return json.data;
  };
  const initialCart = await readCart();
  expect(initialCart.items).toHaveLength(0);
  const initialIds = new Set<string>(initialCart.items.map((i: { cart_item_id: string }) => i.cart_item_id));

  const removeOnlyNewRows = async () => {
    for (;;) {
      const latest = await readCart();
      const created = latest.items.find((i: { cart_item_id: string }) => !initialIds.has(i.cart_item_id));
      if (!created) return latest;
      const removed = await page.context().request.delete("/api/cart/items/" + created.cart_item_id, {
        data: { expected_cart_version: latest.version, idempotency_key: crypto.randomUUID() },
      });
      const json = await removed.json();
      if (!json.ok) throw new Error("created cart row cleanup failed: " + JSON.stringify(json));
    }
  };
  const assertFooterHit = async () => {
    const geometry = await page.evaluate(() => {
      const footer = document.querySelector(".bottom-bar");
      if (!footer) return { found: false };
      const buttons = Array.from(footer.querySelectorAll<HTMLButtonElement>(".detail-actions > button"));
      const points = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const hitAt = (y: number) => {
          const hit = document.elementFromPoint(x, y);
          return { inside: !!hit && button.contains(hit), tag: hit?.tagName ?? null };
        };
        return {
          label: button.getAttribute("aria-label") || button.textContent?.trim() || "unlabeled",
          inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
          center: hitAt(rect.top + rect.height / 2),
          lower: hitAt(rect.bottom - 8),
        };
      });
      return {
        found: true,
        buttonCount: buttons.length,
        allInViewport: buttons.length === 3 && points.every((p) => p.inViewport),
        allHitTargets: buttons.length === 3 && points.every((p) => p.center.inside && p.lower.inside),
        points,
      };
    });
    expect(geometry, JSON.stringify(geometry)).toMatchObject({
      found: true, buttonCount: 3, allInViewport: true, allHitTargets: true,
    });
    return geometry;
  };

  try {
    for (const theme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/#/p/p-a");
      await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await assertFooterHit();

      const overlap = await page.evaluate(async () => {
        const tabs = document.querySelector(".detail-tabs");
        const footer = document.querySelector(".bottom-bar");
        const cta = footer?.querySelector(".detail-actions .btn.primary");
        if (!tabs || !footer || !cta) return { found: false };
        const tabDocumentTop = tabs.getBoundingClientRect().top + scrollY;
        const footerTop = footer.getBoundingClientRect().top;
        scrollTo(0, Math.max(0, tabDocumentTop - footerTop - 4));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const tabRect = tabs.getBoundingClientRect();
        const ctaRect = cta.getBoundingClientRect();
        return {
          found: true,
          tabTop: tabRect.top,
          footerTop: footer.getBoundingClientRect().top,
          overlap: tabRect.top < ctaRect.bottom && tabRect.bottom > ctaRect.top,
        };
      });
      expect(overlap, JSON.stringify(overlap)).toMatchObject({ found: true, overlap: true });
      await assertFooterHit();

      // 844px 실제 초깃값과 탭 겹침은 위에서 검증했다. 이 fixture의 실제 길이로는
      // 844px에서 sticky top에 도달할 수 없어, 콘텐츠를 바꾸지 않고 높이 600px에서
      // 실제 sticky 구간을 별도로 검증한다.
      await page.setViewportSize({ width: 390, height: 600 });
      await page.evaluate(() => {
        const tabs = document.querySelector(".detail-tabs");
        if (tabs) scrollTo(0, tabs.getBoundingClientRect().top + scrollY - 48);
      });
      await expect.poll(() => page.locator(".detail-tabs").evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBe(48);
      await assertFooterHit();

      // 옵션 진입은 하단 바의 별도 CTA가 아니라 본문의 .optline 행이다 [PMQA-067 하단 바 Ref04 구조].
      await page.locator(".option-open").click();
      const sheet = page.locator(".sheet-overlay");
      await expect(sheet).toBeVisible();
      const sheetAboveFooter = await page.evaluate(() => {
        const overlay = document.querySelector(".sheet-overlay");
        const cta = document.querySelector(".bottom-bar .detail-actions .btn.primary");
        if (!overlay || !cta) return false;
        const rect = cta.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!hit && overlay.contains(hit);
      });
      expect(sheetAboveFooter).toBe(true);
      await sheet.getByRole("button", { name: "닫기" }).click();
      await expect(sheet).toHaveCount(0);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await assertFooterHit();

      await page.getByRole("button", { name: "180,000원 담기" }).click();
      await expect(page.getByRole("button", { name: "장바구니 보기" })).toBeVisible();
      const cart = await readCart();
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0]).toMatchObject({ product_id: "p-a", variant_id: "v-a-24", quantity: 1, unit_price_won: 180000 });
      expect(cart.total_won).toBe(183000);
      const cleaned = await removeOnlyNewRows();
      expect(cleaned.items.map((i: { cart_item_id: string }) => i.cart_item_id)).toEqual([...initialIds]);
    }
  } finally {
    await removeOnlyNewRows();
  }
});
