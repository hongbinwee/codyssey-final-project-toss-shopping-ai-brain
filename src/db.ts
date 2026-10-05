import postgres from "postgres";

// connectDb() 호출 전에는 미초기화 상태. server/scripts가 ensureDevDb() 후에 연다.
export let sql: postgres.Sql;

export function connectDb(url: string): postgres.Sql {
  sql = postgres(url);
  return sql;
}

// 모든 업무 변경은 이 트랜잭션 헬퍼 하나로 묶는다.
export const tx = <T>(fn: (q: postgres.Sql) => Promise<T>): Promise<T> =>
  sql.begin(fn as never) as Promise<T>;
