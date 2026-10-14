// 취소 응답 유실 복구 — 서버 action_requests 조회 결과를 UI 결정으로 변환하는
// pure 함수 모음 (DB·fetch 의존 0 — unit 테스트 대상) [PMQA-060].
//
// 서버 진실은 action_requests.status 뿐이다:
//   READY     — 승인만 커밋. 저장 payload의 confirmation_id(=operation_id)로 실행을 이어간다.
//   SUCCEEDED — result_json에 StoredCancelResult가 커밋됨. 화면에는 그 실값만 쓴다.
//   REJECTED  — result_json에 ToolError가 커밋됨. 저장된 거절 메시지를 보여준다.
//   그 외/형식 이상 — 결과를 단정하지 않고 intent를 유지한다(새 키 자동 실행 금지).
//
// [MJ060-4/5] 검증 요건:
// - SUCCEEDED는 저장 결과의 status==="REQUESTED"·주문 일치·nonblank id·
//   0 이상 정수 금액까지 확인한 경우만 DONE이다. 비정형이면 DONE_UNKNOWN으로
//   주문 실제 상태 재확인 경로로 보내고, 완료 화면을 합성하지 않는다.
// - READY는 operation_id가 nonblank일 때만 EXECUTE다 — falsy id로 execute하면
//   서버가 '같은 주문의 최신 READY' fallback을 열어 다른 승인을 실행할 수 있다.
//   빈 id는 UNKNOWN으로 intent 유지·POST 0.
//
// 화면 상태로 결과를 추정·조립하지 않는다 — 과거 SUCCEEDED 복구가
// {id:"", refund:-1, status:REQUESTED}를 조립한 문제의 수정이다.

export interface CancelActionRow {
  status: string;
  operation_id: string;
  result?: unknown;
  error_code?: string | null;
}

// 서버 StoredCancelResult — cancellation.ts requestCancelOrder가 커밋하는 형태.
export interface StoredCancelResult {
  cancel_request_id: string;
  refund_amount_won: number;
  order_id: string;
}

export type CancelRecoveryDecision =
  // READY — 이 operation_id로 execute를 이어간다(사유는 저장 payload 원본).
  | { kind: "EXECUTE"; operation_id: string }
  // SUCCEEDED + 저장 결과 검증 통과 — 실제 id·금액·주문만 표시한다.
  | { kind: "DONE"; result: StoredCancelResult }
  // SUCCEEDED인데 저장 결과가 비정형/주문 불일치 — 주문 실제 상태로 재확인한다.
  | { kind: "DONE_UNKNOWN" }
  // REJECTED — 서버에 커밋된 거절 메시지·코드를 보존한다(재견적·재확인 분기 근거).
  | { kind: "REJECTED"; message: string; code: string }
  // 알 수 없는 상태·READY 빈 id — intent 유지, 잠시 후 재조회 안내.
  | { kind: "UNKNOWN" };

// 저장 결과 형식 검증 — 서버 StoredCancelResult 계약 그대로.
// status는 REQUESTED만 허용(완료·환불 상태를 접수로 오인 금지), 금액은 0 이상
// 정수, id들은 nonblank다. orderId가 주어지면 대상 주문과 일치해야 한다 —
// 다른 주문의 저장 결과를 이 주문의 완료로 표시하지 않는다 [MJ060-4].
export const isStoredCancelResult = (
  x: unknown,
  orderId?: string,
): x is StoredCancelResult => {
  const r = x as StoredCancelResult & { status?: unknown };
  return (
    !!r &&
    typeof r === "object" &&
    r.status === "REQUESTED" &&
    typeof r.cancel_request_id === "string" &&
    r.cancel_request_id.length > 0 &&
    typeof r.refund_amount_won === "number" &&
    Number.isInteger(r.refund_amount_won) &&
    r.refund_amount_won >= 0 &&
    typeof r.order_id === "string" &&
    r.order_id.length > 0 &&
    (orderId === undefined || r.order_id === orderId)
  );
};

// execute 성공 봉투 검증 — 접수 결과의 id·금액·주문이 계약과 다르면 화면에
// 그대로 쓰지 않고 '결과 불확정(복구 조회)' 경로로 보낸다 [MJ060-4].
export const isCancelRequestResult = (
  x: unknown,
  orderId: string,
): x is { cancel_request_id: string; refund_amount_won: number } => {
  const r = x as {
    cancel_request_id?: unknown;
    status?: unknown;
    refund_amount_won?: unknown;
    order?: { id?: unknown } | null;
  };
  if (
    !r ||
    typeof r !== "object" ||
    typeof r.cancel_request_id !== "string" ||
    r.cancel_request_id.length === 0 ||
    r.status !== "REQUESTED" ||
    typeof r.refund_amount_won !== "number" ||
    !Number.isInteger(r.refund_amount_won) ||
    r.refund_amount_won < 0
  )
    return false;
  // order는 조회 실패 시 null 허용 — 있으면 대상 주문과 일치해야 한다.
  if (r.order != null && r.order.id !== orderId) return false;
  return true;
};

const isToolError = (x: unknown): x is { code: string; message: string } => {
  const e = x as { code?: unknown; message?: unknown };
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.code === "string" &&
    typeof e.message === "string"
  );
};

// 서버 조회 결과 한 건을 복구 결정으로 변환한다. expectedOrderId는 이 시트의
// 주문 — 저장 결과가 다른 주문이면 이 화면의 완료로 표시하지 않는다.
// NOT_FOUND는 이 함수에 오지 않는다 — 봉투 레벨(ok=false)에서 처리한다.
export function resolveCancelAction(
  row: CancelActionRow,
  expectedOrderId: string,
): CancelRecoveryDecision {
  // 봉투 ok=true여도 data가 null/비객체일 수 있다 — 필드 접근 전에 형식을 검증해
  // throw가 runFlow의 영구 busy로 새지 않게 한다 [PM060 C].
  if (!row || typeof row !== "object") return { kind: "UNKNOWN" };
  if (row.status === "READY") {
    // 빈 operation_id는 서버의 '최신 READY' fallback을 열어 다른 승인을
    // 실행할 수 있다 — nonblank만 실행 허용 [MJ060-5].
    if (typeof row.operation_id !== "string" || row.operation_id.length === 0)
      return { kind: "UNKNOWN" };
    return { kind: "EXECUTE", operation_id: row.operation_id };
  }
  if (row.status === "SUCCEEDED")
    return isStoredCancelResult(row.result, expectedOrderId)
      ? { kind: "DONE", result: row.result }
      : { kind: "DONE_UNKNOWN" };
  if (row.status === "REJECTED") {
    // 실제 ToolError.code/error_code를 보존한다 — EXPIRED/STALE 같은 재확인
    // 분기는 코드로 판정한다 (메시지만 보면 낡은 견적이 남는다) [PM060 추가].
    const code = isToolError(row.result)
      ? row.result.code
      : typeof row.error_code === "string"
        ? row.error_code
        : "REJECTED";
    const msg = isToolError(row.result)
      ? row.result.message
      : typeof row.error_code === "string"
        ? row.error_code
        : "이전에 거절된 취소 요청이에요. 주문 상태를 새로고침해 주세요.";
    return { kind: "REJECTED", message: msg, code };
  }
  return { kind: "UNKNOWN" };
}
