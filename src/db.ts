import postgres from "postgres";
import { readFileSync } from "node:fs";
import tls from "node:tls";

// connectDb() 호출 전에는 미초기화 상태. server/scripts가 ensureDevDb() 후에 연다.
export let sql: postgres.Sql;

export function connectDb(url: string): postgres.Sql {
  const caFile = process.env.DATABASE_SSL_CA_FILE;
  const readOnly = process.env.AI_LIVE_DEMO === "1"
    ? { connection: { default_transaction_read_only: true } } : {};
  sql = caFile
    ? postgres(url, {
        ...readOnly,
        ssl: {
          ca: readFileSync(caFile),
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname: string, cert: Parameters<typeof tls.checkServerIdentity>[1]) =>
            tls.checkServerIdentity(new URL(url).hostname, cert),
        },
      })
    : postgres(url, readOnly);
  return sql;
}

// 모든 업무 변경은 이 트랜잭션 헬퍼 하나로 묶는다.
export const tx = <T>(fn: (q: postgres.Sql) => Promise<T>): Promise<T> =>
  sql.begin(fn as never) as Promise<T>;

// 트랜잭션 q와 전역 sql 모두에 맞는 최소 쿼리 인터페이스
export type Q = Pick<postgres.ISql, "unsafe">;
