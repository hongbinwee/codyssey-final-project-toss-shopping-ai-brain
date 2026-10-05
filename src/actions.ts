// 실행 요청(action_requests) 공통 처리: 모든 변경 명령의 중복 방지·결과 복원.
// 비즈니스 판정은 각 commerce 서비스가 하고, 여기서는 키/결과 저장만 담당한다.
import { sql, type Q } from "./db.ts";
import type postgres from "postgres";
import {
  ok, fail, err,
  type ToolError, type ToolResult,
} from "./contracts.ts";
import type { RequestContext } from "./session.ts";
import { createHash, randomUUID } from "node:crypto";

// 키 순서에 상관없이 같은 payload면 같은 해시가 나오도록 정규화
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") +
    "}"
  );
}

export const payloadHash = (payload: unknown): string =>
  createHash("sha256").update(canonicalJson(payload)).digest("hex");

export type ActionResult<T> = ToolResult<T> & {
  operation_id?: string;
  action_status?: "SUCCEEDED" | "REJECTED";
  replayed?: boolean;
};

type Row = {
  id: string;
  kind: string;
  payload_hash: string;
  status: "READY" | "SUCCEEDED" | "REJECTED";
  result_json: unknown;
  error_code: string | null;
};

const replay = <T>(row: Row, hash: string, trace_id: string): ActionResult<T> => {
  const base = { operation_id: row.id, replayed: true as const };
  if (row.payload_hash !== hash)
    return {
      ok: false as const,
      error: err("IDEMPOTENCY_CONFLICT", "같은 키에 다른 요청 내용입니다"),
      trace_id,
      operation_id: row.id,
    };
  if (row.status === "SUCCEEDED")
    return {
      ok: true as const,
      data: row.result_json as T,
      observed_at: new Date().toISOString(),
      trace_id,
      action_status: "SUCCEEDED" as const,
      ...base,
    };
  if (row.status === "REJECTED")
    return {
      ok: false as const,
      error:
        (row.result_json as ToolError) ??
        err(row.error_code ?? "REJECTED", "이전에 거절된 요청입니다"),
      trace_id,
      action_status: "REJECTED" as const,
      ...base,
    };
  // READY: 첫 요청의 커밋 여부가 불명확. 새 실행으로 대체하지 않는다.
  return {
    ok: false as const,
      error: err(
        "OUTCOME_UNKNOWN",
        "이전 요청의 처리 결과를 확인 중입니다. 같은 요청을 조회하세요.",
        "CHECK_OPERATION",
      ),
      trace_id,
      operation_id: row.id,
    };
};

// kind에 따라 잠글 대상이 다르다. 카트는 cart 행, 취소/결제는 order 행(Phase 3+).
// fn(q)은 q 트랜잭션 안에서 비즈니스 검증·변경을 수행하고 ToolResult를 반환한다.
export async function runAction<T>(
  ctx: RequestContext,
  kind: string,
  idempotencyKey: string,
  payload: unknown,
  fn: (q: Q) => Promise<ToolResult<T>>,
): Promise<ActionResult<T>> {
  const trace_id = crypto.randomUUID();
  const hash = payloadHash(payload);
  try {
    return await sql.begin(async (q) => {
      const rows = await q.unsafe<Row[]>(
        "SELECT * FROM action_requests WHERE actor_user_id=$1 AND kind=$2 AND idempotency_key=$3 FOR UPDATE",
        [ctx.actorUserId, kind, idempotencyKey],
      );
      const existing = rows[0];
      if (existing) return replay<T>(existing, hash, trace_id);
      const id = randomUUID();
      await q.unsafe(
        "INSERT INTO action_requests (id, actor_user_id, kind, idempotency_key, payload_json, payload_hash, status) VALUES ($1,$2,$3,$4,$5::jsonb,$6,'READY')",
        [id, ctx.actorUserId, kind, idempotencyKey, payload as postgres.JSONValue, hash],
      );
      const res = await fn(q);
      if (res.ok) {
        await q.unsafe(
          "UPDATE action_requests SET status='SUCCEEDED', result_json=$2::jsonb, completed_at=now() WHERE id=$1",
          [id, res.data as postgres.JSONValue],
        );
        return { ...res, operation_id: id, action_status: "SUCCEEDED" as const };
      }
      await q.unsafe(
        "UPDATE action_requests SET status='REJECTED', error_code=$2, result_json=$3::jsonb, completed_at=now() WHERE id=$1",
        [id, res.error.code, res.error],
      );
      return { ...res, operation_id: id, action_status: "REJECTED" as const };
    });
  } catch (e) {
    // 동시에 같은 키가 들어오면 unique 위반으로 직렬화된다. 커밋된 첫 결과를 읽는다.
    if ((e as { code?: string }).code === "23505") {
      const rows = await sql.unsafe<Row[]>(
        "SELECT * FROM action_requests WHERE actor_user_id=$1 AND kind=$2 AND idempotency_key=$3",
        [ctx.actorUserId, kind, idempotencyKey],
      );
      if (rows[0]) return replay<T>(rows[0], hash, trace_id);
      return {
        ok: false as const,
        error: err("OUTCOME_UNKNOWN", "결과 확인 불가. 잠시 후 같은 키로 조회하세요.", "CHECK_OPERATION"),
        trace_id,
      };
    }
    throw e;
  }
}

// 사용자/Adapter 전용 내부 결과 조회 (Agent Tool 아님)
export async function getActionResult(
  ctx: RequestContext,
  lookup: { operation_id?: string; kind?: string; idempotency_key?: string },
): Promise<ToolResult<{
  operation_id: string;
  kind: string;
  status: string;
  result: unknown;
  error_code: string | null;
}>> {
  const trace_id = crypto.randomUUID();
  let rows: Row[] = [];
  if (lookup.operation_id) {
    rows = await sql.unsafe<Row[]>("SELECT * FROM action_requests WHERE id=$1 AND actor_user_id=$2", [lookup.operation_id, ctx.actorUserId]);
  } else if (lookup.kind && lookup.idempotency_key) {
    rows = await sql.unsafe<Row[]>("SELECT * FROM action_requests WHERE actor_user_id=$1 AND kind=$2 AND idempotency_key=$3", [ctx.actorUserId, lookup.kind, lookup.idempotency_key]);
  } else {
    return fail(err("VALIDATION", "operation_id 또는 kind+idempotency_key 필요"), trace_id);
  }
  const r = rows[0];
  if (!r) return fail(err("NOT_FOUND", "해당 실행 요청이 없습니다"), trace_id);
  return ok(
    {
      operation_id: r.id,
      kind: r.kind,
      status: r.status,
      result: r.result_json,
      error_code: r.error_code,
    },
    trace_id,
  );
}
