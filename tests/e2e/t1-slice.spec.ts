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
  const sheet = page.getByRole("dialog", { name: "옵션 한번에 보기" });
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

// [076] Brain 미배포 — AI 진입점은 '준비중' 비활성이며 패널이 열리지 않고
// /api/agent 요청도 발생하지 않아야 한다 [F22]. 과거 stub provider 검증은
// 이관하지 않는다.
test("A01 AI entry: disabled, no panel, no agent requests", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  const agentReqs: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/agent/")) agentReqs.push(r.url());
  });
  const ai = page.locator("button.nav-item", { hasText: "AI" });
  await expect(ai).toBeVisible();
  await expect(ai).toBeDisabled();
  await expect(ai.locator(".nav-soon")).toHaveText("준비중");
  await expect(page.locator(".agent-panel")).toHaveCount(0);
  // 전체 메뉴의 AI 항목도 비활성 — 우회 진입 없음
  await page.getByRole("button", { name: "전체" }).click();
  await expect(
    page.getByRole("menuitem", { name: /AI 쇼핑 도우미/ }),
  ).toBeDisabled();
  expect(agentReqs).toHaveLength(0);
});
