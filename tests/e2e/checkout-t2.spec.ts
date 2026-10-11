// Phase 3 E2E: 장바구니 → 주문서 → 모의 결제 → 주문 상세(PREPARING) → CS 설명.
// 병렬 실행에서 상태가 섞이지 않도록 이 스펙은 전용 사용자 u-c(e2e-c)를 쓴다.
import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill("e2e-c");
  await page.getByRole("button", { name: "시작하기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
}

// 첫 테스트가 결제로 확정한 주문 id — 목록/CS 검증을 같은 주문으로 한정한다.
// 이름이 같은 다른 주문(06a 등 이전 실행 잔여)과 섞이지 않게 하기 위함이다.
let createdOrderId = "";

// 단독 실행 대비 — 같은 id가 없으면 배송 준비 중인 최신 주문 id를 고른다.
async function preparingOrderId(page: Page) {
  const j = await (await page.context().request.get("/api/orders")).json();
  const o = (
    j.data.orders as { id: string; shipping_status?: string | null }[]
  ).find((x) => x.shipping_status === "PREPARING");
  if (!o) throw new Error("no PREPARING order for e2e-c");
  return o.id;
}

test("checkout: cart -> quote -> mock pay -> order detail PREPARING", async ({
  page,
}) => {
  await login(page);

  // 모니터 B 24인치 149,000원 + 배송비 3,000 = 152,000
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await page.getByText("코드뷰 모니터 B").first().click();
  // 기본 옵션(v-b-24 24인치) 자동 선택 → 금액 포함 CTA로 담기
  await page.getByRole("button", { name: "149,000원 담기" }).click();
  await page.getByRole("button", { name: "장바구니 보기" }).click();

  // W03 -> W04
  await page.getByRole("button", { name: /주문하기/ }).click();
  await expect(page.getByRole("heading", { name: "주문서" })).toBeVisible();
  await expect(page.getByText("배송지 (테스트)")).toBeVisible();
  // PMQA-040: 모의결제 안내는 하단 CTA 아래 .pay-note 단일 문구로 이동했다.
  await expect(
    page.locator(".checkout-paybar .pay-note"),
  ).toContainText("모의 결제로 실제 결제는 발생하지 않아요");

  await page.getByRole("button", { name: "152,000원 결제하기" }).click();

  // W04 -> W04-C 결제 완료 (Ref077) -> 링크로 W06 주문 상세 진입.
  await expect(page.getByRole("heading", { name: "결제했어요" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/152,000원 · 모의 결제/)).toBeVisible();
  await page.getByRole("button", { name: "주문 상세 내역 보기" }).click();
  await expect(page.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible({ timeout: 15000 });
  // 결제로 확정된 정확한 주문 id를 route에서 회수한다.
  createdOrderId = decodeURIComponent(
    page.url().match(/#\/orders\/([^/]+)/)![1],
  );
  // 품목 금액(149,000)과 주문 총액(152,000)을 구분해 단정 — 합산해 꾸미지 않는다.
  await expect(page.locator(".pay-row.total")).toContainText("152,000원");
  await expect(page.getByText(/모의 결제 152,000원 — 실제 결제는 발생하지 않아요/)).toBeVisible();
  await expect(page.getByText("배송 준비 중").first()).toBeVisible();

  // W05 목록 — 같은 id 카드 안에서 상품·품목 금액·주문 총액·배송 상태를 함께 검증한다.
  await page.getByRole("button", { name: "목록" }).click();
  const card = page.locator(".order-card[data-order-id='" + createdOrderId + "']");
  await expect(card).toBeVisible();
  await expect(card).toContainText("코드뷰 모니터 B");
  await expect(card).toContainText("149,000원");
  await expect(card).toContainText("주문 총액 152,000원");
  await expect(card.getByText("상품준비중")).toBeVisible();
});

test("cs panel: created order -> shipping status explanation (stub)", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "내 쇼핑" }).click();
  // 이전 테스트가 만든 같은 id의 주문을 연다 — 같은 상품명의 다른 주문과 섞이지 않는다.
  const oid = createdOrderId || (await preparingOrderId(page));
  await page.locator(".order-card[data-order-id='" + oid + "']").getByText("결제 상세").click();
  await expect(page.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();

  await page.getByRole("button", { name: "AI에게 이 주문 물어보기" }).click();
  await expect(page.getByText("AI 고객센터")).toBeVisible();
  await page.getByPlaceholder("조건이나 요청을 입력하세요").fill("내 주문 배송 상태 알려줘");
  await page.getByRole("button", { name: "보내기" }).click();
  // stub CS: list_orders -> get_shipping_status -> 실제 상태 요약
  await expect(page.getByText(/배송 준비 중/).last()).toBeVisible({ timeout: 15000 });
});
