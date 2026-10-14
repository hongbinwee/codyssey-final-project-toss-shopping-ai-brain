// PMQA-062 — mock-guard 순수 판정 + mock-audit verdict DB-free 단위 검증.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  decideRequest,
  MOCK_ORIGIN,
} from "../e2e/mock-guard.ts";
import { mockVerdict } from "../e2e/mock-audit.ts";

test("mock-guard: 가상 origin 정적 자산 fulfill", () => {
  assert.deepEqual(decideRequest("GET", MOCK_ORIGIN + "/"), {
    kind: "static",
    file: "index.html",
    mime: "text/html; charset=utf-8",
  });
  const js = decideRequest("GET", MOCK_ORIGIN + "/web/app.js");
  assert.equal(js.kind, "static");
});

test("mock-guard: 실제 자산 경로 /assets/<subdir> 허용 + 상승 거부", () => {
  const ok = decideRequest("GET", MOCK_ORIGIN + "/assets/products/p-a.webp");
  assert.equal(ok.kind, "static");
  if (ok.kind === "static")
    assert.equal(ok.file, join("web", "assets", "products", "p-a.webp"));
  const up = decideRequest("GET", MOCK_ORIGIN + "/assets/../secrets");
  assert.equal(up.kind, "block");
  const up2 = decideRequest("GET", MOCK_ORIGIN + "/assets/products/../../x");
  assert.equal(up2.kind, "block");
});

test("mock-guard: API 경로는 mock 계층으로, 미등록 정적 경로는 block", () => {
  assert.equal(
    decideRequest("GET", MOCK_ORIGIN + "/api/orders").kind,
    "api",
  );
  assert.equal(
    decideRequest("POST", MOCK_ORIGIN + "/api/orders/x/cancel/execute").kind,
    "api",
  );
  const u = decideRequest("GET", MOCK_ORIGIN + "/unknown");
  assert.equal(u.kind, "block");
  if (u.kind === "block") assert.equal(u.disposition, "blocked-path");
});

test("mock-guard: 외부 origin은 경로 무관 block + 비-GET 정적 요청 block", () => {
  const ext = decideRequest("GET", "https://evil.example/api/orders");
  assert.equal(ext.kind, "block");
  if (ext.kind === "block") assert.equal(ext.disposition, "blocked-origin");
  const cdn = decideRequest(
    "GET",
    "https://cdn.jsdelivr.net/font.css",
  );
  assert.equal(cdn.kind, "block");
  const post = decideRequest("POST", MOCK_ORIGIN + "/web/app.js");
  assert.equal(post.kind, "block");
});

test("mock-guard: 다른 localhost 포트도 외부 origin이다", () => {
  // 3102 readonly 서버로의 새는 요청도 origin이 다르므로 차단된다.
  const d = decideRequest("GET", "http://localhost:3102/api/orders");
  assert.equal(d.kind, "block");
  if (d.kind === "block") assert.equal(d.disposition, "blocked-origin");
});

test("mock-audit verdict: 어떤 실패라도 있으면 PASS 없음", () => {
  assert.deepEqual(
    mockVerdict({ spawnError: null, pwStatus: 0, steps: [{ ok: true, reason: "a" }] }),
    { pass: true, exit: 0, reasons: [] },
  );
  const bad = mockVerdict({
    spawnError: null,
    pwStatus: 1,
    steps: [{ ok: false, reason: "gate" }],
  });
  assert.equal(bad.pass, false);
  assert.equal(bad.exit, 1);
  assert.ok(bad.reasons.length >= 2);
});
