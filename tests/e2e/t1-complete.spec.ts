import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  // 병렬 실행에서 카트 상태가 섞이지 않도록 이 스펙은 u-b를 쓴다.
  await page.getByPlaceholder("접근 코드").fill("e2e-b");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByRole("button", { name: /AI에게 조건/ })).toBeVisible();
}

test("t1 complete: cart quantity update -> remove -> empty state", async ({
  page,
}) => {
  await login(page);

  // 담기 (v-a-24 재고 5)
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await page.getByText("코드뷰 모니터 A").first().click();
  await page.getByRole("button", { name: /24인치.*180,000원/ }).click();
  await page.getByRole("button", { name: "장바구니 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  // 수량 +1 -> 2개, 합계 360,000 + 3,000 = 363,000
  await page.getByRole("button", { name: /수량 증가/ }).click();
  await expect(page.getByText("× 2")).toBeVisible();
  await expect(page.getByText("363,000원")).toBeVisible();

  // 수량 -1 -> 1개
  await page.getByRole("button", { name: /수량 감소/ }).click();
  await expect(page.getByText("× 1")).toBeVisible();
  await expect(page.getByText("183,000원")).toBeVisible();

  // 삭제 -> Empty
  await page.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByText("장바구니가 비어 있어요")).toBeVisible();
});

test("compare card: tool-derived products, evidence, limitations", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByPlaceholder("조건이나 요청을 입력하세요").fill("개발용 모니터 비교해줘");
  await page.getByRole("button", { name: "보내기" }).click();

  // 서버가 Tool 결과로 조립한 비교 카드 (모델 텍스트가 아님)
  const card = page.locator(".compare-card");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.locator(".compare-row")).toHaveCount(3);
  // stub은 첫 상품(p-a)의 리뷰만 조회 -> 나머지는 근거 부족 한계가 표시돼야 한다
  await expect(card.getByText("리뷰 근거가 부족한 상품이 있어요")).toBeVisible();

  // 카드에서 W02 원문으로 이동
  await card.getByRole("button", { name: "상품 보기" }).first().click();
  await expect(page.getByRole("heading", { name: "옵션 선택" })).toBeVisible();
});
