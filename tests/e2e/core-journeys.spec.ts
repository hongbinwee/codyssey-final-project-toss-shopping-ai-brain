// Phase 5 E2E: 기존 스펙이 덮지 않는 필수 상태를 모은다.
// 검색 없음·옵션 품절·배송 정보 없음·배송 완료 주문 취소 불가·CS의 NO_INFORMATION 설명.
// 전부 읽기 위주라 재고/카트 경합이 없어 전용 사용자 없이 e2e-a/u-a, e2e-b/u-b를 쓴다.
// (checkout/cancel/비교 카드 경로는 기존 스펙이 이미 검증한다 — 여기서는 상태 커버리지만 채운다.)
import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page, code: string) {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill(code);
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

test("empty search result state", async ({ page }) => {
  await login(page, "e2e-a");
  await page.getByPlaceholder("상품 검색").fill("냉장고");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await expect(page.getByText("조건에 맞는 상품이 없어요")).toBeVisible();
});

test("soldout option is disabled on product detail", async ({ page }) => {
  await login(page, "e2e-a");
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await page.getByText("코드뷰 모니터 A").first().click();
  // v-a-27(27인치)은 stock 0 — 버튼이 비활성이고 품절 배지가 붙는다
  const soldout = page.locator("button.option-btn", { hasText: "품절" });
  await expect(soldout).toBeVisible();
  await expect(soldout).toBeDisabled();
  await expect(soldout).toContainText("27인치");
});

test("order without shipment shows NO_INFORMATION on W06", async ({ page }) => {
  await login(page, "e2e-b");
  await page.locator(".bottom-nav").getByRole("button", { name: "내 주문" }).click();
  await page.getByText("코드뷰 모니터 B").first().click(); // ord-b-none (shipment 없음)
  await expect(page.getByRole("heading", { name: "주문 상세" })).toBeVisible();
  await expect(page.getByText("배송 정보가 아직 등록되지 않았어요")).toBeVisible();
});

test("delivered order is cancel-ineligible in A02", async ({ page }) => {
  await login(page, "e2e-a");
  await page.locator(".bottom-nav").getByRole("button", { name: "내 주문" }).click();
  await page.getByText("코드뷰 모니터 C").first().click(); // ord-a-done (DELIVERED)
  await expect(page.getByRole("heading", { name: "주문 상세" })).toBeVisible();
  await page.getByRole("button", { name: "주문 취소" }).click();
  await expect(page.getByText("지금은 이 주문을 취소할 수 없어요")).toBeVisible();
  await expect(page.getByText("이미 출고된 주문은 취소할 수 없어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "이 주문 취소 요청" })).toHaveCount(0);
});

test("cs panel explains NO_INFORMATION order (stub)", async ({ page }) => {
  await login(page, "e2e-b");
  await page.locator(".bottom-nav").getByRole("button", { name: "내 주문" }).click();
  await page.getByText("코드뷰 모니터 B").first().click();
  await page.getByRole("button", { name: "AI에게 이 주문 물어보기" }).click();
  const panel = page.locator(".agent-panel");
  await expect(panel.getByText("AI 고객센터")).toBeVisible();
  await page.getByPlaceholder("조건이나 요청을 입력하세요").fill("배송 언제 와?");
  await page.getByRole("button", { name: "보내기" }).click();
  // stub CS: list_orders -> get_shipping_status -> NO_INFORMATION을 있는 그대로 설명
  await expect(panel.getByText(/배송 정보가 아직 등록되지 않았어요/)).toBeVisible({ timeout: 15000 });
});
