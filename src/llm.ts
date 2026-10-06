// LLM Provider Adapter. OpenAI 호환 chat completions + tool calling.
// 모델/SDK를 이 한 파일에 격리한다. live 키가 없으면 read-only stub을 쓴다.
import { config } from "./config.ts";

export type ToolCallReq = { id: string; name: string; arguments: string };
export type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCallReq[];
  tool_call_id?: string;
  name?: string;
};
export type ChatResponse = {
  content: string | null;
  tool_calls?: ToolCallReq[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};
export interface Provider {
  name: string;
  chat(messages: ChatMsg[], tools: unknown[]): Promise<ChatResponse>;
}

export function liveProvider(): Provider {
  return {
    name: "live:" + config.llmModel,
    async chat(messages, tools) {
      const res = await fetch(config.llmBaseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + config.llmApiKey,
        },
        body: JSON.stringify({
          model: config.llmModel,
          messages,
          tools,
          tool_choice: "auto",
        }),
      });
      if (!res.ok)
        throw new Error("LLM http " + res.status + ": " + (await res.text()).slice(0, 300));
      const j = (await res.json()) as {
        choices: { message: { content: string | null; tool_calls?: ToolCallReq[] } }[];
        usage?: ChatResponse["usage"];
      };
      const m = j.choices[0].message;
      return { content: m.content, tool_calls: m.tool_calls, usage: j.usage };
    },
  };
}

// 평가·테스트용: 케이스 파일이 정한 응답을 순서대로 재생한다.
export function scriptedProvider(steps: ChatResponse[]): Provider {
  let i = 0;
  return {
    name: "scripted",
    async chat() {
      const s = steps[i++];
      if (!s) return { content: "(scripted provider: 응답 소진)" };
      return s;
    },
  };
}

// 로컬 데모용 stub: LLM 없이도 A01을 열 수 있게 조회 Tool만 호출하고,
// 쓰기 Tool은 절대 호출하지 않는다. 실제 모델 실행으로 보고하지 않는다.
export function stubProvider(): Provider {
  return {
    name: "stub-readonly",
    async chat(messages, tools) {
      const names = new Set(
        (tools as { function?: { name?: string } }[]).map((t) => t.function?.name),
      );
      const toolMsgs = messages.filter((m) => m.role === "tool");
      // CS Brain 스텁: 주문 목록 → 첫 주문 배송 조회 → 실제 조회값 요약.
      if (names.has("list_orders")) {
        if (toolMsgs.length === 0)
          return {
            content: null,
            tool_calls: [{ id: "call_1", name: "list_orders", arguments: "{}" }],
          };
        if (toolMsgs.length === 1) {
          try {
            const d = JSON.parse(String(toolMsgs[0].content));
            const oid = d?.orders?.[0]?.id;
            if (!oid)
              return { content: "주문 내역이 없어요. 주문이 생기면 다시 확인해 주세요." };
            return {
              content: null,
              tool_calls: [
                { id: "call_2", name: "get_shipping_status", arguments: JSON.stringify({ order_id: oid }) },
              ],
            };
          } catch {
            // fallthrough
          }
        }
        try {
          const ship = JSON.parse(String(toolMsgs[1]?.content ?? "{}"));
          const list = JSON.parse(String(toolMsgs[0].content));
          const oid = list?.orders?.[0]?.id;
          if (ship?.information === "NO_INFORMATION")
            return { content: oid + " 주문의 배송 정보가 아직 등록되지 않았어요. 잠시 후 다시 확인해 주세요." };
          const label = { PREPARING: "배송 준비 중", IN_TRANSIT: "배송 중", DELIVERED: "배송 완료", CANCELLED: "배송 취소" }[ship?.status as string] ?? "알 수 없음";
          return { content: oid + " 주문은 현재 " + label + " 상태예요. (로컬 stub — LLM 미설정)" };
        } catch {
          return { content: "주문/배송 정보를 확인하지 못했어요." };
        }
      }
      if (toolMsgs.length === 0) {
        const userMsg = [...messages].reverse().find((m) => m.role === "user");
        const raw = typeof userMsg?.content === "string" ? userMsg.content : "";
        // stub은 의도 추출을 흉내낸다: 요청 어미(~해줘/~주세요/추천/비교 등)를 떼고
        // 남은 토큰의 마지막을 상품 키워드로 쓴다. 없으면 원문 그대로.
        const tokens = raw
          .split(/\s+/)
          .map((t) => t.replace(/[?!.,~]/g, ""))
          .filter(
            (t) =>
              t &&
              !/(해주세요|해줘|주세요|줘|줄래|해주|해|추천|비교|알려|보여|찾아|골라|검색|싶어|할게)$/u.test(
                t,
              ),
          );
        const query = (tokens[tokens.length - 1] ?? raw).slice(0, 50);
        return {
          content: null,
          tool_calls: [
            { id: "call_1", name: "search_products", arguments: JSON.stringify({ query }) },
          ],
        };
      }
      // 이미 상품 검색 결과가 있으면 첫 상품의 리뷰를 한 번 조회한다.
      if (toolMsgs.length === 1 && toolMsgs[0].name === "search_products") {
        try {
          const data = JSON.parse(String(toolMsgs[0].content));
          const pid = data?.data?.items?.[0]?.product_id;
          if (pid)
            return {
              content: null,
              tool_calls: [
                { id: "call_2", name: "get_reviews", arguments: JSON.stringify({ product_id: pid }) },
              ],
            };
        } catch {
          // fallthrough
        }
      }
      const first = JSON.parse(String(toolMsgs[0]?.content ?? "{}"));
      const items = first?.data?.items ?? [];
      if (items.length === 0)
        return {
          content: "조건에 맞는 상품을 찾지 못했어요. 검색 조건을 바꿔서 다시 알려주세요.",
        };
      const lines = items
        .slice(0, 3)
        .map(
          (it: { product_id: string; name: string; matched_variants: { variant_id: string; unit_price_won: number; availability: string }[] }) =>
            "- " + it.name + " (" + it.product_id + "): " +
            it.matched_variants
              .map((v) => v.variant_id + " " + v.unit_price_won.toLocaleString() + "원 " + v.availability)
              .join(" / "),
        );
      return {
        content:
          "(로컬 stub — LLM 미설정)\n조건에 맞는 후보를 찾았어요:\n" +
          lines.join("\n") +
          "\n\n옵션과 수량을 지정해 주시면 장바구니에 담아드릴게요.",
      };
    },
  };
}

export function getProvider(): Provider {
  return config.llmProvider === "live" && config.llmApiKey
    ? liveProvider()
    : stubProvider();
}
