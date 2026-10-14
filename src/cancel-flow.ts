// 취소 승인→실행·응답 유실 복구의 오케스트레이션 [PMQA-060].
// 네트워크·저장소·스코프는 CancelFlowIO로 주입받는다 — CancelSheet가 실제
// api/pending을 꽂고, unit 테스트가 mock IO로 같은 핸들러를 그대로 실증한다
// (DB·브라우저 없이 approve/execute 유실·연타·재진입·스코프 전환을 회귀).
//
// 안전 계약 [MJ060-2/4/5]:
// - intent는 첫 POST 전에 보존하고, 확정 결과(DONE·REJECTED)에서만 해제한다.
// - await 이후 intent 변경·후속 POST 전에 io.scope()가 시작 시점과 같은지 검사한다.
//   스코프가 바뀌면(계정 전환) 후속 POST 0·다른 intent 변경 0 — ABORTED.
// - 서버 응답은 형식·대상까지 검증한다 — 비정형 성공은 '결과 불확정'으로 두고
//   복구 조회가 서버 진실로 확정하게 한다(완료 화면 합성 금지).
// - READY 복구는 조회된 nonblank operation_id + 저장 confirmation_id 일치 시에만
//   execute한다 — 빈 id·충돌 id는 POST 0·UNKNOWN(서버 fallback 오실행 방지).
import type { ApiResult } from "./web/api.ts";
import { AMBIGUOUS_CODES } from "./web/api.ts";
import type { PendingWrite } from "./web/pending.ts";
import type { CancelRequestResult, OrderView } from "./contracts.ts";
import {
  resolveCancelAction, isCancelRequestResult,
  type CancelActionRow,
} from "./cancel-recovery.ts";

export interface CancelFlowIO {
  approve(path: string, body: unknown): Promise<ApiResult<{ confirmation_id: string }>>;
  execute(
    orderId: string,
    body: { confirmation_id: string; reason_code: string },
  ): Promise<ApiResult<CancelRequestResult>>;
  lookupAction(uiKey: string): Promise<ApiResult<CancelActionRow>>;
  getOrder(orderId: string): Promise<ApiResult<OrderView>>;
  putPending(pw: PendingWrite): void;
  removePending(uiKey: string): void;
  scope(): string | null;
  // 컴포넌트/수명주기/주문 epoch 토큰 — 계정 스코프·주문·unmount 중 하나라도
  // 바뀌면 값이 바뀌어야 한다. 각 엔트리는 시작 시점 토큰을 잡아 await 직후마다
  // 비교하고, 달라졌으면 후속 POST·intent 변경 없이 작업을 방치한다
  // (A→B→A 같은 user 복귀도 토큰이 달라져 기존 작업 계속 금지) [PM060 추가].
  epoch(): unknown;
}

export type CancelOutcome =
  | { kind: "DONE"; cancel_request_id: string; refund_amount_won: number }
  | { kind: "LOST" }              // commit 여부 불확정 — intent 유지, '결과 확인' 복구
  | { kind: "RETRYABLE" }         // 기록 없음 — 같은 키+같은 payload 명시 재전송 가능
  | { kind: "UNKNOWN_KEEP" }      // 아직 확인 불가 — intent 유지, 재전송 없음
  | { kind: "REJECTED"; message: string; reconfirm: boolean } // 확정 거절 — intent 해제
  | { kind: "ABORTED" };          // 스코프 변경 — 아무 상태도 바꾸지 않음

// 서버가 재확인을 요구하는 확정 거절 — 견적/자격을 다시 받게 한다.
const RECONFIRM_CODES = new Set([
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_STALE",
  "CANCEL_NOT_ELIGIBLE",
]);

// commit 여부 불확정·계정 문제 — intent를 유지하고 '결과 확인' 복구만 허용한다.
// IDEMPOTENCY_CONFLICT는 같은 키의 서버 기록이 있으므로 재전송 없이 조회로 해결한다.
// UNAUTHENTICATED(서버 401 실제 코드)·UNAUTHORIZED·FORBIDDEN은 같은 계정 재인증 후
// 복구 대상 — 재시도는 멈추고 원 user의 intent를 보존한다 [MJ060-5].
export const isAmbiguousCancelError = (code: string) =>
  AMBIGUOUS_CODES.has(code) ||
  code === "IDEMPOTENCY_CONFLICT" ||
  code === "UNAUTHENTICATED" ||
  code === "UNAUTHORIZED" ||
  code === "FORBIDDEN";

// 재확인 거절 뒤 시트가 지워야 할 선택 상태 — reason을 유지하면 같은 라디오가
// 이미 checked라 onChange가 재발화하지 않아 새 견적 요청이 영구 불가능해진다
// (견적 영역이 '확인하는 중…'에 머뭄) [PM060 MAJOR1]. 재견적은 사용자의 명시
// 재선택으로만 시작한다 — 만료된 확인의 자동 재시도가 아니다.
export const reconfirmReset = (out: CancelOutcome): boolean =>
  out.kind === "REJECTED" && out.reconfirm;

const THREW = Symbol("threw");
type Maybe<T> = T | typeof THREW;
// thunk 형태로 받는다 — io 호출이 동기 throw를 던져도(비정형 어댑터) THREW로
// 매핑돼 runFlow의 reject/영구 busy로 새지 않는다 [PM060 C].
const attempt = async <T>(fn: () => Promise<T>): Promise<Maybe<T>> => {
  try {
    return await fn();
  } catch {
    return THREW; // transport 실패 — 서버 commit 여부 불확정
  }
};

// api 봉투는 ok만 믿지 않는다 — error/code/data가 비정형(null·비객체)이면
// 확정 거절로 분류하지 않고 'commit 불확정'으로 둔다 [PM060 C].
const errCode = (e: { code?: unknown } | null | undefined): string =>
  e && typeof e.code === "string" ? e.code : "";
const errMsg = (e: { message?: unknown } | null | undefined, fb: string): string =>
  e && typeof e.message === "string" ? e.message : fb;
const strField = (x: unknown): string | null =>
  x && typeof x === "object" &&
  typeof (x as { confirmation_id?: unknown }).confirmation_id === "string"
    ? ((x as { confirmation_id: string }).confirmation_id)
    : null;

// await 이후 intent 변경·후속 POST 전에 호출한다.
const sameScope = (
  io: CancelFlowIO,
  scopeAt: string | null,
  epochAt: unknown,
) => io.scope() === scopeAt && io.epoch() === epochAt;

// 확정 거절 — scope 동일 확인 후 intent 해제(스코프가 바뀌었으면 원 user의
// intent를 건드리지 않고 ABORTED).
const rejectDefinitive = (
  io: CancelFlowIO,
  uiKey: string,
  scopeAt: string | null,
  epochAt: unknown,
  code: string,
  message: string,
): CancelOutcome => {
  if (!sameScope(io, scopeAt, epochAt)) return { kind: "ABORTED" };
  io.removePending(uiKey);
  return { kind: "REJECTED", message, reconfirm: RECONFIRM_CODES.has(code) };
};

// execute 호출과 그 결과 처리 — approve 직후·READY 복구·재시도가 공유한다.
async function finishExecute(
  io: CancelFlowIO,
  orderId: string,
  confirmationId: string,
  reasonCode: string,
  uiKey: string,
  scopeAt: string | null,
  epochAt: unknown,
): Promise<CancelOutcome> {
  const ex = await attempt(() => io.execute(orderId, {
    confirmation_id: confirmationId,
    reason_code: reasonCode,
  }));
  if (ex === THREW) return { kind: "LOST" };
  if (!ex.ok) {
    const code = errCode(ex.error);
    if (code === "" || isAmbiguousCancelError(code)) return { kind: "LOST" };
    return rejectDefinitive(io, uiKey, scopeAt, epochAt, code, errMsg(ex.error, code));
  }
  // 성공 봉투도 형식·대상 검증 — 비정형은 완료로 합성하지 않고 복구 조회로 보낸다.
  if (!isCancelRequestResult(ex.data, orderId)) return { kind: "LOST" };
  if (!sameScope(io, scopeAt, epochAt)) return { kind: "ABORTED" };
  io.removePending(uiKey);
  return {
    kind: "DONE",
    cancel_request_id: ex.data.cancel_request_id,
    refund_amount_won: ex.data.refund_amount_won,
  };
}

// ---- 신규 취소 요청: intent 보존 → approve → execute ----

export async function runCancelRequest(
  io: CancelFlowIO,
  args: {
    orderId: string;
    itemLabel: string;
    reason: string;
    quoteToken: string;
    uiKey: string;
    scopeAt: string | null;
  },
): Promise<CancelOutcome> {
  const { orderId, itemLabel, reason, quoteToken, uiKey, scopeAt } = args;
  const epochAt = io.epoch();
  const approvePath =
    "/api/orders/" + encodeURIComponent(orderId) + "/cancel/approve";
  const pw: PendingWrite = {
    uiKey,
    kind: "CANCEL_ORDER",
    path: approvePath,
    method: "POST",
    payload: {
      order_id: orderId,
      reason_code: reason,
      quote_token: quoteToken,
      action_key: "ui-" + uiKey,
      confirmation_id: null,
    },
    label: "주문 취소 요청 · " + itemLabel,
    at: Date.now(),
  };
  // 전송 전 보존 — approve commit 직후 응답 유실·탭 종료 대비.
  io.putPending(pw);

  const ap = await attempt(() => io.approve(approvePath, {
    quote_token: quoteToken,
    reason_code: reason,
    action_key: "ui-" + uiKey,
  }));
  if (ap === THREW) return { kind: "LOST" };
  if (!ap.ok) {
    const code = errCode(ap.error);
    if (code === "" || isAmbiguousCancelError(code)) return { kind: "LOST" };
    return rejectDefinitive(io, uiKey, scopeAt, epochAt, code, errMsg(ap.error, code));
  }
  // 성공 봉투의 confirmation_id도 검증 — data null/비정형·빈 id는 실행 경로를 열 수 없다.
  const cid = strField(ap.data);
  if (cid === null || cid.length === 0) return { kind: "LOST" };
  if (!sameScope(io, scopeAt, epochAt)) return { kind: "ABORTED" };
  // READY 커밋 확인 — 복구가 원본 승인(confirmation_id)을 찾게 intent에 기록한다.
  io.putPending({
    ...pw,
    payload: { ...pw.payload, confirmation_id: cid },
  });
  return finishExecute(io, orderId, cid, reason, uiKey, scopeAt, epochAt);
}

// ---- '결과 확인': 서버 action 기록으로만 상태 확정(재요청 아님) ----

export async function runCancelRecovery(
  io: CancelFlowIO,
  args: { pending: PendingWrite; scopeAt: string | null },
): Promise<CancelOutcome> {
  const { pending: p, scopeAt } = args;
  const epochAt = io.epoch();
  const orderId = typeof p.payload.order_id === "string" ? p.payload.order_id : "";
  const r = await attempt(() => io.lookupAction(p.uiKey));
  if (r === THREW) return { kind: "UNKNOWN_KEEP" }; // 조회 실패 — intent 유지
  if (!r.ok) {
    if (errCode(r.error) === "NOT_FOUND") return { kind: "RETRYABLE" };
    return { kind: "UNKNOWN_KEEP" };
  }
  const dec = resolveCancelAction(r.data, orderId);
  if (dec.kind === "EXECUTE") {
    // 저장 confirmation_id가 있으면 조회된 승인과 일치해야 한다 — 없음/충돌은
    // 서버의 '최신 READY' fallback 오실행 방지로 POST 0·UNKNOWN 유지 [MJ060-5].
    const stored = p.payload.confirmation_id;
    if (typeof stored === "string" && stored.length > 0 && stored !== dec.operation_id)
      return { kind: "UNKNOWN_KEEP" };
    if (!sameScope(io, scopeAt, epochAt)) return { kind: "ABORTED" };
    // READY — 저장 payload의 원본 사유로 실행을 이어간다(현재 mutable reason이 아니다).
    const rc =
      typeof p.payload.reason_code === "string" ? p.payload.reason_code : "";
    return finishExecute(io, orderId, dec.operation_id, rc, p.uiKey, scopeAt, epochAt);
  }
  if (dec.kind === "DONE") {
    if (!sameScope(io, scopeAt, epochAt)) return { kind: "ABORTED" };
    io.removePending(p.uiKey);
    return {
      kind: "DONE",
      cancel_request_id: dec.result.cancel_request_id,
      refund_amount_won: dec.result.refund_amount_won,
    };
  }
  if (dec.kind === "DONE_UNKNOWN") {
    // SUCCEEDED인데 저장 결과 비정형 — pending을 먼저 지우지 않고 주문 실제
    // 상태로 확인한다. 저장 id가 있으면 주문의 접수 행과 일치해야 복원한다.
    // 확인 불가면 intent를 유지한다 — 모호한 접수 성공을 합성하지 않는다 [MJ060-4].
    const ord = await attempt(() => io.getOrder(orderId));
    if (ord === THREW || !ord.ok) return { kind: "UNKNOWN_KEEP" };
    // 봉투 성공이어도 data가 null/비객체면 확인 불가 — 직접 필드 접근으로 throw하지 않는다.
    const od = ord.data as OrderView | null;
    if (!od || typeof od !== "object") return { kind: "UNKNOWN_KEEP" };
    // 조회된 주문 자체가 대상과 다른 경우·접수 행의 형식도 검증한다 —
    // status는 REQUESTED/COMPLETED(실제 접수), id·금액은 정형이어야 한다 [PM060 추가].
    const cx = od.cancel_request;
    if (od.id !== orderId || !cx)
      return { kind: "UNKNOWN_KEEP" };
    if (
      (cx.status !== "REQUESTED" && cx.status !== "COMPLETED") ||
      typeof cx.id !== "string" ||
      cx.id.length === 0 ||
      !Number.isInteger(cx.refund_amount_won) ||
      cx.refund_amount_won < 0
    )
      return { kind: "UNKNOWN_KEEP" };
    const stored = (r.data as { result?: unknown } | null)?.result as
      | { cancel_request_id?: unknown }
      | undefined;
    if (
      stored &&
      typeof stored.cancel_request_id === "string" &&
      stored.cancel_request_id.length > 0 &&
      stored.cancel_request_id !== cx.id
    )
      return { kind: "UNKNOWN_KEEP" }; // 다른 접수 — 이 요청의 결과로 합성하지 않는다
    if (!sameScope(io, scopeAt, epochAt)) return { kind: "ABORTED" };
    io.removePending(p.uiKey);
    return {
      kind: "DONE",
      cancel_request_id: cx.id,
      refund_amount_won: cx.refund_amount_won,
    };
  }
  if (dec.kind === "REJECTED")
    // 실제 거절 코드를 넘겨 EXPIRED/STALE → 재견적·재확인 분기에 연결한다 [PM060 추가].
    return rejectDefinitive(io, p.uiKey, scopeAt, epochAt, dec.code, dec.message);
  return { kind: "UNKNOWN_KEEP" }; // UNKNOWN — intent 유지·새 키 자동 실행 없음
}

// ---- '다시 시도': 기록 없음(NOT_FOUND) 뒤 같은 키+같은 payload의 명시 재전송 ----

export async function runCancelRetry(
  io: CancelFlowIO,
  args: { pending: PendingWrite; scopeAt: string | null },
): Promise<CancelOutcome> {
  const { pending: p, scopeAt } = args;
  const epochAt = io.epoch();
  const orderId = typeof p.payload.order_id === "string" ? p.payload.order_id : "";
  const reasonCode =
    typeof p.payload.reason_code === "string" ? p.payload.reason_code : "";
  const ap = await attempt(() => io.approve(p.path, {
    quote_token: p.payload.quote_token,
    reason_code: p.payload.reason_code,
    action_key: "ui-" + p.uiKey,
  }));
  if (ap === THREW) return { kind: "LOST" };
  if (!ap.ok) {
    const code = errCode(ap.error);
    if (code === "" || isAmbiguousCancelError(code)) return { kind: "LOST" };
    return rejectDefinitive(io, p.uiKey, scopeAt, epochAt, code, errMsg(ap.error, code));
  }
  const cid = strField(ap.data);
  if (cid === null || cid.length === 0) return { kind: "LOST" };
  if (!sameScope(io, scopeAt, epochAt)) return { kind: "ABORTED" };
  io.putPending({
    ...p,
    payload: { ...p.payload, confirmation_id: cid },
  });
  return finishExecute(io, orderId, cid, reasonCode, p.uiKey, scopeAt, epochAt);
}
