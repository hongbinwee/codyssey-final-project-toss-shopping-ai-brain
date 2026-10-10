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
      if (!res.ok()) throw new Error("interceptWrite: 서버 응답 " + res.status());
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

test("detail: default option → sheet → qty → add → cart ops → empty", async ({ page }) => {
  await loginClean(page);
  await page.goto("/#/p/p-a");

  // 구매 가능한 기본 옵션(v-a-24 24인치)이 자동 선택돼 있다
  await expect(page.locator(".option-open")).toContainText("24인치");

  // 옵션 변경은 BottomSheet — 품절 옵션(v-a-27)은 비활성
  await page.locator(".option-open").click();
  const sheet = page.getByRole("dialog", { name: "옵션 선택" });
  await expect(sheet).toBeVisible();
  const soldout = sheet.locator("button.sort-item", { hasText: "27인치" });
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
  await expect(page.getByText("× 2")).toBeVisible();

  // 수량 감소 → 1 → 삭제 → 빈 상태
  await page.getByRole("button", { name: /수량 감소/ }).click();
  await expect(page.getByText("× 1")).toBeVisible();
  await page.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("장바구니가 비어 있어요")).toBeVisible();
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
    route.fulfill({ json: { ok: true, data: { reviews: [], total_matching: 0, returned_count: 0, next_cursor: null, has_more: false } } }));
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
  await expect(page.getByText("× 1")).toBeVisible();
  await expect(page.getByText("상품 180,000원 + 배송비 3,000원")).toBeVisible();
  await expect(page.locator(".bottom-bar b")).toHaveText("183,000원");
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
  await expect(page.getByText("× 1")).toBeVisible();
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
  await expect(page.getByText("× 2")).toBeVisible();

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
  await expect(page.getByText("장바구니가 비어 있어요")).toBeVisible();
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
      idempotency_key: "e2e-followup-1",
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
  await page.getByRole("dialog", { name: "옵션 선택" })
    .getByRole("button", { name: /32인치/ }).click();
  await page.locator(".qty-ctrl").getByRole("button", { name: "+" }).click();
  await page.getByRole("button", { name: "698,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  await page.getByRole("button", { name: /수량 증가/ }).click();
  await expect(page.getByText(/변경 실패/)).toBeVisible();
  // 확정 거절 → intent 해제됐으므로 pending 박스가 없고 수량도 2 유지
  await expect(page.getByText("결과를 확인하지 못한 요청이 있어요")).toHaveCount(0);
  await expect(page.getByText("× 2")).toBeVisible();
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
      idempotency_key: "e2e-conflict-1",
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
  await expect(page.getByText("장바구니가 비어 있어요")).toBeVisible();
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
  await expect(page.getByText("× 2")).toBeVisible();
  await expect(page.getByText("상품 360,000원 + 배송비 3,000원")).toBeVisible();

  // 늦은 v1 응답을 푼다 — UI가 ×1로 되돌아가면 race 재현
  release();
  await expect.poll(() => delivered, { timeout: 5000 }).toBe(true); // 응답이 실제 전달됐다
  await expect(page.getByText("× 2")).toBeVisible();
  await expect(page.getByText("상품 360,000원 + 배송비 3,000원")).toBeVisible();
  await expect(page.getByText("상품 180,000원 + 배송비 3,000원")).toHaveCount(0);
  await expect(page.getByText("363,000원").first()).toBeVisible();

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
  await page.getByRole("dialog", { name: "옵션 선택" })
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
