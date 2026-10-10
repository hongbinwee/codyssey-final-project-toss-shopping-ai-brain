// W03 장바구니 (Phase 2+: 수량 변경/삭제/실패 복구 → 주문 진입).
// 쓰기 요청은 idempotency_key를 단다. intent는 전송 전 pending 저장소에 보존하고
// 확정 결과에서만 해제한다 — 응답 유실(AMBIGUOUS)이면 같은 키로 결과 조회하고,
// 확정 거절(VERSION_CONFLICT 등)이면 자동 재실행 없이 최신 상태 재확인을 요구한다.
// 미확정 intent가 하나라도 있으면 수량·삭제·주문 버튼을 잠근다.
import { useEffect, useRef, useState } from "react";
import {
  apiSafe, fmtWon, newActionKey, AMBIGUOUS_CODES, type ApiResult,
} from "../api.ts";
import type { CartItemView, CartView } from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { productImg } from "../display-meta.ts";
import {
  listPending, putPending, removePending, lookupAction,
  type PendingWrite,
} from "../pending.ts";

export function Cart({
  cart,
  onCartLoaded,
  onOpenShop,
  onCheckout,
  onOpenProduct,
}: {
  cart: CartView | null;
  onCartLoaded: (v: CartView) => void;
  onOpenShop: () => void;
  onCheckout: () => void;
  onOpenProduct: (id: string) => void;
}) {
  const [res, setRes] = useState<ApiResult<CartView> | null>(
    cart ? { ok: true, data: cart } : null,
  );
  const [loading, setLoading] = useState(!cart);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendings, setPendings] = useState<PendingWrite[]>(() => listPending());
  const busyRef = useRef(false); // 동기 중복 쓰기 차단 (state 반영 전 이중 클릭)
  // 마운트 GET이 늦게 도착해 그 사이 확정된 쓰기(v2)를 과거(v1)로 덮는 레이스 방지.
  // 쓰기가 새 상태를 적용할 때 seq를 올려 진행 중인 read를 무효화한다.
  const readSeq = useRef(0);

  useEffect(() => {
    const on = () => setPendings(listPending());
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  async function reload() {
    const my = ++readSeq.current;
    const r = await apiSafe<CartView>("/api/cart");
    if (readSeq.current !== my) return r; // 늦은 stale read — 적용하지 않는다
    setRes(r);
    if (r.ok) onCartLoaded(r.data);
    return r;
  }
  useEffect(() => {
    reload().then(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const locked = busy || pendings.length > 0;

  // 쓰기 공통: intent를 전송 전 보존 → 전송 → 확정 결과에서만 해제.
  async function runWrite(
    item: CartItemView,
    kind: "UPDATE_CART" | "REMOVE_CART",
    payload: Record<string, unknown>,
    label: string,
  ) {
    const pw: PendingWrite = {
      uiKey: payload.idempotency_key as string,
      kind,
      path: "/api/cart/items/" + item.cart_item_id,
      method: kind === "UPDATE_CART" ? "PATCH" : "DELETE",
      payload,
      label,
      at: Date.now(),
    };
    putPending(pw); // 서버 commit 후 응답 유실·탭 종료 대비 — 전송 전 보존
    const r = await apiSafe<{ cart: CartView }>(pw.path, {
      method: pw.method,
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      removePending(pw.uiKey);
      // replay(저장 snapshot)면 최신 카트를 회수 — 그 사이 다른 변경이 섞일 수 있다.
      if (r.replayed) {
        await reload();
        setNotice("이미 처리된 요청이에요 (재전송 복원)");
        return;
      }
      readSeq.current++; // 진행 중이던 read보다 이 쓰기 결과가 최신이다
      const v = { ok: true as const, data: r.data.cart };
      setRes(v);
      onCartLoaded(r.data.cart);
      setNotice(null);
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      setNotice("결과를 확인하지 못했어요. '결과 확인'으로 이어서 확인할 수 있어요.");
      return; // pending 유지 → 복구 UI
    }
    removePending(pw.uiKey);
    if (r.error.code === "VERSION_CONFLICT") {
      setNotice("카트가 변경되었어요. 최신 상태로 다시 불러왔습니다.");
      await reload();
      return;
    }
    // VERSION_CONFLICT 외 확정 거절(OUT_OF_STOCK·UNAVAILABLE·NOT_FOUND)도
    // 최신 CartView를 회수한다 — 재고/판매 상태가 바뀐 거절에서 stale
    // can_checkout·수량 버튼이 남지 않도록(retryPending과 동일 기준).
    setNotice("변경 실패: " + r.error.message);
    await reload();
  }

  async function changeQty(item: CartItemView, quantity: number) {
    if (locked || busyRef.current || !res?.ok) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const key = newActionKey();
    await runWrite(
      item,
      "UPDATE_CART",
      {
        quantity,
        expected_cart_version: res.data.version,
        expected_variant_version: item.variant_version,
        idempotency_key: key,
      },
      item.product_name + " 수량 " + quantity + "개",
    );
    setBusy(false);
    busyRef.current = false;
  }

  async function removeItem(item: CartItemView) {
    if (locked || busyRef.current || !res?.ok) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    const key = newActionKey();
    await runWrite(
      item,
      "REMOVE_CART",
      {
        expected_cart_version: res.data.version,
        idempotency_key: key,
      },
      item.product_name + " 삭제",
    );
    setBusy(false);
    busyRef.current = false;
  }

  // 미확정 intent의 서버 기록을 조회한다. SUCCEEDED라도 카트 본문은
  // historical snapshot일 수 있으므로 항상 GET으로 재동기화한다.
  async function checkPending(p: PendingWrite) {
    const r = await lookupAction(p);
    if (!r.ok) {
      if (r.error.code === "NOT_FOUND") {
        // 서버에 기록이 없음 — 같은 키/페이로드로만 명시 재시도.
        setNotice(
          "요청 기록이 없어요. '다시 시도'로 같은 요청을 재전송할 수 있어요.",
        );
        return;
      }
      setNotice("결과를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.");
      return;
    }
    const st = r.data.status;
    if (st === "SUCCEEDED") {
      removePending(p.uiKey);
      const c = await reload();
      setNotice(
        c.ok
          ? "처리가 완료된 요청이었어요. 최신 상태로 반영했습니다."
          : "처리는 완료된 요청이었어요. 최신 카트를 불러오지 못했어요 — 다시 시도해 주세요.",
      );
      return;
    }
    if (st === "REJECTED") {
      removePending(p.uiKey);
      setNotice("요청이 거절되었어요. 최신 상태를 확인해 주세요.");
      await reload();
      return;
    }
    if (st === "READY") {
      setNotice("아직 처리 중이에요. 잠시 후 다시 확인해 주세요.");
      return;
    }
    // 서버 status는 READY|SUCCEEDED|REJECTED — 예상치 못한 값이면
    // intent를 유지한 채 다음 확인에 맡긴다.
    setNotice("결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
  }

  async function retryPending(p: PendingWrite) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const r = await apiSafe<{ cart: CartView }>(p.path, {
      method: p.method,
      body: JSON.stringify(p.payload),
    });
    setBusy(false);
    busyRef.current = false;
    if (r.ok) {
      removePending(p.uiKey);
      // 명시 재시도는 대부분 replay — 저장 snapshot 대신 최신 카트를 회수해 표시.
      const c = await reload();
      setNotice(
        c.ok
          ? "요청이 반영됐어요."
          : "요청은 반영됐어요. 최신 카트를 불러오지 못했어요 — 다시 시도해 주세요.",
      );
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      setNotice("아직 결과를 확인할 수 없어요. '결과 확인'으로 이어서 확인하세요.");
      return;
    }
    removePending(p.uiKey);
    if (r.error.code === "VERSION_CONFLICT") {
      setNotice("카트가 변경되었어요. 최신 상태로 다시 불러왔습니다.");
      await reload();
      return;
    }
    setNotice("변경 실패: " + r.error.message);
    await reload();
  }

  if (loading) return <Loading />;
  if (!res) return null;
  if (!res.ok)
    return (
      <ErrorState
        text="카트를 불러오지 못했어요"
        onRetry={() => {
          setLoading(true);
          reload().then(() => setLoading(false));
        }}
      />
    );
  const c = res.data;

  return (
    <div className="screen">
      {notice && <div className="state-box">{notice}</div>}
      {pendings.length > 0 && (
        <div className="state-box">
          <b>결과를 확인하지 못한 요청이 있어요</b>
          <ul className="pending-list">
            {pendings.map((p) => (
              <li key={p.uiKey}>
                <span className="pending-label">{p.label}</span>
                <span className="pending-actions">
                  <button className="link" onClick={() => checkPending(p)}>
                    결과 확인
                  </button>
                  <button
                    className="link"
                    disabled={busy}
                    onClick={() => retryPending(p)}
                  >
                    다시 시도
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <div className="muted sm">
            결과가 확정되기 전에는 수량·삭제·주문을 변경할 수 없어요.
          </div>
        </div>
      )}
      {c.items.length === 0 ? (
        <Empty
          text="장바구니가 비어 있어요"
          action={
            <button className="btn primary" onClick={onOpenShop}>
              쇼핑하러 가기
            </button>
          }
        />
      ) : (
        <>
          <ul className="cart-list">
            {c.items.map((i) => (
              <li key={i.cart_item_id} className="cart-item">
                <button
                  className="cart-thumb"
                  aria-label={i.product_name + " 상품 상세"}
                  onClick={() => onOpenProduct(i.product_id)}
                >
                  <img
                    src={productImg({ product_id: i.product_id, image: i.image })}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                </button>
                <div className="cart-info">
                  <button
                    className="cart-name"
                    onClick={() => onOpenProduct(i.product_id)}
                  >
                    {i.product_name}
                  </button>
                  <div className="muted">
                    {Object.values(i.option_values).join(" · ")}
                  </div>
                  {!i.purchasable && (
                    <div className="badge-soldout">
                      {i.block_reason} — 주문할 수 없어요
                    </div>
                  )}
                  <div className="qty-ctrl sm">
                    <button
                      aria-label={"수량 감소 " + i.cart_item_id}
                      disabled={locked || i.quantity <= 1}
                      onClick={() => changeQty(i, i.quantity - 1)}
                    >
                      −
                    </button>
                    <b>{i.quantity}</b>
                    <button
                      aria-label={"수량 증가 " + i.cart_item_id}
                      disabled={locked || !i.purchasable}
                      onClick={() => changeQty(i, i.quantity + 1)}
                    >
                      +
                    </button>
                    <button
                      className="link"
                      disabled={locked}
                      onClick={() => removeItem(i)}
                    >
                      삭제
                    </button>
                  </div>
                </div>
                <div className="cart-right">
                  <b>{fmtWon(i.unit_price_won)}</b>
                  <span className="muted">× {i.quantity}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="bottom-bar">
            <div>
              <div className="muted">
                상품 {fmtWon(c.items_total_won)} + 배송비{" "}
                {fmtWon(c.shipping_fee_won)}
              </div>
              <b>{fmtWon(c.total_won)}</b>
            </div>
            <div>
              {!c.can_checkout && pendings.length === 0 && (
                <div className="muted sm">주문 불가 항목을 삭제해 주세요</div>
              )}
              {pendings.length > 0 && (
                <div className="muted sm">이전 요청 결과를 먼저 확인해 주세요</div>
              )}
              <button
                className="btn primary"
                disabled={!c.can_checkout || locked}
                onClick={onCheckout}
              >
                주문하기
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// 카트 뷰에는 stock이 없으므로 +버튼은 구매 가능 여부만 힌트로 쓴다.
// 실제 재고 초과는 서버가 OUT_OF_STOCK으로 막는다.
