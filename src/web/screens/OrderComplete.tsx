// W04-C 결제 완료 — Ref077 구조: 체크+'결제했어요' → 상품 행 → 배송지 →
// '홈으로 가기' CTA + '주문 상세 내역 보기' 링크 [Observed→구현].
// GET /api/orders/:id 조회 전용 — 쓰기를 하지 않아 reload/재진입이 안전하다.
// 상품 이미지는 현재 카탈로그 이미지(조회 시점 참고용, null이면 글자 fallback).
// 이름/옵션/수량/가격/주소는 저장된 주문 스냅샷만 사용한다 [PM 지침].
//
// [성공 표시 계약] '결제했어요' 구조는 실제 주문이 CONFIRMED + PAID +
// paid_amount=total일 때만 보여준다. 직접 URL 진입으로 취소/환불/결제정보 없는
// 주문을 열면 신규 결제 성공으로 오인하지 않게 실제 상태+상세 진입을 보여준다.
import { useEffect, useRef, useState } from "react";
import { apiSafe, fmtWon, type ApiResult } from "../api.ts";
import type { OrderView } from "../../contracts.ts";
import { ErrorState, Loading } from "../components/CommerceState.tsx";
import { productImg } from "../display-meta.ts";
import { IcCheck } from "../icons.tsx";

export function OrderComplete({
  orderId,
  onOpenOrder,
  onOpenHome,
}: {
  orderId: string;
  onOpenOrder: (orderId: string) => void;
  onOpenHome: () => void;
}) {
  const [res, setRes] = useState<ApiResult<OrderView> | null>(null);
  const [retrying, setRetrying] = useState(false);
  const seq = useRef(0);

  // orderId가 바뀌면 이전 조회를 무효화하고 loading으로 리셋한다 —
  // 늦게 도착한 이전 GET이 새 route에 옛 주문을 덮지 않는다.
  useEffect(() => {
    const my = ++seq.current;
    setRes(null);
    apiSafe<OrderView>("/api/orders/" + encodeURIComponent(orderId)).then((r) => {
      if (my === seq.current) setRes(r);
    });
    return () => {
      seq.current++; // unmount 시 늦은 응답이 setRes를 호출하지 않게 폐기한다.
    };
  }, [orderId]);

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    const my = ++seq.current;
    setRes(null);
    const r = await apiSafe<OrderView>("/api/orders/" + encodeURIComponent(orderId));
    if (my === seq.current) setRes(r);
    setRetrying(false);
  }

  if (!res) return <Loading text="주문을 확인하는 중…" />;
  // 응답은 왔지만 route가 이미 다른 주문을 가리킨다 — 옛 본문이 flash되지 않게
  // 바로 loading으로 되돌린다 (useEffect가 곧 새 GET을 시작한다).
  if (res.ok && res.data.id !== orderId)
    return <Loading text="주문을 확인하는 중…" />;
  if (!res.ok)
    return (
      <div className="screen">
        <ErrorState
          text={
            res.error.code === "NOT_FOUND"
              ? "주문을 찾을 수 없어요"
              : "주문을 불러오지 못했어요"
          }
          onRetry={retry}
        />
        <button className="btn ghost" onClick={onOpenHome}>홈으로 가기</button>
      </div>
    );
  const o = res.data;

  // 신규 결제 성공으로 볼 조건 — 나머지 상태는 성공 구조로 오인시키지 않는다.
  // 취소 요청이 진행 중/완료된 주문도 신규 결제 화면이 아니다.
  const paidOk =
    o.status === "CONFIRMED" &&
    o.payment?.status === "PAID" &&
    o.payment.paid_amount_won === o.total_won &&
    !o.cancel_request;

  const stateLabel = !paidOk
    ? o.status === "CANCELLED"
      ? "취소된 주문이에요"
      : o.cancel_request
        ? o.cancel_request.status === "COMPLETED"
          ? "취소가 완료된 주문이에요"
          : "취소 요청이 접수된 주문이에요"
      : !o.payment
        ? "결제 정보를 확인할 수 없어요"
        : o.payment.refund_status !== "NONE"
          ? o.payment.refund_status === "REFUNDED"
            ? "환불이 완료된 주문이에요"
            : "환불 처리 중인 주문이에요"
          : "주문 상태를 확인해 주세요"
    : null;

  return (
    <div className="screen oc-screen">
      <div className="oc-head">
        {paidOk ? (
          <>
            <span className="oc-check" aria-hidden="true"><IcCheck size={26} /></span>
            <h2 className="oc-title">결제했어요</h2>
            <div className="muted">{fmtWon(o.total_won)} · 모의 결제</div>
          </>
        ) : (
          <>
            <h2 className="oc-title">주문 상태</h2>
            <div className="muted">{stateLabel}</div>
          </>
        )}
      </div>

      {/* 주문 상품 — 스냅샷 이름/옵션/수량/가격 + 조회 시점 카탈로그 이미지 */}
      <div className="checkout-block">
        <h3 className="section-title">주문 상품 {o.items.length}건</h3>
        <ul className="cart-list">
          {o.items.map((i) => (
            <li key={i.order_item_id} className="cart-item">
              <div className="cart-thumb">
                <img
                  src={productImg({ product_id: i.product_id ?? i.variant_id, image: i.image })}
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
              <div className="cart-right"><b>{fmtWon(i.line_total_won)}</b></div>
            </li>
          ))}
        </ul>
      </div>

      <div className="checkout-block">
        <h3 className="section-title">배송지</h3>
        {/* Ref077과 동일 계층 — 주소/상세가 주 정보, 이름·연락처는 보조 */}
        <div>{o.address_snapshot.address} {o.address_snapshot.detail}</div>
        <div className="muted">
          {o.address_snapshot.name} · {o.address_snapshot.phone}
        </div>
      </div>

      <div className="muted sm oc-note">
        모의 결제로 실제 청구는 발생하지 않았어요.
      </div>

      {/* Ref077: 짧은 본문일 때 CTA 그룹은 viewport 하단 — 긴 본문은 스크롤로 도달 */}
      <div className="oc-cta">
        <button className="btn primary oc-home" onClick={onOpenHome}>
          홈으로 가기
        </button>
        <button className="link oc-detail" onClick={() => onOpenOrder(o.id)}>
          주문 상세 내역 보기
        </button>
      </div>
    </div>
  );
}

