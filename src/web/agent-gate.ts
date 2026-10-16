// 쇼핑 AI만 활성화한다. CS는 서버 지원 전까지 전송하지 않는다.
export const AGENT_TURN_ENABLED = true;

export interface AgentTurnPayload {
  user_message: string;
  page_context: unknown;
  client_action_id: string;
  brain: "shopping" | "cs";
}

export type AgentTurnResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

// 비활성 Brain은 전송 함수를 호출하지 않는다.
export async function sendAgentTurn<T>(
  payload: AgentTurnPayload,
  post: (path: "/api/agent/turn", body: AgentTurnPayload) => Promise<AgentTurnResult<T>>,
): Promise<AgentTurnResult<T>> {
  if (!AGENT_TURN_ENABLED || payload.brain !== "shopping")
    return {
      ok: false,
      error: {
        code: "AGENT_UNAVAILABLE",
        message: payload.brain === "cs"
          ? "AI 고객센터는 아직 지원하지 않아요"
          : "AI 쇼핑 도우미는 아직 준비 중이에요",
      },
    };
  return post("/api/agent/turn", payload);
}
