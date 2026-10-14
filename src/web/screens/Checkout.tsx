// W04 주문서·모의 결제 (UI 전용 — Agent가 호출할 수 없는 checkout 경로).
// Ref051/054 구조: 배송지(flat, 페이지 배경 위) → '일반 배송 상품 N건' 헤더
// (카드 밖) + 상품 카드 1개(상품 행 + '주문 금액' 요약 행) → '총 결제 금액'
// 독립 flat 섹션(토글로 펼침) → 하단 'N원 결제하기' + 모의결제 단일 안내
// [Observed→구현, PMQA-040]. 큰 섹션 사이의 밴드 구분 구조는 Observed이고,
// 8px 치수는 측정값이 아닌 [Project] 토큰이다(styles.css .checkout-band 동일 명시).
// 견적(5분 서명 토큰) → 확인 클릭 → Processing → 성공 시 W04-C 결제 완료로 이동.
// 같은 클릭의 재시도는 같은 idempotency key를 쓰고, 견적이 바뀌면 새 키를 쓴다
// (토큰 해시가 payload라 같은 키+다른 견적은 IDEMPOTENCY_CONFLICT가 된다).
//
// [복구 계약] 미확정 CHECKOUT intent는 quote 성공 여부와 독립적으로 렌더된다.
// 커밋 직후 응답 유실 → 카트가 비워진 상태로 reload하면 견적 자체가
// VALIDATION(빈 카트)으로 실패하므로, pending 복구 UI가 견적 성공에 의존하면
// 결제했는지 영영 확인할 수 없다. pending이 있으면 복구가 최우선이고,
// 저장된 원본 payload는 현재 quote 없이도 재전송할 수 있어야 한다 [PM 지침].
import { useEffect, useRef, useState } from "react";
import { apiSafe, fmtWon, newActionKey, AMBIGUOUS_CODES, type ApiResult } from "../api.ts";
import type { CheckoutQuoteView, CheckoutTarget } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { productImg } from "../display-meta.ts";
import { IcChevronDown } from "../icons.tsx";
import {
  listPendingByKind, putPending, removePending, lookupAction,
  type PendingWrite,
} from "../pending.ts";
import { pendingScope } from "../pending.ts";
import { boundFor, createOpGuard, type Bound } from "../checkout-guard.ts";

type Phase = "confirm" | "processing" | "error";

export function Checkout({
  onOpenComplete,
  onOpenCart,
  target,
}: {
  onOpenComplete: (orderId: string) => void;
  onOpenCart: () => void;
  // PMQA-067 — 없으면 legacy 전체 카트 견적, 있으면 선택/바로 구매 견적.
  // INVALID는 파싱 실패 라우트 — 어떤 견적도 발급하지 않는다.
  target?: CheckoutTarget | { kind: "INVALID" };
}) {
  // 견적은 발급 대상·actor에 묶어 저장한다 — boundFor가 현재 컨텍스트의
  // 견적만 풀어준다 [PMQA-067-R2 ②].
  const [quote, setQuote] = useState<Bound<ApiResult<CheckoutQuoteView>> | null>(null);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendings, setPendings] = useState<PendingWrite[]>(() =>
    listPendingByKind("CHECKOUT"),
  );
  // actor 바인딩을 React state로 동기화한다 — bindPendingUser가 늦게 잡히는
  // 세션 복원·직접 해시 진입에서 scope 변경이 견적 재발급을 유발하게 한다
  // [PMQA-067-R2 추가 검수].
  const [scope, setScope] = useState<string | null>(() => pendingScope());
  // 구매 대상 변경 감지 — 같은 checkout 라우트 안에서 전체↔선택↔바로구매가
  // 바뀌면 견적·행동 키를 무효화하고 다시 견적을 받는다.
  const targetKey = JSON.stringify(target ?? null);
  // targetKey의 최신값을 passive effect 밖에서도 읽는다 — 새 start() 없이
  // 대상만 바뀐 렌더 직후 창에서도 이전 작업의 늦은 응답이 stale이게 한다.
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const [quoteOpen, setQuoteOpen] = useState(false);
  const actionKey = useRef<string | null>(null);
  const busyRef = useRef(false); // 연타·재시도+새견적 동시요청 동기 차단
  // 세대·actor 가드 — 대상 변경·계정 전환·unmount 이후 도착한 늦은 응답은
  // 화면 상태·pending intent·화면 이동을 건드리지 않는다 [PMQA-067-R2].
  const guardRef = useRef<ReturnType<typeof createOpGuard> | null>(null);
  guardRef.current ??= createOpGuard(pendingScope, () => targetKeyRef.current);
  const guard = guardRef.current;
  const barRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

  // 견적은 발급 대상(targetKey)+actor에 묶인다 — 대상·계정이 바뀐 상태에서
  // 이전 견적의 금액·결제 버튼이 남거나 이전 토큰으로 결제되지 않게 한다.
  const cur = boundFor(quote, targetKey, scope);

  // unmount 이후 도착하는 늦은 응답을 전부 무효화한다.
  useEffect(() => () => guard.invalidate(), [guard]);

  // 고정 하단바 높이만큼 본문 하단 여백을 둔다 (Cart와 같은 --bb-h 패턴).
  useEffect(() => {
    const bar = barRef.current;
    const screen = screenRef.current;
    if (!bar || !screen || typeof ResizeObserver === "undefined") return;
    const apply = () =>
      screen.style.setProperty("--bb-h", bar.offsetHeight + "px");
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [cur]);

  useEffect(() => {
    const on = () => {
      setPendings(listPendingByKind("CHECKOUT"));
      setScope(pendingScope()); // actor 바인딩·전환을 구독해 재견적으로 이어준다
    };
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  async function loadQuote() {
    const op = guard.start();
    if (!op.scope) return null; // actor 미바인딩 — 견적을 발급하지 않는다.
    // 세션 복원 등으로 바인딩이 늦어지면 scope state 변경이 이 호출을 다시
    // 발생시킨다 (effect deps에 scope 포함).
    const reqKey = targetKey; // 이 견적이 응답하는 구매 대상
    // 견적 대상: 없음=전체 카트(legacy GET), DIRECT=바로 구매, CART_SELECTED=선택 항목.
    // INVALID 라우트는 견적을 발급하지 않는다 — 잘못된 대상을 전체 카트로 대체하지 않는다.
    const r: ApiResult<CheckoutQuoteView> =
      !target
        ? await apiSafe<CheckoutQuoteView>("/api/checkout/quote")
        : target.kind === "INVALID"
          ? { ok: false, error: { code: "VALIDATION", message: "주문 대상을 확인할 수 없어요. 다시 시도해 주세요." } }
          : await apiSafe<CheckoutQuoteView>("/api/checkout/quote", {
              method: "POST",
              body: JSON.stringify(
                target.kind === "DIRECT"
                  ? { source: "DIRECT", variant_id: target.variant_id, quantity: target.quantity }
                  : { source: "CART_SELECTED", cart_item_ids: target.cart_item_ids },
              ),
            });
    if (guard.stale(op)) return r; // 늦은 응답 — 대상·actor 변경 후에는 적용하지 않는다
    setQuote({ key: reqKey, scope: op.scope, value: r });
    if (r.ok) actionKey.current = newActionKey(); // 새 견적 = 새 행동 키
    return r;
  }
  useEffect(() => {
    // 대상이 바뀌면 이전 견적·행동 키를 즉시 무효화한다 — 새 견적 도착
    // 전까지 이전 대상의 금액·결제 버튼이 남지 않게 한다 [PMQA-067-R2 ②].
    actionKey.current = null;
    setQuote(null);
    setPhase("confirm");
    setNotice(null);
    const scope0 = pendingScope();
    let mine = true;
    loadQuote().then((r) => {
      // 다른 대상·다른 actor의 작업이 이후 시작됐으면 안내를 적용하지 않는다.
      if (!mine || pendingScope() !== scope0) return;
      if (r?.ok && r.data.items.length === 0)
        setNotice("주문할 상품이 없어요. 장바구니에서 담아 주세요.");
    });
    return () => {
      mine = false;
    };
    // targetKey·scope가 바뀌면 이전 견적·키를 더는 쓸 수 없다 — loadQuote 내부의
    // guard가 늦은 응답 적용을 차단하고, 성공 시 actionKey를 새로 발급한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, scope]);

  const pending = pendings[0] ?? null;

  async function confirm() {
    // 이미 처리 중이거나 미확정 intent가 남아 있으면 새 결제를 막는다 —
    // 미해결 intent를 먼저 '결과 확인/다시 결제하기'로 정리하게 한다.
    // cur은 현재 대상+actor에 묶인 견적 — 대상 전환 직후 이전 견적의
    // 토큰으로 결제되는 것을 boundFor가 차단한다 [PMQA-067-R2 ②].
    // 클릭 시점의 실제 바인딩으로 한 번 더 재확인한다 — 렌더 이후 scope가
    // 어긋난 찰나의 클릭을 차단한다 [PMQA-067-R2 추가 검수].
    const live = boundFor(quote, targetKey, pendingScope());
    if (!live?.ok || phase === "processing" || busyRef.current || pending) return;
    busyRef.current = true;
    const op = guard.start();
    if (!op.scope) {
      busyRef.current = false;
      return; // actor 미바인딩 — intent를 기록할 수 없어 실제 전송하지 않는다
    }
    const key = actionKey.current ?? newActionKey();
    actionKey.current = key;
    const pw: PendingWrite = {
      uiKey: key,
      kind: "CHECKOUT",
      path: "/api/checkout/confirm",
      method: "POST",
      payload: { quote_token: live.data.quote_token, idempotency_key: key },
      label: "모의 결제 " + fmtWon(live.data.total_won),
      at: Date.now(),
    };
    putPending(pw); // 전송 전 보존 — commit 직후 응답 유실·탭 종료 대비
    setPhase("processing");
    setNotice(null);
    const r = await apiSafe<{ order_id: string; total_won: number }>(
      "/api/checkout/confirm",
      { method: "POST", body: JSON.stringify(pw.payload) },
    );
    busyRef.current = false;
    if (guard.stale(op)) {
      // 대상 변경·계정 전환·unmount 이후 도착한 응답 — 서버에서 성공했어도
      // 상태·intent·이동을 건드리지 않는다. intent는 보낸 actor의 pending
      // 버킷에 남아, 그 계정이 돌아와 '결과 확인'할 때 명시 복구된다
      // [PMQA-067-R2 ①].
      return;
    }
    if (r.ok) {
      removePending(key);
      onOpenComplete(r.data.order_id); // W04 → W04-C 결제 완료
      return;
    }
    setPhase("error");
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      // 서버 커밋 여부 불확정 — intent 유지 + 복구 스트립.
      setNotice("주문 결과를 확인하지 못했어요. '결과 확인'으로 이어서 확인할 수 있어요.");
      setPhase("confirm");
      return;
    }
    // 확정 거절 — intent 해제. STALE_QUOTE/CART_BLOCKED는 새 견적으로 재확인.
    removePending(key);
    if (r.error.code === "STALE_QUOTE" || r.error.code === "CART_BLOCKED") {
      setNotice(r.error.message);
      setPhase("confirm");
      await loadQuote();
      return;
    }
    setNotice("주문 실패: " + r.error.message);
    setPhase("confirm");
  }

  // 미확정 intent의 서버 기록 조회. NOT_FOUND는 미도착/미커밋일 수 있어
  // 새 키/새 견적으로 전환하지 않고 같은 키+같은 payload의 명시 재시도만 허용한다.
  async function checkPending(p: PendingWrite) {
    // 계정 전환 직후 이전 actor의 pending 행 클릭을 차단한다 — p는 렌더
    // 시점의 스냅샷이라, 현재 actor·현재 버킷에 실제로 남아 있는 intent인지
    // 시작 전에 다시 확인한다 [PMQA-067-R2 재검수].
    if (
      pendingScope() !== scope ||
      !listPendingByKind("CHECKOUT").some((x) => x.uiKey === p.uiKey)
    )
      return;
    if (busyRef.current) return;
    busyRef.current = true;
    const op = guard.start();
    const r = await lookupAction(p);
    busyRef.current = false;
    if (guard.stale(op)) return; // 늦은 조회 결과 — 현재 화면에 적용하지 않는다
    if (!r.ok) {
      if (r.error.code === "NOT_FOUND") {
        setNotice(
          "요청 기록이 없어요. '다시 결제하기'로 같은 요청을 재전송할 수 있어요.",
        );
        return;
      }
      setNotice("아직 결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
      return;
    }
    const st = r.data.status;
    if (st === "SUCCEEDED") {
      removePending(p.uiKey);
      const orderId = (r.data.result as { order_id?: string } | undefined)?.order_id;
      if (orderId) {
        onOpenComplete(orderId);
        return;
      }
      setNotice("처리가 완료된 요청이었어요. 주문 내역에서 확인해 주세요.");
      return;
    }
    if (st === "REJECTED") {
      removePending(p.uiKey);
      setNotice("주문이 거절되었어요. 견적을 새로 받아 다시 확인해 주세요.");
      await loadQuote();
      return;
    }
    setNotice("아직 처리 중이에요. 잠시 후 다시 확인해 주세요.");
  }

  // 저장된 intent 그대로 재전송 — 같은 키+같은 payload라 서버가 replay 또는
  // 최초 실행으로 안전하게 처리한다. 새 키 발급·자동 재전송은 하지 않는다.
  // quote와 무관하게 저장 payload만 쓰므로 견적 실패 상태에서도 동작한다.
  async function retryPending(p: PendingWrite) {
    // checkPending과 같은 이유 — 재전송은 실제 쓰기라 더 엄격히 막는다.
    if (
      pendingScope() !== scope ||
      !listPendingByKind("CHECKOUT").some((x) => x.uiKey === p.uiKey)
    )
      return;
    if (busyRef.current) return;
    busyRef.current = true;
    const op = guard.start();
    setPhase("processing");
    const r = await apiSafe<{ order_id: string; total_won: number }>(p.path, {
      method: p.method,
      body: JSON.stringify(p.payload),
    });
    busyRef.current = false;
    if (guard.stale(op)) return;
    setPhase("confirm");
    if (r.ok) {
      removePending(p.uiKey);
      onOpenComplete(r.data.order_id);
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      setNotice("아직 결과를 확인할 수 없어요. '결과 확인'으로 이어서 확인하세요.");
      return;
    }
    // 확정 거절 — 저장 intent 해제 후 새 견적으로 재확인하게 한다.
    removePending(p.uiKey);
    if (r.error.code === "STALE_QUOTE" || r.error.code === "CART_BLOCKED") {
      setNotice(r.error.message);
      await loadQuote();
      return;
    }
    setNotice("주문 실패: " + r.error.message);
  }

  // 미확정 intent 복구 영역 — quote 상태와 독립적으로 항상 렌더한다.
  const pendingBlock = pending ? (
    <div className="state-box">
      <b>결제 결과를 확인하지 못했어요</b>
      <ul className="pending-list">
        <li>
          <span className="pending-label">{pending.label}</span>
          <span className="pending-actions">
            <button
              className="link"
              disabled={phase === "processing"}
              onClick={() => checkPending(pending)}
            >
              결과 확인
            </button>
            <button
              className="link"
              disabled={phase === "processing"}
              onClick={() => retryPending(pending)}
            >
              다시 결제하기
            </button>
          </span>
        </li>
      </ul>
      <div className="muted sm">
        결과가 확정되기 전에는 새 결제를 진행할 수 없어요.
      </div>
    </div>
  ) : null;

  if (!cur)
    return pendingBlock ? (
      <div className="screen checkout-screen">
        <h2 className="section-title">주문서</h2>
        {pendingBlock}
        <Loading text="주문서를 준비하는 중…" />
      </div>
    ) : (
      <Loading text="주문서를 준비하는 중…" />
    );

  return (
    <div className="screen checkout-screen" ref={screenRef}>
      <h2 className="section-title">주문서</h2>
      {notice && <div className="state-box">{notice}</div>}
      {pendingBlock}
      {!cur.ok ? (
        // 견적 실패 — pending이 있으면 복구가 우선이므로 ErrorState로 가리지 않는다.
        pending ? (
          <div className="muted sm">
            주문서를 새로 불러오지 못했어요. 위 복구 동작으로 먼저 결과를 확인해 주세요.
          </div>
        ) : cur.error.code === "VALIDATION" ? (
          // 빈 카트·배송지 누락 같은 VALIDATION은 재시도가 아니라 상태 안내다.
          <Empty
            text={cur.error.message}
            action={<button className="btn primary" onClick={onOpenCart}>장바구니로</button>}
          />
        ) : (
          <ErrorState
            text={cur.error.message}
            onRetry={() => { setQuote(null); loadQuote(); }}
          />
        )
      ) : cur.data.items.length === 0 ? (
        <Empty
          text="주문할 상품이 없어요"
          action={<button className="btn primary" onClick={onOpenCart}>장바구니로</button>}
        />
      ) : (
        <>
          {/* 배송지 — Ref051: 페이지 배경 위 열린(flat) 영역, 카드 아님.
              accent 수취인 '…님에게 배송' 헤드라인 → 주소/상세 → 이름·연락처
              보조 행 [Observed→구현·PMQA-075 F25].
              변경 칩·배송 요청 필드는 미지원이라 렌더하지 않는다. */}
          <section className="checkout-sec checkout-ship">
            <h3 className="section-title">배송지 (테스트)</h3>
            <div className="ship-to">
              <span className="accent">{cur.data.address.name}</span> 님에게 배송
            </div>
            <div className="ship-addr">
              {cur.data.address.address} {cur.data.address.detail}
            </div>
            <div className="ship-sub">
              {cur.data.address.name} ({cur.data.address.phone})
            </div>
          </section>

          {/* Ref051: 큰 섹션 사이를 밴드로 구분하는 구조 [Observed].
              8px 치수는 [Project] 토큰. */}
          <div className="checkout-band" aria-hidden="true" />

          {/* 일반 배송 상품 N건 — Ref051: 섹션 헤더는 카드 밖 페이지 배경 위,
              상품 행과 '주문 금액' 요약 행은 카드 1개 안 [Observed→구현].
              도착예정 라벨은 서버 데이터가 없어 렌더하지 않는다. */}
          <section className="checkout-sec">
            <h3 className="section-title">
              일반 배송 상품 {cur.data.items.length}건
            </h3>
            <div className="checkout-card">
              <ul className="checkout-items">
                {cur.data.items.map((i) => (
                  // DIRECT는 cart_item_id가 없다 — variant로 대체한다.
                  <li key={i.cart_item_id ?? i.variant_id} className="checkout-item">
                    <div className="checkout-thumb">
                      <img
                        src={productImg({ product_id: i.product_id, image: i.image })}
                        alt=""
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    </div>
                    <div className="checkout-item-info">
                      <div className="checkout-item-name">
                        {i.product_name}
                        {Object.values(i.option_values).length
                          ? ", " + Object.values(i.option_values).join(", ")
                          : ""}
                      </div>
                      {/* Ref051: '단가 · 수량' 한 행 인라인 표기 [Observed·
                          PMQA-075 F25]. 서버 unit_price_won이 정본 — 합계
                          (unit×qty)를 단가처럼 보이게 쓰지 않는다.
                          도착예정·무료배송 라벨은 서버 데이터가 없어 렌더하지
                          않는다(미지원 약속 임의 생성 금지). */}
                      <div className="checkout-item-price">
                        <b>{fmtWon(i.unit_price_won)}</b>
                        <span className="checkout-item-qty"> · {i.quantity}개</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* 주문 금액 — Ref051 카드 내 요약 행(접힘: 총액+chevron).
                  펼치면 카드 밖 '총 결제 금액' 독립 섹션(Ref054)이 열린다 —
                  Ref051의 카드 내 행과 Ref054의 독립 결제 영역은 서로 다른
                  영역이며, 표시 전용 토글 [Project]이 두 상태를 잇는다. */}
              <button
                type="button"
                className="cart-quote-toggle checkout-quote-toggle"
                aria-expanded={quoteOpen}
                aria-controls="checkout-quote-rows"
                aria-label={quoteOpen ? "주문 금액 상세 접기" : "주문 금액 상세 펼치기"}
                onClick={() => setQuoteOpen((v) => !v)}
              >
                <span className="cart-quote-label">주문 금액</span>
                <span className="cart-quote-amount">
                  <b>{fmtWon(cur.data.total_won)}</b>
                  <IcChevronDown size={15} />
                </span>
              </button>
            </div>
          </section>

          {/* 총 결제 금액 — Ref054: 상품 카드와 분리된 독립 flat 섹션
              (페이지 배경 위, 카드 아님). 강조 총액 행 + 상품 금액/배송비
              보조 행 — 지원 데이터만 표시하고 쿠폰/포인트/할인 행은
              미지원이므로 렌더하지 않는다. 위 카드의 '주문 금액' 토글이
              이 영역을 연다 [Observed Ref054→구현]. */}
          <section
            id="checkout-quote-rows"
            className="checkout-total"
            hidden={!quoteOpen}
          >
            <div className="checkout-total-head">
              <span className="checkout-total-label">총 결제 금액</span>
              <b>{fmtWon(cur.data.total_won)}</b>
            </div>
            <div className="cart-quote-row">
              <span className="muted">상품 금액</span>
              <span>{fmtWon(cur.data.items_total_won)}</span>
            </div>
            <div className="cart-quote-row">
              <span className="muted">배송비</span>
              <span>{fmtWon(cur.data.shipping_fee_won)}</span>
            </div>
          </section>

          {/* Ref051/054: 주요 CTA는 하단 전체폭 'N원 결제하기'. Ref의 동의
              미세 문구 위치에 모의결제 안내를 둔다 — '실제 결제는 발생하지
              않는다'를 CTA 주변 단일 문구로 명시 [PM 지침]. */}
          <div className="bottom-bar checkout-paybar" ref={barRef}>
            <button
              className="btn primary"
              disabled={phase === "processing" || !!pending}
              onClick={confirm}
            >
              {phase === "processing" ? "결제 처리 중…" : fmtWon(cur.data.total_won) + " 결제하기"}
            </button>
            <div className="pay-note">
              주문 내용을 확인했어요 · 모의 결제로 실제 결제는 발생하지 않아요
            </div>
          </div>
        </>
      )}
    </div>
  );
}
