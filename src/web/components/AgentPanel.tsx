// A01 공통 AI 대화·비교 패널
import { useState } from "react";
import { api, fmtWon, newActionKey, type AgentBrain } from "../api.ts";
import type { CompareCard } from "../../contracts.ts";

export interface AgentReply {
  role: "user" | "ai";
  text: string;
  evidence?: { products: string[]; variants: string[]; reviews: string[] };
  compare?: CompareCard;
  toolCalls?: string[];
  error?: boolean;
}

// 카트에 영향을 주는 쓰기 Tool — 성공 시 헤더 카트를 갱신한다.
const CART_WRITE_TOOLS = ["add_to_cart", "update_cart_quantity", "remove_cart_item"];

function CompareCardView({
  card,
  onOpenProduct,
}: {
  card: CompareCard;
  onOpenProduct: (id: string) => void;
}) {
  return (
    <div className="compare-card">
      {card.products.map((p) => (
        <div key={p.product_id} className="compare-row">
          <div className="compare-head">
            <b>{p.name}</b>
            {p.availability !== "AVAILABLE" && <span className="badge-soldout">품절/중단</span>}
          </div>
          <div className="muted sm">
            {fmtWon(p.min_price_won)}
            {p.max_price_won > p.min_price_won && " ~ " + fmtWon(p.max_price_won)}
            {" · "}
            {p.rating_summary.avg === null
              ? "평점 없음"
              : "★" + p.rating_summary.avg + " (" + p.rating_summary.count + ")"}
          </div>
          <div className="muted sm">
            근거 리뷰:{" "}
            {p.evidence_review_ids.length > 0
              ? p.evidence_review_ids.join(", ")
              : "없음"}
          </div>
          <button className="link" onClick={() => onOpenProduct(p.product_id)}>
            상품 보기
          </button>
        </div>
      ))}
      {card.limitations.length > 0 && (
        <div className="muted sm compare-limit">
          {card.limitations.map((l) => (
            <div key={l}>· {l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentPanel({
  brain,
  messages,
  setMessages,
  pageContext,
  onOpenProduct,
  onCartChanged,
  onClose,
}: {
  brain: AgentBrain;
  messages: AgentReply[];
  setMessages: (m: AgentReply[]) => void;
  pageContext: { screen?: string; product_id?: string; order_id?: string };
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
      compare?: CompareCard;
      tool_calls: { name: string; ok: boolean; code?: string }[];
      limit_reached?: boolean;
      error?: string;
    }>("/api/agent/turn", {
      method: "POST",
      body: JSON.stringify({
        user_message: text,
        page_context: pageContext,
        client_action_id: newActionKey(),
        brain,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setMessages([...next, { role: "ai", text: "호출에 실패했어요: " + r.error.message, error: true }]);
      return;
    }
    const d = r.data;
    if (d.tool_calls.some((c) => c.ok && CART_WRITE_TOOLS.includes(c.name))) onCartChanged();
    setMessages([
      ...next,
      {
        role: "ai",
        text: d.message,
        evidence: d.evidence_refs,
        compare: d.compare,
        toolCalls: d.tool_calls.map((c) => c.name + (c.ok ? "" : "✗")),
        error: !!d.error || !!d.limit_reached,
      },
    ]);
  }

  return (
    <aside className="agent-panel">
      <div className="agent-head">
        <div>
          <b>{brain === "cs" ? "AI 고객센터" : "AI 쇼핑 도우미"}</b>
          <div className="muted sm">AI 생성 답변 · 실제 데이터를 조회합니다</div>
        </div>
        <button className="link" onClick={onClose}>닫기</button>
      </div>
      <div className="agent-body">
        {messages.length === 0 && (
          <div className="state-box">
            {brain === "cs"
              ? "주문이나 배송에 대해 물어보세요. 예: “내 최근 주문 배송 상태 알려줘”"
              : "예산·용도를 알려주세요. 예: “배송비 포함 20만원 안에서 개발용 모니터 비교해줘”"}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + m.role + (m.error ? " err" : "")}>
            <p>{m.text}</p>
            {m.toolCalls && m.toolCalls.length > 0 && (
              <div className="muted sm">Tool: {m.toolCalls.join(", ")}</div>
            )}
            {m.compare && (
              <CompareCardView card={m.compare} onOpenProduct={onOpenProduct} />
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
