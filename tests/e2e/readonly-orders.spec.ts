// PMQA-048-B0 — 06B 주문 목록/상세/배송 읽기 검증.
// [real] = 실제 서버·실데이터 검증. [mock:xxx] = 실데이터 부재 상태로 응답만
// mock한 별도 표시 검증 — 실서버 PASS·Reference 실제 관찰과 절대 혼용하지 않는다.
// CS 송신·취소 실행·결제는 이 경로에서 만들지 않고, 가드가 차단함을 단정한다.
//
// 검수 반영: custom context는 baseURL=RO_ORIGIN 고정(goto 상대경로·roApi
// 상대경로가 모두 정상 해석된다). heading은 실제 DOM '주문 상세 내역'이다.
// 소유자 탐색은 브라우저와 분리된 guard APIContext에서 하고, 브라우저는
// 찾은 owner로 정상 login을 한 번만 한다. A→B 전환은 page.goto(전체 reload)
// 가 아니라 hash 기반 SPA 전환으로 seqRef를 실제로 검증한다. 실데이터 존재를
// 기대하는 단정은 skip하지 않고 명시적으로 실패시켜 보고한다.
import {
  test as base, expect, request as pwRequest, type Page,
} from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installRoGuard, roApi, RO_ORIGIN } from "./readonly-guard.ts";

const RUN = process.env.RO_RUN_ID ?? "unmanaged";
const SHOT_DIR = join("shots", "06b", RUN, "captures");

// context 생성 직후·첫 goto 이전에 가드를 설치한다 — allowlist 없는 요청 경로는
// 이 fixture 밖에 존재하지 않는다. baseURL을 RO_ORIGIN으로 고정해 상대 경로
// goto·roApi fetch가 외부 origin으로 새지 않는다.
const test = base.extend({
  context: async ({ browser }, use) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: RO_ORIGIN,
    });
    await installRoGuard(ctx);
    await use(ctx);
    await ctx.close();
  },
});

async function login(page: Page, code = "e2e-a") {
  await page.goto("/");
  await page.getByPlaceholder("접근 코드").fill(code);
  await page.getByRole("button", { name: "시작하기" }).click();
  await page.getByRole("button", { name: "내 쇼핑" }).waitFor();
}

async function openOrders(page: Page) {
  await page.getByRole("button", { name: "내 쇼핑" }).click();
  await expect(page.getByRole("heading", { name: "주문 목록" })).toBeVisible();
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOT_DIR, { recursive: true });
  // 버퍼로 받아 wx(no-overwrite)로 쓴다 — 같은 run 내 이름 중복도 실패다
  // [PM B0 최종 검수].
  const buf = await page.screenshot();
  writeFileSync(join(SHOT_DIR, name + ".png"), buf, { flag: "wx" });
}

// 배송 포커스 실측 [PMQA-048-C 증거 정정] — goto + heading visible만으로는
// smooth scroll 미완료 상태에서 통과할 수 있어, #order-shipping .timeline의
// 실제 bbox가 sticky .backbar 아래·fixed .bottom-bar 위에 온전히 놓이고
// scrollY가 연속 frame에서 안정될 때까지 rAF bounded poll로 확인한다.
// 임의 sleep 금지. 측정값은 호출부가 run 폴더에 wx로 기록한다.
type ShipFocus = {
  done: boolean; tries: number; scrollY: number;
  timeline: { top: number; bottom: number } | null;
  barTop: number | null; backBottom: number | null;
};
async function shipFocus(page: Page): Promise<ShipFocus> {
  return page.evaluate(
    () =>
      new Promise<ShipFocus>((resolve) => {
        let stable = 0;
        let lastY = -1;
        let tries = 0;
        const tick = () => {
          tries++;
          const tl = document.querySelector("#order-shipping .timeline");
          const bar = document.querySelector(".bottom-bar");
          const hdr = document.querySelector(".backbar");
          const y = window.scrollY;
          stable = Math.abs(y - lastY) < 0.5 ? stable + 1 : 0;
          lastY = y;
          const tlR = tl ? tl.getBoundingClientRect() : null;
          const barTop = bar ? bar.getBoundingClientRect().top : null;
          const backBottom = hdr ? hdr.getBoundingClientRect().bottom : 0;
          const boxOk =
            tlR != null &&
            barTop != null &&
            tlR.top >= backBottom - 1 &&
            tlR.bottom <= barTop + 1;
          if ((boxOk && stable >= 2) || tries > 120) {
            resolve({
              done: boxOk && stable >= 2,
              tries,
              scrollY: y,
              timeline: tlR ? { top: tlR.top, bottom: tlR.bottom } : null,
              barTop,
              backBottom,
            });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

// 측정값 wx 기록 + 완전 노출 단정 — 실패하면 PNG를 쓰지 않고 원인 그대로 보고한다.
async function expectShipFocus(page: Page, tag: string): Promise<ShipFocus> {
  const m = await shipFocus(page);
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(
    join(SHOT_DIR, "shipping-focus-" + tag + ".json"),
    JSON.stringify({ tag, ...m, at: new Date().toISOString() }, null, 2),
    { flag: "wx" },
  );
  expect(
    m.done,
    "배송 타임라인 미완전 노출 — scrollY " + m.scrollY +
      ", timeline " + JSON.stringify(m.timeline) + ", barTop " + m.barTop,
  ).toBe(true);
  return m;
}

// 소유자 탐색 — 브라우저 세션과 분리된 guard APIContext에서 사용자별 login→
// 목록 조회로 실제 소유자를 찾는다(page context의 세션 쿠키를 오염시키지
// 않는다). session POST는 허용 목록, GET /api/orders는 SELECT다.
async function findOrderViaApi(
  match: (o: Record<string, unknown>) => boolean,
): Promise<{ order: Record<string, unknown>; code: string } | null> {
  for (const code of ["e2e-a", "e2e-b", "e2e-c", "e2e-d"]) {
    const ctx = await pwRequest.newContext({ baseURL: RO_ORIGIN });
    try {
      const api = roApi(ctx);
      await api.post("/api/session", { code });
      const r = await api.get("/api/orders?limit=50");
      const orders =
        (r.json as { data?: { orders?: Record<string, unknown>[] } })?.data
          ?.orders ?? [];
      const hit = orders.find(match);
      if (hit) return { order: hit, code };
    } finally {
      await ctx.dispose();
    }
  }
  return null;
}

test.describe("[real] 06B 목록·상세 — 실데이터", () => {
  test("주문 목록 — 카드 해부·cardHead·배송 칩·data-order-id", async ({ page }) => {
    await login(page);
    await openOrders(page);
    const ship = page.locator('.order-card[data-order-id="ord-a-ship"]');
    await expect(ship.locator(".order-card-head")).toContainText("배송 중");
    await expect(ship.locator(".order-ship-chip")).toBeVisible();
    await expect(page.locator('.order-card[data-order-id="ord-a-pre"] .order-card-head')).toContainText("상품준비중");
    await expect(page.locator('.order-card[data-order-id="ord-a-done"] .order-card-head')).toContainText("배송 완료");
    // CTA는 지원 경로만 — 결제 상세 링크. 취소하기는 서버 canonical 정책 결과만 소비:
    // ord-a-ship(IN_TRANSIT→ALREADY_SHIPPED)은 미노출, ord-a-pre(PREPARING)만 노출 [PMQA-06B-053].
    await expect(ship.getByRole("button", { name: /결제 상세/ })).toBeVisible();
    await expect(ship.getByRole("button", { name: "취소하기" })).toHaveCount(0);
    await expect(
      page.locator('.order-card[data-order-id="ord-a-pre"]').getByRole("button", { name: "취소하기" }),
    ).toBeVisible();
    // CS Brain 미구축 — 문의 CTA는 '준비 중' 비활성으로만 노출한다 [MJ053-2].
    const askBtn = ship.getByRole("button", { name: "AI 주문 문의 · 준비 중" });
    await expect(askBtn).toBeVisible();
    await expect(askBtn).toBeDisabled();
    await expect(askBtn).toHaveAttribute("title", "AI 주문 문의 기능은 아직 준비 중이에요");
    // 키보드 실측 — disabled CTA는 포커스되지 않는다(프로그램적 focus 시도 + Tab 순회).
    await askBtn.focus();
    await expect(askBtn).not.toBeFocused();
    const agentCalls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/agent/turn")) agentCalls.push(r.url()); });
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      await expect(askBtn).not.toBeFocused();
    }
    // 합성 click은 이벤트 전달 시도일 뿐 — 활성화 불가는 위 focus/Tab 실측이 단정한다.
    // 실제 키보드 Enter/Space도 어떤 패널·agent 요청도 만들지 않는다.
    await askBtn.dispatchEvent("click");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(page.locator(".agent-panel")).toHaveCount(0);
    expect(agentCalls).toHaveLength(0);
  });

  test("주문 상세 — 스냅샷 행·결제 정보·배송 상태·CTA (ord-a-ship)", async ({ page }) => {
    await login(page);
    await openOrders(page);
    await page.locator('.order-card[data-order-id="ord-a-ship"] .order-item-body').click();
    await expect(page.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
    await expect(page.getByText("코드뷰 모니터 B")).toBeVisible();
    await expect(page.locator(".pay-row.total")).toContainText("152,000원");
    await expect(page.getByText("모의 결제 152,000원")).toBeVisible();   // '일시불' 문구 없음
    // IN_TRANSIT → 서버 cancel_eligible=false — 취소 CTA 미노출 [PMQA-06B-053].
    await expect(page.getByRole("button", { name: "취소하기" })).toHaveCount(0);
    // CS Brain 미구축 — 카드·하단 문의 CTA 모두 비활성 '준비 중' [MJ053-2].
    const askBtns = page.getByRole("button", { name: "AI 주문 문의 · 준비 중" });
    await expect(askBtns).toHaveCount(2);
    for (const b of await askBtns.all()) await expect(b).toBeDisabled();
    await expect(askBtns.first()).toHaveAttribute("title", "AI 주문 문의 기능은 아직 준비 중이에요");
    // 키보드 실측 — disabled CTA는 포커스되지 않는다(focus() 시도 + Tab 순회 모두).
    await askBtns.first().focus();
    await expect(askBtns.first()).not.toBeFocused();
    const agentCalls: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/agent/turn")) agentCalls.push(r.url()); });
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      await expect(askBtns.first()).not.toBeFocused();
      await expect(askBtns.nth(1)).not.toBeFocused();
    }
    // 합성 click은 이벤트 전달 시도일 뿐 — 활성화 불가는 위 focus/Tab 실측이 단정한다.
    await askBtns.first().dispatchEvent("click");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(page.locator(".agent-panel")).toHaveCount(0);
    expect(agentCalls).toHaveLength(0);
  });

  test("배송 조회 칩 → 상세 배송 섹션 앵커", async ({ page }) => {
    await login(page);
    await openOrders(page);
    await page.locator('.order-card[data-order-id="ord-a-ship"] .order-ship-chip').click();
    await expect(page).toHaveURL(/#\/orders\/ord-a-ship\/shipping$/);
    await expect(page.getByRole("heading", { name: "배송 상태" })).toBeInViewport();
    // smooth scroll 완료 + timeline이 고정 바 사이에 온전히 보이는지 실측 단정.
    await expectShipFocus(page, "chip");
  });

  test("배송 정보 없음 — ord-b-none NO_INFORMATION", async ({ page }) => {
    await login(page, "e2e-b");
    await openOrders(page);
    // data-order-id로 정확히 진입 — 상품명 first는 신규 주문과 혼동한다 [PM 검수].
    await page.locator('.order-card[data-order-id="ord-b-none"] .order-item-body').click();
    await expect(page.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
    await expect(page.getByText("배송 정보가 아직 등록되지 않았어요")).toBeVisible();
    // 배송 레코드 없음 → SHIPPING_UNVERIFIED → 서버 정책 부적격 — CTA 미노출 +
    // 실GET eligibility 일치 [PMQA-06B-053].
    await expect(page.getByRole("button", { name: "취소하기" })).toHaveCount(0);
    const api = roApi(page.context().request);
    const elig = await api.get("/api/orders/ord-b-none/cancel/eligibility");
    const eligData = (elig.json as {
      data?: { eligible?: boolean; reasons?: { code: string }[] };
    })?.data;
    expect(eligData?.eligible, "ord-b-none eligibility").toBe(false);
    expect(
      (eligData?.reasons ?? []).some((r) => r.code === "SHIPPING_UNVERIFIED"),
      "ord-b-none reasons에 SHIPPING_UNVERIFIED",
    ).toBe(true);
    // 목록·상세 DTO도 같은 판정이다.
    const listB = await api.get("/api/orders?limit=50");
    const rowB = (
      (listB.json as { data?: { orders?: Record<string, unknown>[] } })
        ?.data?.orders ?? []
    ).find((o) => o.id === "ord-b-none");
    expect(rowB?.cancel_eligible, "ord-b-none 목록 DTO").toBe(false);
    const detailB = await api.get("/api/orders/ord-b-none");
    expect(
      (detailB.json as { data?: { cancel_eligible?: boolean } })?.data?.cancel_eligible,
      "ord-b-none 상세 DTO",
    ).toBe(false);
  });

  test("타인 주문 접근 — owner scope NOT_FOUND", async ({ page }) => {
    await login(page, "e2e-b");
    await page.goto("/#/orders/ord-a-ship");
    await expect(page.getByText("주문을 찾을 수 없어요")).toBeVisible();
  });

  test("취소 CTA — 부적격은 버튼 없음 + 실DTO·eligibility 일치 행렬 (ord-a-ship IN_TRANSIT) [PMQA-06B-053]", async ({ page }) => {
    await login(page);
    await openOrders(page);
    await page.locator('.order-card[data-order-id="ord-a-ship"] .order-item-body').click();
    // 서버 canonical 정책이 cancel_eligible=false면 시트 진입 CTA 자체가 없다 —
    // 'CTA 노출 → 시트 내 거절' UX를 같은 정책의 fail closed 미노출로 바꿨다.
    await expect(page.getByRole("button", { name: "취소하기" })).toHaveCount(0);
    // 실DTO 목록·상세·eligibility endpoint가 같은 판정인지 교차 단정한다.
    const api = roApi(page.context().request);
    const list = await api.get("/api/orders?limit=50");
    const row = (
      (list.json as { data?: { orders?: Record<string, unknown>[] } })
        ?.data?.orders ?? []
    ).find((o) => o.id === "ord-a-ship");
    expect(row?.cancel_eligible, "목록 DTO cancel_eligible").toBe(false);
    const detail = await api.get("/api/orders/ord-a-ship");
    expect(
      (detail.json as { data?: { cancel_eligible?: boolean } })?.data?.cancel_eligible,
      "상세 DTO cancel_eligible",
    ).toBe(false);
    const elig = await api.get("/api/orders/ord-a-ship/cancel/eligibility");
    const eligData = (elig.json as {
      data?: { eligible?: boolean; reasons?: { code: string }[] };
    })?.data;
    expect(eligData?.eligible, "eligibility endpoint eligible").toBe(false);
    expect(
      (eligData?.reasons ?? []).some((r) => r.code === "ALREADY_SHIPPED"),
      "eligibility reasons에 ALREADY_SHIPPED",
    ).toBe(true);
    // 같은 행렬을 실데이터가 있는 나머지 상태로 확장한다 — PREPARING은 true.
    const rows = (list.json as { data?: { orders?: Record<string, unknown>[] } })
      ?.data?.orders ?? [];
    const matrix: { id: string; eligible: boolean; reason?: string }[] = [
      { id: "ord-a-done", eligible: false, reason: "ALREADY_SHIPPED" }, // DELIVERED
      { id: "ord-a-pre", eligible: true },                            // PREPARING 정상
    ];
    for (const m of matrix) {
      const r0 = rows.find((o) => o.id === m.id);
      expect(r0?.cancel_eligible, m.id + " 목록 DTO").toBe(m.eligible);
      const d = await api.get("/api/orders/" + m.id);
      expect(
        (d.json as { data?: { cancel_eligible?: boolean } })?.data?.cancel_eligible,
        m.id + " 상세 DTO",
      ).toBe(m.eligible);
      const e = await api.get("/api/orders/" + m.id + "/cancel/eligibility");
      const ed = (e.json as {
        data?: { eligible?: boolean; reasons?: { code: string }[] };
      })?.data;
      expect(ed?.eligible, m.id + " eligibility").toBe(m.eligible);
      if (m.reason)
        expect(
          (ed?.reasons ?? []).some((r) => r.code === m.reason),
          m.id + " reasons에 " + m.reason,
        ).toBe(true);
      if (m.eligible)
        expect(ed?.reasons ?? [], m.id + " reasons empty").toHaveLength(0);
    }
    // 실데이터가 없는 부적격 경로(payment 없음·refund PENDING/REFUNDED·paid≠total 등)는
    // canonical 정책 단위 tests/unit/cancellation-policy.test.ts가 행렬로 단정한다 —
    // 이 spec은 실데이터가 있는 상태(IN_TRANSIT·noShipment·REQUESTED·PREPARING)만 커버한다.
  });

  test("취소 시트 — 자격 경로에서 견적 GET은 가드 차단 (ord-a-pre)", async ({ page }) => {
    const blocked: string[] = [];
    page.on("response", (r) => { if (r.status() === 403) blocked.push(r.url()); });
    await login(page);
    await openOrders(page);
    await page.locator('.order-card[data-order-id="ord-a-pre"] .order-item-body').click();
    await page.getByRole("button", { name: "취소하기" }).click();
    await expect(page.getByText("전체 상품이 취소돼요")).toBeVisible();
    // 사유 선택 → cancel/quote GET은 allowlist 밖 — 서버 도달 전 차단이 관측된다
    await page.getByText("단순 변심이에요").click();
    await expect.poll(() => blocked.some((u) => u.includes("/cancel/quote"))).toBe(true);
  });

  test("취소 요청 주문 — cardHead '취소요청' ≠ '취소완료' (047 산출물)", async ({ page }) => {
    // 047이 남긴 REQUESTED 취소 실데이터를 기대한다 — 없으면 스킵이 아니라
    // 명시 실패로 보고한다 [PM 검수].
    const hit = await findOrderViaApi((o) => o.cancel_status === "REQUESTED");
    expect(
      hit,
      "cancel_status=REQUESTED 실데이터 부재 — 047 산출물 상태를 확인해 보고한다",
    ).toBeTruthy();
    await login(page, hit!.code);
    await openOrders(page);
    const head = page.locator(
      '.order-card[data-order-id="' + (hit!.order.id as string) + '"] .order-card-head',
    );
    await expect(head).toContainText("취소요청");
    await expect(head).not.toContainText("취소완료");
    // 이미 취소 요청 접수 — CANCEL_ALREADY_REQUESTED → CTA 미노출 + 실GET 일치 [PMQA-06B-053].
    const reqCard = page.locator(
      '.order-card[data-order-id="' + (hit!.order.id as string) + '"]',
    );
    await expect(reqCard.getByRole("button", { name: "취소하기" })).toHaveCount(0);
    const api2 = roApi(page.context().request);
    const elig2 = await api2.get(
      "/api/orders/" + (hit!.order.id as string) + "/cancel/eligibility",
    );
    const eligData2 = (elig2.json as {
      data?: { eligible?: boolean; reasons?: { code: string }[] };
    })?.data;
    expect(eligData2?.eligible, "REQUESTED eligibility").toBe(false);
    expect(
      (eligData2?.reasons ?? []).some((r) => r.code === "CANCEL_ALREADY_REQUESTED"),
      "REQUESTED reasons에 CANCEL_ALREADY_REQUESTED",
    ).toBe(true);
    // 목록·상세 DTO도 같은 판정이다.
    const listR = await api2.get("/api/orders?limit=50");
    const rowR = (
      (listR.json as { data?: { orders?: Record<string, unknown>[] } })
        ?.data?.orders ?? []
    ).find((o) => o.id === (hit!.order.id as string));
    expect(rowR?.cancel_eligible, "REQUESTED 목록 DTO").toBe(false);
    const detailR = await api2.get("/api/orders/" + (hit!.order.id as string));
    expect(
      (detailR.json as { data?: { cancel_eligible?: boolean } })?.data?.cancel_eligible,
      "REQUESTED 상세 DTO",
    ).toBe(false);
  });

  test("다품목 주문 — '외 N건' + 주문 총액 별도 행", async ({ page }) => {
    const hit = await findOrderViaApi((o) => ((o.item_count as number) ?? 0) > 1);
    expect(
      hit,
      "item_count>1 실데이터 부재 — 현재 fixture 상태를 확인해 보고한다",
    ).toBeTruthy();
    await login(page, hit!.code);
    await openOrders(page);
    const card = page.locator('.order-card[data-order-id="' + (hit!.order.id as string) + '"]');
    await expect(card.locator(".order-item-name").first()).toContainText(
      "외 " + ((hit!.order.item_count as number) - 1) + "건",
    );
    await expect(card.locator(".order-card-total")).toContainText("주문 총액");
  });

  test("API limit=1 실제 페이지네이션 — cursor 중복 없음", async ({ page }) => {
    await login(page);
    const api = roApi(page.context().request);
    const p1 = await api.get("/api/orders?limit=1");
    expect(p1.blocked).toBe(false);
    expect(p1.status).toBe(200);
    const d1 = (p1.json as { data: { orders: { id: string }[]; has_more: boolean; next_cursor: string | null } }).data;
    expect(d1.orders.length).toBe(1);
    expect(d1.has_more).toBe(true);   // u-a는 seed 4건+승인 산출물 — 1페이지 초과 실데이터
    const p2 = await api.get("/api/orders?limit=1&cursor=" + encodeURIComponent(d1.next_cursor!));
    const d2 = (p2.json as { data: { orders: { id: string }[] } }).data;
    expect(d2.orders[0].id).not.toBe(d1.orders[0].id);
  });

  test("UI 페이지네이션 — forced limit=1(URL rewrite)·잠금·실패 복구", async ({ page }) => {
    // URL rewrite는 응답을 만들지 않는다 — 실서버가 limit=1 페이지를 돌려준다.
    // (UI 기본 호출은 서버 기본 limit — 이 둘은 별개 계층이다)
    let failNext = false;
    let orderCalls = 0;
    await page.route(/\/api\/orders(\?.*)?$/, async (route) => {
      const u = new URL(route.request().url());
      if (failNext && u.searchParams.has("cursor")) {
        failNext = false;
        return route.abort();   // 주입 실패 — 인라인 재시도 검증용
      }
      if (!u.searchParams.has("limit")) u.searchParams.set("limit", "1");
      orderCalls++;
      await route.continue({ url: u.toString() });
    });
    await login(page);
    await openOrders(page);
    await expect(page.locator(".order-card")).toHaveCount(1);
    const more = page.getByRole("button", { name: "더 보기" });
    await expect(more).toBeVisible();

    // 연속 클릭 — moreLock이 in-flight 중복 요청을 막는다
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "더 보기");
      (b as HTMLButtonElement).click();
      (b as HTMLButtonElement).click();
      (b as HTMLButtonElement).click();
    });
    await expect(page.locator(".order-card")).toHaveCount(2);
    expect(orderCalls).toBe(2);   // 첫 로드 + 더 보기 1회 — 중복 요청 없음

    // 3페이지 실패 주입 → 인라인 오류 → '다시 시도'로 실제 데이터 이어가기
    failNext = true;
    await more.click();
    await expect(page.getByText("목록을 더 불러오지 못했어요")).toBeVisible();
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(page.locator(".order-card")).toHaveCount(3);
    const ids = await page.locator(".order-card").evaluateAll((es) => es.map((e) => e.getAttribute("data-order-id")));
    expect(new Set(ids).size).toBe(ids.length);   // id-dedupe
  });

  test("주문 A→B 빠른 전환 — 늦은 응답 버림 (주입 지연, seqRef)", async ({ page }) => {
    // page.goto는 앱 전체 reload라 seqRef를 검증하지 못한다 — hash 기반 SPA
    // 전환으로 A 요청 발사를 확인한 뒤 B로 바꾸고, 지연 A 응답이 와도 B가
    // 유지되는지 본다 [PM 검수].
    await page.route(/\/api\/orders\/ord-a-pre$/, async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await login(page);
    const reqA = page.waitForRequest(/\/api\/orders\/ord-a-pre$/);
    // 응답 대기는 요청 발사 전에 예약한다 — B 렌더가 지연(1.2s)보다 오래 걸려도
    // A 응답을 놓쳐 timeout하지 않는다 [PM 검수].
    const resA = page.waitForResponse(/\/api\/orders\/ord-a-pre$/);
    await page.evaluate(() => { location.hash = "#/orders/ord-a-pre"; });
    await reqA;   // A GET이 실제로 발사됐다 — 이제 B로 전환
    await page.evaluate(() => { location.hash = "#/orders/ord-a-done"; });
    await expect(page.getByText("코드뷰 모니터 C")).toBeVisible();
    await resA;   // 지연 A 응답 도착을 사전 예약한 promise로 확인
    await expect(page.getByText("코드뷰 모니터 A")).toHaveCount(0); // B 화면 유지
  });

  test("목록 로드 실패 → 재시도 성공 (주입 실패 — 서버 오류 아님)", async ({ page }) => {
    let fail = true;
    await page.route(/\/api\/orders$/, async (route) => {
      if (fail) { fail = false; return route.abort(); }
      return route.continue();
    });
    await login(page);
    await page.getByRole("button", { name: "내 쇼핑" }).click();
    await expect(page.getByText("주문 내역을 불러오지 못했어요")).toBeVisible();
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(page.locator(".order-card").first()).toBeVisible();
  });

  test("[guard] 쓰기·미허용·외부 origin 경로는 서버 도달 전 차단", async ({ page }) => {
    await login(page);
    const cases: [string, string][] = [
      ["GET", "/api/cart"],              // GET이지만 carts INSERT 유발
      ["GET", "/api/checkout/quote"],
      ["GET", "/api/orders/ord-a-pre/cancel/quote"],
      ["GET", "/api/actions"],
      ["GET", "/api/products"],
      ["GET", "/api/products/p-a"],
      ["GET", "/api/agent/turn"],
      ["POST", "/api/cart/items"],
      ["POST", "/api/checkout/confirm"],
      ["POST", "/api/orders/ord-a-pre/cancel/approve"],
      ["POST", "/api/orders/ord-a-pre/cancel/execute"],
      ["POST", "/api/agent/turn"],
      ["PATCH", "/api/cart/items/ci-x"],
      ["DELETE", "/api/cart/items/ci-x"],
      ["DELETE", "/api/session"],
    ];
    for (const [m, u] of cases) {
      const r = await page.evaluate(async (pair: string[]) => {
        const res = await fetch(pair[1], { method: pair[0] });
        return { s: res.status, j: await res.json().catch(() => null) };
      }, [m, u]);
      expect(r.s, m + " " + u).toBe(403);
      expect(r.j?.error?.code, m + " " + u).toBe("RO_GUARD_BLOCKED");
    }
    // 외부 origin — 같은 /api/orders라도 RO_ORIGIN이 아니면 차단 [PM 검수].
    const ext = await page.evaluate(async () => {
      const res = await fetch("https://external.example.com/api/orders");
      return { s: res.status, j: await res.json().catch(() => null) };
    });
    expect(ext.s).toBe(403);
    expect(ext.j?.error?.code).toBe("RO_GUARD_BLOCKED");
    // roApi 래퍼 — blocked:true는 실제 서버 응답이 아니라 사전 차단이다
    const api = roApi(page.context().request);
    expect((await api.get("/api/cart")).blocked).toBe(true);
    expect((await api.post("/api/agent/turn", {})).blocked).toBe(true);
    expect((await api.get("https://external.example.com/health")).blocked).toBe(true);
  });

  test("390×844 — 목록·상세 가로 overflow 없음", async ({ page }) => {
    await login(page);
    await openOrders(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.locator('.order-card[data-order-id="ord-a-ship"] .order-item-body').click();
    await expect(page.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

test.describe("[mock] 실데이터 부재 상태 — 응답 mock 별도 표시", () => {
  test("[mock:refund] 환불 라벨 — PENDING·REFUNDED 각각 실제 표시", async ({ page }) => {
    await login(page);
    await openOrders(page);
    const api = roApi(page.context().request);
    const r = await api.get("/api/orders?limit=50");
    const orders =
      (r.json as { data?: { orders?: { refund_status?: string | null }[] } })
        ?.data?.orders ?? [];
    const live = new Set(
      orders.map((o) => o.refund_status).filter((s) => s && s !== "NONE"),
    );
    // 두 상태 모두 실제 표시를 단정한다 — 실데이터가 있으면 그 카드로,
    // 부족한 상태는 응답만 mock해 채운다(실서버 PASS와 혼용 표기 금지).
    for (const c of [
      { st: "PENDING", label: "환불 처리 중" },
      { st: "REFUNDED", label: "환불 완료" },
    ] as const) {
      if (live.has(c.st)) {
        await expect(
          page.locator(".order-card-refund", { hasText: c.label }).first(),
        ).toBeVisible();
        continue;
      }
      const st = c.st;
      await page.route(/\/api\/orders(\?.*)?$/, async (route) => {
        const res = await route.fetch({ maxRedirects: 0 });
        const j = await res.json();
        if (j?.data?.orders?.length) j.data.orders[0].refund_status = st;
        await route.fulfill({ response: res, json: j });
      });
      await page.reload();
      // reload 후 SPA는 #/orders 해시를 유지해 이미 주문 목록이다 — 홈 전제의
      // openOrders('내 쇼핑' 클릭)는 해당 버튼이 없어 timeout난다
      // [PM B1 원인 판정 — 제품 결함 아닌 test navigation 결함].
      await expect(
        page.getByRole("heading", { name: "주문 목록" }),
      ).toBeVisible();
      await expect(
        page.locator(".order-card-refund", { hasText: c.label }).first(),
      ).toBeVisible();
      await page.unroute(/\/api\/orders(\?.*)?$/);
    }
  });

  test("[mock:empty] 빈 주문 목록", async ({ page }) => {
    await login(page, "e2e-d");
    await page.route(/\/api\/orders(\?.*)?$/, async (route) => {
      const res = await route.fetch({ maxRedirects: 0 });
      const j = await res.json();
      if (j?.data) { j.data.orders = []; j.data.has_more = false; j.data.next_cursor = null; }
      await route.fulfill({ response: res, json: j });
    });
    await openOrders(page);
    await expect(page.getByText("주문 내역이 없어요")).toBeVisible();
    await expect(page.getByRole("button", { name: "쇼핑하러 가기" })).toBeVisible();
  });

  test("[mock:cancelled] 취소 완료+환불 완료 카드", async ({ page }) => {
    await login(page);
    await page.route(/\/api\/orders(\?.*)?$/, async (route) => {
      const res = await route.fetch({ maxRedirects: 0 });
      const j = await res.json();
      if (j?.data?.orders?.length) {
        j.data.orders[0].order_status = "CANCELLED";
        j.data.orders[0].cancel_status = "COMPLETED";
        j.data.orders[0].cancelled_at = "2026-10-10T12:00:00";
        j.data.orders[0].refund_status = "REFUNDED";
      }
      await route.fulfill({ response: res, json: j });
    });
    await openOrders(page);
    const first = page.locator(".order-card").first();
    await expect(first.locator(".order-card-head")).toContainText("취소완료");
    await expect(first.locator(".order-card-head")).toContainText("취소 완료");
    await expect(first.locator(".order-card-refund")).toHaveText("환불 완료");
  });
});

test.describe("[capture] 390×844 dark/light — 실서버 캡처", () => {
  for (const scheme of ["dark", "light"] as const) {
    test("주문 목록·상세·배송 — " + scheme, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: scheme,
        baseURL: RO_ORIGIN,
      });
      await installRoGuard(ctx);
      const p = await ctx.newPage();
      await login(p);
      await openOrders(p);
      await shot(p, "impl_orders_list_" + scheme);            // Ref079/091 대응
      await p.locator('.order-card[data-order-id="ord-a-ship"] .order-item-body').click();
      await expect(p.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
      await shot(p, "impl_order_detail_" + scheme);           // Ref080 대응(배송 중)
      // 결제 정보 섹션으로 스크롤 — Ref081 payment focus 대응
      await p.locator(".pay-row.total").scrollIntoViewIfNeeded();
      await shot(p, "impl_order_payment_" + scheme);
      await p.goto("/#/orders/ord-a-ship/shipping");
      await expect(p.getByRole("heading", { name: "배송 상태" })).toBeVisible();
      // shipping-focus 캡처 — timeline bbox 완전 노출 + scrollY 안정 후에만 쓴다.
      await expectShipFocus(p, scheme);
      await shot(p, "impl_order_shipping_" + scheme);
      await ctx.close();
    });
  }

  test("상태별 상세 캡처 — paid(no shipment)·preparing·REQUESTED (dark)", async ({ browser }) => {
    // 세션 쿠키는 page가 아니라 BrowserContext에 저장된다 — 같은 context의
    // 두 번째 page.goto('/')는 로그인 폼이 아니라 이미 로그인된 앱이라
    // placeholder가 없어 login()이 실패한다. owner별 상태는 각각 새
    // context(baseURL/viewport/dark/guard)로 분리하고 반드시 닫는다 [PM 검수].
    const mkCtx = async () => {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
        baseURL: RO_ORIGIN,
      });
      await installRoGuard(ctx);
      return ctx;
    };

    // Ref080 대응 — paid 상태이나 shipment 없음(ord-b-none)
    const ctxB = await mkCtx();
    try {
      const p = await ctxB.newPage();
      await login(p, "e2e-b");
      await p.goto("/#/orders/ord-b-none");
      await expect(p.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
      await shot(p, "impl_order_detail_paid_noship_dark");
    } finally {
      await ctxB.close();
    }

    // Ref084 대응 — 상품준비중(ord-a-pre)
    const ctxA = await mkCtx();
    try {
      const p = await ctxA.newPage();
      await login(p);
      await p.goto("/#/orders/ord-a-pre");
      await expect(p.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
      await shot(p, "impl_order_detail_preparing_dark");
    } finally {
      await ctxA.close();
    }

    // Ref090/091 대응 — 취소요청(REQUESTED) 실데이터 카드+상세
    const hit = await findOrderViaApi((o) => o.cancel_status === "REQUESTED");
    expect(hit, "REQUESTED 캡처 대상 실데이터 부재 — 상태를 보고한다").toBeTruthy();
    const ctxR = await mkCtx();
    try {
      const p = await ctxR.newPage();
      await login(p, hit!.code);
      await openOrders(p);
      await p.locator('.order-card[data-order-id="' + (hit!.order.id as string) + '"]').scrollIntoViewIfNeeded();
      await shot(p, "impl_orders_list_requested_dark");        // Ref091 대응
      await p.goto("/#/orders/" + (hit!.order.id as string));
      await expect(p.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
      await shot(p, "impl_order_detail_requested_dark");       // Ref090 대응
    } finally {
      await ctxR.close();
    }
  });

  test("캡처 노트 — Ref 비교 계획·알려진 차이 기록", async () => {
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(
      join(SHOT_DIR, "capture-notes.md"),
      [
        "# 06B 주문 화면 캡처 — Ref 비교 계획 (PMQA-048)",
        "",
        "## 대응 Reference ↔ 산출물",
        "- Ref079/091 주문 목록 → impl_orders_list_{dark,light} · impl_orders_list_requested_dark",
        "- Ref080 주문 상세(결제완료 카드) → impl_order_detail_{dark,light} · impl_order_detail_paid_noship_dark",
        "- Ref081 결제 정보 영역 → impl_order_payment_{dark,light} (Ref081 원본은 스크롤된 전체 캡처 — 결제 정보 비교는 양쪽 동일 영역의 supplemental 비교로 라벨)",
        "- Ref084 상품준비중 상세 → impl_order_detail_preparing_dark",
        "- Ref090 취소요청 상세 → impl_order_detail_requested_dark",
        "- 배송 섹션 → impl_order_shipping_{dark,light}",
        "- 비교 항목: 카드 anatomy 순서·라벨 위치·버튼 형태·정보 밀도·스크롤 구간",
        "",
        "## 알려진 차이(비교 캡션에 명기)",
        "- Ref080에는 도착 예정(ETA) 정보가 있다 — 'Reference도 배송 정보 없음' 주장 금지. 공통점은 PAID 상태뿐이고 impl_order_detail_paid_noship은 shipment 부재라 NOSHIP 차이로 명시",
        "- 배송 상태 타임라인 표현은 [Project] — Ref에 대응 상세 타임라인 미관측",
        "- OS/폰트 렌더링·상품 이미지·금액은 데모 데이터라 원본과 다르다",
        "- 영수증·포인트·송장·주소 변경·구매 확정은 의도적 미구현",
      ].join("\n"),
      { flag: "wx" },
    );
  });
});
