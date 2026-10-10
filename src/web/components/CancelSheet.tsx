// A02 취소 사유·최종 확인 시트 — W06 위의 Bottom Sheet.
// 서버의 자격/견적을 조회해 보여주고, 사용자가 사유를 고른 뒤 최종 버튼을 누르면
// 승인(READY) → 공통 취소 실행 순서로 진행한다. 시트를 여는 것만으로는 아무것도 바뀌지 않는다.
import { useEffect, useRef, useState } from "react";
import { api, apiSafe, fmtWon, newActionKey, type ApiResult } from "../api.ts";
import type {
  CancelEligibilityResult, CancelQuoteResult, CancelRequestResult,
} from "../../contracts.ts";
import { Loading } from "./CommerceState.tsx";

const REASONS: { code: string; label: string }[] = [
  { code: "ORDER_MISTAKE", label: "주문을 잘못 입력했어요" },
  { code: "CHANGE_OF_MIND", label: "단순 변심이에요" },
  { code: "OTHER", label: "기타" },
];

export function CancelSheet({
  orderId,
  itemSummary,
  onClose,
}: {
  orderId: string;
  itemSummary: string;
  onClose: (changed: boolean) => void;
}) {
  const [elig, setElig] = useState<ApiResult<CancelEligibilityResult> | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [quote, setQuote] = useState<ApiResult<CancelQuoteResult> | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CancelRequestResult | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [lostResult, setLostResult] = useState(false);
  const actionKey = useRef("ui-" + newActionKey());

  async function loadEligibility() {
    setElig(null);
    setElig(await apiSafe<CancelEligibilityResult>(
      "/api/orders/" + encodeURIComponent(orderId) + "/cancel/eligibility",
    ));
  }
  useEffect(() => { loadEligibility(); }, [orderId]);

  async function pickReason(code: string) {
    setReason(code);
    setQuote(null);
    setErrMsg(null);
    setQuote(await apiSafe<CancelQuoteResult>(
      "/api/orders/" + encodeURIComponent(orderId) + "/cancel/quote?reason_code=" + code,
    ));
  }

  async function runExecute(confirmationId: string) {
    return api<CancelRequestResult>(
      "/api/orders/" + encodeURIComponent(orderId) + "/cancel/execute",
      { method: "POST", body: JSON.stringify({ confirmation_id: confirmationId, reason_code: reason }) },
    );
  }

  // 응답 유실 복구: UI 행동 키로 승인/실행 상태를 찾아 이어서 처리한다.
  async function recoverResult() {
    setBusy(true);
    const r = await apiSafe<{ status: string; operation_id: string; result?: { cancel_request_id?: string }; error_code?: string }>(
      "/api/actions?kind=CANCEL_ORDER&idempotency_key=" + encodeURIComponent(actionKey.current),
    );
    if (!r.ok) { setErrMsg("결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요."); setBusy(false); return; }
    if (r.data.status === "READY") {
      const ex = await runExecute(r.data.operation_id).catch(() => null);
      if (ex?.ok) { setDone(ex.data); setLostResult(false); setBusy(false); return; }
      if (ex && !ex.ok) { setErrMsg(ex.error.message); setLostResult(false); setBusy(false); return; }
      setErrMsg("결과를 확인하지 못했어요. 다시 시도해 주세요.");
      setBusy(false);
      return;
    }
    if (r.data.status === "SUCCEEDED") {
      setDone({ cancel_request_id: r.data.result?.cancel_request_id ?? "", status: "REQUESTED", refund_amount_won: -1, order: null });
      setLostResult(false);
      setBusy(false);
      return;
    }
    setErrMsg("취소가 거절되었어요. 주문 상태를 새로고침해 주세요.");
    setLostResult(false);
    setBusy(false);
  }

  async function confirm() {
    if (!quote?.ok || !quote.data.quote || !reason || busy) return;
    setBusy(true);
    setErrMsg(null);
    try {
      const ap = await api<{ confirmation_id: string }>(
        "/api/orders/" + encodeURIComponent(orderId) + "/cancel/approve",
        {
          method: "POST",
          body: JSON.stringify({
            quote_token: quote.data.quote.quote_token,
            reason_code: reason,
            action_key: actionKey.current,
          }),
        },
      );
      if (!ap.ok) {
        setErrMsg(ap.error.message);
        if (ap.error.code === "CONFIRMATION_EXPIRED" || ap.error.code === "CONFIRMATION_STALE" || ap.error.code === "CANCEL_NOT_ELIGIBLE") {
          setQuote(null);
          await loadEligibility();
        }
        setBusy(false);
        return;
      }
      const ex = await runExecute(ap.data.confirmation_id);
      if (ex.ok) { setDone(ex.data); setBusy(false); return; }
      setErrMsg(ex.error.message);
      if (ex.error.code === "CONFIRMATION_EXPIRED" || ex.error.code === "CONFIRMATION_STALE" || ex.error.code === "CANCEL_NOT_ELIGIBLE") {
        setQuote(null);
        await loadEligibility();
      }
      setBusy(false);
    } catch {
      setLostResult(true);
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay" onClick={() => !busy && onClose(!!done)}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="agent-head" style={{ padding: "0 0 12px" }}>
          <b>주문 취소</b>
          <button className="link" onClick={() => onClose(!!done)}>닫기</button>
        </div>

        {done ? (
          <>
            <div className="state-box">
              취소 요청이 접수됐어요
              {done.refund_amount_won >= 0 && <> · 환불 예정 {fmtWon(done.refund_amount_won)}</>}
            </div>
            <div className="muted sm" style={{ marginTop: 8 }}>
              접수 후 처리가 진행되면 주문 취소·환불 상태가 갱신돼요. 주문 상세에서 확인할 수 있어요.
            </div>
            <div className="sheet-actions">
              <button className="btn primary" onClick={() => onClose(true)}>확인</button>
            </div>
          </>
        ) : !elig ? (
          <Loading text="취소 가능 여부를 확인하는 중…" />
        ) : !elig.ok ? (
          <div className="state-box error">{elig.error.message}</div>
        ) : !elig.data.eligible ? (
          <>
            <div className="state-box">
              지금은 이 주문을 취소할 수 없어요
            </div>
            <ul className="reason-list">
              {elig.data.reasons.map((r) => <li key={r.code} className="muted">· {r.message}</li>)}
            </ul>
            <div className="sheet-actions">
              <button className="btn ghost" onClick={() => onClose(false)}>돌아가기</button>
            </div>
          </>
        ) : (
          <>
            <div className="muted sm">
              {orderId} · {itemSummary}
            </div>
            <div className="state-box">전체 상품이 취소돼요 (부분 취소는 지원하지 않아요)</div>

            <h3 className="section-title" style={{ marginTop: 16 }}>취소 사유</h3>
            {REASONS.map((r) => (
              <label key={r.code} className={"reason-opt" + (reason === r.code ? " sel" : "")}>
                <input
                  type="radio"
                  name="cancel-reason"
                  checked={reason === r.code}
                  onChange={() => pickReason(r.code)}
                />
                {r.label}
              </label>
            ))}

            {reason && (
              <div className="checkout-block">
                {!quote ? (
                  <div className="muted sm">환불 예정액을 확인하는 중…</div>
                ) : !quote.ok ? (
                  <div className="state-box error">{quote.error.message}</div>
                ) : quote.data.quote ? (
                  <>
                    <div>환불 예정 <b>{fmtWon(quote.data.quote.refund_amount_won)}</b></div>
                    <div className="muted sm">
                      모의 결제 전액 환불 · 서버 확정 금액 ·{" "}
                      {new Date(quote.data.quote.expires_at).toLocaleTimeString("ko-KR")}까지 유효
                    </div>
                  </>
                ) : (
                  <div className="state-box">
                    지금은 취소할 수 없어요
                    <ul className="reason-list">
                      {quote.data.reasons.map((r) => <li key={r.code} className="muted">· {r.message}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {errMsg && <div className="state-box error">{errMsg}</div>}
            {lostResult && (
              <button className="btn ghost" onClick={recoverResult}>결과 확인</button>
            )}

            <div className="sheet-actions">
              <button className="btn ghost" onClick={() => onClose(!!done)} disabled={busy}>돌아가기</button>
              <button
                className="btn primary"
                disabled={busy || !reason || !quote?.ok || !quote.data.quote}
                onClick={confirm}
              >
                {busy ? "처리 중…" : "이 주문 취소 요청"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
