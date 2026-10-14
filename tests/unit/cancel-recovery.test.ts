// src/cancel-recovery.ts의 DB-free 검증 — 서버 action 조회 결과(status)가
// 올바른 복구 결정으로 변환되는지 단정한다 [PMQA-060 · MJ060-4/5 검증 계약].
// 핵심: READY→nonblank op_id로 실행 이어가기 · SUCCEEDED→REQUESTED+주문 일치+
// 정수 금액+nonblank id까지 검증된 실값만 · REJECTED→저장 거절 메시지 ·
// 미확인 상태·빈 op_id→intent 유지(새 키 자동 실행·fallback 오실행 금지).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCancelAction, isStoredCancelResult, isCancelRequestResult,
} from "../../src/cancel-recovery.ts";

const stored = {
  cancel_request_id: "cxl-abc12345",
  status: "REQUESTED",
  refund_amount_won: 292000,
  order_id: "ord-x",
};

describe("resolveCancelAction — 서버 action 상태 → 복구 결정", () => {
  test("READY + nonblank op_id → EXECUTE: 원본 승인으로 실행을 이어간다", () => {
    const d = resolveCancelAction({ status: "READY", operation_id: "op-1" }, "ord-x");
    assert.deepEqual(d, { kind: "EXECUTE", operation_id: "op-1" });
  });

  test("READY + 빈 operation_id → UNKNOWN: 서버 '최신 READY' fallback 오실행 방지", () => {
    for (const bad of ["", 0, null, undefined] as const) {
      const d = resolveCancelAction(
        { status: "READY", operation_id: bad as unknown as string },
        "ord-x",
      );
      assert.equal(d.kind, "UNKNOWN", JSON.stringify(bad));
    }
  });

  test("SUCCEEDED + 검증 통과 → DONE: 실제 id·금액·주문만 쓴다", () => {
    const d = resolveCancelAction(
      { status: "SUCCEEDED", operation_id: "op-1", result: stored },
      "ord-x",
    );
    assert.deepEqual(d, { kind: "DONE", result: stored });
  });

  test("SUCCEEDED + 결과 누락/비정형/주문 불일치 → DONE_UNKNOWN: 합성 금지", () => {
    const bads = [
      undefined, null, {},
      { ...stored, status: "COMPLETED" },          // REQUESTED 아님
      { ...stored, cancel_request_id: "" },        // 빈 id
      { ...stored, refund_amount_won: -1 },        // 음수
      { ...stored, refund_amount_won: 1.5 },       // 비정수
      { ...stored, order_id: "ord-y" },            // 다른 주문
      { ...stored, order_id: 3 },                  // 비문자
    ];
    for (const bad of bads) {
      const d = resolveCancelAction(
        { status: "SUCCEEDED", operation_id: "op-1", result: bad },
        "ord-x",
      );
      assert.equal(d.kind, "DONE_UNKNOWN", JSON.stringify(bad));
    }
  });

  test("REJECTED + ToolError 결과 → 저장된 거절 메시지", () => {
    const d = resolveCancelAction({
      status: "REJECTED",
      operation_id: "op-1",
      result: { code: "CANCEL_NOT_ELIGIBLE", message: "이미 출고된 주문은 취소할 수 없습니다" },
    }, "ord-x");
    assert.deepEqual(d, { kind: "REJECTED", message: "이미 출고된 주문은 취소할 수 없습니다", code: "CANCEL_NOT_ELIGIBLE" });
  });

  test("REJECTED + 결과 없음 → error_code 또는 기본 문구", () => {
    const a = resolveCancelAction({ status: "REJECTED", operation_id: "op-1", error_code: "CONFIRMATION_EXPIRED" }, "ord-x");
    assert.equal(a.kind, "REJECTED");
    if (a.kind === "REJECTED") {
      assert.equal(a.message, "CONFIRMATION_EXPIRED");
      assert.equal(a.code, "CONFIRMATION_EXPIRED"); // error_code fallback 보존
    }
    const b = resolveCancelAction({ status: "REJECTED", operation_id: "op-1" }, "ord-x");
    assert.equal(b.kind, "REJECTED");
    if (b.kind === "REJECTED") assert.equal(b.code, "REJECTED"); // 코드 부재는 기본값
  });

  test("알 수 없는 상태 → UNKNOWN: intent 유지·자동 실행 없음", () => {
    for (const s of ["PROCESSING", "PENDING", "RUNNING", "", "ready"]) {
      const d = resolveCancelAction({ status: s, operation_id: "op-1" }, "ord-x");
      assert.equal(d.kind, "UNKNOWN", s);
    }
  });

  test("비정형 row(null/undefined/비객체) → UNKNOWN — throw 없음 [PM060 C]", () => {
    for (const bad of [null, undefined, "x", 7, true]) {
      assert.equal(
        resolveCancelAction(bad as never, "ord-x").kind,
        "UNKNOWN",
        String(bad),
      );
    }
  });
});

describe("isStoredCancelResult — 저장 결과 계약 검증 [MJ060-4]", () => {
  test("REQUESTED + 주문 일치 + nonblank id + 0 이상 정수 금액만 통과", () => {
    assert.equal(isStoredCancelResult(stored, "ord-x"), true);
    assert.equal(isStoredCancelResult({ ...stored, status: "COMPLETED" }, "ord-x"), false);
    assert.equal(isStoredCancelResult({ ...stored, order_id: "ord-y" }, "ord-x"), false);
    assert.equal(isStoredCancelResult({ ...stored, refund_amount_won: -1 }, "ord-x"), false);
    assert.equal(isStoredCancelResult({ ...stored, refund_amount_won: 1.1 }, "ord-x"), false);
    assert.equal(isStoredCancelResult({ ...stored, cancel_request_id: "" }, "ord-x"), false);
  });
});

describe("isCancelRequestResult — execute 성공 봉투 검증 [MJ060-4]", () => {
  const okRes = {
    cancel_request_id: "cxl-1",
    status: "REQUESTED",
    refund_amount_won: 292000,
    order: { id: "ord-x" },
  };
  test("정형 + order 일치 → 통과, order null 허용, order 불일치 → 거부", () => {
    assert.equal(isCancelRequestResult(okRes, "ord-x"), true);
    assert.equal(isCancelRequestResult({ ...okRes, order: null }, "ord-x"), true);
    assert.equal(isCancelRequestResult({ ...okRes, order: { id: "ord-y" } }, "ord-x"), false);
  });
  test("빈 id·음수/비정수 금액·REQUESTED 아님 → 거부 (완료 합성 금지)", () => {
    assert.equal(isCancelRequestResult({ ...okRes, cancel_request_id: "" }, "ord-x"), false);
    assert.equal(isCancelRequestResult({ ...okRes, refund_amount_won: -1 }, "ord-x"), false);
    assert.equal(isCancelRequestResult({ ...okRes, refund_amount_won: 0.5 }, "ord-x"), false);
    assert.equal(isCancelRequestResult({ ...okRes, status: "COMPLETED" }, "ord-x"), false);
  });
});
