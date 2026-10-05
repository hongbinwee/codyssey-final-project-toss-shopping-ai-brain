import { expect, test } from "@playwright/test";

test("t1 slice: login -> search -> product -> add option -> cart totals", async ({
  page,
}) => {
  await page.goto("/");
  // 로그인 (테스트 접근 코드)
  await page.getByPlaceholder("접근 코드").fill("e2e-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByRole("button", { name: /AI에게 조건/ })).toBeVisible();

  // W01: 검색
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await expect(page.getByText("코드뷰 모니터 A").first()).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(3);

  // W02: 상세 → 옵션 선택 → 담기
  await page.getByText("코드뷰 모니터 A").first().click();
  await expect(page.getByRole("heading", { name: "옵션 선택" })).toBeVisible();
  await page.getByRole("button", { name: /24인치.*180,000원/ }).click();
  await page.getByRole("button", { name: "장바구니 담기" }).click();
  await expect(page.getByText("장바구니에 담았어요")).toBeVisible();

  // W03: 카트에서 금액 확인
  await page.getByRole("button", { name: "장바구니 보기" }).click();
  await expect(page.getByText("상품 180,000원")).toBeVisible();
  await expect(page.getByText("183,000원")).toBeVisible();
});

test("A01 panel: stub provider answers with real data", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  // name 매칭은 substring이므로 "🤖 AI에게 조건…" 버튼과 충돌한다 → exact 필수
  await page.getByRole("button", { name: "🤖 AI", exact: true }).click();
  await page.getByPlaceholder("조건이나 요청을 입력하세요").fill("개발용 모니터 비교해줘");
  await page.getByRole("button", { name: "보내기" }).click();
  // stub provider가 실제 Tool 조회 결과를 반영한 답변을 돌려준다
  await expect(page.locator(".msg.ai").last()).toContainText("p-a", {
    timeout: 15000,
  });
});
