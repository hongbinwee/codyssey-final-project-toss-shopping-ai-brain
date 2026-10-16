// DB-free: dispatch and timeout selection; fetch never reaches a server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendAgentTurn, type AgentTurnPayload } from "../../src/web/agent-gate.ts";
import { api, apiSafe } from "../../src/web/api.ts";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transpileModule, JsxEmit, ModuleKind } from "typescript";
import type { CompareCard } from "../../src/contracts.ts";

// Compile TSX in memory for component assertions; no browser, bundle, or output files.
const tsxHook = registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext },
      }).outputText,
    };
  },
});
const { AgentPanel } = await import("../../src/web/components/AgentPanel.tsx");
tsxHook.deregister();

const payload: AgentTurnPayload = {
  user_message: "상품과 저장 리뷰를 비교해줘",
  page_context: { screen: "shop" },
  client_action_id: "live-ui-test",
  brain: "shopping",
};

test("shopping dispatches once to the agent endpoint with its original payload", async () => {
  let calls = 0;
  const result = await sendAgentTurn(payload, async (path, body) => {
    calls++;
    assert.equal(path, "/api/agent/turn");
    assert.deepEqual(body, payload);
    return { ok: true, data: { message: "조회 결과" } };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true, data: { message: "조회 결과" } });
});

test("CS stays unsupported and never invokes transport", async () => {
  let calls = 0;
  const result = await sendAgentTurn({ ...payload, brain: "cs" }, async () => {
    calls++;
    return { ok: true, data: {} };
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "AGENT_UNAVAILABLE");
});

test("only agent turns get enough time for the 240s tool loop; commerce stays at 30s", async (t) => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, "fetch", async (_path: string, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ ok: true, data: { value: 1 } }));
  });
  for (const path of ["/api/agent/turn", "/api/products", "/api/cart", "/api/agent/turn-other"]) {
    assert.deepEqual(await api(path), { ok: true, data: { value: 1 } });
  }
  assert.ok(timeouts[0]! >= 240_000);
  assert.deepEqual(timeouts.slice(1), [30_000, 30_000, 30_000]);
});

test("agent timeout preserves caller cancellation and apiSafe returns a recoverable envelope", async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, "fetch", async (_path: string, init?: RequestInit) => {
    assert.equal(init?.signal?.aborted, true);
    init!.signal!.throwIfAborted();
    throw new Error("unreachable");
  });
  const result = await apiSafe("/api/agent/turn", { signal: controller.signal });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "NETWORK");
});

const panelProps = {
  brain: "shopping" as const,
  setMessages: () => {},
  pageContext: { screen: "shop" },
  onOpenProduct: () => {},
  onCartChanged: () => {},
  onClose: () => {},
};

test("single-product cards retain product actions and label sparse/low-rated evidence as reference", () => {
  for (const [avg, count, reference] of [[3.5, 10, true], [4.5, 9, true], [null, 10, true], [3.6, 10, false]] as const) {
    const compare: CompareCard = {
      products: [{
        product_id: "real-product-1", name: "실제 상품", min_price_won: 10_000,
        max_price_won: 10_000, rating_summary: { avg, count }, availability: "AVAILABLE",
        evidence_review_ids: ["stored-review-1"],
      }],
      limitations: [],
    };
    const html = renderToStaticMarkup(createElement(AgentPanel, {
      ...panelProps,
      messages: [{ role: "ai", text: "조회 결과", compare,
        evidence: { products: ["real-product-1"], reviews: ["stored-review-1"], variants: [] } }],
    }));
    assert.equal(html.includes("참고용 상품"), reference);
    assert.ok(html.includes(`저장된 리뷰 ${count}개`));
    assert.ok(html.includes("Amazon 전체 리뷰 수가 아니에요"));
    assert.ok(html.includes("상품 보기 · real-product-1"));
    assert.ok(html.includes("stored-review-1"));
    assert.ok(!html.includes("추천"));
    assert.ok(!html.includes("장바구니"));
  }
});

test("unsupported CS renders disabled input and send controls without soliciting orders", () => {
  const html = renderToStaticMarkup(createElement(AgentPanel, { ...panelProps, brain: "cs", messages: [] }));
  assert.ok(html.includes("AI 고객센터는 아직 지원하지 않아요"));
  assert.match(html, /<input[^>]*disabled=""/);
  assert.match(html, /<button class="btn primary" disabled=""/);
  assert.ok(!html.includes("내 최근 주문"));
});
