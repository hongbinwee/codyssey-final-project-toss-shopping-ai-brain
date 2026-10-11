// e2e 전용 서버 래퍼 — production src/server.ts는 그대로 두고, 실제 접속 DB가
// commerce_test임을 확인한 뒤에만 listen을 시작하게 한다(PMQA-040-B0).
//
// - DATABASE_URL이 없으면 즉시 실패한다 — .env fallback(src/config.ts)도
//   embedded Postgres(src/devdb.ts ensureDevDb)도 테스트 경로에서는 금지다.
// - ?database= 등 query가 있으면 즉시 실패한다.
// - 같은 URL로 연 probe에서 current_database()==='commerce_test'를 실측한
//   뒤에만 export된 start()를 명시 호출한다 — src/server.ts는
//   argv[1]===import.meta.url 일 때만 자동 기동하므로, 이 래퍼에서 import만
//   하면 서버가 뜨지 않는다(검증 전에는 어떤 listen도 없다).
// - Playwright webServer가 이 파일을 띄우며, 검증이 실패하면 프로세스가
//   종료돼 서버가 뜨지 않는다(fail closed).
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url)
  throw new Error(
    "test-server: DATABASE_URL 없음 — embedded DB/.env fallback 경로 금지",
  );
if (url.includes("?"))
  throw new Error("test-server: DATABASE_URL query 금지 — ?database= 우회 방지");

const probe = postgres(url, { max: 1 });
try {
  const [r] = await probe.unsafe<{ d: string }[]>(
    "SELECT current_database() AS d",
  );
  if (r.d !== "commerce_test")
    throw new Error(
      "test-server: 대상 DB 불일치 " + r.d + " != commerce_test — listen 거부",
    );
} finally {
  await probe.end().catch(() => {});
}

// 검증 통과 후에만 실제 서버를 기동한다 — server.ts의 ensureDevDb()는
// DATABASE_URL이 있으면 그대로 쓰므로 embedded PG는 뜨지 않는다.
const { start } = await import("../../src/server.ts");
await start();
