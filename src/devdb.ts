// DATABASE_URL이 없으면 프로젝트 로컬 .pgdata에 실제 PostgreSQL을 띄운다.
// 행 잠금·트랜잭션이 실제 동작하며 Docker가 필요 없다. 운영에서는 DATABASE_URL을 지정.
import "./config.ts";

export async function ensureDevDb(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const pg = new EmbeddedPostgres({
    databaseDir: ".pgdata",
    user: "postgres",
    password: "postgres",
    port: 5433,
    persistent: true,
  });
  await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("commerce");
  } catch {
    // 이미 존재하면 그대로 사용
  }
  process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5433/commerce";
  return process.env.DATABASE_URL;
}
