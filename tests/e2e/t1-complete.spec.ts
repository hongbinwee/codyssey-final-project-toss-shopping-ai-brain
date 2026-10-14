import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  // 병렬 실행에서 카트 상태가 섞이지 않도록 이 스펙은 u-b를 쓴다.
  await page.getByPlaceholder("접근 코드").fill("e2e-b");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

test("t1 complete: cart quantity update -> remove -> empty state", async ({
  page,
}) => {
  await login(page);

  // 담기 (v-a-24 재고 5)
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await page.getByText("코드뷰 모니터 A").first().click();
  // 기본 옵션(v-a-24 24인치) 자동 선택 → 금액 포함 CTA로 담기
  await page.getByRole("button", { name: "180,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  // 수량 +1 -> 2개, 합계 360,000 + 3,000 = 363,000
  await page.getByRole("button", { name: /수량 증가/ }).click();
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("2");
  await expect(page.locator(".cart-summary-total b")).toHaveText("363,000원");

  // 수량 -1 -> 1개
  await page.getByRole("button", { name: /수량 감소/ }).click();
  await expect(page.locator(".cart-item .qty-ctrl b").first()).toHaveText("1");
  await expect(page.locator(".cart-summary-total b")).toHaveText("183,000원");

  // 삭제 -> Empty
  await page.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("장바구니가 비었어요")).toBeVisible();
});

// [076] 비교 카드는 Brain Tool 결과 — Brain 미배포이므로 AI 진입이 차단되고
// 패널·compare-card·/api/agent 요청이 모두 없어야 한다 [F22].
// 과거 stub 카드 검증은 이관하지 않는다.
test("compare card: AI disabled — no panel or tool traffic", async ({
  page,
}) => {
  await login(page);
  const agentReqs: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/agent/")) agentReqs.push(r.url());
  });
  await expect(
    page.locator("button.nav-item", { hasText: "AI" }),
  ).toBeDisabled();
  await expect(page.locator(".agent-panel")).toHaveCount(0);
  await expect(page.locator(".compare-card")).toHaveCount(0);
  expect(agentReqs).toHaveLength(0);
});
