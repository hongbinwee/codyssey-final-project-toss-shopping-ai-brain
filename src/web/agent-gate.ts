// F22 글로벌 AI 진입 게이트 — Commerce Fidelity 단계에서 일반 구매 흐름의
// AI 요청은 열지 않는다. /api/agent/turn 서버 계약과 Brain 설계는 미래를 위해
// 보존하되, 활성화 전까지 이 게이트는 어떤 호출자에게도 실제 네트워크를 열지
// 않는다(fail-closed). '준비 중' 상태는 진입점 라벨과 이 결과로 정직하게 표시한다.
export const AGENT_TURN_ENABLED = false;

export interface AgentTurnPayload {
  user_message: string;
  page_context: unknown;
  client_action_id: string;
  brain: "shopping" | "cs";
}

export type AgentTurnResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

// post는 실제 전송 함수 — 게이트가 닫혀 있으면 한 번도 호출되지 않는다
// (0-callback 보장을 단위 테스트로 검증한다).
export async function sendAgentTurn<T>(
  payload: AgentTurnPayload,
  post: (path: "/api/agent/turn", body: AgentTurnPayload) => Promise<AgentTurnResult<T>>,
): Promise<AgentTurnResult<T>> {
  if (!AGENT_TURN_ENABLED)
    return {
      ok: false,
      error: {
        code: "AGENT_UNAVAILABLE",
        message: "AI 쇼핑 도우미는 아직 준비 중이에요",
      },
    };
  return post("/api/agent/turn", payload);
}
