// A02 취소 사유·최종 확인 — 전용 fullpage 단계 표현 [PMQA-060 재작성 →
// PMQA-063 사용자 승인 Visual Correction: Ref087/088/089의 전용 페이지 위계를
// 기존 overlay 위에 구현 — 가변 높이 시트·소형 헤더·split CTA 대신 뒤로 아이콘 +
// 대형 단계 제목 + flat 행 + 하단 단일 primary CTA].
// 단계 [Observed Ref087/088/089]:
//   자격 조회(서버 판정) → 사유 선택 → 서버 견적(환불 예정액)
//   → 최종 확인(원주문 상품·금액 스냅샷 + 사유 + 서버 견적 환불 예정액)
//   → 승인(approve·READY) → 실행(execute·REQUESTED) → 접수 결과.
//
// 안전 계약:
// - 자격·환불액·상태 전환은 서버만 판정한다 — UI는 quote/응답 표시만 한다.
//   원주문 금액·paid·quote가 같아 보여도 클라이언트가 정책을 판정하지 않는다.
// - 쓰기·복구 오케스트레이션은 src/cancel-flow.ts가 담당한다 — intent 보존·
//   스코프 epoch·서버 응답 형식/대상 검증·READY 원본 승인 확인은 거기서 검증된다.
// - 시트는 어떤 자격 상태에서도 미해결 intent의 '결과 확인' 복구를 노출한다 —
//   취소가 commit되면 cancel_eligible이 false가 되어 재진입 통로가 사라지기 때문이다.
// - busy/미해결 intent 동안 시트 닫기·사유 변경을 막는다.
import { useEffect, useRef, useState } from "react";
import {
  apiSafe, fmtWon, newActionKey, type ApiResult,
} from "../api.ts";
import type {
  CancelEligibilityResult, CancelQuoteResult, CancelRequestResult, OrderView,
} from "../../contracts.ts";
import { IcBack, IcCheck, IcClose } from "../icons.tsx";
import { Loading } from "./CommerceState.tsx";
import {
  listPendingByKind, putPending, removePending, pendingScope,
  type PendingWrite,
} from "../pending.ts";
import { api } from "../api.ts";
import {
  runCancelRequest, runCancelRecovery, runCancelRetry,
  reconfirmReset,
  type CancelFlowIO, type CancelOutcome,
} from "../../cancel-flow.ts";
import type { CancelActionRow } from "../../cancel-recovery.ts";

const REASONS: { code: string; label: string }[] = [
  { code: "ORDER_MISTAKE", label: "주문을 잘못 입력했어요" },
  { code: "CHANGE_OF_MIND", label: "단순 변심이에요" },
  { code: "OTHER", label: "기타" },
];
const REASON_LABEL: Record<string, string> = Object.fromEntries(
  REASONS.map((r) => [r.code, r.label]),
);

type DoneView = { kind: "RESULT"; cancel_request_id: string; refund_amount_won: number };

export function CancelSheet({
  orderId,
  order,
  itemSummary: itemSummaryProp,
  onClose,
}: {
  orderId: string;
  order?: OrderView;   // 원주문 스냅샷 — 있으면 그대로, 없으면 시트가 직접 조회 [MJ060-3]
  itemSummary?: string; // 스냅샷 없을 때의 표시 요약(목록 경로)
  onClose: (changed: boolean) => void;
}) {
  const itemSummary = order
    ? order.items[0]?.product_name +
      (order.items.length > 1 ? " 외 " + (order.items.length - 1) + "건" : "")
    : itemSummaryProp ?? orderId;
  const [elig, setElig] = useState<ApiResult<CancelEligibilityResult> | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [quote, setQuote] = useState<ApiResult<CancelQuoteResult> | null>(null);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<DoneView | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [lostResult, setLostResult] = useState(false);
  const [retryable, setRetryable] = useState(false); // 기록 없음 — 같은 payload 명시 재전송 가능
  const [pendings, setPendings] = useState<PendingWrite[]>(() =>
    listPendingByKind("CANCEL_ORDER"),
  );
  // 최종 확인의 원주문 상품/금액 행 — props로 주어진 스냅샷이 없으면 직접 조회한다.
  const [snap, setSnap] = useState<OrderView | null>(order ?? null);
  const [snapErr, setSnapErr] = useState(false);
  // 읽기 채널별 순서 가드 — 자격·스냅샷·견적은 서로 다른 비동기라 하나의 seq를
  // 공유하면 후속 호출이 앞 응답을 무효화해 elig가 영구 null(무한 로딩)이 된다
  // (목록 경로 loadEligibility+loadSnapshot 동시 호출 race) [PM060 A].
  const seqElig = useRef(0);
  const seqSnap = useRef(0);
  const seqQuote = useRef(0);
  const busyRef = useRef(false);    // 연타·복구+확인 동시 실행 동기 차단
  const restored = useRef<string | null>(null); // 복원한 uiKey — 중복 복원 방지
  const alive = useRef(true);       // unmount 뒤 setState 방지
  const orderIdRef = useRef(orderId);
  orderIdRef.current = orderId;
  // 컴포넌트/수명주기/주문 epoch — 스코프·주문·unmount 변경 시 증가시켜
  // 진행 중 쓰기·복구가 await 직후 후속 POST·intent 변경을 멈추게 한다 [MJ060-2].
  const epochRef = useRef(0);
  const lastScope = useRef<string | null>(pendingScope());

  // 이 주문의 미해결 취소 intent — 있으면 새 취소를 막고 결과 확인부터 정리한다.
  const pending =
    pendings.find((p) => p.payload?.order_id === orderId) ?? null;

  // cancel-flow IO — 실제 api/pending을 주입한다(테스트는 mock으로 같은 경로 실증).
  const ioRef = useRef<CancelFlowIO | null>(null);
  if (!ioRef.current) {
    ioRef.current = {
      approve: (path, body) =>
        api<{ confirmation_id: string }>(path, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      execute: (oid, body) =>
        api<CancelRequestResult>(
          "/api/orders/" + encodeURIComponent(oid) + "/cancel/execute",
          { method: "POST", body: JSON.stringify(body) },
        ),
      lookupAction: (uiKey) =>
        apiSafe<CancelActionRow>(
          "/api/actions?kind=CANCEL_ORDER&idempotency_key=" +
            encodeURIComponent("ui-" + uiKey),
        ),
      getOrder: (oid) =>
        apiSafe<OrderView>("/api/orders/" + encodeURIComponent(oid)),
      putPending,
      removePending,
      scope: pendingScope,
      epoch: () => epochRef.current,
    };
  }

  // ---- 컨텍스트 가드 ----
  // await 뒤 intent 변경·setState·후속 POST 전에 호출한다. 주문이 바뀌거나
  // 계정 스코프가 바뀌면 진행 중 작업은 아무 상태도 바꾸지 않고 방치한다 —
  // intent는 원래 계정 버킷에 남아 원 계정 복귀 시 복구된다 [MJ060-2].
  const sameCtx = (oid: string, scopeAt: string | null) =>
    oid === orderIdRef.current && pendingScope() === scopeAt;

  const endBusy = () => {
    busyRef.current = false;
    setBusy(false);
  };

  // ---- 읽기 ----

  async function loadEligibility() {
    const my = ++seqElig.current;
    const oid = orderIdRef.current;
    const scopeAt = pendingScope();
    const r = await apiSafe<CancelEligibilityResult>(
      "/api/orders/" + encodeURIComponent(oid) + "/cancel/eligibility",
    );
    if (my !== seqElig.current || !alive.current || !sameCtx(oid, scopeAt)) return;
    setElig(r);
  }

  // 원주문 스냅샷 — 목록 경로에서 시트를 열면 props가 없어 직접 조회한다 [MJ060-3].
  async function loadSnapshot() {
    const my = ++seqSnap.current;
    const oid = orderIdRef.current;
    const scopeAt = pendingScope();
    const r = await apiSafe<OrderView>(
      "/api/orders/" + encodeURIComponent(oid),
    );
    if (my !== seqSnap.current || !alive.current || !sameCtx(oid, scopeAt)) return;
    if (r.ok) {
      setSnap(r.data);
      setSnapErr(false);
    } else {
      setSnapErr(true);
    }
  }

  // 원 컨텍스트 초기화 — 주문 변경·계정 스코프 변경 시 이전 컨텍스트의
  // 응답·단계·busy·복원 상태가 남지 않게 되돌린다 [MJ060-2].
  function resetSheet() {
    seqElig.current++;
    seqSnap.current++;
    seqQuote.current++;
    busyRef.current = false;
    setBusy(false);
    setElig(null);
    setReason(null);
    setQuote(null);
    setStep("form");
    setDone(null);
    setErrMsg(null);
    setLostResult(false);
    setRetryable(false);
    restored.current = null;
    setSnap(order ?? null);
    setSnapErr(false);
  }

  // orderId 변경 시 이전 주문의 응답·단계·busy·복원 상태가 남지 않게 초기화한다.
  useEffect(() => {
    epochRef.current++;
    lastScope.current = pendingScope();
    resetSheet();
    loadEligibility();
    if (!order) loadSnapshot();
  }, [orderId]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epochRef.current++; // unmount도 epoch 변경 — 진행 중 작업 방치
    };
  }, []);

  // 계정 스코프 변경 감지 — bindPendingUser의 pending-writes 이벤트를 이용한다.
  // 스코프가 바뀌면(전환·로그아웃·A→B→A 복귀 포함) epoch를 올려 진행 중 작업을
  // 방치하고 시트 상태를 원 컨텍스트에서 초기화한다 [MJ060-2].
  useEffect(() => {
    const on = () => {
      const s = pendingScope();
      if (s !== lastScope.current) {
        lastScope.current = s;
        epochRef.current++;
        resetSheet();
        setPendings(listPendingByKind("CANCEL_ORDER")); // 새 스코프 버킷으로 교체
        loadEligibility();
        return;
      }
      setPendings(listPendingByKind("CANCEL_ORDER"));
    };
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  // 재진입 복구 — 이 주문에 남은 intent가 있으면 저장 사유를 복원하고
  // '결과 확인' 경로를 연다(자동 실행은 하지 않는다).
  useEffect(() => {
    if (!pending || restored.current === pending.uiKey || done) return;
    restored.current = pending.uiKey;
    const rc = pending.payload?.reason_code;
    if (typeof rc === "string" && REASON_LABEL[rc]) setReason(rc);
    setLostResult(true);
    setErrMsg(null);
  }, [pending, done]);

  async function pickReason(code: string) {
    if (busyRef.current || pending) return; // 처리 중·미해결 intent 동안 사유 변경 금지
    const my = ++seqQuote.current;
    const oid = orderIdRef.current;
    const scopeAt = pendingScope();
    setReason(code);
    setQuote(null);
    setErrMsg(null);
    const r = await apiSafe<CancelQuoteResult>(
      "/api/orders/" + encodeURIComponent(oid) +
        "/cancel/quote?reason_code=" + encodeURIComponent(code),
    );
    if (my !== seqQuote.current || !alive.current || !sameCtx(oid, scopeAt)) return;
    setQuote(r);
  }

  // ---- 쓰기 — 오케스트레이션은 cancel-flow가 담당, 여기는 결과→화면 매핑 ----

  function applyOutcome(out: CancelOutcome) {
    if (out.kind === "DONE") {
      setLostResult(false);
      setDone({
        kind: "RESULT",
        cancel_request_id: out.cancel_request_id,
        refund_amount_won: out.refund_amount_won,
      });
      return;
    }
    if (out.kind === "LOST") {
      setLostResult(true);
      setErrMsg(
        "결과를 확인하지 못했어요. '결과 확인'으로 이어서 확인할 수 있어요.",
      );
      return;
    }
    if (out.kind === "RETRYABLE") {
      setErrMsg(
        "취소 요청 기록이 아직 없어요. '다시 시도'로 같은 내용을 재전송할 수 있어요.",
      );
      setRetryable(true);
      return;
    }
    if (out.kind === "UNKNOWN_KEEP") {
      setErrMsg("아직 결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
      return;
    }
    if (out.kind === "REJECTED") {
      setErrMsg(out.message);
      setLostResult(false);
      if (reconfirmReset(out)) {
        // 이미 checked인 라디오는 onChange가 재발화하지 않는다 — reason을 유지하면
        // 같은 사유로 새 견적을 받을 수 없어 견적 영역이 '환불 예정액을
        // 확인하는 중…'에 영구 머문다. reason을 초기화해 명시 재선택이 재견적을
        // 시작하게 한다 (자동 재견적이 아니다) [PM060 MAJOR1].
        setReason(null);
        setQuote(null);
        setStep("form");
        loadEligibility();
      }
      return;
    }
    // ABORTED — 스코프가 바뀌어 아무 상태도 바꾸지 않는다(방치).
  }

  async function runFlow(promise: Promise<CancelOutcome>, oid: string, scopeAt: string | null) {
    const epochAt = epochRef.current; // 시작 시점 토큰 — A→B→A 복귀도 구분한다 [PM060 B]
    let out: CancelOutcome;
    try {
      out = await promise;
    } catch {
      // 예상 못한 예외도 intent는 유지한다 — 확정 결과만 해제하므로 복구 경로가
      // 서버 진실을 확인하게 두고, 이 operation의 busy는 반드시 해제한다 [PM060 C].
      out = { kind: "UNKNOWN_KEEP" };
    }
    const still = () =>
      alive.current && sameCtx(oid, scopeAt) && epochRef.current === epochAt;
    if (!still()) return; // 방치 — 새 컨텍스트의 busy·상태에 관여하지 않는다
    applyOutcome(out);
    endBusy();
  }

  // 최종 확인 → 승인(approve) → 실행(execute).
  async function confirm() {
    if (!quote?.ok || !quote.data.quote || !reason || busyRef.current || pending)
      return;
    busyRef.current = true;
    setBusy(true);
    seqElig.current++; // 진행 중 늦은 읽기 응답 무시
    seqSnap.current++;
    seqQuote.current++;
    setErrMsg(null);
    setLostResult(false);
    setRetryable(false);
    const oid = orderIdRef.current;
    const scopeAt = pendingScope();
    const uiKey = newActionKey();
    restored.current = uiKey; // 자기가 만든 intent를 '복구 대상'으로 오인하지 않게 표시
    await runFlow(
      runCancelRequest(ioRef.current!, {
        orderId: oid,
        itemLabel: itemSummary,
        reason,
        quoteToken: quote.data.quote.quote_token,
        uiKey,
        scopeAt,
      }),
      oid,
      scopeAt,
    );
  }

  // '결과 확인' — 서버 action 기록으로만 상태를 확정한다(재요청 아님).
  async function recoverResult() {
    const p = pending;
    if (!p || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrMsg(null);
    setRetryable(false);
    const oid = orderIdRef.current;
    const scopeAt = pendingScope();
    await runFlow(runCancelRecovery(ioRef.current!, { pending: p, scopeAt }), oid, scopeAt);
  }

  // '다시 시도' — 기록 없음 뒤 같은 키+같은 payload의 명시 재전송만.
  async function retryRequest() {
    const p = pending;
    if (!p || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrMsg(null);
    setRetryable(false);
    const oid = orderIdRef.current;
    const scopeAt = pendingScope();
    await runFlow(runCancelRetry(ioRef.current!, { pending: p, scopeAt }), oid, scopeAt);
  }

  // ---- 렌더 ----

  // 미해결 intent의 복구 접근점 — 자격 성공/실패/부적격과 무관하게 항상 노출한다
  // (execute가 commit되면 cancel_eligible=false가 되어 '취소하기' CTA가 숨는다) [MJ060-1].
  // 원주문 상품 행 — 사유 선택·최종 확인·접수 결과에서 같은 서버 스냅샷을
  // 반복해 보여준다 [Observed Ref087/088/089]: 썸네일 + 상품명(옵션 병기) +
  // '단가 · 수량' 행. 수량은 1이어도 표시한다 [MN062-VIS1 — 가격·수량 누락 해소].
  // badge는 접수 단계의 '취소요청' 표시에만 쓴다 [Ref089].
  const itemRows = (v: OrderView, badge?: string) => (
    <div>
      {v.items.map((it) => (
        <div key={it.order_item_id} className="cancel-item">
          {it.image && (
            <span className="cancel-thumb">
              <img src={it.image} alt="" />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            {badge && <span className="cancel-badge">{badge}</span>}
            <div className="cancel-item-nm">
              {it.product_name}
              {Object.values(it.option_values).length
                ? ", " + Object.values(it.option_values).join(", ")
                : ""}
            </div>
            <div className="cancel-item-pr">
              {fmtWon(it.unit_price_won)} · {it.quantity}개
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const recoveryBlock = pending && !done ? (
    <div className="state-box">
      <b>이전 취소 요청의 결과를 확인하지 못했어요</b>
      <div className="muted sm" style={{ marginTop: 4 }}>{pending.label}</div>
      <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
        <button className="link" disabled={busy} onClick={recoverResult}>
          결과 확인
        </button>
        {retryable && (
          <button className="link" disabled={busy} onClick={retryRequest}>
            다시 시도
          </button>
        )}
      </div>
    </div>
  ) : null;

  // 단계 표시줄 — 좌: 뒤로 아이콘(form·기타 상태=닫기, confirm=이전, done=닫기),
  // 우: confirm에서만 X 닫기를 둬 진행 중 종료 통로를 분리한다(두 버튼 모두 busy 잠금)
  // [Observed Ref087/088/089 좌상단 뒤로 아이콘 · confirm의 X는 Project — 기존
  // '닫기' 제어의 접근 이름을 유지하기 위한 최소 추가].
  const stepKind = done ? "done" : step; // "form" | "confirm" | "done"
  const topBar = (
    <div className="cancel-top">
      <button
        type="button"
        className="icon-btn"
        aria-label={stepKind === "confirm" ? "이전" : "닫기"}
        disabled={busy}
        onClick={() =>
          stepKind === "confirm"
            ? setStep("form")
            : onClose(stepKind === "done")
        }
      >
        <IcBack size={24} />
      </button>
      {stepKind === "confirm" && (
        <button
          type="button"
          className="icon-btn"
          aria-label="닫기"
          disabled={busy}
          onClick={() => onClose(false)}
        >
          <IcClose size={22} />
        </button>
      )}
    </div>
  );

  return (
    // 전용 fullpage 표현 — 기존 overlay/sheet 위에 flex column으로 구성한다.
    // .sheet 클래스·onClick 계약은 유지해 기존 spec의 .sheet 스코프와
    // overlay 닫기 가드(busyRef)를 그대로 쓴다.
    <div className="sheet-overlay cancel-overlay" onClick={() => !busyRef.current && onClose(!!done)}>
      <div className="sheet cancel-sheet" onClick={(e) => e.stopPropagation()}>
        {topBar}

        <div className="cancel-body">
          {done ? (
            <>
              {/* 접수 — '취소요청'은 접수 상태이지 취소·환불 완료가 아니다 [Ref089]. */}
              <h2 className="cancel-title cancel-done-title">
                <span className="accent">취소 요청</span>이 접수됐어요
              </h2>
              <div className="cancel-card">
                {snap && itemRows(snap, "취소요청")}
                {reason && (
                  <div className="cancel-reason-box">
                    취소 사유: {REASON_LABEL[reason] ?? reason}
                  </div>
                )}
              </div>
              <div className="muted sm" style={{ marginTop: 12 }}>
                접수는 취소 완료가 아니에요. 처리가 진행되면 주문 취소·환불 상태가
                갱신되고, 주문 상세에서 확인할 수 있어요.
              </div>
            </>
          ) : (
            <>
              {recoveryBlock}
              {!elig ? (
                <Loading text="취소 가능 여부를 확인하는 중…" />
              ) : !elig.ok ? (
                <div className="state-box error">{elig.error.message}</div>
              ) : !elig.data.eligible ? (
                <>
                  <div className="state-box">지금은 이 주문을 취소할 수 없어요</div>
                  <ul className="reason-list">
                    {elig.data.reasons.map((r) => (
                      <li key={r.code} className="muted">· {r.message}</li>
                    ))}
                  </ul>
                </>
              ) : step === "form" ? (
                <>
                  {/* 사유 선택 — 대형 단계 제목 + 상품 행 + flat 사유 행 [Ref087] */}
                  <h2 className="cancel-title">취소하는 이유는 무엇인가요?</h2>
                  {snap && itemRows(snap)}
                  <hr className="cancel-div" />

                  <div role="radiogroup" aria-label="취소 사유">
                    {REASONS.map((r) => (
                      <label
                        key={r.code}
                        className={"reason-opt" + (reason === r.code ? " sel" : "")}
                      >
                        <input
                          type="radio"
                          name="cancel-reason"
                          checked={reason === r.code}
                          disabled={busy || !!pending}
                          onChange={() => pickReason(r.code)}
                        />
                        {r.label}
                        <IcCheck size={22} className="reason-check" />
                      </label>
                    ))}
                  </div>
                  {/* 서버 REASON_CODES가 지원하는 선택지만 노출한다 — 상세 사유
                      입력(Ref087의 textarea)·배송 지연 사유는 Backend 미지원이라
                      만들지 않는다. */}

                  {/* 환불 견적 금액은 최종 확인 단계에서만 표시한다 — Ref087의
                      사유 단계에는 견적 블록이 없고 Ref088 확인 단계에서 금액을
                      보여주는 계층 분리를 따른다 [Observed·PMQA-075 F15].
                      견적 자체는 사유 선택 시 백그라운드로 조회한다(다음 CTA의
                      활성 조건 + confirm 단계 데이터) — 사유 단계에는 조회 중
                      짧은 안내와 견적 실패·불가 안내만 남긴다. */}
                  {/* 견적 조회 진행 — 성공 금액·견적 카드 없이 짧은 inline
                      상태만 표시한다. 사유 미선택·미해결 intent 복구 중
                      (pending — 복구 안내와 중복)에는 띄우지 않는다
                      [PMQA-075-FIX — quote==null 로딩 안내 복원]. */}
                  {reason && !pending && !quote && (
                    <div className="muted sm" style={{ marginTop: 14 }}>
                      환불 예정액을 확인하는 중…
                    </div>
                  )}
                  {reason && !pending && quote && !quote.ok && (
                    <div className="cancel-quote">
                      <div className="state-box error">{quote.error.message}</div>
                      <button
                        className="link"
                        disabled={busy}
                        onClick={() => pickReason(reason)}
                      >
                        다시 확인
                      </button>
                    </div>
                  )}
                  {reason && !pending && quote?.ok && !quote.data.quote && (
                    <div className="cancel-quote">
                      <div className="state-box">
                        지금은 취소할 수 없어요
                        <ul className="reason-list">
                          {quote.data.reasons.map((r) => (
                            <li key={r.code} className="muted">· {r.message}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}

                  {errMsg && <div className="state-box error">{errMsg}</div>}
                </>
              ) : (
                <>
                  {/* 최종 확인 — 원주문 스냅샷 + flat 금액 행 + 서버 견적 강조
                      [Ref088]. 환불 분해(배송비·할인별)는 quote DTO에 없어
                      만들지 않는다 [MJ060-3]. */}
                  <h2 className="cancel-title">환불 예정 금액을 확인해주세요</h2>

                  {/* 원주문 스냅샷 — 조회 전·실패 상태에서는 실제 금액·상품 행을
                      보여주지 않고 최종 CTA도 잠근다(임의 표시 금지) [MJ060-3]. */}
                  {!snap ? (
                    <div>
                      {snapErr ? (
                        <>
                          <div className="state-box error">주문 정보를 불러오지 못했어요</div>
                          <button className="link" disabled={busy} onClick={loadSnapshot}>
                            다시 확인
                          </button>
                        </>
                      ) : (
                        <div className="muted sm">주문 내용을 확인하는 중…</div>
                      )}
                    </div>
                  ) : (
                    <>
                      {itemRows(snap)}
                      <hr className="cancel-div" />

                      <div className="pay-row">
                        <span>취소 사유</span>
                        <b>{REASON_LABEL[reason ?? ""] ?? reason}</b>
                      </div>
                      <div className="pay-row"><span>상품 금액</span><b>{fmtWon(snap.items_total_won)}</b></div>
                      <div className="pay-row"><span>배송비</span><b>{fmtWon(snap.shipping_fee_won)}</b></div>
                      <div className="pay-row"><span>총 결제 금액</span><b>{fmtWon(snap.total_won)}</b></div>
                      <hr className="cancel-div" />
                      <div className="pay-row cancel-refund">
                        <span>환불 예정 금액</span>
                        <b>{quote?.ok && quote.data.quote ? fmtWon(quote.data.quote.refund_amount_won) : "—"}</b>
                      </div>

                      <div className="cancel-note">
                        <b>취소 안내</b>
                        <p>전체 상품이 취소돼요 (부분 취소는 지원하지 않아요)</p>
                        <p>
                          요청 접수는 취소·환불 완료가 아니에요. 취소 처리가
                          완료되면 환불 상태를 확인할 수 있어요.
                          {quote?.ok && quote.data.quote
                            ? " 환불 예정 견적은 " +
                              new Date(quote.data.quote.expires_at).toLocaleTimeString("ko-KR") +
                              "까지 유효해요."
                            : ""}
                        </p>
                      </div>
                    </>
                  )}

                  {errMsg && <div className="state-box error">{errMsg}</div>}
                </>
              )}
            </>
          )}
        </div>

        {/* 하단 단일 CTA — 단계별 하나만 둔다 [Ref087/088/089] */}
        {done ? (
          <div className="cancel-cta">
            <button className="btn primary" onClick={() => onClose(true)}>
              확인
            </button>
          </div>
        ) : !elig ? null : !elig.ok ? (
          <div className="cancel-cta">
            <button className="btn ghost" onClick={loadEligibility} disabled={busy}>
              다시 확인
            </button>
          </div>
        ) : !elig.data.eligible ? (
          <div className="cancel-cta">
            <button className="btn ghost" onClick={() => onClose(false)}>
              돌아가기
            </button>
          </div>
        ) : step === "form" ? (
          <div className="cancel-cta">
            <button
              className="btn primary"
              disabled={busy || !!pending || !reason || !quote?.ok || !quote.data.quote}
              onClick={() => setStep("confirm")}
            >
              취소 내용 확인
            </button>
          </div>
        ) : (
          <div className="cancel-cta">
            <button
              className="btn primary"
              disabled={busy || !!pending || !snap || !quote?.ok || !quote.data.quote}
              onClick={confirm}
            >
              {busy ? "처리 중…" : "이 주문 취소 요청"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
