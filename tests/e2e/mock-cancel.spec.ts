// PMQA-062 — 06C 취소·환불 UX Mock 전용 브라우저 검증.
// 실제 서버·DB 0 — 가상 origin 위에서 정적 자산은 로컬 bytes fulfill,
// 모든 API는 등록 mock fulfill 또는 abort다. Mock 견적·결과는 실서버
// 계산이 아니다(검증 대상 = 소스 UI 플로우·가드, 정책 계산 아님).
// 네트워크 기록은 parent broker가 wx로 기록한다.
import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  connectWorkerClient,
  type ChannelWorkerClient,
} from "../helpers/ipc-channel.ts";
import {
  decideRequest,
  readStatic,
  MOCK_ORIGIN,
  type NetRec,
} from "./mock-guard.ts";

// ── 네트워크 기록 — route.continue는 이 파일 어디에도 없다. ──────
// 모든 요청은 fulfilled-static / fulfilled-mock / blocked-* / injected-failure
// 중 하나로 종결된다. violations = 서버 도달 가능성을 남긴 예상 밖 요청
// (미등록 API·미등록 정적 경로). 외부 origin은 전부 차단되며 위반이 아닌
// '차단 증거'로 기록한다(폰트 CDN 포함 — 로드 실패 허용, 기록만).
const netlog: NetRec[] = [];
const violations: NetRec[] = [];
// 브라우저 request/response/requestfailed 이벤트 — route 종결 로그와 1:1로
// 대조해 '기록 없이 지나간 요청'이 0인지를 증명한다 [PM preflight ②].
const reqEvents: { method: string; url: string }[] = [];
const serverAddrs: { url: string; ip: string | null }[] = [];
const failedEvents: { url: string; errorText: string }[] = [];
// serverAddr() 조회 실패 — null(peer 없음)로 치환하면 구분이 안 되므로
// 별도 기록하고 최종 단정에서 FAIL로 연결한다 [PM preflight ①].
const addrErrors: { url: string; error: string }[] = [];
// response listener의 비동기 기록 — teardown/afterAll 전 완료 대상.
const respPending: Promise<unknown>[] = [];
const rec = (r: NetRec, violation = false) => {
  netlog.push(r);
  if (violation) violations.push(r);
};

// request 이벤트 ↔ route 종결 로그 1:1 대조 + peer 집계 —
// afterAll(JSON 기록)과 [mock:netlog] 테스트(FAIL 단정)가 같은 계산을 쓴다.
function netCrosscheck() {
  const counted = new Map<string, number>();
  for (const r of netlog)
    counted.set(r.method + " " + r.url, (counted.get(r.method + " " + r.url) ?? 0) + 1);
  const unhandled: { method: string; url: string }[] = [];
  for (const e of reqEvents) {
    const k = e.method + " " + e.url;
    const c = counted.get(k) ?? 0;
    if (c > 0) counted.set(k, c - 1);
    else unhandled.push(e);
  }
  const loggedWithoutEvent = [...counted]
    .filter(([, n]) => n > 0)
    .map(([k, n]) => ({ key: k, count: n }));
  const realPeers = serverAddrs.filter((a) => a.ip !== null);
  return { unhandled, loggedWithoutEvent, realPeers };
}

type MockReply =
  | { status?: number; json: unknown }
  | { abort: true; note?: string }
  | { delayMs: number; status?: number; json: unknown };
type MockHandler =
  | MockReply
  | ((req: { method: string; url: string; body: string }) => MockReply | Promise<MockReply>);
const apiMocks = new Map<string, MockHandler>(); // "METHOD /api/path" — query 무시

function mockApi(method: string, path: string, h: MockHandler) {
  apiMocks.set(method.toUpperCase() + " " + path, h);
}
const mockJson = (method: string, path: string, json: unknown, status = 200) =>
  mockApi(method, path, { status, json });

async function installMockGuard(context: BrowserContext) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const m = req.method().toUpperCase();
    const url = req.url();
    const d = decideRequest(m, url);
    if (d.kind === "block") {
      rec({ method: m, url, disposition: d.disposition, note: d.reason },
        d.disposition !== "blocked-origin");
      return route.abort();
    }
    if (d.kind === "static") {
      rec({ method: m, url, disposition: "fulfilled-static" });
      if (!d.file) return route.fulfill({ status: 204 });
      return route.fulfill({
        status: 200,
        contentType: d.mime,
        body: readStatic(d.file),
      });
    }
    const key = m + " " + new URL(url, MOCK_ORIGIN).pathname;
    const h = apiMocks.get(key);
    if (!h) {
      rec({ method: m, url, disposition: "blocked-api" }, true);
      return route.abort();
    }
    const out = typeof h === "function"
      ? await h({ method: m, url, body: req.postData() ?? "" })
      : h;
    if ("abort" in out && out.abort) {
      rec({ method: m, url, disposition: "injected-failure", note: out.note });
      return route.abort();
    }
    const reply = out as { status?: number; json?: unknown; delayMs?: number };
    if (reply.delayMs)
      await new Promise((r) => setTimeout(r, reply.delayMs));
    rec({ method: m, url, disposition: "fulfilled-mock" });
    return route.fulfill({
      status: reply.status ?? 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(reply.json),
    });
  });
}

const test = base.extend({
  context: async ({ browser }, use) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: MOCK_ORIGIN,
      colorScheme: "dark", // dark 명명 캡처와 일치 — 생략 시 기본값은 light [PMQA-062]
      serviceWorkers: "block", // Worker/SW 우회 경로 차단 [PMQA-062]
    });
    // route 설치 전 이벤트를 먼저 연다 — 모든 요청이 목격된다.
    ctx.on("request", (req) => {
      reqEvents.push({ method: req.method(), url: req.url() });
    });
    ctx.on("response", (res) => {
      // route.fulfill은 네트워크를 타지 않는다 — serverAddr가 null이어야 하고,
      // null이 아닌 실제 peer가 관측되면 외부 전달 의심으로 위반 기록한다.
      // async listener는 fire-and-forget 금지 — Promise를 수집해 context
      // teardown/afterAll 이전에 전부 완료시킨다 [PM preflight ①].
      respPending.push((async () => {
        let addr: { ipAddress: string; port: number } | null;
        try {
          addr = await res.serverAddr();
        } catch (e) {
          // 조회 실패를 null(peer 없음)로 치환하지 않는다 — peer 여부가
          // 미확정인 채 지나가면 '실서버 도달 0' 증명이 깨진다 → 기록 + FAIL.
          addrErrors.push({ url: res.url(), error: String(e) });
          return;
        }
        serverAddrs.push({
          url: res.url(),
          ip: addr ? addr.ipAddress + ":" + addr.port : null,
        });
      })());
    });
    ctx.on("requestfailed", (req) => {
      failedEvents.push({
        url: req.url(),
        errorText: req.failure()?.errorText ?? "",
      });
    });
    await installMockGuard(ctx);
    try {
      await use(ctx);
    } finally {
      // response listener의 async 기록이 settle한 뒤에만 context를 닫는다 —
      // close 이후 resolve되는 지연 listener는 기록에서 빠져 대조를 속인다.
      await Promise.allSettled(respPending);
      await ctx.close(); // Worker/기록 실패는 FAIL — close는 항상 보장
    }
  },
});

// parent broker 소유 채널 — RO_* env 없는 직접 실행은 지원하지 않는다.
let w: ChannelWorkerClient | null = null;
test.beforeAll(async () => {
  const nonce = process.env.RO_WORKER_NONCE;
  const port = Number(process.env.RO_CHANNEL_PORT);
  if (!nonce || !Number.isInteger(port) || port <= 0)
    throw new Error(
      "RO_WORKER_NONCE/RO_CHANNEL_PORT 필수 — parent broker 통합 외 직접 실행 금지",
    );
  w = await connectWorkerClient({ nonce, port });
});
test.afterAll(async () => {
  // worker는 기록만 전송 — 실제 파일 기록은 부모 claim handle [PMQA-062].
  if (w) {
    // 지연된 response listener까지 전부 settle한 뒤 대조·기록한다 —
    // request 이벤트 ↔ route 종결 로그 1:1 대조는 netCrosscheck()와
    // [mock:netlog] 단정이 같은 계산을 공유한다 [PM preflight ①].
    await Promise.allSettled(respPending);
    const x = netCrosscheck();
    const byDisp: Record<string, number> = {};
    for (const r of netlog) byDisp[r.disposition] = (byDisp[r.disposition] ?? 0) + 1;
    await w.submit(
      "network.json",
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          origin: MOCK_ORIGIN,
          // route.continue/route.fetch/APIRequestContext는 소스에 없다 —
          // continue 0은 상수가 아니라 아래 이벤트 대조로 검증된다.
          total: netlog.length,
          byDisposition: byDisp,
          events: {
            request: reqEvents.length,
            response: serverAddrs.length,
            requestfailed: failedEvents.length,
          },
          crosscheck: {
            unhandled: x.unhandled,                     // request 이벤트는 떴는데 route 종결 기록이 없음
            loggedWithoutEvent: x.loggedWithoutEvent,   // route 로그는 있는데 request 이벤트가 없음
            realPeers: x.realPeers,                     // serverAddr 실측 peer — mock/fulfill은 null이어야 함
            addrErrors,                                 // serverAddr 조회 실패 — peer 미확정(위반 경로)
            failedEvents,                               // abort·차단으로 실패한 요청의 실제 errorText
          },
          violations,
          log: netlog,
        },
        null,
        2,
      ),
    );
    await w.submit(
      "mock-notes.md",
      [
        "# PMQA-062 Mock 취소 시트 검증 노트",
        "",
        "- Mock 견적·환불액·접수 결과는 실서버 계산이 아닌 고정 mock이다 — 정책 검증 아님.",
        "- 접수는 취소/환불 완료가 아니다 — REQUESTED 상태 문구만 검증했다.",
        "- Reference 없는 시나리오(복구·실패·중복)는 Project Mock UX로 표기한다.",
        "- mock_recovery_lost/mock_recovery_rejected.png — Project Mock UX 기록",
        "  (사유/최종확인/접수 3상태 캡처와 구별).",
        "- 폰트 CDN(jsdelivr)은 외부 origin이라 차단된다 — 폴백 폰트로 렌더됨(시각 차이 인지).",
        "- 비교 캡션: 상품/금액은 mock 값(코드뷰 모니터 A · 292,000원), OS·폰트 차이 명시.",
        "- 미검증 표시: EXPIRED/STALE 견적 재발급 경로·비정형 SUCCEEDED 저장 payload의",
        "  pending 유지·주문/사용자 전환 시나리오는 이번 Mock run에서 검증하지 않았다",
        "  (요청 범위의 최소 실증만 수행 — UI 전체 PASS로 인용 금지).",
      ].join("\n"),
    );
  }
  await w?.close();
});

// ── Mock 데이터 — contracts.ts 계약과 같은 형태, 값은 mock 표기. ──
const ORDER = {
  id: "ord-mock",
  version: 1,
  status: "CONFIRMED",
  created_at: "2026-10-10T01:00:00.000Z",
  cancelled_at: null,
  items: [
    {
      order_item_id: "oi-mock-1",
      variant_id: "v-a-27",
      product_name: "코드뷰 모니터 A",
      option_values: { 크기: "27인치" },
      unit_price_won: 289000,
      quantity: 1,
      line_total_won: 289000,
      image: "/assets/products/p-a.webp",
      product_id: "p-a",
    },
  ],
  items_total_won: 289000,
  shipping_fee_won: 3000,
  total_won: 292000,
  address_snapshot: { name: "테스트", phone: "010-0000-0000" },
  payment: {
    status: "PAID",
    paid_amount_won: 292000,
    paid_at: "2026-10-10T01:01:00.000Z",
    refund_status: "NONE",
    refunded_amount_won: 0,
    refunded_at: null,
  },
  shipping: null,
  cancel_request: null,
  cancel_eligible: true,
};

const ORDER_LIST = {
  ok: true,
  data: {
    orders: [
      {
        id: "ord-mock",
        created_at: "2026-10-10T01:00:00.000Z",
        item_summary: "코드뷰 모니터 A",
        total_won: 292000,
        order_status: "CONFIRMED",
        payment_status: "PAID",
        shipping_status: null,
        refund_status: "NONE",
        cancel_status: null,
        item_count: 1,
        first_item: {
          product_name: "코드뷰 모니터 A",
          option_values: { 크기: "27인치" },
          quantity: 1,
          line_total_won: 289000,
          image: "/assets/products/p-a.webp",
          product_id: "p-a",
        },
        cancel_eligible: true,
      },
    ],
    has_more: false,
    next_cursor: null,
  },
};

// 사유별로 구별되는 견적 — race에서 옛 응답 덮기를 탐지할 수 있게
// token·금액을 reason_code에 묶는다(실 서버 의미가 아닌 mock 구분값).
const quoteReply = (rc: string | null, won = 292000) => ({
  ok: true,
  data: {
    order_id: "ord-mock",
    order_version: 1,
    eligible: true,
    reasons: [],
    quote: {
      order_id: "ord-mock",
      order_version: 1,
      reason_code: rc ?? "CHANGE_OF_MIND",
      refund_amount_won: won,
      currency: "KRW",
      policy_version: "mock-1",
      expires_at: "2026-10-10T02:00:00.000Z",
      quote_token: "qt-" + (rc ?? "X"),
    },
  },
});

const EXEC_RESULT = {
  ok: true,
  data: {
    cancel_request_id: "cr-mock-1",
    status: "REQUESTED",
    refund_amount_won: 292000,
    order: {
      ...ORDER,
      cancel_request: {
        id: "cr-mock-1",
        status: "REQUESTED",
        reason_code: "CHANGE_OF_MIND",
        refund_amount_won: 292000,
        requested_at: "2026-10-10T01:05:00.000Z",
        completed_at: null,
      },
      payment: { ...ORDER.payment, refund_status: "PENDING" },
      cancel_eligible: false,
    },
  },
};

// 기본 mock 세트 — 각 테스트가 필요한 것만 덮어쓴다.
function installBaseMocks(order = ORDER, list = ORDER_LIST) {
  apiMocks.clear();
  mockJson("GET", "/api/session", {
    ok: true,
    user: { id: "u-a", display_name: "모크사용자" },
  });
  mockJson("GET", "/api/cart", {
    ok: true,
    data: {
      cart_id: "c-mock",
      version: 1,
      items: [],
      items_total_won: 0,
      shipping_fee_won: 0,
      total_won: 0,
      can_checkout: false,
    },
  });
  mockJson("GET", "/api/orders", list);
  mockJson("GET", "/api/orders/ord-mock", { ok: true, data: order });
  mockJson("GET", "/api/orders/ord-mock/cancel/eligibility", {
    ok: true,
    data: {
      order_id: "ord-mock",
      order_version: 1,
      eligible: true,
      reasons: [],
      policy_version: "mock-1",
    },
  });
  mockApi("GET", "/api/orders/ord-mock/cancel/quote", (req) => ({
    json: quoteReply(new URL(req.url).searchParams.get("reason_code")),
  }));
  mockJson("POST", "/api/orders/ord-mock/cancel/approve", {
    ok: true,
    data: { confirmation_id: "conf-mock-1" },
  });
  mockJson("POST", "/api/orders/ord-mock/cancel/execute", EXEC_RESULT);
  mockJson("GET", "/api/actions", {
    ok: false,
    error: { code: "NOT_FOUND", message: "intent 없음" },
  });
}

test.beforeEach(() => {
  apiMocks.clear();
  installBaseMocks();
  approveCalls = 0;
  executeCalls = 0;
  approveBodies.length = 0;
  executeBodies.length = 0;
});

// 주문 상세 → 취소 시트 진입까지 공통 경로.
async function openSheet(page: Page) {
  await page.goto("/#/orders/ord-mock");
  await expect(page.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
  await page.getByRole("button", { name: "취소하기" }).click();
  await expect(page.getByRole("heading", { name: "취소하는 이유는 무엇인가요?" })).toBeVisible();
  // 원앱 실행 계약 — localhost 가상 origin에서도 secure context가 유지돼
  // crypto.randomUUID가 실제로 동작함을 확인한다(mock 대체 없음) [PM preflight].
  expect(
    await page.evaluate(
      () =>
        window.isSecureContext === true &&
        typeof crypto.randomUUID === "function",
    ),
  ).toBe(true);
}

async function shot(page: Page, name: string) {
  const buf = await page.screenshot();
  await w!.submit(name + ".png", buf);
}

test("[mock:happy] 사유→견적→최종 확인→REQUESTED 접수", async ({ page }) => {
  countWrites(false);
  const seenReasons: (string | null)[] = [];
  mockApi("GET", "/api/orders/ord-mock/cancel/quote", (req) => {
    const rc = new URL(req.url).searchParams.get("reason_code");
    seenReasons.push(rc);
    return { json: quoteReply(rc) };
  });
  await openSheet(page);
  const next = page.getByRole("button", { name: "취소 내용 확인" });
  await expect(next).toBeDisabled();
  await page.getByText("단순 변심이에요").click();
  // 사유 단계에는 환불액을 표시하지 않는다 — 견적은 백그라운드 조회이며
  // 금액 노출은 최종 확인 단계뿐 [PMQA-075 F15 · Ref087/088].
  await expect(page.getByText(/환불 예정/).and(page.locator(".sheet *"))).toHaveCount(0);
  await expect(next).toBeEnabled();
  // 사유·견적 단계까지 명시 확인 없이 쓰기 0 [Luna QA].
  expect(seenReasons).toEqual(["CHANGE_OF_MIND"]);
  expect(approveCalls).toBe(0);
  expect(executeCalls).toBe(0);
  await next.click();
  await expect(page.getByText("전체 상품이 취소돼요")).toBeVisible();
  // 환불 예정액은 최종 확인 단계에서만 표시한다.
  await expect(page.locator(".pay-row.cancel-refund")).toContainText("환불 예정 금액");
  await page.getByRole("button", { name: "이 주문 취소 요청" }).click();
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible();
  expect(approveCalls).toBe(1);
  expect(executeCalls).toBe(1);
  // 실행 payload는 선택 사유·견적 토큰과 정확히 일치한다.
  const ab = JSON.parse(approveBodies[0]);
  expect(ab.reason_code).toBe("CHANGE_OF_MIND");
  expect(ab.quote_token).toBe("qt-CHANGE_OF_MIND");
  expect(JSON.parse(executeBodies[0]).confirmation_id).toBe("conf-mock-1");
});

test("[mock:ineligible] 부적격 주문 — 취소 CTA 비노출(fail-closed)", async ({ page }) => {
  installBaseMocks({ ...ORDER, cancel_eligible: false });
  await page.goto("/#/orders/ord-mock");
  await expect(page.getByRole("heading", { name: "주문 상세 내역" })).toBeVisible();
  await expect(page.getByRole("button", { name: "취소하기" })).toHaveCount(0);
});

test("[mock:guard] busy 중 중복 제출·닫기 차단 → approve/execute 각 1회", async ({ page }) => {
  // 즉시 성공 응답에서는 '사라진 버튼 클릭'으로 busy 방지를 검증할 수 없다 —
  // approve/execute를 지연시켜 실제 busy 구간을 만든다 [Luna QA].
  mockApi("POST", "/api/orders/ord-mock/cancel/approve", (req) => {
    approveCalls++;
    approveBodies.push(req.body);
    return { delayMs: 700, json: { ok: true, data: { confirmation_id: "conf-mock-1" } } };
  });
  mockApi("POST", "/api/orders/ord-mock/cancel/execute", (req) => {
    executeCalls++;
    executeBodies.push(req.body);
    return { delayMs: 700, json: EXEC_RESULT };
  });
  await openSheet(page);
  await page.getByText("단순 변심이에요").click();
  const next = page.getByRole("button", { name: "취소 내용 확인" });
  await expect(next).toBeEnabled();
  expect(approveCalls).toBe(0); // 확인 전 실행 0 [PMQA-062]
  await next.click();
  const submit = page.getByRole("button", { name: "이 주문 취소 요청" });
  await submit.click();
  // busy 구간 — confirm 화면에 실제 존재하는 컨트롤의 상태만 단정한다.
  // 사유 radio label은 confirm 단계에 없으므로 사유 클릭 시도는 검증할 수
  // 없고(없는 요소에 대한 click은 대기 후 오류만 낸다), 시트에는 Escape
  // 핸들러가 없으므로 키 닫기도 흉내내지 않는다 [PM preflight].
  const processing = page.locator(".sheet").getByRole("button", { name: "처리 중…" });
  await expect(processing).toBeDisabled();
  await expect(page.locator(".sheet").getByRole("button", { name: "이전" })).toBeDisabled();
  await expect(page.locator(".sheet").getByRole("button", { name: "닫기" })).toBeDisabled();
  // 첫 approve가 실제로 도달한 시점까지 기다려 busy 시작을 확정한다.
  await expect.poll(() => approveCalls, { timeout: 3000 }).toBe(1);
  // 2차 입력이 POST를 늘리지 않는다 — disabled 버튼에 대한 programmatic
  // dispatch는 React onClick까지 도달하지만 busyRef 가드가 두 번째 호출을
  // 막고, 오버레이 외곽 클릭은 busyRef 닫기 가드가 흡수한다.
  await processing.dispatchEvent("click");
  await page.mouse.click(8, 8);
  expect(approveCalls).toBe(1);
  await expect(page.locator(".sheet")).toBeVisible(); // 닫기 시도에도 열림 유지
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible({ timeout: 5000 });
  expect(approveCalls).toBe(1);
  expect(executeCalls).toBe(1);
  // 추가 입력이 payload를 바꾸지 않았다 — 처음 선택 사유 그대로.
  expect(JSON.parse(approveBodies[0]).reason_code).toBe("CHANGE_OF_MIND");
});

test("[mock:quote-race] 지연 첫 견적 vs 마지막 사유 — 최신 token·reason만 실행", async ({ page }) => {
  let first = true;
  let firstHandlerDone = false;
  mockApi("GET", "/api/orders/ord-mock/cancel/quote", async (req) => {
    const rc = new URL(req.url).searchParams.get("reason_code");
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 900));
      firstHandlerDone = true; // handler 완료 시점 — fulfill/브라우저 수신 이전이라 도달 증거 아님
      return { json: quoteReply(rc, 292000) };
    }
    // 마지막 사유의 견적은 뚜렷이 다른 mock 값 — 옛 응답 덮기가 생기면
    // 금액·토큰이 어긋나 즉시 검출된다 [Luna QA].
    return { json: quoteReply(rc, 100000) };
  });
  countWrites(false);
  await openSheet(page);
  // 느린 첫 응답의 실제 도착을 기다리는 리스너를 선택 전에 등록한다 —
  // handler 완료(firstHandlerDone)만으로는 브라우저 도달을 증명하지 못한다
  // [PM preflight].
  const firstQuote = page.waitForResponse(
    (res) =>
      res.url().includes("/cancel/quote") &&
      res.url().includes("reason_code=CHANGE_OF_MIND"),
  );
  await page.getByText("단순 변심이에요").click();
  await page.getByText("주문을 잘못 입력했어요").click(); // 느린 첫 견적 취소
  // 늦게 도착한 첫 응답은 버려지고 마지막 사유의 견적만 반영된다.
  await expect(
    page.locator(".sheet").getByText(/100,000원/),
  ).toBeVisible({ timeout: 5000 });
  const firstRes = await firstQuote; // 느린 첫 응답이 실제로 브라우저에 도착
  await firstRes.finished();          // 응답 본문 수신 완료
  expect(firstHandlerDone).toBe(true); // 보조 신호 — handler도 종료됨
  // 늦은 응답을 브라우저가 처리·React가 렌더할 시간을 실제로 준 뒤에도
  // 최신 견적이 유지되는지 단정한다 — 2연속 animation frame [PM preflight].
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(page.locator(".sheet").getByText(/100,000원/)).toBeVisible();
  await page.getByRole("button", { name: "취소 내용 확인" }).click();
  await page.getByRole("button", { name: "이 주문 취소 요청" }).click();
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible();
  const ab = JSON.parse(approveBodies[0]);
  expect(ab.reason_code).toBe("ORDER_MISTAKE");
  expect(ab.quote_token).toBe("qt-ORDER_MISTAKE");
});

test("[mock:net-fail] 자격 조회 실패 → '다시 확인' 재시도로 복구", async ({ page }) => {
  let eligCalls = 0;
  mockApi("GET", "/api/orders/ord-mock/cancel/eligibility", () => {
    eligCalls++;
    if (eligCalls === 1)
      return { abort: true, note: "주입 실패" };
    return {
      json: {
        ok: true,
        data: {
          order_id: "ord-mock",
          order_version: 1,
          eligible: true,
          reasons: [],
          policy_version: "mock-1",
        },
      },
    };
  });
  await page.goto("/#/orders/ord-mock");
  await page.getByRole("button", { name: "취소하기" }).click();
  // 주입된 첫 실패 — 실제 오류 문구와 '다시 확인' 재시도 통로를 단정한다.
  // 시트에는 Escape 핸들러가 없으므로 키 닫기를 흉내내지 않는다 [PM preflight].
  await expect(
    page.locator(".sheet").getByText("서버에 연결하지 못했어요"),
  ).toBeVisible({ timeout: 5000 });
  await page.locator(".sheet").getByRole("button", { name: "다시 확인" }).click();
  await expect(page.getByRole("heading", { name: "취소하는 이유는 무엇인가요?" })).toBeVisible({ timeout: 5000 });
  expect(eligCalls).toBe(2); // 주입 실패 1 + 명시 재시도 1
});

// ── 복구 검증 — 실제 유실 flow로 pending intent를 만든 뒤 '결과 확인'을
// 눌러 actions 조회→결정→실행/표시를 단정한다. goto+heading만으로는 복구
// 경로를 검증할 수 없으므로 approve/execute 호출 수까지 센다 [PM 중간검토].
let approveCalls = 0;
let executeCalls = 0;
const approveBodies: string[] = [];
const executeBodies: string[] = [];
// lost=true면 execute는 abort(응답 유실 주입), false면 성공.
// body는 실제 전송 payload를 기록해 사유/토큰/동일 키 재전송을 단정한다.
function countWrites(lost: boolean) {
  mockApi("POST", "/api/orders/ord-mock/cancel/approve", (req) => {
    approveCalls++;
    approveBodies.push(req.body);
    return { json: { ok: true, data: { confirmation_id: "conf-mock-1" } } };
  });
  mockApi("POST", "/api/orders/ord-mock/cancel/execute", (req) => {
    executeCalls++;
    executeBodies.push(req.body);
    return lost
      ? { abort: true as const, note: "execute 유실 주입" }
      : { json: EXEC_RESULT };
  });
}
async function createLostPending(page: Page) {
  countWrites(true);
  await openSheet(page);
  await page.getByText("단순 변심이에요").click();
  await page.getByRole("button", { name: "취소 내용 확인" }).click();
  await page.getByRole("button", { name: "이 주문 취소 요청" }).click();
  // 복구 배너는 intent가 보존되는 순간(approve POST)부터 이미 보인다 —
  // 유실 증거가 아니다. execute abort가 실제로 발화하고 LOST errMsg가
  // 표시된 뒤, busy가 끝나 '결과 확인'이 다시 활성화될 때까지 기다린다
  // [PM preflight].
  await expect.poll(() => executeCalls, { timeout: 5000 }).toBe(1);
  await expect(
    page.locator(".sheet").getByText(/'결과 확인'으로 이어서 확인할 수 있어요/),
  ).toBeVisible();
  await expect(
    page.locator(".sheet").getByRole("button", { name: "결과 확인" }),
  ).toBeEnabled();
  expect(approveCalls).toBe(1);
}
const actionsReply = (data: unknown) => ({ json: { ok: true, data } });

test("[mock:lost-ready] 응답 유실 → '결과 확인' → 원본 승인으로 실행 이어감", async ({ page }) => {
  await createLostPending(page);
  await shot(page, "mock_recovery_lost"); // Project Mock UX — 유실 복구 배너
  // READY 원본 승인(operation_id=저장 confirmation_id)으로 실행을 이어간다 —
  // 새 approve는 절대 발생하지 않는다 [cancel-recovery EXECUTE].
  mockApi("GET", "/api/actions", () =>
    actionsReply({
      operation_id: "conf-mock-1",
      kind: "CANCEL_ORDER",
      status: "READY",
      result: null,
      error_code: null,
    }),
  );
  countWrites(false); // 이후 execute는 성공 응답
  await page
    .locator(".sheet")
    .getByRole("button", { name: "결과 확인", exact: true })
    .click();
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible();
  expect(approveCalls).toBe(1);  // approve 재생성 0 — 원본 승인 재사용
  expect(executeCalls).toBe(2);  // 유실 1 + 복구 이어가기 1
});

test("[mock:recovery-succeeded] SUCCEEDED 조회 — 저장 결과를 접수 완료로 표시, 실행 0", async ({ page }) => {
  await createLostPending(page);
  mockApi("GET", "/api/actions", () =>
    actionsReply({
      operation_id: "conf-mock-1",
      kind: "CANCEL_ORDER",
      status: "SUCCEEDED",
      result: {
        cancel_request_id: "cr-mock-1",
        refund_amount_won: 292000,
        order_id: "ord-mock",
        status: "REQUESTED",
      },
      error_code: null,
    }),
  );
  await page
    .locator(".sheet")
    .getByRole("button", { name: "결과 확인", exact: true })
    .click();
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible();
  expect(executeCalls).toBe(1); // SUCCEEDED — 새 execute 0
  expect(approveCalls).toBe(1);
});

test("[mock:recovery-rejected] REJECTED 조회 — 서버 거절 메시지 표시, 실행 0", async ({ page }) => {
  await createLostPending(page);
  mockApi("GET", "/api/actions", () =>
    actionsReply({
      operation_id: "conf-mock-1",
      kind: "CANCEL_ORDER",
      status: "REJECTED",
      result: { code: "ALREADY_SHIPPED", message: "이미 출고된 주문이에요" },
      error_code: "ALREADY_SHIPPED",
    }),
  );
  await page
    .locator(".sheet")
    .getByRole("button", { name: "결과 확인", exact: true })
    .click();
  await expect(page.getByText("이미 출고된 주문이에요")).toBeVisible();
  await shot(page, "mock_recovery_rejected"); // Project Mock UX — 서버 거절 표시
  expect(executeCalls).toBe(1); // 거절 조회가 실행으로 오인되지 않는다
});

test("[mock:recovery-notfound] 기록 없음 — '다시 시도' 안내, 자동 재전송 0", async ({ page }) => {
  await createLostPending(page);
  mockApi("GET", "/api/actions", () => ({
    json: { ok: false, error: { code: "NOT_FOUND", message: "기록 없음" } },
  }));
  await page
    .locator(".sheet")
    .getByRole("button", { name: "결과 확인", exact: true })
    .click();
  await expect(
    page.getByText(/취소 요청 기록이 아직 없어요/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
  expect(approveCalls).toBe(1); // 자동 재전송 0 — 명시 '다시 시도'만 허용
  expect(executeCalls).toBe(1);
  // 명시 재시도 — 같은 키(action_key)·같은 payload의 재전송만 허용된다.
  mockApi("POST", "/api/orders/ord-mock/cancel/execute", (req) => {
    executeCalls++;
    executeBodies.push(req.body);
    return { json: EXEC_RESULT };
  });
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible();
  expect(approveCalls).toBe(2);
  const first = JSON.parse(approveBodies[0]);
  const retry = JSON.parse(approveBodies[1]);
  // '같은 요청 재전송'은 부분 필드 비교로 증명되지 않는다 — quote_token
  // 포함 body 전체의 deep equality를 단정한다 [PM preflight].
  expect(retry).toEqual(first);
  expect(executeCalls).toBe(2);
});

test("[mock:recovery-unknown] 알 수 없는 상태 — 실행 없이 재조회 안내", async ({ page }) => {
  await createLostPending(page);
  mockApi("GET", "/api/actions", () =>
    actionsReply({
      operation_id: "conf-mock-1",
      kind: "CANCEL_ORDER",
      status: "PROCESSING", // resolveCancelAction이 모르는 상태 → UNKNOWN
      result: null,
      error_code: null,
    }),
  );
  await page
    .locator(".sheet")
    .getByRole("button", { name: "결과 확인", exact: true })
    .click();
  await expect(
    page.getByText(/아직 결과를 확인할 수 없어요/),
  ).toBeVisible();
  expect(executeCalls).toBe(1); // UNKNOWN — 실행 없이 intent 유지
});

test("[mock:capture] 390×844 — 사유/최종확인/접수 3상태 캡처(dark·light)", async ({ page }) => {
  await openSheet(page);
  // Ref087/088/089 비교 상태 = 잘못 주문 1개·수량 1 — 사유는
  // ORDER_MISTAKE로 맞춘다(quoteReply가 query reason_code를 반영) [PM].
  await page.getByText("주문을 잘못 입력했어요").click();
  // 사유 단계에는 환불액 미표시 — 견적은 백그라운드 조회이며 다음 CTA의
  // 활성 조건이다 [PMQA-075 F15 · Ref087].
  await expect(page.getByText(/환불 예정/).and(page.locator(".sheet *"))).toHaveCount(0);
  await expect(page.getByRole("button", { name: "취소 내용 확인" })).toBeEnabled();
  // [PMQA-063 중간검수 — 기본 단정] fullpage layout + 3단계 CTA 모두 부분이
  // 아니라 완전히 viewport 안에 있어야 한다(toBeInViewport ratio:1).
  const sheetBox = await page.locator(".cancel-sheet").boundingBox();
  expect(sheetBox && Math.round(sheetBox.height)).toBe(844);
  expect(sheetBox && Math.round(sheetBox.width)).toBe(390);
  await expect(page.locator(".cancel-top")).toBeVisible();
  await expect(
    page.locator(".cancel-cta .btn"),
  ).toBeInViewport({ ratio: 1 });
  // 상품 가격·수량 표기 — Ref087/088의 '단가 · 수량' 행 [MN062-VIS1 해소 단정].
  await expect(
    page.locator(".cancel-item-pr").first(),
  ).toContainText("289,000원 · 1개");
  await shot(page, "cancel_reason_dark");
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, "cancel_reason_light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "취소 내용 확인" }).click();
  await expect(page.getByText("전체 상품이 취소돼요")).toBeVisible();
  // 확인 단계에도 같은 스냅샷 가격·수량 + 서버 견적 환불 예정액 강조 행.
  await expect(
    page.locator(".cancel-item-pr").first(),
  ).toContainText("289,000원 · 1개");
  await expect(page.locator(".pay-row.cancel-refund")).toContainText("292,000원");
  await expect(
    page.locator(".cancel-cta .btn"),
  ).toBeInViewport({ ratio: 1 });
  // 390×600 — CTA 완전 노출 + 본문 스크롤로 취소 안내까지 도달 가능한지 단정한
  // 뒤 390×844로 복원해 기존 캡처를 저장한다(추가 캡처 슬롯 없음).
  await page.setViewportSize({ width: 390, height: 600 });
  await expect(
    page.locator(".cancel-cta .btn"),
  ).toBeInViewport({ ratio: 1 });
  await page
    .locator(".cancel-body")
    .evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator(".cancel-note")).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  // 600 단정에서 남은 본문 스크롤을 되돌린다 — scrollTop>0 상태의 촬영은
  // Ref088 대응 상단 정보(제목·상품 행)를 가린다 [PM gate].
  await page
    .locator(".cancel-body")
    .evaluate((el) => { el.scrollTop = 0; });
  expect(
    await page.locator(".cancel-body").evaluate((el) => el.scrollTop),
  ).toBe(0);
  await shot(page, "cancel_confirm_dark");
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, "cancel_confirm_light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "이 주문 취소 요청" }).click();
  await expect(page.getByText("취소 요청이 접수됐어요")).toBeVisible();
  await expect(
    page.locator(".cancel-item-pr").first(),
  ).toContainText("289,000원 · 1개");
  await expect(
    page.locator(".cancel-cta .btn"),
  ).toBeInViewport({ ratio: 1 });
  await shot(page, "cancel_accepted_dark");
  await page.emulateMedia({ colorScheme: "light" });
  await shot(page, "cancel_accepted_light");
  // done 390×600 — 접수 화면의 단일 CTA도 완전 노출.
  await page.setViewportSize({ width: 390, height: 600 });
  await expect(
    page.locator(".cancel-cta .btn"),
  ).toBeInViewport({ ratio: 1 });
});

test("[mock:netlog] 위반 0 — 미등록 도달·실서버 peer·기록 누락 없음", async () => {
  // 마지막 테스트 — 지연된 response listener까지 확정한 뒤 누적 기록을
  // 전부 단정한다. afterAll이 JSON을 기록할 뿐이라 단정이 없으면 위반도
  // PASS로 지나간다 [PM preflight ①].
  await Promise.allSettled(respPending);
  const x = netCrosscheck();
  expect(violations).toEqual([]);            // 미등록 API·정적 경로 abort
  expect(x.unhandled).toEqual([]);           // request 이벤트인데 route 미종결
  expect(x.loggedWithoutEvent).toEqual([]);  // route 로그만 있는 요청
  expect(x.realPeers).toEqual([]);           // fulfill 외 실제 peer 관측
  expect(addrErrors).toEqual([]);            // serverAddr 조회 실패 = peer 미확정
});
