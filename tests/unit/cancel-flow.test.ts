// src/cancel-flow.ts의 DB-free 검증 — mock IO를 실제 핸들러에 주입해
// approve/execute 유실·연타·재진입·스코프 전환·형식 검증을 회귀한다 [PMQA-060].
// 브라우저 없이 UI 호출 경로의 배선을 실증한다 — CancelSheet는 같은 함수에
// 실제 api/pending을 꽂는다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ApiResult } from "../../src/web/api.ts";
import type { PendingWrite } from "../../src/web/pending.ts";
import type { CancelRequestResult, OrderView } from "../../src/contracts.ts";
import {
  runCancelRequest, runCancelRecovery, runCancelRetry,
  isAmbiguousCancelError, reconfirmReset,
  type CancelFlowIO, type CancelOutcome,
} from "../../src/cancel-flow.ts";
import type { CancelActionRow } from "../../src/cancel-recovery.ts";

// ---- mock IO ----

type Store = Map<string, PendingWrite>;

function mkIo(handlers: Partial<CancelFlowIO> = {}) {
  const calls: string[] = [];
  // intent 저장소 — 복구·재시도는 'intent 유지/해제'를 단정하므로 저장된 상태로
  // 시작한다(미삽입이면 remove 없이도 size 0이라 '유지' 단정이 거짓으로 깨진다).
  // 직접 set이라 호출 기록에는 남지 않는다.
  const pending: Store = new Map([["k1", mkPending()]]);
  const state = { scope: "u-a" as string | null, epoch: 1 };
  const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
  const fail = (code: string, message = code): ApiResult<never> => ({
    ok: false,
    error: { code, message },
  });
  // 호출 기록은 래퍼가 먼저 남기고 커스텀 핸들러에 위임한다 — 커스텀 핸들러가
  // 호출 자체를 기록하지 않아도 POST 여부·횟수를 정확히 검증할 수 있다.
  const io: CancelFlowIO = {
    approve: (path, body) => {
      calls.push("approve:" + JSON.stringify(body));
      return handlers.approve
        ? handlers.approve(path, body)
        : Promise.resolve(ok({ confirmation_id: "op-1" }));
    },
    execute: (oid, body) => {
      calls.push("execute:" + JSON.stringify(body));
      return handlers.execute
        ? handlers.execute(oid, body)
        : Promise.resolve(ok({
            cancel_request_id: "cxl-1",
            status: "REQUESTED",
            refund_amount_won: 292000,
            order: { id: oid } as OrderView,
          } as CancelRequestResult));
    },
    lookupAction: (uiKey) => {
      calls.push("lookup");
      return handlers.lookupAction
        ? handlers.lookupAction(uiKey)
        : Promise.resolve(fail("NOT_FOUND"));
    },
    getOrder: (oid) => {
      calls.push("getOrder");
      return handlers.getOrder
        ? handlers.getOrder(oid)
        : Promise.resolve(fail("NOT_FOUND"));
    },
    putPending: (pw) => {
      calls.push("put:" + (pw.payload.confirmation_id ? "cfm" : "init"));
      if (handlers.putPending) return handlers.putPending(pw);
      pending.set(pw.uiKey, pw);
    },
    removePending: (k) => {
      calls.push("remove");
      if (handlers.removePending) return handlers.removePending(k);
      pending.delete(k);
    },
    scope: handlers.scope ?? (() => state.scope),
    epoch: handlers.epoch ?? (() => state.epoch),
  };
  return { io, calls, pending, state, ok, fail };
}

const reqArgs = {
  orderId: "ord-x",
  itemLabel: "모니터 외 1건",
  reason: "CHANGE_OF_MIND",
  quoteToken: "qt-1",
  uiKey: "k1",
  scopeAt: "u-a",
};

const mkPending = (over: Record<string, unknown> = {}): PendingWrite => ({
  uiKey: "k1",
  kind: "CANCEL_ORDER",
  path: "/api/orders/ord-x/cancel/approve",
  method: "POST",
  payload: {
    order_id: "ord-x",
    reason_code: "CHANGE_OF_MIND",
    quote_token: "qt-1",
    action_key: "ui-k1",
    confirmation_id: "op-1",
    ...over,
  },
  label: "주문 취소 요청 · 모니터",
  at: 0,
});

const kind = (o: CancelOutcome) => o.kind;
const noPost = (calls: string[]) => calls.filter((c) => c.startsWith("approve") || c.startsWith("execute"));

describe("runCancelRequest — 승인→실행 오케스트레이션", () => {
  test("정상: intent 선보존 → approve → confirmation 기록 → execute → DONE+해제", async () => {
    const { io, calls, pending } = mkIo();
    const out = await runCancelRequest(io, reqArgs);
    assert.equal(kind(out), "DONE");
    assert.deepEqual(calls, ["put:init", "approve:" + JSON.stringify({
      quote_token: "qt-1", reason_code: "CHANGE_OF_MIND", action_key: "ui-k1",
    }), "put:cfm", "execute:" + JSON.stringify({
      confirmation_id: "op-1", reason_code: "CHANGE_OF_MIND",
    }), "remove"]);
    assert.equal(pending.size, 0);
  });

  test("approve transport throw → LOST·intent 유지(재전송 없음)", async () => {
    const { io, pending } = mkIo({
      approve: async () => { throw new Error("net down"); },
    });
    assert.equal(kind(await runCancelRequest(io, reqArgs)), "LOST");
    assert.equal(pending.size, 1); // 유지 — '결과 확인' 복구 대상
  });

  test("approve NETWORK/INTERNAL/CONFLICT/UNAUTHENTICATED → LOST·intent 유지", async () => {
    for (const code of ["NETWORK", "INTERNAL", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN"]) {
      const { io, pending } = mkIo({ approve: async () => ({ ok: false, error: { code, message: code } }) });
      assert.equal(kind(await runCancelRequest(io, reqArgs)), "LOST", code);
      assert.equal(pending.size, 1, code); // 원 user intent 보존
    }
  });

  test("approve 확정 거절(EXPIRED) → REJECTED reconfirm + intent 해제", async () => {
    const { io, pending } = mkIo({
      approve: async () => ({ ok: false, error: { code: "CONFIRMATION_EXPIRED", message: "만료" } }),
    });
    const out = await runCancelRequest(io, reqArgs);
    assert.equal(kind(out), "REJECTED");
    if (out.kind === "REJECTED") assert.equal(out.reconfirm, true);
    assert.equal(pending.size, 0);
  });

  test("approve 성공 봉투지만 confirmation_id 빈값 → LOST·execute 호출 0", async () => {
    const { io, calls } = mkIo({
      approve: async () => ({ ok: true, data: { confirmation_id: "" } }),
    });
    assert.equal(kind(await runCancelRequest(io, reqArgs)), "LOST");
    assert.equal(calls.filter((c) => c.startsWith("execute")).length, 0);
  });

  test("execute throw → LOST·confirmation이 intent에 기록됨", async () => {
    const { io, pending } = mkIo({
      execute: async () => { throw new Error("lost"); },
    });
    assert.equal(kind(await runCancelRequest(io, reqArgs)), "LOST");
    assert.equal(pending.get("k1")?.payload.confirmation_id, "op-1");
  });

  test("execute 확정 거절 → REJECTED + intent 해제", async () => {
    const { io, pending } = mkIo({
      execute: async () => ({ ok: false, error: { code: "CANCEL_NOT_ELIGIBLE", message: "불가" } }),
    });
    const out = await runCancelRequest(io, reqArgs);
    assert.equal(kind(out), "REJECTED");
    assert.equal(pending.size, 0);
  });

  test("execute 성공 봉투 비정형(음수 금액·빈 id·주문 불일치) → LOST·완료 합성 금지", async () => {
    const bads = [
      { cancel_request_id: "", status: "REQUESTED", refund_amount_won: 1, order: null },
      { cancel_request_id: "cxl-1", status: "REQUESTED", refund_amount_won: -1, order: null },
      { cancel_request_id: "cxl-1", status: "COMPLETED", refund_amount_won: 1, order: null },
      { cancel_request_id: "cxl-1", status: "REQUESTED", refund_amount_won: 1, order: { id: "ord-y" } },
    ];
    for (const data of bads) {
      const { io, pending } = mkIo({
        execute: async () => ({ ok: true, data: data as CancelRequestResult }),
      });
      assert.equal(kind(await runCancelRequest(io, reqArgs)), "LOST", JSON.stringify(data));
      assert.equal(pending.size, 1);
    }
  });

  test("스코프 전환(approve 직후) → ABORTED·후속 POST 0·다른 intent 변경 0", async () => {
    const { io, calls, state } = mkIo({
      approve: async () => {
        state.scope = "u-b"; // 응답 도착 전 계정 전환
        return { ok: true, data: { confirmation_id: "op-1" } };
      },
    });
    const out = await runCancelRequest(io, reqArgs);
    assert.equal(kind(out), "ABORTED");
    assert.equal(noPost(calls).length, 1); // approve 1회뿐 — execute 0
    assert.deepEqual(calls.filter((c) => c === "put:cfm" || c === "remove"), []);
  });

  test("스코프 전환(execute 직후) → ABORTED·remove는 새 스코프에 적용되지 않음", async () => {
    const { io, calls, state, pending } = mkIo({
      execute: async () => {
        state.scope = "u-b";
        return {
          ok: true,
          data: { cancel_request_id: "cxl-1", status: "REQUESTED", refund_amount_won: 1, order: { id: "ord-x" } } as CancelRequestResult,
        };
      },
    });
    const out = await runCancelRequest(io, reqArgs);
    assert.equal(kind(out), "ABORTED");
    assert.equal(calls.filter((c) => c === "remove").length, 0);
    assert.equal(pending.size, 1); // 원 user intent 보존 — 복귀 시 복구
  });
});

describe("runCancelRecovery — 서버 기록으로만 상태 확정", () => {
  const act = (row: CancelActionRow): CancelFlowIO["lookupAction"] =>
    async () => ({ ok: true, data: row });

  test("조회 NOT_FOUND → RETRYABLE(같은 키·payload 명시 재전송만)", async () => {
    const { io } = mkIo();
    assert.equal(kind(await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" })), "RETRYABLE");
  });

  test("조회 throw/NETWORK → UNKNOWN_KEEP·intent 유지·POST 0", async () => {
    const a = mkIo({ lookupAction: async () => { throw new Error("net"); } });
    assert.equal(kind(await runCancelRecovery(a.io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    const b = mkIo({ lookupAction: async () => ({ ok: false, error: { code: "NETWORK", message: "x" } }) });
    assert.equal(kind(await runCancelRecovery(b.io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(noPost(a.calls).length + noPost(b.calls).length, 0);
  });

  test("READY + 저장 confirmation 일치 → 원본 승인·저장 사유로 execute → DONE", async () => {
    const { io, calls, pending } = mkIo({
      lookupAction: act({ status: "READY", operation_id: "op-1" }),
    });
    const out = await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "DONE");
    assert.equal(calls.filter((c) => c.startsWith("execute")).length, 1);
    assert.ok(calls.some((c) => c.includes('"confirmation_id":"op-1"') && c.includes('"reason_code":"CHANGE_OF_MIND"')));
    assert.equal(pending.size, 0);
  });

  test("READY + 저장 confirmation 충돌 → UNKNOWN_KEEP·POST 0 (다른 승인 오실행 방지)", async () => {
    const { io, calls } = mkIo({
      lookupAction: act({ status: "READY", operation_id: "op-OTHER" }),
    });
    assert.equal(kind(await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(noPost(calls).length, 0);
  });

  test("READY + 빈 operation_id → UNKNOWN_KEEP·POST 0 (서버 최신 READY fallback 차단)", async () => {
    const { io, calls } = mkIo({
      lookupAction: act({ status: "READY", operation_id: "" }),
    });
    assert.equal(kind(await runCancelRecovery(io, { pending: mkPending({ confirmation_id: null }), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(noPost(calls).length, 0);
  });

  test("READY + 저장 confirmation 없음 → 조회된 승인으로 execute 허용", async () => {
    const { io, calls } = mkIo({
      lookupAction: act({ status: "READY", operation_id: "op-1" }),
    });
    const out = await runCancelRecovery(io, { pending: mkPending({ confirmation_id: null }), scopeAt: "u-a" });
    assert.equal(kind(out), "DONE");
    assert.equal(calls.filter((c) => c.startsWith("execute")).length, 1);
  });

  test("SUCCEEDED + 저장 결과 검증 통과 → DONE(실값)·intent 해제·POST 0", async () => {
    const { io, calls, pending } = mkIo({
      lookupAction: act({
        status: "SUCCEEDED", operation_id: "op-1",
        result: { cancel_request_id: "cxl-1", status: "REQUESTED", refund_amount_won: 292000, order_id: "ord-x" },
      }),
    });
    const out = await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "DONE");
    if (out.kind === "DONE") assert.equal(out.refund_amount_won, 292000);
    assert.equal(pending.size, 0);
    assert.equal(noPost(calls).length, 0);
  });

  test("SUCCEEDED 비정형 → pending 먼저 삭제하지 않고 주문 실제 접수로 복원", async () => {
    const { io, pending } = mkIo({
      lookupAction: act({
        status: "SUCCEEDED", operation_id: "op-1",
        result: { cancel_request_id: "cxl-1", refund_amount_won: -1, order_id: "ord-x" }, // 비정형
      }),
      getOrder: async () => ({
        ok: true,
        data: { id: "ord-x", cancel_request: { id: "cxl-1", status: "REQUESTED", reason_code: "CHANGE_OF_MIND", refund_amount_won: 292000, requested_at: "t", completed_at: null } } as OrderView,
      }),
    });
    const out = await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "DONE"); // 주문 실값으로 복원
    if (out.kind === "DONE") assert.equal(out.refund_amount_won, 292000);
    assert.equal(pending.size, 0);
  });

  test("SUCCEEDED 비정형 + 주문 접수 id 불일치 → UNKNOWN_KEEP·intent 유지(합성 금지)", async () => {
    const { io, pending } = mkIo({
      lookupAction: act({
        status: "SUCCEEDED", operation_id: "op-1",
        result: { cancel_request_id: "cxl-OTHER", refund_amount_won: -1, order_id: "ord-x" },
      }),
      getOrder: async () => ({
        ok: true,
        data: { id: "ord-x", cancel_request: { id: "cxl-1", status: "REQUESTED", reason_code: "CHANGE_OF_MIND", refund_amount_won: 292000, requested_at: "t", completed_at: null } } as OrderView,
      }),
    });
    assert.equal(kind(await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(pending.size, 1);
  });

  test("SUCCEEDED 비정형 + 주문에 접수 없음/조회 실패 → UNKNOWN_KEEP·intent 유지", async () => {
    const a = mkIo({
      lookupAction: act({ status: "SUCCEEDED", operation_id: "op-1", result: { refund_amount_won: -1 } }),
      getOrder: async () => ({ ok: true, data: { id: "ord-x", cancel_request: null } as OrderView }),
    });
    assert.equal(kind(await runCancelRecovery(a.io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(a.pending.size, 1);
    const b = mkIo({
      lookupAction: act({ status: "SUCCEEDED", operation_id: "op-1", result: null }),
      getOrder: async () => { throw new Error("net"); },
    });
    assert.equal(kind(await runCancelRecovery(b.io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(b.pending.size, 1);
  });

  test("SUCCEEDED 저장 결과가 다른 주문 → 주문 확인 경로로만(이 주문 완료로 합성 금지)", async () => {
    const { io, pending } = mkIo({
      lookupAction: act({
        status: "SUCCEEDED", operation_id: "op-1",
        result: { cancel_request_id: "cxl-1", status: "REQUESTED", refund_amount_won: 1, order_id: "ord-y" },
      }),
      getOrder: async () => ({ ok: true, data: { id: "ord-x", cancel_request: null } as OrderView }),
    });
    assert.equal(kind(await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(pending.size, 1);
  });

  test("REJECTED + ToolError → 저장 거절 메시지 + intent 해제", async () => {
    const { io, pending } = mkIo({
      lookupAction: act({
        status: "REJECTED", operation_id: "op-1",
        result: { code: "CONFIRMATION_EXPIRED", message: "취소 확인이 만료되었습니다" },
      }),
    });
    const out = await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "REJECTED");
    if (out.kind === "REJECTED") assert.equal(out.message, "취소 확인이 만료되었습니다");
    assert.equal(pending.size, 0);
  });

  test("REJECTED + 실제 ToolError.code 보존 → 재견적·재확인 분기 연결", async () => {
    // EXPIRED/STALE 코드는 reconfirm=true — 낡은 견적이 남지 않는다 [PM060 추가].
    const a = mkIo({
      lookupAction: act({
        status: "REJECTED", operation_id: "op-1",
        result: { code: "CONFIRMATION_EXPIRED", message: "만료" },
      }),
    });
    const outA = await runCancelRecovery(a.io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(outA.kind, "REJECTED");
    if (outA.kind === "REJECTED") assert.equal(outA.reconfirm, true);
    // error_code 컬럼 폴백도 코드로 읽는다
    const b = mkIo({
      lookupAction: act({ status: "REJECTED", operation_id: "op-1", error_code: "CANCEL_NOT_ELIGIBLE" }),
    });
    const outB = await runCancelRecovery(b.io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(outB.kind, "REJECTED");
    if (outB.kind === "REJECTED") assert.equal(outB.reconfirm, true);
    // 재확인 대상 아닌 코드는 reconfirm=false
    const c = mkIo({
      lookupAction: act({ status: "REJECTED", operation_id: "op-1", error_code: "VALIDATION" }),
    });
    const outC = await runCancelRecovery(c.io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(outC.kind, "REJECTED");
    if (outC.kind === "REJECTED") assert.equal(outC.reconfirm, false);
  });

  test("DONE_UNKNOWN 주문 검증 — 대상 불일치·비정형 접수 행은 UNKNOWN_KEEP", async () => {
    const badOrder = (over: Record<string, unknown>): ApiResult<OrderView> =>
      ({ ok: true, data: { id: "ord-x", cancel_request: { id: "cxl-1", status: "REQUESTED", reason_code: "X", refund_amount_won: 1, requested_at: "t", completed_at: null }, ...over } as OrderView });
    const storedBad = { status: "SUCCEEDED", operation_id: "op-1", result: { refund_amount_won: -1 } };
    for (const [name, ord] of [
      ["다른 주문 데이터", badOrder({ id: "ord-y" })],
      ["접수 상태 비정형", badOrder({ cancel_request: { id: "cxl-1", status: "DRAFT", reason_code: "X", refund_amount_won: 1, requested_at: "t", completed_at: null } })],
      ["접수 id 빈값", badOrder({ cancel_request: { id: "", status: "REQUESTED", reason_code: "X", refund_amount_won: 1, requested_at: "t", completed_at: null } })],
      ["환불액 비정수", badOrder({ cancel_request: { id: "cxl-1", status: "REQUESTED", reason_code: "X", refund_amount_won: 1.5, requested_at: "t", completed_at: null } })],
      ["환불액 음수", badOrder({ cancel_request: { id: "cxl-1", status: "REQUESTED", reason_code: "X", refund_amount_won: -1, requested_at: "t", completed_at: null } })],
    ] as const) {
      const { io, pending } = mkIo({
        lookupAction: act(storedBad),
        getOrder: async () => ord as ApiResult<OrderView>,
      });
      assert.equal(kind(await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP", name);
      assert.equal(pending.size, 1, name);
    }
    // 정형 접수 행은 복원된다
    const { io, pending } = mkIo({
      lookupAction: act(storedBad),
      getOrder: async () => badOrder({}),
    });
    assert.equal(kind(await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" })), "DONE");
    assert.equal(pending.size, 0);
  });

  test("epoch 변경(주문 변경·unmount·A→B→A 복귀) → ABORTED·후속 POST 0·원 intent 보존", async () => {
    // 같은 scope여도 epoch가 다르면 진행 중 작업은 멈춘다 — scope만으로는
    // A→B→A 복귀를 구분할 수 없다 [PM060 추가].
    const { io, calls, state, pending } = mkIo({
      approve: async () => {
        state.epoch = 99; // approve await 중 컨텍스트 변경
        return { ok: true, data: { confirmation_id: "op-1" } };
      },
    });
    const out = await runCancelRequest(io, reqArgs);
    assert.equal(kind(out), "ABORTED");
    assert.equal(calls.filter((c) => c.startsWith("execute")).length, 0);
    assert.deepEqual(calls.filter((c) => c === "put:cfm" || c === "remove"), []);
    assert.equal(pending.size, 1);
    // READY 복구 경로도 epoch 변경으로 멈춘다
    const r = mkIo();
    r.io.lookupAction = async () => {
      r.state.epoch = 99; // 조회 await 중 컨텍스트 변경(주문 변경·unmount·복귀)
      return { ok: true, data: { status: "READY", operation_id: "op-1" } };
    };
    const outR = await runCancelRecovery(r.io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(outR), "ABORTED");
    assert.equal(noPost(r.calls).length, 0);
  });

  test("알 수 없는 상태 → UNKNOWN_KEEP·intent 유지·POST 0·새 키 자동 실행 없음", async () => {
    const { io, calls, pending } = mkIo({
      lookupAction: act({ status: "PROCESSING", operation_id: "op-1" }),
    });
    assert.equal(kind(await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" })), "UNKNOWN_KEEP");
    assert.equal(pending.size, 1);
    assert.equal(noPost(calls).length, 0);
  });

  test("스코프 전환(READY→execute 직전) → ABORTED·POST 0", async () => {
    const { io, calls, state } = mkIo({
      lookupAction: act({ status: "READY", operation_id: "op-1" }),
      scope: () => "u-b", // 시작 시점과 다른 스코프
    });
    const out = await runCancelRecovery(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "ABORTED");
    assert.equal(noPost(calls).length, 0);
  });
});

describe("runCancelRetry — 같은 키+같은 payload의 명시 재전송만", () => {
  test("저장 payload 원본으로 approve→execute → DONE (새 키 발급 없음)", async () => {
    const { io, calls, pending } = mkIo();
    const out = await runCancelRetry(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "DONE");
    const apCall = calls.find((c) => c.startsWith("approve:"));
    assert.ok(apCall && apCall.includes('"action_key":"ui-k1"') && apCall.includes('"quote_token":"qt-1"'));
    assert.equal(pending.size, 0);
  });

  test("재전송 approve CONFIRMATION_EXPIRED → REJECTED reconfirm + intent 해제", async () => {
    const { io, pending } = mkIo({
      approve: async () => ({ ok: false, error: { code: "CONFIRMATION_EXPIRED", message: "만료" } }),
    });
    const out = await runCancelRetry(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "REJECTED");
    if (out.kind === "REJECTED") assert.equal(out.reconfirm, true);
    assert.equal(pending.size, 0);
  });

  test("재전송 스코프 전환 → ABORTED·후속 POST 0", async () => {
    const { io, calls, state } = mkIo({
      approve: async () => {
        state.scope = "u-b";
        return { ok: true, data: { confirmation_id: "op-1" } };
      },
    });
    const out = await runCancelRetry(io, { pending: mkPending(), scopeAt: "u-a" });
    assert.equal(kind(out), "ABORTED");
    assert.equal(calls.filter((c) => c.startsWith("execute")).length, 0);
  });
});

describe("봉투 비정형·예외 — throw 없이 intent 유지 [PM060 C]", () => {
  const rowAct = (row: CancelActionRow): CancelFlowIO["lookupAction"] =>
    async () => ({ ok: true, data: row });

  test("approve data null/비객체/cid 비정형 → LOST·intent 유지·execute 0", async () => {
    for (const data of [null, undefined, "x", 7, {}, { confirmation_id: 5 }, { confirmation_id: "" }]) {
      const m = mkIo({
        approve: async () => ({ ok: true, data }) as unknown as ApiResult<{ confirmation_id: string }>,
      });
      assert.equal(kind(await runCancelRequest(m.io, reqArgs)), "LOST", JSON.stringify(data));
      assert.equal(m.pending.size, 1, JSON.stringify(data));
      assert.equal(m.calls.filter((c) => c.startsWith("execute")).length, 0, JSON.stringify(data));
    }
  });

  test("approve error 비정형(error null·code 없음/비문자열) → LOST (확정 거절 아님)", async () => {
    for (const error of [null, undefined, {}, { code: 7 }, { message: "x" }]) {
      const m = mkIo({
        approve: async () => ({ ok: false, error }) as unknown as ApiResult<never>,
      });
      assert.equal(kind(await runCancelRequest(m.io, reqArgs)), "LOST", JSON.stringify(error));
      assert.equal(m.pending.size, 1);
    }
  });

  test("execute data null → LOST·intent 유지(완료 합성 금지)", async () => {
    const m = mkIo({
      execute: async () => ({ ok: true, data: null }) as unknown as ApiResult<CancelRequestResult>,
    });
    assert.equal(kind(await runCancelRequest(m.io, reqArgs)), "LOST");
    assert.equal(m.pending.size, 1);
  });

  test("lookup data null/비객체 → UNKNOWN_KEEP·intent 유지", async () => {
    for (const data of [null, undefined, "x", 7]) {
      const m = mkIo({
        lookupAction: async () => ({ ok: true, data }) as unknown as ApiResult<CancelActionRow>,
      });
      assert.equal(
        kind(await runCancelRecovery(m.io, { pending: mkPending(), scopeAt: "u-a" })),
        "UNKNOWN_KEEP",
        String(data),
      );
      assert.equal(m.pending.size, 1, String(data));
    }
  });

  test("lookup error 비정형 → UNKNOWN_KEEP (NOT_FOUND가 아니면 재전송 안내 아님)", async () => {
    const m = mkIo({
      lookupAction: async () => ({ ok: false, error: null }) as unknown as ApiResult<CancelActionRow>,
    });
    assert.equal(
      kind(await runCancelRecovery(m.io, { pending: mkPending(), scopeAt: "u-a" })),
      "UNKNOWN_KEEP",
    );
    assert.equal(m.pending.size, 1);
  });

  test("SUCCEEDED + getOrder data null → UNKNOWN_KEEP (직접 필드 접근 throw 없음)", async () => {
    const m = mkIo({
      lookupAction: rowAct({ status: "SUCCEEDED", operation_id: "op-1", result: null }),
      getOrder: async () => ({ ok: true, data: null }) as unknown as ApiResult<OrderView>,
    });
    assert.equal(
      kind(await runCancelRecovery(m.io, { pending: mkPending(), scopeAt: "u-a" })),
      "UNKNOWN_KEEP",
    );
    assert.equal(m.pending.size, 1);
  });

  test("동기 throw 어댑터도 THREW 매핑 — runFlow reject·영구 busy 없음", async () => {
    const m = mkIo({
      approve: (() => { throw new Error("sync adapter"); }) as unknown as CancelFlowIO["approve"],
    });
    assert.equal(kind(await runCancelRequest(m.io, reqArgs)), "LOST");
    assert.equal(m.pending.size, 1);
    const r = mkIo({
      lookupAction: (() => { throw new Error("sync adapter"); }) as unknown as CancelFlowIO["lookupAction"],
    });
    assert.equal(
      kind(await runCancelRecovery(r.io, { pending: mkPending(), scopeAt: "u-a" })),
      "UNKNOWN_KEEP",
    );
  });
});

describe("isAmbiguousCancelError — commit 불확정·계정 분류", () => {
  test("AMBIGUOUS·CONFLICT·UNAUTHENTICATED/UNAUTHORIZED/FORBIDDEN만 유실 복구 대상", () => {
    for (const c of ["NETWORK", "INTERNAL", "OUTCOME_UNKNOWN", "BAD_RESPONSE", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN"])
      assert.equal(isAmbiguousCancelError(c), true, c);
    for (const c of ["CONFIRMATION_EXPIRED", "CANCEL_NOT_ELIGIBLE", "NOT_FOUND", "VALIDATION"])
      assert.equal(isAmbiguousCancelError(c), false, c);
  });
});

describe("reconfirmReset — 재견적 분기의 사유 초기화 계약 [PM060 MAJOR1]", () => {
  test("approve CONFIRMATION_EXPIRED 거절 → reconfirmReset=true (reason 미초기화 시 견적 영구 미도착)", async () => {
    // 서버 재확인 거절이 오면 시트는 reason을 지워야 한다 — 같은 라디오는 이미
    // checked라 onChange가 재발화하지 않아 pickReason으로 새 견적을 열 수 없고
    // 견적 영역이 '확인하는 중…'에 영구 머문다.
    const m = mkIo({
      approve: async () => ({ ok: false, error: { code: "CONFIRMATION_EXPIRED", message: "만료" } }),
    });
    const out = await runCancelRequest(m.io, reqArgs);
    assert.equal(kind(out), "REJECTED");
    assert.equal(reconfirmReset(out), true);
  });

  test("비재확인 거절·비거절 결과는 false — 사유를 불필요하게 지우지 않는다", async () => {
    const m = mkIo({
      approve: async () => ({ ok: false, error: { code: "VALIDATION", message: "bad" } }),
    });
    const out = await runCancelRequest(m.io, reqArgs);
    assert.equal(kind(out), "REJECTED");
    assert.equal(reconfirmReset(out), false);
    for (const o of [
      { kind: "LOST" }, { kind: "RETRYABLE" }, { kind: "UNKNOWN_KEEP" },
      { kind: "ABORTED" },
      { kind: "DONE", cancel_request_id: "c-1", refund_amount_won: 0 },
    ] as CancelOutcome[]) assert.equal(reconfirmReset(o), false);
  });
});
