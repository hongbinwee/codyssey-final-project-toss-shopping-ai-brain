// AI 게이트 — 쇼핑만 전송하고 CS는 차단한다(DB-free, 실제 네트워크 없음).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { AGENT_TURN_ENABLED, sendAgentTurn } = await import(
  "../../src/web/agent-gate.ts"
);

describe("agent-gate shopping enabled / CS fail-closed", () => {
  test("쇼핑 활성 상태에서 post callback 호출 1 + 응답 보존", async () => {
    assert.equal(AGENT_TURN_ENABLED, true);
    let calls = 0;
    const r = await sendAgentTurn(
      {
        user_message: "모니터 추천해줘",
        page_context: { screen: "shop" },
        client_action_id: "k1",
        brain: "shopping",
      },
      async (path, body) => {
        calls++;
        assert.equal(path, "/api/agent/turn");
        assert.equal(body.brain, "shopping");
        return { ok: true, data: { message: "x" } };
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(r, { ok: true, data: { message: "x" } });
  });

  test("CS는 post callback 호출 0 + AGENT_UNAVAILABLE 반환", async () => {
    let calls = 0;
    const r = await sendAgentTurn(
      {
        user_message: "배송 상태 알려줘",
        page_context: { screen: "orders" },
        client_action_id: "cs-k1",
        brain: "cs",
      },
      async () => {
        calls++;
        return { ok: true, data: { message: "x" } };
      },
    );
    assert.equal(calls, 0, "미지원 CS는 전송 함수를 호출하지 않아야 한다");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "AGENT_UNAVAILABLE");
      assert.ok(r.error.message.length > 0);
    }
  });
});
