// eval/cases/<split>/*.json을 실행한다.
// mode=stub: 케이스의 script를 재생해 runtime/Tool 경계 평가.
// mode=live: 실제 LLM 호출. 키 없으면 BLOCKED.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { ensureTestDb, cleanUserData } from "../tests/helpers/testdb.ts";
import { runAgentTurn, resetHistory, ungroundedCitations } from "../src/agent.ts";
import { liveProvider, scriptedProvider, type ChatResponse, type Provider } from "../src/llm.ts";
import { getCart } from "../src/cart.ts";
import { sql } from "../src/db.ts";
import { config } from "../src/config.ts";

// --k=v 와 k=v 둘 다 받는다. (기존은 k=v만 매칭돼 --split 등이 조용히 무시됐다)
const arg = (k: string, d?: string) =>
  process.argv
    .map((a) => a.replace(/^--/, ""))
    .find((a) => a.startsWith(k + "="))
    ?.split("=")[1] ?? d;

const mode = arg("mode", "stub")!;
const split = arg("split", "dev")!;
// holdout은 같은 케이스를 초기화된 상태에서 repeat회 반복한다 (기본 1).
const repeat = Math.max(1, Number(arg("repeat", "1")));

if (mode === "live" && !config.llmApiKey) {
  console.log("BLOCKED: LLM_API_KEY not set — live eval skipped (stub PASS로 대체하지 않음)");
  process.exit(2);
}

type Expect = {
  required_tools?: string[];
  forbidden_tools?: string[];
  cart?: {
    items_count?: number;
    variant_id?: string;
    quantity?: number;
    items_total_won?: number;
    total_won?: number;
  };
  stock?: Record<string, number>;
  expect_error_code?: string;
  evidence_cited?: boolean;
  compare_present?: boolean;
};
type Case = {
  case_id: string;
  user: string;
  brain?: "shopping" | "cs";
  turns: { user_message: string }[];
  script?: ChatResponse[];
  expect: Expect;
};

const dir = "eval/cases/" + split;
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const results: { case_id: string; pass: boolean; failures: string[] }[] = [];

await ensureTestDb(Number(arg("phase", "4")));

for (const f of files) {
  const cases = JSON.parse(readFileSync(dir + "/" + f, "utf8")).cases as Case[];
  for (const c of cases) {
    for (let rep = 0; rep < repeat; rep++) {
    const caseLabel = repeat > 1 ? c.case_id + "#r" + (rep + 1) : c.case_id;
    const failures: string[] = [];
    await cleanUserData();
    resetHistory(c.user);
    const provider: Provider =
      mode === "live" ? liveProvider() : scriptedProvider(c.script ?? []);
    const ctx = { actorUserId: c.user, origin: "AGENT" as const };
    const turns = [];
    for (const [i, t] of c.turns.entries()) {
      // scripted 쓰기 케이스용: "$last_changed_item"을 직전 카트 첫 항목 id로 치환한다.
      const cartBefore = await getCart(ctx);
      const lastItem = cartBefore.ok ? cartBefore.data.items[0]?.cart_item_id : undefined;
      const dyn: Provider =
        mode === "live" || !lastItem
          ? provider
          : {
              name: provider.name,
              chat: async (m, tl) => {
                const resp = await provider.chat(m, tl);
                if (resp.tool_calls)
                  for (const tc of resp.tool_calls)
                    if (tc.arguments?.includes("$last_changed_item"))
                      tc.arguments = tc.arguments.replaceAll("$last_changed_item", lastItem);
                return resp;
              },
            };
      const r = await runAgentTurn(
        { user_message: t.user_message, client_action_id: "eval-" + c.case_id + "-" + i, brain: c.brain },
        ctx,
        dyn,
      );
      turns.push(r);
    }
    const last = turns[turns.length - 1];
    const used = new Set(turns.flatMap((t) => t.tool_calls.map((c2) => c2.name)));
    for (const t of c.expect.required_tools ?? [])
      if (!used.has(t)) failures.push("required tool missing: " + t);
    for (const t of c.expect.forbidden_tools ?? [])
      if (used.has(t)) failures.push("forbidden tool used: " + t);
    if (c.expect.expect_error_code) {
      const hit = turns.some((t) =>
        t.tool_calls.some((c2) => c2.code === c.expect.expect_error_code),
      );
      if (!hit) failures.push("expected error code not observed: " + c.expect.expect_error_code);
    }
    if (c.expect.cart) {
      const cartRes = await getCart(ctx);
      if (!cartRes.ok) failures.push("cart read failed");
      else {
        const cart = cartRes.data;
        if (c.expect.cart.items_count !== undefined && cart.items.length !== c.expect.cart.items_count)
          failures.push("cart items_count=" + cart.items.length + " expected " + c.expect.cart.items_count);
        if (c.expect.cart.variant_id) {
          const it = cart.items.find((i) => i.variant_id === c.expect.cart!.variant_id);
          if (!it) failures.push("cart item missing: " + c.expect.cart.variant_id);
          else if (c.expect.cart.quantity !== undefined && it.quantity !== c.expect.cart.quantity)
            failures.push("cart qty=" + it.quantity + " expected " + c.expect.cart.quantity);
        }
        if (c.expect.cart.items_total_won !== undefined && cart.items_total_won !== c.expect.cart.items_total_won)
          failures.push("items_total=" + cart.items_total_won);
        if (c.expect.cart.total_won !== undefined && cart.total_won !== c.expect.cart.total_won)
          failures.push("total=" + cart.total_won);
      }
    }
    for (const [vid, want] of Object.entries(c.expect.stock ?? {})) {
      const [v] = await sql.unsafe<{ stock_qty: number }[]>(
        "SELECT stock_qty FROM product_variants WHERE id=$1", [vid],
      );
      if (v?.stock_qty !== want) failures.push("stock " + vid + "=" + v?.stock_qty + " expected " + want);
    }
    if (c.expect.evidence_cited) {
      for (const id of ungroundedCitations(last.message, last.evidence_refs))
        failures.push("cited id not in tool results: " + id);
    }
    if (c.expect.compare_present && !last.compare)
      failures.push("expected compare card but none was assembled");
    results.push({ case_id: caseLabel, pass: failures.length === 0, failures });
    }
  }
}

mkdirSync("eval/results", { recursive: true });
writeFileSync(
  "eval/results/" + split + "-" + mode + ".json",
  JSON.stringify({ mode, split, provider: mode, at: new Date().toISOString(), results }, null, 2),
);
for (const r of results)
  console.log((r.pass ? "PASS" : "FAIL") + " " + r.case_id + (r.failures.length ? " — " + r.failures.join("; ") : ""));
const failed = results.filter((r) => !r.pass).length;
console.log("eval " + mode + "/" + split + ": " + (results.length - failed) + "/" + results.length + " passed");
await sql.end();
process.exit(failed ? 1 : 0);
