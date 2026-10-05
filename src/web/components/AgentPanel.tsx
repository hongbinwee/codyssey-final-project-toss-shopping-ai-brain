// A01 공통 AI 대화·비교 패널
import { useState } from "react";
import { api, newActionKey } from "../api.ts";

export interface AgentReply {
  role: "user" | "ai";
  text: string;
  evidence?: { products: string[]; variants: string[]; reviews: string[] };
  toolCalls?: string[];
  error?: boolean;
}

export function AgentPanel({
  messages,
  setMessages,
  pageContext,
  onOpenProduct,
  onCartChanged,
  onClose,
}: {
  messages: AgentReply[];
  setMessages: (m: AgentReply[]) => void;
  pageContext: { screen?: string; product_id?: string };
  onOpenProduct: (id: string) => void;
  onCartChanged: () => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    const next = [...messages, { role: "user" as const, text }];
    setMessages(next);
    const r = await api<{
      message: string;
      evidence_refs: { products: string[]; variants: string[]; reviews: string[] };
      tool_calls: { name: string; ok: boolean; code?: string }[];
      limit_reached?: boolean;
      error?: string;
    }>("/api/agent/turn", {
      method: "POST",
      body: JSON.stringify({
        user_message: text,
        page_context: pageContext,
        client_action_id: newActionKey(),
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setMessages([...next, { role: "ai", text: "호출에 실패했어요: " + r.error.message, error: true }]);
      return;
    }
    const d = r.data;
    if (d.tool_calls.some((c) => c.ok && ["add_to_cart"].includes(c.name))) onCartChanged();
    setMessages([
      ...next,
      {
        role: "ai",
        text: d.message,
        evidence: d.evidence_refs,
        toolCalls: d.tool_calls.map((c) => c.name + (c.ok ? "" : "✗")),
        error: !!d.error || !!d.limit_reached,
      },
    ]);
  }

  return (
    <aside className="agent-panel">
      <div className="agent-head">
        <div>
          <b>AI 쇼핑 도우미</b>
          <div className="muted sm">AI 생성 답변 · 실제 데이터를 조회합니다</div>
        </div>
        <button className="link" onClick={onClose}>닫기</button>
      </div>
      <div className="agent-body">
        {messages.length === 0 && (
          <div className="state-box">
            예산·용도를 알려주세요. 예: “배송비 포함 20만원 안에서 개발용 모니터 비교해줘”
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role + (m.error ? " err" : "")}>
            <p>{m.text}</p>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div className="muted sm">Tool: {m.toolCalls.join(", ")}</div>
            )}
            {m.evidence && (m.evidence.products.length + m.evidence.reviews.length > 0) && (
              <div className="evidence-chips">
                {m.evidence.products.map((id) => (
                  <button key={id} className="chip link-chip" onClick={() => onOpenProduct(id)}>
                    상품 {id}
                  </button>
                ))}
                {m.evidence.reviews.map((id) => (
                  <span key={id} className="chip">리뷰 {id}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg ai"><p>조회 중…</p></div>}
      </div>
      <div className="agent-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="조건이나 요청을 입력하세요"
        />
        <button className="btn primary" onClick={send} disabled={busy || !input.trim()}>
          보내기
        </button>
      </div>
    </aside>
  );
}

