// Phase 4 E2E: 주문 생성 → A02 취소 확인 시트 → 사유+견적 → 최종 확인 → 접수 결과가 W06에 반영.
// 병렬 실행에서 상태가 섞이지 않도록 전용 사용자 u-d(e2e-d)를 쓴다.
import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-d");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

test("t3: checkout order -> A02 confirm -> cancel REQUESTED on W06", async ({ page }) => {
  await login(page);

  // 주문 생성 (모니터 C 27인치 — 289,000 + 3,000). 모니터 B는 checkout-t2가
  // 병렬로 구매하므로 재고 차감 → 옵션 버전 증가 → STALE_QUOTE 충돌을 피해 C를 쓴다.
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await page.getByText("코드뷰 모니터 C").first().click();
  // 기본 옵션(v-c-27 27인치) 자동 선택 → 금액 포함 CTA로 담기
  await page.getByRole("button", { name: "289,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();
  await page.getByRole("button", { name: /주문하기/ }).click();
  await page.getByRole("button", { name: "292,000원 결제하기" }).click();
  // 병렬 실행 시 서버 응답이 느려질 수 있어 넉넉하게 기다린다
  await expect(page.getByRole("heading", { name: "주문 상세" })).toBeVisible({ timeout: 15000 });

  // 확인 없는 상태에서는 실행 버튼이 열리지 않는다 — 시트를 먼저 연다
  await page.getByRole("button", { name: "주문 취소" }).click();
  await expect(page.getByText("전체 상품이 취소돼요")).toBeVisible();
  const submit = page.getByRole("button", { name: "이 주문 취소 요청" });
  await expect(submit).toBeDisabled(); // 사유 선택 전 비활성

  await page.getByText("단순 변심이에요").click();
  await expect(page.getByText(/환불 예정/).and(page.locator(".sheet *"))).toBeVisible();
  await expect(page.getByText("292,000원").last()).toBeVisible();
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible();
  await page.getByRole("button", { name: "확인" }).last().click();

  // W06에 취소 요청 블록과 배지가 보인다. 접수는 취소 완료가 아니다 — 주문은 아직 주문 완료 상태.
  await expect(page.getByText("취소 요청 접수됨")).toBeVisible();
  await expect(page.getByText(/환불 예정 292,000원/)).toBeVisible();
  await expect(page.getByRole("button", { name: "주문 취소" })).toHaveCount(0); // 중복 취소 CTA 제거

  // 목록에도 취소 요청 배지
  await page.getByRole("button", { name: "목록" }).click();
  await expect(page.locator(".badge", { hasText: "취소 요청" })).toBeVisible();
});

test("t3: shipped order is ineligible in A02 (e2e-a seed order)", async ({ page }) => {
  // 출고된 seed 주문 — 시트가 서버 판정을 보여주고 실행을 막는다.
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  await page.getByRole("button", { name: "내 쇼핑" }).click();
  await page.getByText("코드뷰 모니터 B").first().click(); // ord-a-ship (배송 중)
  await expect(page.getByRole("heading", { name: "주문 상세" })).toBeVisible();
  await page.getByRole("button", { name: "주문 취소" }).click();
  await expect(page.getByText("지금은 이 주문을 취소할 수 없어요")).toBeVisible();
  await expect(page.getByText("이미 출고된 주문은 취소할 수 없어요")).toBeVisible();
  await expect(page.getByRole("button", { name: "이 주문 취소 요청" })).toHaveCount(0);
});
