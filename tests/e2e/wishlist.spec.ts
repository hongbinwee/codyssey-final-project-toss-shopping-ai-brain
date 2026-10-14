// PMQA-077-A — 서버 찜(Wishlist) UI 동기화 E2E.
// ⚠ SOURCE-ONLY — 실행 금지. checkout-c.spec.ts와 같은 게이트:
// playwright.config.ts는 'not-ready'로 사전 거부되며, 실행은 별도 승인된
// launcher/config 경로가 열린 뒤에만 가능하다 [PMQA-077-A 위임].
// helpers/testdb·playwright.config.ts는 commerce_test로 고정돼 있다 — 보호
// DB에 대한 migration 004 적용·spec 실행은 미승인이며, 본 spec의 실제 실행은
// 격리(owned scratch) DB 연결 보완 승인 + 별도 실행 승인 후에만 가능하다.
//
// 저장소 구분 주의 — '찜'은 서버 wishlist_items의 기록이고 '최근 본 상품'은
// localStorage의 별개 저장소다. 이 spec은 서버 찜만 검증하고 두 저장소 간
// 동기화를 주장하지 않는다.
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const WISH_TAB = "/#/recent?tab=wish";

// 찜 토글은 스토어가 'ready'가 아니면 저장하지 않고 목록 재조회만 한다 —
// 첫 클릭 전에 GET /api/wishlist 완료를 기다려야 저장이 결정적이다
// (src/web/wishlist.ts useWishToggle의 !ready 분기).
const wishlistGet = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes("/api/wishlist") &&
      r.request().method() === "GET" &&
      r.ok(),
  );

async function login(page: Page, code: string) {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill(code);
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

// 이전 실행의 서버 찜 행을 전부 해제한다 — restricted reset은
// wishlist_items를 정리하지 않으므로 spec이 스스로 선행 상태를 비운다.
async function clearWishApi(page: Page) {
  const j = await (await page.context().request.get("/api/wishlist")).json();
  for (const it of (j.data?.items ?? []) as { product_id: string }[]) {
    const d = await page.context().request.put(
      "/api/wishlist/" + encodeURIComponent(it.product_id),
      {
        data: { saved: false, idempotency_key: crypto.randomUUID() },
      },
    );
    if (!(await d.json()).ok)
      throw new Error("clearWishApi 실패: " + it.product_id);
  }
}

async function loginCleanWish(page: Page, code: string) {
  await login(page, code);
  await clearWishApi(page);
  // 미해결 intent 흔적도 비운다 — 서버 행과 별개로 localStorage 버킷이 남을 수 있다.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith("pending-writes-v1:")) localStorage.removeItem(k);
  });
  // 로그인 홈 마운트가 이미 스토어를 채웠을 수 있다 — reload로 모듈 스토어를
  // 초기화하고 깨끗한 서버 목록으로 재적재한다. 이후 내비게이션은 스토어가
  // 'ready'라 재조회가 없으므로 토글 클릭이 결정적으로 저장된다.
  const w = wishlistGet(page);
  await page.reload();
  await w;
}

// 앱에 logout UI는 없다 — 기존 session API 계약(DELETE → 쿠키 Max-Age=0)으로
// 같은 context의 actor를 교체한다. login()의 goto("/")가 새 문서를 로드해
// 로그인 폼으로 돌아간다 [PMQA-077-A — 별도 logout 기능/Backend 추가 금지].
const logout = (page: Page) => page.context().request.delete("/api/session");

// 같은 브라우저(같은 context) 안에서 actor만 교체한다. 서로 다른 context는
// 이 회귀를 검증하지 못한다 — 세션 쿠키·localStorage를 공유한 채 계정이
// 바뀌는 경로가 요구 조건이다. pending 버킷은 건드리지 않는다 — 이전 계정의
// 미해결 intent 격리가 검증 대상이다.
async function switchUser(page: Page, code: string) {
  const r = await logout(page);
  if (!r.ok()) throw new Error("로그아웃 실패: " + r.status());
  await login(page, code);
  // 로그인 홈 마운트에서 채워진 스토어를 신뢰하지 않고, 서버 GET 완료를 기준으로
  // 새 actor의 찜 동기화를 기다린다 [PM 지시 — login 직후 동기화는 서버
  // wishlist GET 기준].
  const w = wishlistGet(page);
  await page.reload();
  await w;
}

test("저장 → 상세·홈 카드·찜 탭 동기화 → 새로고침 유지 → 해제 시 전부 해제", async ({ page }) => {
  await loginCleanWish(page, "e2e-a");

  // 상세 하단 하트로 저장 — 서버 확정 후 Ref06 시트가 열린다
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "코드뷰 모니터 A 찜하기" }).click();
  await expect(page.getByText("찜 목록에 추가했어요")).toBeVisible();
  await page.getByRole("button", { name: "닫기" }).click();
  await expect(page.getByRole("button", { name: "코드뷰 모니터 A 찜 해제" })).toBeVisible();

  // 홈 카드 하트도 같은 서버 확정 상태를 반영한다
  // (홈 그리드는 카탈로그 전체를 WishProductCard로 렌더한다)
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: "코드뷰 모니터 A 찜 해제" })).toBeVisible();

  // 찜 탭 — 서버 목록의 표시 정보(name/image)로 렌더된다
  await page.goto(WISH_TAB);
  const item = page.locator(".wish-item", { hasText: "코드뷰 모니터 A" });
  await expect(item).toBeVisible();
  await expect(item.locator(".product-name")).toContainText("코드뷰 모니터 A");

  // 새로고침 — 서버 기록이 유지된다(로컬 저장소 상태가 아님)
  await page.reload();
  await expect(page.locator(".wish-item", { hasText: "코드뷰 모니터 A" })).toBeVisible();

  // 목록의 X로 해제 — 모든 표면이 꺼진다
  await page.getByRole("button", { name: "코드뷰 모니터 A 찜 해제" }).click();
  await expect(page.getByText("찜한 상품이 없어요")).toBeVisible();
  await page.goto("/#/p/p-a");
  await expect(page.getByRole("button", { name: "코드뷰 모니터 A 찜하기" })).toBeVisible();
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: "코드뷰 모니터 A 찜하기" })).toBeVisible();
});

test("같은 브라우저 계정 전환 — B에 A의 찜/pending 미노출, A 복귀 시 서버 기록 유지", async ({ page }) => {
  // 독립 context 모델만으로는 같은 브라우저 계정 교체를 커버한 것으로 기록하지
  // 않는다 — 이 spec은 하나의 page/context 안에서 session API로 A→B→A를
  // 전환해 localStorage 버킷 격리와 서버 기록 보존을 검증한다.
  await loginCleanWish(page, "e2e-b"); // B의 기존 서버 찜을 비워 빈 목록 확정
  expect((await logout(page)).ok()).toBe(true);
  await loginCleanWish(page, "e2e-a"); // A도 깨끗한 상태로

  // A: p-a 저장 — 서버 확정
  await page.goto("/#/p/p-a");
  await page.getByRole("button", { name: "코드뷰 모니터 A 찜하기" }).click();
  await expect(page.getByText("찜 목록에 추가했어요")).toBeVisible();
  await page.getByRole("button", { name: "닫기" }).click();

  // A 버킷에 미확정 SET_WISHLIST intent를 심는다 — 실제 생산자 계약을 정확히
  // 따른다(src/web/wishlist.ts: putPending은 uiKey=key·payload=
  // {product_id,saved,idempotency_key:key}이고, wishPendingError는
  // payload.idempotency_key===uiKey·path/product_id 일치를 요구한다).
  // 카트 계열의 'ui-' 접두 lookup 관례와는 별개 계약이다.
  // 주의: 이 fixture가 유효하다는 근거는 UI 노출이 아니라 위 계약 일치다.
  await page.evaluate(() => {
    localStorage.setItem(
      "pending-writes-v1:u-a",
      JSON.stringify([
        {
          uiKey: "077a-wish-pending-a",
          kind: "SET_WISHLIST",
          path: "/api/wishlist/p-b",
          method: "PUT",
          payload: { product_id: "p-b", saved: true, idempotency_key: "077a-wish-pending-a" },
          label: "p-b",
          at: Date.now(),
        },
      ]),
    );
  });
  // A 세션의 찜 탭에서 복구 표면이 렌더되는지 확인(렌더 노출 확인일 뿐
  // fixture 유효성 증명은 위 계약 일치에 있다)
  await page.goto(WISH_TAB);
  await expect(page.getByText("찜 요청 결과를 확인하지 못했어요")).toBeVisible();

  // 같은 context에서 B로 전환 — 쿠키 교체 + 새 문서 로드로 스토어·스코프 리셋
  await switchUser(page, "e2e-b");

  // B의 찜 탭: A의 서버 기록이 보이지 않는다
  await page.goto(WISH_TAB);
  await expect(page.getByText("찜한 상품이 없어요")).toBeVisible();
  await expect(
    page.locator(".wish-item", { hasText: "코드뷰 모니터 A" }),
  ).toHaveCount(0);
  // A 버킷의 미해결 intent도 B 스코프에는 노출되지 않는다
  await expect(page.getByText("찜 요청 결과를 확인하지 못했어요")).toHaveCount(0);
  // 같은 상품의 하트도 B에게는 미저장 상태다
  await page.goto("/#/p/p-a");
  await expect(
    page.getByRole("button", { name: "코드뷰 모니터 A 찜하기" }),
  ).toBeVisible();

  // A로 복귀 — 서버 기록은 그대로고, A 버킷의 intent도 다시 노출된다
  await switchUser(page, "e2e-a");
  await page.goto(WISH_TAB);
  await expect(
    page.locator(".wish-item", { hasText: "코드뷰 모니터 A" }),
  ).toBeVisible();
  await expect(page.getByText("찜 요청 결과를 확인하지 못했어요")).toBeVisible();

  // 정리 — 실패를 삼키지 않는다(catch(()=>{}) 금지). 격리 run에서는 일반
  // 실패로 기록된다. 어느 세션에서 실패했든 A 세션으로 복귀해 A가 남긴
  // 상태만 정리한다.
  const s = await page.context().request.post("/api/session", {
    data: { code: "e2e-a" },
  });
  if (!s.ok()) throw new Error("정리용 세션 복구 실패: " + s.status());
  const d = await page.context().request.put("/api/wishlist/p-a", {
    data: { saved: false, idempotency_key: crypto.randomUUID() },
  });
  const dj = await d.json();
  if (!dj.ok) throw new Error("정리용 찜 해제 실패: " + JSON.stringify(dj));
  await page.evaluate(() => localStorage.removeItem("pending-writes-v1:u-a"));
});
