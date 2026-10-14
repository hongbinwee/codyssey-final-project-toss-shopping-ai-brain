// F22 AI 게이트 — 게이트가 닫힌 동안 전송 callback이 한 번도 호출되지 않음을
// spy로 검증한다(DB-free). '실제 네트워크 0'은 정적 분석이 아니라 이 결과로
// 주장한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { AGENT_TURN_ENABLED, sendAgentTurn } = await import(
  "../../src/web/agent-gate.ts"
);

describe("agent-gate fail-closed", () => {
  test("비활성 상태에서 post callback 호출 0 + AGENT_UNAVAILABLE 반환", async () => {
    assert.equal(AGENT_TURN_ENABLED, false);
    let calls = 0;
    const r = await sendAgentTurn(
      {
        user_message: "모니터 추천해줘",
        page_context: { screen: "shop" },
        client_action_id: "k1",
        brain: "shopping",
      },
      async () => {
        calls++;
        return { ok: true, data: { message: "x" } };
      },
    );
    assert.equal(calls, 0, "게이트가 닫히면 전송 함수는 호출되지 않아야 한다");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "AGENT_UNAVAILABLE");
      assert.ok(r.error.message.length > 0);
    }
  });
});
