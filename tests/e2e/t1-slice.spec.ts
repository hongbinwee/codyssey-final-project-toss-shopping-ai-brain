import { expect, test } from "@playwright/test";

test("t1 slice: login -> search -> product -> add option -> cart totals", async ({
  page,
}) => {
  await page.goto("/");
  // 로그인 (테스트 접근 코드)
  await page.getByPlaceholder("접근 코드").fill("e2e-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();

  // W01: 검색
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await expect(page.getByText("코드뷰 모니터 A").first()).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(3);

  // W02: 상세 → 옵션 선택 → 담기
  await page.getByText("코드뷰 모니터 A").first().click();
  // 기본 구매 가능 옵션(v-a-24 24인치)이 자동 선택돼 있고, 변경은 BottomSheet.
  await expect(page.locator(".option-open")).toContainText("24인치");
  await page.locator(".option-open").click();
  const sheet = page.getByRole("dialog", { name: "옵션 선택" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /24인치/ }).click();
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await expect(page.getByText("장바구니에 담았어요")).toBeVisible();

  // W03: 카트에서 금액 확인 — 견적 패널의 상품 금액/배송비 행은 서버값 그대로다
  await page.getByRole("button", { name: "장바구니 보기" }).click();
  const quoteRows = page.locator("#cart-quote-rows");
  await expect(quoteRows).toContainText("상품 금액");
  await expect(quoteRows).toContainText("180,000원");
  await expect(quoteRows).toContainText("배송비");
  await expect(quoteRows).toContainText("3,000원");
  await expect(page.locator(".cart-summary-total b")).toHaveText("183,000원");
});

test("A01 panel: stub provider answers with real data", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  // name 매칭은 substring이므로 "AI에게 조건…" 버튼과 충돌한다 → exact 필수
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByPlaceholder("조건이나 요청을 입력하세요").fill("개발용 모니터 비교해줘");
  await page.getByRole("button", { name: "보내기" }).click();
  // stub provider가 실제 Tool 조회 결과를 반영한 답변을 돌려준다
  await expect(page.locator(".msg.ai").last()).toContainText("p-a", {
    timeout: 15000,
  });
});
