// W05 내 주문 목록 — Ref079/091의 카드 anatomy [Observed 구조].
// 상태 헤더+우측 상태일 → '결제 상세 >' → 썸네일+스냅샷 상품 행 → 지원 CTA.
// 카드 클릭/결제 상세는 W06 상세로, '배송 조회' 칩은 상세의 배송 섹션 앵커로 이동한다.
import { useEffect, useRef, useState } from "react";
import { apiSafe, fmtWon, type ApiResult } from "../api.ts";
import type { OrderListItem } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { CancelSheet } from "../components/CancelSheet.tsx";
import { OrderCard } from "../components/OrderCard.tsx";
import {
  canRequestCancel, cardHead, cardRightLabel, koShortDate, showShipChip,
  refundLabel,
} from "../../order-display.ts";

type OrdersPage = {
  orders: OrderListItem[];
  next_cursor: string | null;
  has_more: boolean;
};

export function Orders({
  onOpenOrder,
  onOpenShop,
  onOpenShipping,
}: {
  onOpenOrder: (orderId: string) => void;
  onOpenShop: () => void;
  onOpenShipping: (orderId: string) => void;
}) {
  const [res, setRes] = useState<ApiResult<OrdersPage> | null>(null);
  const [list, setList] = useState<OrderListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreErr, setMoreErr] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<{ id: string; summary: string } | null>(null);
  // 동시 '더 보기' 요청 잠금 — 응답 역전·중복 추가를 막는다 [PMQA-048 보조 기준].
  const moreLock = useRef(false);

  async function loadFirst() {
    const r = await apiSafe<OrdersPage>("/api/orders");
    setRes(r);
    if (r.ok) {
      setList(r.data.orders);
      setCursor(r.data.next_cursor);
      setHasMore(r.data.has_more);
    }
    return r;
  }
  useEffect(() => {
    loadFirst();
  }, []);

  async function loadMore() {
    if (!cursor || moreLock.current) return;
    moreLock.current = true;
    setLoadingMore(true);
    setMoreErr(null);
    const r = await apiSafe<OrdersPage>(
      "/api/orders?cursor=" + encodeURIComponent(cursor),
    );
    // 실패해도 기존 목록은 그대로 둔다 — 하단 인라인 오류+재시도 [PM 지침].
    if (r.ok) {
      setList((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...r.data.orders.filter((o) => !seen.has(o.id))];
      });
      setCursor(r.data.next_cursor);
      setHasMore(r.data.has_more);
    } else {
      setMoreErr(r.error.message);
    }
    setLoadingMore(false);
    moreLock.current = false;
  }

  if (!res) return <Loading text="주문 내역을 불러오는 중…" />;
  if (!res.ok)
    return (
      <ErrorState text="주문 내역을 불러오지 못했어요" onRetry={() => loadFirst()} />
    );

  return (
    <div className="screen">
      <h2 className="section-title">주문 목록</h2>
      {list.length === 0 ? (
        <Empty
          text="주문 내역이 없어요"
          action={<button className="btn primary" onClick={onOpenShop}>쇼핑하러 가기</button>}
        />
      ) : (
        <div className="order-card-list">
          {list.map((o) => {
            const head = cardHead(o);
            const right = cardRightLabel(o);
            const fi = o.first_item;
            return (
              <OrderCard
                key={o.id}
                orderId={o.id}
                headLabel={head.label}
                headMuted={head.tone === "muted"}
                rightLabel={right}
                refundLabel={refundLabel(o)}
                shipChip={showShipChip(o)}
                onShip={() => onOpenShipping(o.id)}
                detailDateLabel={koShortDate(o.paid_at ?? o.created_at)}
                onOpenDetail={() => onOpenOrder(o.id)}
                items={
                  fi
                    ? [
                        {
                          key: o.id,
                          name: fi.product_name,
                          option: Object.values(fi.option_values).join(" · ") || null,
                          qty: fi.quantity,
                          lineWon: fi.line_total_won,
                          image: fi.image,
                          productId: fi.product_id,
                        },
                      ]
                    : [
                        {
                          // first_item 없음(품목 조인 실패) — 요약+주문 총액만 표시하고
                          // 확인할 수 없는 품목 금액·수량은 만들어 넣지 않는다 [PM048 검수].
                          key: o.id,
                          name: o.item_summary,
                          image: null,
                          productId: null,
                          clickable: true,
                        },
                      ]
                }
                extraItemCount={fi && (o.item_count ?? 0) > 1 ? (o.item_count ?? 0) - 1 : 0}
                totalWon={o.total_won}
                onCancel={canRequestCancel(o) ? () => setCancelFor({ id: o.id, summary: o.item_summary }) : undefined}
              />
            );
          })}

          {hasMore && (
            <button className="btn ghost" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "불러오는 중…" : "더 보기"}
            </button>
          )}
          {moreErr && (
            <div className="state-box error">
              목록을 더 불러오지 못했어요 — {moreErr}
              <div>
                <button className="btn ghost" onClick={loadMore} disabled={loadingMore}>
                  다시 시도
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {cancelFor && (
        <CancelSheet
          orderId={cancelFor.id}
          itemSummary={cancelFor.summary}
          onClose={(changed) => {
            setCancelFor(null);
            // 취소 반영 시 첫 페이지부터 다시 읽는다 — 카드 상태·CTA가 바뀐다.
            if (changed) loadFirst();
          }}
        />
      )}
    </div>
  );
}
