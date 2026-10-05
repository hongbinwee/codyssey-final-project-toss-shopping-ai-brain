// DATA_TOOL_DESIGN 5절 공통 응답 봉투. Tool별 DTO는 Phase 1+에서 추가한다.
export type RecoveryAction =
  | "RETRY_READ"
  | "REFRESH_AND_RECONFIRM"
  | "CHECK_OPERATION"
  | "STOP";

export type ToolError = {
  code: string;
  message: string;
  recovery_action: RecoveryAction;
};

export type ToolResult<T> =
  | { ok: true; data: T; observed_at: string; trace_id: string }
  | {
      ok: false;
      error: ToolError;
      trace_id: string;
      operation_id?: string;
    };

export const ok = <T>(data: T, trace_id: string): ToolResult<T> => ({
  ok: true,
  data,
  observed_at: new Date().toISOString(),
  trace_id,
});

export const fail = <T>(
  error: ToolError,
  trace_id: string,
  operation_id?: string,
): ToolResult<T> => ({ ok: false, error, trace_id, operation_id });
