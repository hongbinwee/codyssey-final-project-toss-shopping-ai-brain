// W04 주문서·모의 결제 (UI 전용 — Agent가 호출할 수 없는 checkout 경로).
// Ref051 구조: 배송지 → 일반 배송 상품 N건(실제 상품 이미지) → 주문 금액
// 접힘/펼침 → 모의결제 명시+동의 → 하단 총액+'N원 결제하기' [Observed→구현].
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
import type { CheckoutQuoteView } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { productImg } from "../display-meta.ts";
import { IcChevronDown } from "../icons.tsx";
import {
  listPendingByKind, putPending, removePending, lookupAction,
  type PendingWrite,
} from "../pending.ts";

type Phase = "confirm" | "processing" | "error";

export function Checkout({
  onOpenComplete,
  onOpenCart,
}: {
  onOpenComplete: (orderId: string) => void;
  onOpenCart: () => void;
}) {
  const [quote, setQuote] = useState<ApiResult<CheckoutQuoteView> | null>(null);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendings, setPendings] = useState<PendingWrite[]>(() =>
    listPendingByKind("CHECKOUT"),
  );
  const [quoteOpen, setQuoteOpen] = useState(false);
  const actionKey = useRef<string | null>(null);
  const busyRef = useRef(false); // 연타·재시도+새견적 동시요청 동기 차단
  const seq = useRef(0); // 비동기 순서 가드 — 늦은 응답이 최신 상태를 덮지 않게
  const barRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);

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
  }, [quote]);

  useEffect(() => {
    const on = () => setPendings(listPendingByKind("CHECKOUT"));
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  async function loadQuote() {
    const my = ++seq.current;
    const r = await apiSafe<CheckoutQuoteView>("/api/checkout/quote");
    if (my !== seq.current) return r; // 이후 복구 동작이 시작됐으면 덮지 않는다
    setQuote(r);
    if (r.ok) actionKey.current = newActionKey(); // 새 견적 = 새 행동 키
    return r;
  }
  useEffect(() => {
    loadQuote().then((r) => {
      if (r?.ok && r.data.cart.items.length === 0)
        setNotice("주문할 상품이 없어요. 장바구니에서 담아 주세요.");
    });
  }, []);

  const pending = pendings[0] ?? null;

  async function confirm() {
    // 이미 처리 중이거나 미확정 intent가 남아 있으면 새 결제를 막는다 —
    // 미해결 intent를 먼저 '결과 확인/다시 결제하기'로 정리하게 한다.
    if (!quote?.ok || phase === "processing" || busyRef.current || pending) return;
    busyRef.current = true;
    seq.current++;
    const key = actionKey.current ?? newActionKey();
    actionKey.current = key;
    const pw: PendingWrite = {
      uiKey: key,
      kind: "CHECKOUT",
      path: "/api/checkout/confirm",
      method: "POST",
      payload: { quote_token: quote.data.quote_token, idempotency_key: key },
      label: "모의 결제 " + fmtWon(quote.data.cart.total_won),
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
    if (busyRef.current) return;
    busyRef.current = true;
    const my = ++seq.current;
    const r = await lookupAction(p);
    busyRef.current = false;
    if (my !== seq.current) return; // 이후 동작이 시작됐으면 무시
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
    if (busyRef.current) return;
    busyRef.current = true;
    const my = ++seq.current;
    setPhase("processing");
    const r = await apiSafe<{ order_id: string; total_won: number }>(p.path, {
      method: p.method,
      body: JSON.stringify(p.payload),
    });
    busyRef.current = false;
    if (my !== seq.current) return;
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

  if (!quote)
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
      {!quote.ok ? (
        // 견적 실패 — pending이 있으면 복구가 우선이므로 ErrorState로 가리지 않는다.
        pending ? (
          <div className="muted sm">
            주문서를 새로 불러오지 못했어요. 위 복구 동작으로 먼저 결과를 확인해 주세요.
          </div>
        ) : quote.error.code === "VALIDATION" ? (
          // 빈 카트·배송지 누락 같은 VALIDATION은 재시도가 아니라 상태 안내다.
          <Empty
            text={quote.error.message}
            action={<button className="btn primary" onClick={onOpenCart}>장바구니로</button>}
          />
        ) : (
          <ErrorState
            text={quote.error.message}
            onRetry={() => { setQuote(null); loadQuote(); }}
          />
        )
      ) : quote.data.cart.items.length === 0 ? (
        <Empty
          text="주문할 상품이 없어요"
          action={<button className="btn primary" onClick={onOpenCart}>장바구니로</button>}
        />
      ) : (
        <>
          {/* 배송지 — Ref051 최상단 블록. 변경칩/메모 필드는 미지원이라 렌더하지 않는다. */}
          <div className="checkout-block">
            <h3 className="section-title">배송지 (테스트)</h3>
            {/* Ref051: 주소/상세가 배송지의 주 정보 — 이름·연락처는 보조 [Observed→구현] */}
            <div>{quote.data.address.address} {quote.data.address.detail}</div>
            <div className="muted">
              {quote.data.address.name} · {quote.data.address.phone}
            </div>
          </div>

          {/* 일반 배송 상품 N건 — 실제 상품 이미지 [Observed Ref051→구현].
              도착예정 라벨은 서버 데이터가 없어 렌더하지 않는다.
              주문 금액 행은 Ref051처럼 같은 상품 카드 안에 연결된다. */}
          <div className="checkout-block">
            <h3 className="section-title">일반 배송 상품 {quote.data.cart.items.length}건</h3>
            <ul className="cart-list">
              {quote.data.cart.items.map((i) => (
                <li key={i.cart_item_id} className="cart-item">
                  <div className="cart-thumb">
                    <img
                      src={productImg({ product_id: i.product_id, image: i.image })}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </div>
                  <div className="cart-info">
                    <div>{i.product_name}</div>
                    <div className="muted">
                      {Object.values(i.option_values).join(" · ")} · {i.quantity}개
                    </div>
                  </div>
                  <div className="cart-right"><b>{fmtWon(i.unit_price_won * i.quantity)}</b></div>
                </li>
              ))}
            </ul>

            {/* 주문 금액 — Ref051의 접힌 행('주문 금액 N원 >') + Ref054의 펼쳐진
                금액 행. 토글 동작 자체는 미관측이라 [Project] 접힘/펼침으로 구현.
                할인·쿠폰·포인트 행은 미지원이므로 상품 금액·배송비만 표시한다. */}
            <div className="checkout-quote-block">
            <button
              type="button"
              className="cart-quote-toggle"
              aria-expanded={quoteOpen}
              aria-controls="checkout-quote-rows"
              aria-label={quoteOpen ? "주문 금액 상세 접기" : "주문 금액 상세 펼치기"}
              onClick={() => setQuoteOpen((v) => !v)}
            >
              <span className="cart-quote-label">주문 금액</span>
              <span className="cart-quote-amount">
                <b>{fmtWon(quote.data.cart.total_won)}</b>
                <IcChevronDown size={15} />
              </span>
            </button>
            <div
              id="checkout-quote-rows"
              className="cart-quote-rows"
              hidden={!quoteOpen}
            >
              <div className="cart-quote-row">
                <span className="muted">상품 금액</span>
                <span>{fmtWon(quote.data.cart.items_total_won)}</span>
              </div>
              <div className="cart-quote-row">
                <span className="muted">배송비</span>
                <span>{fmtWon(quote.data.cart.shipping_fee_won)}</span>
              </div>
            </div>
            </div>
          </div>

          {/* 결제 — Ref의 개인정보 동의/포인트/쿠폰/멤버십 문구는 미지원 업무로
              오인되므로 복제하지 않고, 주문 확인+모의결제 안내로 표현한다 [PM 지침]. */}
          <div className="checkout-block">
            <h3 className="section-title">결제</h3>
            <div className="muted sm">모의 결제 — 실제 결제는 발생하지 않아요</div>
            <div className="muted">
              주문 내용을 확인했어요. 모의 결제로 실제 청구는 발생하지 않아요.
            </div>
          </div>

          {/* Ref051/054: 주요 CTA는 하단 전체폭 'N원 결제하기' — 총액 상세는
              본문의 주문 금액 행에 둔다. [Observed→구현] */}
          <div className="bottom-bar checkout-paybar" ref={barRef}>
            <button
              className="btn primary"
              disabled={phase === "processing" || !!pending}
              onClick={confirm}
            >
              {phase === "processing" ? "결제 처리 중…" : fmtWon(quote.data.cart.total_won) + " 결제하기"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
