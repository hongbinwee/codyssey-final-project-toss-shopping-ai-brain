import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, mock, test } from "node:test";
import type { ChatMsg } from "../../src/llm.ts";

// Import the real adapter/config without reading .env or credential files.
const readFileSync = fs.readFileSync;
const envGuard = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
  if (String(args[0]) === ".env") throw new Error("test: .env disabled");
  return Reflect.apply(readFileSync, fs, args);
});
syncBuiltinESMExports();
delete process.env.DATABASE_PASSWORD_FILE;
Object.assign(process.env, {
  NODE_ENV: "test", SESSION_SECRET: "test-session-only", TEST_USER_CODES: "",
  LLM_API_KEY: "fake-test-key", LLM_MODEL: "gpt-6-luna",
  LLM_BASE_URL: "https://example.invalid/v1", LLM_PROVIDER: "live",
});
delete process.env.LLM_REASONING_EFFORT;
delete process.env.LLM_API_TIMEOUT_MS;
const { config } = await import("../../src/config.ts");
const { liveProvider, scriptedProvider, stubProvider } = await import("../../src/llm.ts");
envGuard.mock.restore();
syncBuiltinESMExports();
const defaults = { ...config };
afterEach(() => { mock.restoreAll(); Object.assign(config, defaults); });

type Body = Record<string, any>;
function capture(responses: Response[]) {
  const requests: { url: string; options: RequestInit; body: Body }[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit) => {
    requests.push({ url: String(url), options, body: JSON.parse(String(options.body)) });
    const response = responses.shift();
    assert.ok(response, "unexpected retry or extra request");
    return response;
  });
  return requests;
}
const reply = (output: unknown[], extra = {}) => Response.json({
  id: "resp_test", object: "response", status: "completed", output, ...extra,
});
const textOutput = [{ type: "message", id: "msg_test", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "Hello", annotations: [] }] }];

test("Responses request uses configured model, flat optional tools, stateless reasoning and full history", async () => {
  const requests = capture([reply(textOutput, {
    usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
  })]);
  const result = await liveProvider().chat([
    { role: "system", content: "Policy one" },
    { role: "user", content: "Earlier" },
    { role: "assistant", content: "Previous answer" },
    { role: "system", content: "Policy two" },
    { role: "user", content: "Latest" },
  ], [{ type: "function", function: {
    name: "lookup", description: "Find orders", strict: true,
    parameters: { type: "object", properties: { query: { type: "string" } } },
  } }]);
  assert.equal(requests[0].url, "https://example.invalid/v1/responses");
  assert.equal(requests[0].options.method, "POST");
  assert.equal((requests[0].options.headers as Record<string, string>).authorization, "Bearer fake-test-key");
  assert.deepEqual(requests[0].body, {
    model: "gpt-6-luna", reasoning: { effort: "xhigh" }, max_output_tokens: 8192, store: false,
    include: ["reasoning.encrypted_content"], instructions: "Policy one\n\nPolicy two",
    input: [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Latest" }],
    tools: [{ type: "function", name: "lookup", description: "Find orders", strict: false,
      parameters: { type: "object", properties: { query: { type: "string" } } } }],
    tool_choice: "auto",
  });
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 });
  assert.deepEqual(result.responses_output, textOutput);
});

test("raw reasoning and function calls round trip once, using call_id rather than output item id", async () => {
  const raw = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-test-reasoning" },
    { type: "function_call", id: "fc_item_1", call_id: "call_order_1", name: "lookup", arguments: "{}", status: "completed" },
  ];
  const requests = capture([reply(raw), reply(textOutput)]);
  const provider = liveProvider();
  const history: ChatMsg[] = [{ role: "user", content: "Find my order" }];
  const first = await provider.chat(history, []);
  assert.equal(first.content, null);
  assert.deepEqual(first.tool_calls, [{ id: "call_order_1", name: "lookup", arguments: "{}" }]);
  assert.deepEqual(first.responses_output, raw);
  history.push({ role: "assistant", content: first.content, tool_calls: first.tool_calls,
    responses_output: first.responses_output });
  history.push({ role: "tool", tool_call_id: first.tool_calls![0].id, content: '{"order":42}' });
  await provider.chat(history, []);
  assert.deepEqual(requests[1].body.input, [
    { role: "user", content: "Find my order" }, ...raw,
    { type: "function_call_output", call_id: "call_order_1", output: '{"order":42}' },
  ]);
  assert.equal("previous_response_id" in requests[1].body, false);
});

test("legacy assistant tool calls convert to function_call and tool output", async () => {
  const requests = capture([reply(textOutput)]);
  await liveProvider().chat([
    { role: "assistant", content: "Looking up", tool_calls: [{ id: "call_legacy", name: "lookup", arguments: "{}" }] },
    { role: "tool", tool_call_id: "call_legacy", content: "found" },
  ], []);
  assert.deepEqual(requests[0].body.input, [
    { role: "assistant", content: "Looking up" },
    { type: "function_call", call_id: "call_legacy", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_legacy", output: "found" },
  ]);
});

test("provider requests remain isolated across concurrent users", async () => {
  const requests = capture([reply(textOutput), reply(textOutput)]);
  const provider = liveProvider();
  await Promise.all([
    provider.chat([{ role: "user", content: "User A" }], []),
    provider.chat([{ role: "user", content: "User B" }], []),
  ]);
  assert.deepEqual(requests.map((r) => r.body.input), [
    [{ role: "user", content: "User A" }], [{ role: "user", content: "User B" }],
  ]);
  assert.ok(requests.every((r) => !("previous_response_id" in r.body)));
});

test("configured base URL retains custom path and removes trailing slashes", async () => {
  config.llmBaseUrl = "https://proxy.invalid/custom/v1///";
  const requests = capture([reply(textOutput)]);
  await liveProvider().chat([], []);
  assert.equal(requests[0].url, "https://proxy.invalid/custom/v1/responses");
});

test("non-200 errors expose only HTTP status and never consume the secret response body or retry", async () => {
  const response = new Response("fake-test-key private-customer-content", { status: 429 });
  const requests = capture([response]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM http 429" });
  assert.equal(response.bodyUsed, false);
  assert.equal(requests.length, 1);
});

test("transport and invalid JSON errors do not leak upstream messages", async () => {
  mock.method(globalThis, "fetch", async () => { throw new Error("fake-test-key private-network-detail"); });
  await assert.rejects(liveProvider().chat([], []), { message: "LLM request failed" });
  mock.restoreAll();
  capture([new Response("private-bad-json", { status: 200 })]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM invalid response" });
});

test("timeout aborts the request without retries or fallback", async () => {
  Object.assign(config, { llmApiTimeoutMs: 10 });
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("private-timeout-detail")), { once: true });
    });
  });
  await assert.rejects(liveProvider().chat([], []), { message: "LLM timeout" });
  assert.equal(calls, 1);
});

test("external deadline abort settles the pending fetch before the provider timeout", async () => {
  Object.assign(config, { llmApiTimeoutMs: 50 });
  const deadline = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    fetchSignal = options.signal!;
    return await new Promise<Response>((_resolve, reject) => {
      fetchSignal!.addEventListener("abort", () => reject(new Error("private-abort-detail")), { once: true });
    });
  });
  const settled = assert.rejects(liveProvider().chat([], [], { signal: deadline.signal }), { message: "LLM timeout" });
  deadline.abort();
  const abortedByDeadline = fetchSignal?.aborted;
  await settled;
  assert.equal(abortedByDeadline, true);
  assert.equal(calls, 1);
});

test("malformed or failed response cannot become an empty successful answer", async () => {
  capture([Response.json({ error: { message: "secret" } }), reply([], { status: "failed", error: { message: "secret" } })]);
  await assert.rejects(liveProvider().chat([], []), { message: "LLM invalid response" });
  await assert.rejects(liveProvider().chat([], []), { message: "LLM response failed" });
});

test("scripted and read-only stub providers keep the chat contract without fetch", async () => {
  mock.method(globalThis, "fetch", async () => { assert.fail("stub/scripted must not fetch"); });
  assert.deepEqual(await scriptedProvider([{ content: "scripted" }]).chat([], []), { content: "scripted" });
  const stub = await stubProvider().chat([{ role: "user", content: "apple" }], []);
  assert.equal(stub.tool_calls?.[0].name, "search_products");
});
