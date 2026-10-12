// 주문 카드 — Ref orders(079/080/081/084/090/091)의 Observed anatomy.
// 상태 헤더+우측 상태일 → 썸네일 + 상품정보열(날짜/결제상세 링크 → 상품명 → 옵션 →
// 가격/수량 → 주문단위 배송비) → 지원 CTA [PMQA-048-C].
// Ref079는 'N.N 결제 상세 >'가 썸네일 우측 정보열 첫줄이고, Ref080은 배송비가 첫
// 품목 정보열 아래 주문 단위로 표시된다 — 별도 전체폭 행으로 두지 않는다.
// 카드 안에 버튼을 중첩하지 않기 위해 품목 행은 div > (thumb button | info 열)이고,
// info 열 안의 링크·상품 본문은 각각 sibling button이다.
import { productImg } from "../display-meta.ts";

export type OrderCardItem = {
  key: string;
  name: string;                 // 스냅샷 상품명
  option?: string | null;       // 스냅샷 옵션 요약 — 있을 때만 표시
  qty?: number;                 // 스냅샷 수량(해당 품목) — 미확인이면 생략
  lineWon?: number;             // 스냅샷 품목 금액 — 주문 총액 아님. 미확인이면 생략
  image: string | null;         // 조회 시점 카탈로그 이미지 — 스냅샷 아님
  productId: string | null;     // 조회 시점 상품 링크 참조 — 스냅샷 아님
  clickable?: boolean;          // false면 비interactive div — 없는 클릭을 약속하지 않는다
};

export function OrderCard({
  headLabel,
  headMuted = false,
  rightLabel,
  shipChip,
  onShip,
  detailDateLabel,
  hideLink = false,
  onOpenDetail,
  items,
  extraItemCount = 0,
  totalWon,
  deliveryLine,
  onCancel,
  onItemClick,
  refundLabel,
  orderId,
}: {
  orderId?: string;             // 회귀 선택자용 DOM 속성 — 시각 표시는 하지 않는다
  headLabel: string;
  headMuted?: boolean;
  rightLabel: { text: string; tone: "ok" | "muted" } | null;
  shipChip?: boolean;
  onShip?: () => void;
  detailDateLabel?: string;     // "10.4 (일) 결제 상세 >" 앞의 결제일
  hideLink?: boolean;           // 상세 화면 자체의 카드 — 링크 행 생략 [Observed Ref080]
  onOpenDetail: () => void;
  items: OrderCardItem[];
  extraItemCount?: number;      // 목록에서 첫 품목 외 N건 — 0이면 미표시
  totalWon?: number;            // 다품목일 때만 '외 N건'과 별도로 보여주는 주문 총액
  deliveryLine?: string | null; // "무료배송"/"배송비 N원" — null이면 미표시
  onCancel?: () => void;        // 제공 시에만 '취소하기' 버튼
  onItemClick?: (it: OrderCardItem) => void; // 없으면 onOpenDetail로 대체
  refundLabel?: string | null;   // 서버 refund_status 라벨 — 실데이터 있을 때만 별도 표시
}) {
  const fmt = (n: number) => n.toLocaleString("ko-KR") + "원";
  const itemClick = onItemClick ?? (() => onOpenDetail());
  return (
    <article className="order-card" data-order-id={orderId}>
      <div className="order-card-head">
        <b className={headMuted ? "muted" : ""}>{headLabel}</b>
        <span className="order-card-head-right">
          {rightLabel && (
            <span className={"order-card-right " + rightLabel.tone}>
              {rightLabel.text}
            </span>
          )}
          {shipChip && onShip && (
            <button className="order-ship-chip" onClick={onShip}>
              배송 조회
            </button>
          )}
        </span>
      </div>

      {refundLabel && <div className="order-card-refund">{refundLabel}</div>}

      {items.map((it, idx) => {
        const first = idx === 0;
        const clickable = it.clickable !== false;
        const thumb = (
          <span className="cart-thumb order-thumb">
            <img
              src={productImg({ product_id: it.productId ?? it.key, image: it.image })}
              alt=""
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          </span>
        );
        const infoBody = (
          <>
            <span className="order-item-name">
              {it.name}
              {extraItemCount > 0 && first ? " 외 " + extraItemCount + "건" : ""}
            </span>
            {it.option && <span className="muted sm">{it.option}</span>}
            {it.lineWon != null && (
              <span className="order-item-price">
                <b>{fmt(it.lineWon)}</b>
                {it.qty != null && <span className="muted"> · {it.qty}개</span>}
              </span>
            )}
          </>
        );
        return (
          <div key={it.key} className="order-card-item">
            {/* 썸네일도 실제 진입 경로 — 클릭 불가 품목은 span으로 [중첩 button 금지] */}
            {clickable ? (
              <button className="order-thumb-btn" onClick={() => itemClick(it)} aria-label={it.name}>
                {thumb}
              </button>
            ) : (
              thumb
            )}
            <span className="order-item-info">
              {/* 'N.N 결제 상세 >' — 정보열 첫줄 [Observed Ref079], 상세 카드는 생략 [Observed Ref080] */}
              {first && !hideLink && (
                <button className="order-card-link" onClick={onOpenDetail}>
                  {detailDateLabel} 결제 상세 &gt;
                </button>
              )}
              {clickable ? (
                <button className="order-item-body" onClick={() => itemClick(it)}>
                  {infoBody}
                </button>
              ) : (
                <span className="order-item-body">{infoBody}</span>
              )}
              {/* 주문 단위 배송비 — 첫 품목 정보열 아래 [Observed Ref080]. 품목별 반복·총액 혼동 금지 */}
              {first && deliveryLine && (
                <span className="muted sm order-item-delivery">{deliveryLine}</span>
              )}
            </span>
          </div>
        );
      })}

      {totalWon != null && (
        <div className="order-card-total muted sm">
          {extraItemCount > 0
            ? "외 " + extraItemCount + "건 포함 주문 총액 " + fmt(totalWon)
            : "주문 총액 " + fmt(totalWon)}
        </div>
      )}

      <div className="order-card-actions">
        {onCancel && (
          <button className="btn ghost oc-btn" onClick={onCancel}>
            취소하기
          </button>
        )}
        {/* CS Brain 미구축 — 클릭 가능한 문의 CTA를 약속하지 않고 준비 중 상태로
            둔다. 가짜 목적지·더미 답변 금지 [PMQA-06B-053 MJ053-2] */}
        <button
          className="btn ghost oc-btn"
          disabled
          title="AI 주문 문의 기능은 아직 준비 중이에요"
        >
          AI 주문 문의 · 준비 중
        </button>
      </div>
    </article>
  );
}
