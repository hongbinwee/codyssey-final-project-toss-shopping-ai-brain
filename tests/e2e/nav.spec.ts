import { expect, test, type Page } from "@playwright/test";

// 04-D Navigation — Toss 하단 네비 구조/스크롤 숨김/active 컨텍스트/
// history.state 마커 기반 back fallback 검증 (PM QA 조건 반영).

async function login(page: Page, code = "e2e-a") {
  await page.getByPlaceholder("접근 코드").fill(code);
  await page.getByRole("button", { name: "시작하기" }).click();
  // 로그인 성공은 접근 코드 폼이 사라지는 것으로 판정 — 각 화면의 readiness는
  // 라우트별로 다르므로 개별 테스트가 기다린다 (direct #/p·#/checkout에는 검색 필드가 없음).
  await expect(page.getByPlaceholder("접근 코드")).toBeHidden();
}

test("bottom nav: 쇼핑 active, hides on scroll down, returns on scroll up", async ({
  page,
}) => {
  await page.goto("/");
  await login(page);

  const nav = page.locator(".bottom-nav");
  await expect(nav).toBeVisible();
  await expect(nav.locator(".nav-item.on")).toHaveText(/쇼핑/);
  // 5슬롯: 홈/혜택/쇼핑/AI/전체 — 라벨이 실제 기능과 일치(증권 라벨 미사용)
  for (const label of ["홈", "혜택", "쇼핑", "AI", "전체"]) {
    await expect(
      nav.getByRole("button", { name: label, exact: true }),
    ).toBeVisible();
  }

  // 실제 도달한 scrollY 기준으로 검증 — 문서가 짧으면 임의값이 같은 위치에
  // 클램프돼 'up' 이벤트가 발생하지 않을 수 있다 [PM 지침]
  const y1 = await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    return window.scrollY;
  });
  expect(y1).toBeGreaterThan(120);
  await expect(nav).toHaveClass(/hidden/);
  // visibility:hidden — Tab 포커스/접근성 트리에서도 제외돼야 한다
  await expect(nav).toBeHidden();
  await expect(nav.getByRole("button", { name: "홈" })).toBeHidden();
  const y2 = await page.evaluate(() => {
    window.scrollTo(0, Math.max(0, window.scrollY - 250));
    return window.scrollY;
  });
  expect(y2).toBeLessThan(y1);
  await expect(nav).not.toHaveClass(/hidden/);
  await expect(nav).toBeVisible();
});

test("혜택 slot lands on 특가 tab while 쇼핑 keeps the global active slot", async ({
  page,
}) => {
  await page.goto("/");
  await login(page);

  await page.locator(".bottom-nav").getByRole("button", { name: "혜택" }).click();
  // 쇼핑 서비스 내부 탭(특가)에서는 전역 활성이 쇼핑 슬롯에 유지된다 [Observed 위치]
  await expect(page.locator(".shop-tab.on")).toHaveText("특가");
  const shopItem = page.locator(".bottom-nav .nav-item.on");
  await expect(shopItem).toHaveText(/쇼핑/);
  // 목적지 current는 aria-current, 메뉴는 aria-expanded로 구분
  await expect(shopItem).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator(".bottom-nav").getByRole("button", { name: "전체" }),
  ).toHaveAttribute("aria-expanded", "false");

  // 네비 탭 전환으로 새 화면에 진입하면 스크롤이 초기화된다 [Project]
  await page.locator(".bottom-nav").getByRole("button", { name: "홈" }).click();
  await expect(page.locator(".shop-tab.on")).toHaveText("쇼핑 홈");
  const deep = await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    return window.scrollY;
  });
  expect(deep).toBeGreaterThan(120);
  // 스크롤 다운의 숨김이 실제 반영될 때까지 대기한다 — hidden이 아직 적용되지
  // 않은 상태에서 scroll up하면 'not.hidden' 단언이 원래 false 상태에서 먼저
  // 통과할 수 있다(첫 nav 테스트와 같은 barrier).
  const navBar = page.locator(".bottom-nav");
  await expect(navBar).toHaveClass(/hidden/);
  await expect(navBar).toBeHidden();
  const y2 = await page.evaluate(() => {
    window.scrollTo(0, Math.max(0, window.scrollY - 200));
    return window.scrollY;
  });
  expect(y2).toBeLessThan(deep);
  await expect(navBar).not.toHaveClass(/hidden/);
  await expect(navBar).toBeVisible();
  await navBar.getByRole("button", { name: "혜택" }).click();
  await expect(page.locator(".shop-tab.on")).toHaveText("특가");
  await expect
    .poll(async () => page.evaluate(() => window.scrollY))
    .toBeLessThan(60);
});

test("전체 sheet: focus/ESC/outside-close and 내 쇼핑 enters orders", async ({ page }) => {
  await page.goto("/");
  await login(page);

  const allBtn = page.locator(".bottom-nav").getByRole("button", { name: "전체" });
  await allBtn.click();
  await expect(allBtn).toHaveAttribute("aria-expanded", "true");
  for (const label of ["내 쇼핑", "장바구니", "검색", "AI 쇼핑 도우미"]) {
    await expect(page.getByRole("menuitem", { name: label })).toBeVisible();
  }
  // 열 때 첫 메뉴 항목으로 포커스
  await expect(page.locator(".menu-item").first()).toBeFocused();
  // ESC 닫기 → 포커스가 전체 버튼으로 복귀
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu-sheet")).toHaveCount(0);
  await expect(allBtn).toBeFocused();
  await expect(allBtn).toHaveAttribute("aria-expanded", "false");
  // 외부(오버레이) 탭 닫기
  await allBtn.click();
  await page.locator(".sheet-overlay").click({ position: { x: 8, y: 8 } });
  await expect(page.locator(".menu-sheet")).toHaveCount(0);

  await allBtn.click();
  await page.getByRole("menuitem", { name: "내 쇼핑" }).click();
  await expect(page.getByRole("heading", { name: "주문 목록" })).toBeVisible();
});

test("goto revisit vs browser back: new push is not mistaken for pop", async ({
  page,
}) => {
  await page.goto("/");
  await login(page);
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();

  // 실제 UI 경로로 A→B→new goto(A): 홈(#/) → 검색(#/search) →
  // Search 화면의 뒤로가기 버튼은 goto(home) — 같은 URL '#/'의 새 push다.
  await page.getByPlaceholder("상품 검색").fill("모니터");
  await page.getByPlaceholder("상품 검색").press("Enter");
  await expect(page).toHaveURL(new RegExp("#/search"));
  await page.getByRole("button", { name: "뒤로가기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();

  // goto(home)이 '뒤로가기'로 오인됐다면 여기서 Search가 아니라 앱 밖으로 나간다.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp("#/search"));
  await page.goForward();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp("#/search"));
});

test("direct #/p entry → cart → back → back ends at shop, never exits app", async ({
  page,
}) => {
  await page.goto("/#/p/p-a");
  await login(page);
  try {
    await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");

    await page.getByRole("button", { name: "180,000원 담기" }).click();
    await page.getByRole("button", { name: "장바구니 보기" }).click();
    await expect(page).toHaveURL(/#\/cart/);

    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");

    // 직접 진입 엔트리에는 내부 이력이 없으므로 브라우저 back이 아니라 parent fallback
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
  } finally {
    // 이 테스트가 e2e-a 카트에 넣은 항목을 제거해 뒤 시나리오를 오염시키지 않는다.
    // (cleanUserData 기준 시작 카트는 비어 있으므로 여기서 추가한 항목만 존재한다)
    // 카트 렌더 readiness를 기다린 뒤 정리 — 실패는 catch로 삼키지 않고 드러낸다 [PM 지침]
    await page.goto("/#/cart");
    const del = page.getByRole("button", { name: "삭제", exact: true });
    await expect(
      del.first().or(page.getByText("장바구니가 비었어요")),
    ).toBeVisible();
    for (let i = 0; i < 5; i += 1) {
      const n = await del.count();
      if (n === 0) break;
      await del.first().click();
      await expect(del).toHaveCount(n - 1);
    }
    await expect(page.getByText("장바구니가 비었어요")).toBeVisible();
  }
});

test("direct #/checkout entry climbs parent chain without back-loop", async ({
  page,
}) => {
  await page.goto("/#/checkout");
  await login(page);
  // 빈 카트 직접 링크의 실제 응답은 VALIDATION '카트가 비어 있습니다' ErrorState —
  // 주문서 heading이 아닌 실제 readiness를 기준으로 한다 [PM 지침]
  await expect(page.getByText("카트가 비어 있습니다")).toBeVisible();
  await expect(page.getByRole("button", { name: "뒤로가기" })).toBeVisible();

  // fallback은 replace — checkout→cart→shop 단조 상승, checkout 회귀 루프 없음
  await page.getByRole("button", { name: "뒤로가기" }).click();
  await expect(page).toHaveURL(/#\/cart/);
  await page.getByRole("button", { name: "뒤로가기" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
});

test("reload preserves entry marker: internal back still reaches prior screen", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await login(page);

  await page.getByText("코드뷰 모니터 A").first().click();
  await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");

  // 세션 복원 계약 증거 — GET /api/session은 {ok,user} 최상위 반환 [Observed 계약]
  const sess = await page.evaluate(() =>
    fetch("/api/session").then((r) => r.json()),
  );
  expect(sess.ok).toBe(true);
  expect(sess.user?.display_name).toBeTruthy();

  await page.reload();
  await expect(page.locator(".detail-name")).toHaveText("코드뷰 모니터 A");
  // 세션 복원 시 pageerror(구 r.data.user TypeError 회귀)가 없어야 한다
  expect(pageErrors).toEqual([]);

  // reload 후에도 엔트리의 internal 마커가 복원돼 실제 브라우저 back이 동작한다.
  await page.getByRole("button", { name: "뒤로가기" }).click();
  await expect(page.getByPlaceholder("상품 검색")).toBeVisible();
});
