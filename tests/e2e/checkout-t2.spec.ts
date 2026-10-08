// Phase 3 E2E: 장바구니 → 주문서 → 모의 결제 → 주문 상세(PREPARING) → CS 설명.
// 병렬 실행에서 상태가 섞이지 않도록 이 스펙은 전용 사용자 u-c(e2e-c)를 쓴다.
import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-c");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

test("checkout: cart -> quote -> mock pay -> order detail PREPARING", async ({
  page,
}) => {
  await login(page);

  // 모니터 B 24인치 149,000원 + 배송비 3,000 = 152,000
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await page.getByText("코드뷰 모니터 B").first().click();
  await page.getByRole("button", { name: /24인치.*149,000원/ }).click();
  await page.getByRole("button", { name: "장바구니 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  // W03 -> W04
  await page.getByRole("button", { name: /주문하기/ }).click();
  await expect(page.getByRole("heading", { name: "주문서" })).toBeVisible();
  await expect(page.getByText("배송지 (테스트)")).toBeVisible();
  await expect(page.getByText("모의 결제 — 실제 결제는 발생하지 않아요")).toBeVisible();

  await page.getByRole("button", { name: "152,000원 결제하기" }).click();

  // W04 완료 -> W06 주문 상세. 병렬 실행 시 서버 응답이 느려질 수 있어 넉넉하게 기다린다.
  await expect(page.getByRole("heading", { name: "주문 상세" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("모의 결제 152,000원")).toBeVisible();
  await expect(page.getByText("배송 준비 중").first()).toBeVisible();

  // W05 목록에서도 같은 주문이 보인다
  await page.getByRole("button", { name: "목록" }).click();
  await expect(page.getByText("코드뷰 모니터 B")).toBeVisible();
  await expect(page.locator(".badge", { hasText: "배송 준비 중" })).toBeVisible();
});

test("cs panel: created order -> shipping status explanation (stub)", async ({
  page,
}) => {
  await login(page);
  await page.locator(".bottom-nav").getByRole("button", { name: "내 주문" }).click();
  // 이전 테스트가 만든 주문을 연다
  await page.getByText("코드뷰 모니터 B").first().click();
  await expect(page.getByRole("heading", { name: "주문 상세" })).toBeVisible();

  await page.getByRole("button", { name: "AI에게 이 주문 물어보기" }).click();
  await expect(page.getByText("AI 고객센터")).toBeVisible();
  await page.getByPlaceholder("조건이나 요청을 입력하세요").fill("내 주문 배송 상태 알려줘");
  await page.getByRole("button", { name: "보내기" }).click();
  // stub CS: list_orders -> get_shipping_status -> 실제 상태 요약
  await expect(page.getByText(/배송 준비 중/).last()).toBeVisible({ timeout: 15000 });
});
