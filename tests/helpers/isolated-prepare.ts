// 격리 테스트 DB의 실제 준비(migration + base seed) 오케스트레이션
// [PMQA-051-A]. launcher가 만든 scratch DB 하나를 받아 commerce schema와
// base fixture를 같은 원자 단위로 채운다.
//
// 안전 계약:
// - env는 '증거'가 아니다 — planIsolatedConnect의 계약 형식·strict·opt-in
//   게이트를 통과한 뒤에도, 같은 연결의 같은 트랜잭션 안에서
//   verifyOwnedExec로 name/OID/owner/marker를 실측해 모두 일치해야만
//   첫 DDL/seed를 실행한다. env만으로 CREATE 증거나 승인을 주장하지 않는다.
// - 모든 write(소유권 이후의 DDL·migration·seed)는 client.begin 하나의
//   트랜잭션 안에서 실행된다 — 중간 실패 시 전부 롤백되고 절반만 남지
//   않는다. 실패 후 cleanup·DROP·fallback 경로는 없다 — 지우지 못해 남는
//   것이 잘못 지우는 것보다 안전하다(scratch-db.ts와 같은 원칙).
// - 이 모듈은 top-level에서 connect·config·.env를 읽지 않는다. connect는
//   deps 주입이고 기본값은 postgres() 래퍼다 — 단위 테스트는 mock
//   connect만으로 전체 경계를 검증할 수 있다.
// - 준비 대상 schema는 항상 canonical 3개 migration + phase≤4 base
//   fixture다 — 부분 schema는 테스트 간 암묵적 의존을 만든다.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  planIsolatedConnect,
  verifyOwnedExec,
} from "./isolated-db.ts";
import { seedBase, type SeedExec } from "../../scripts/base-seed.ts";

// 격리 DB 준비에 적용하는 고정 canonical migration — db/migrations에서
// 파일 본문을 읽어 sha256을 계산한다. _migrations 기존 행의 sha와 다르면
// 중간 변경으로 간주해 실패 폐쇄한다(migrate.ts와 같은 정책).
export const ISOLATED_MIGRATIONS = [
  "001_catalog_cart_actions.sql",
  "002_orders_payments_shipments.sql",
  "003_cancel_requests.sql",
] as const;

// 최소 클라이언트 형태 — postgres.Sql이 구조적으로 만족하며, 테스트는
// BEGIN/query/COMMIT/ROLLBACK을 기록하는 mock을 주입한다.
export type SqlClient = {
  unsafe: SeedExec["unsafe"];
  begin: <T>(fn: (q: SeedExec) => Promise<T>) => Promise<T>;
  end?: () => Promise<unknown>;
};

export type PrepareDeps = {
  connect?: (url: string, opts?: { max?: number }) => SqlClient;
};

export type PrepareResult = {
  ok: true;
  dbName: string;
  migrations: { name: string; sha256: string }[];
  seededFiles: string[];
};

/**
 * source env로 격리 준비를 계획·실행한다.
 * 거부(계약/strict/opt-in/URL 불일치/소유권 실측/migration sha 불일치·
 * 파일 부재)는 전부 throw다 — 어떤 경우에도 부분 적용을 반환하지 않는다.
 */
export async function prepareIsolatedDb(
  sourceEnv: Record<string, string | undefined>,
  deps: PrepareDeps = {},
): Promise<PrepareResult> {
  // 1) 연결 결정 — 형식·strict·opt-in이 어긋나면 connect 호출 0건으로 거부.
  const plan = planIsolatedConnect(sourceEnv);
  if (!plan.ok) throw new Error("isolated 준비 거부: " + plan.reason);
  const contract = plan.contract;
  // 조용한 덮어쓰기 금지 — source의 DATABASE_URL이 계약과 다르면 거부한다
  // (buildIsolatedChildEnv와 같은 규칙).
  if (
    sourceEnv.DATABASE_URL !== undefined &&
    sourceEnv.DATABASE_URL !== contract.dbUrl
  )
    throw new Error(
      "isolated 준비 거부: source DATABASE_URL이 계약과 다름 — 덮어쓰기 금지",
    );

  const connect =
    deps.connect ??
    ((url, opts) => postgres(url, opts) as unknown as SqlClient);
  const client = connect(contract.dbUrl, { max: 1 });

  const migrations: { name: string; sha256: string }[] = [];
  try {
    const seededFiles = await client.begin(async (q) => {
      // 2) 소유권 실측 — 같은 트랜잭션·같은 연결의 read-only SELECT.
      //    이것이 첫 query다: guard 통과 전에는 DDL도 실행하지 않는다.
      const owned = await verifyOwnedExec(q, contract);
      if (!owned.ok)
        throw new Error("isolated 소유권 실측 거부: " + owned.reason);

      // 3) 동시 준비 경합 방지 — 트랜잭션 범위 advisory lock(커밋/롤백 시
      //    자동 해제 — 세션 lock처럼 연결 밖으로 새지 않는다).
      await q.unsafe("SELECT pg_advisory_xact_lock(727272)");

      // 4) canonical migration — 디스크 본문 sha256이 정본이다.
      await q.unsafe(
        "CREATE TABLE IF NOT EXISTS _migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())",
      );
      for (const f of ISOLATED_MIGRATIONS) {
        let body: string;
        try {
          body = readFileSync("db/migrations/" + f, "utf8");
        } catch {
          throw new Error("migration 파일 부재: " + f);
        }
        const sha = createHash("sha256").update(body).digest("hex");
        const rows = await q.unsafe<{ sha256: string }[]>(
          "SELECT sha256 FROM _migrations WHERE name = $1",
          [f],
        );
        const row = rows[0];
        if (row) {
          if (row.sha256 !== sha)
            throw new Error("migration changed after apply: " + f);
        } else {
          await q.unsafe(body);
          await q.unsafe(
            "INSERT INTO _migrations (name, sha256) VALUES ($1, $2)",
            [f, sha],
          );
        }
        migrations.push({ name: f, sha256: sha });
      }

      // 5) base fixture — seed.ts base 경로와 같은 seedBase를 같은
      //    트랜잭션 안에서 실행한다(executor 주입이 유일한 차이).
      const s = await seedBase(q, 4);
      return s.seeded;
    });
    return {
      ok: true,
      dbName: contract.dbName,
      migrations,
      seededFiles,
    };
  } finally {
    // 성공/실패와 무관하게 연결만 닫는다 — 롤백은 트랜잭션에 맡기고
    // 별도 cleanup·DROP은 하지 않는다.
    await client.end?.();
  }
}
