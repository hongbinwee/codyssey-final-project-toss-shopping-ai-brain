// 06B 전용 readonly 서버 래퍼 — production src/server.ts는 그대로 두고,
// 실제 접속 DB가 commerce_test·OID 16516이며 read-only startup GUC가 적용됨을
// 실측한 뒤에만 listen을 시작한다 [PMQA-048-B0]. test-server.ts(3101)는 그대로
// 두고 이 파일은 별도 전용 포트(3102)에서만 쓴다.
//
// - DATABASE_URL이 없으면 즉시 실패 — .env fallback(src/config.ts)과 embedded
//   Postgres(src/devdb.ts ensureDevDb)도 이 경로에서는 금지다.
// - URL은 localhost:5432/commerce_test 고정. query param은
//   default_transaction_read_only=on 하나만 허용하고, 없으면 이 래퍼가 추가한다.
//   database= 등 다른 param은 거부한다(우회·무시 혼동 방지).
// - postgres.js는 알 수 없는 URL param을 startup message의 GUC로 전달하므로
//   최종 URL로 여는 풀의 모든 연결이 default_transaction_read_only=on 상태가
//   된다 — 어떤 write 트랜잭션도 DB 레벨에서 거부된다(브라우저 allowlist와
//   독립적인 2중 차단).
// - probe에서 current_database()+oid+SHOW default_transaction_read_only를
//   실측한 뒤에만 import 후 start()를 호출한다(검증 전 어떤 listen도 없다).
import postgres from "postgres";
import { parseRoDbUrl, RO_DB, RO_DB_OID } from "./readonly-db.ts";

const roUrl = parseRoDbUrl(process.env.DATABASE_URL);
process.env.DATABASE_URL = roUrl;   // server.ts connectDb가 이 URL을 그대로 쓴다

const probe = postgres(roUrl, { max: 1 });
try {
  const [id] = await probe.unsafe<{ d: string; oid: number }[]>(
    "SELECT current_database() AS d, (SELECT oid::int FROM pg_database WHERE datname = current_database()) AS oid",
  );
  if (id.d !== RO_DB || id.oid !== RO_DB_OID)
    throw new Error(
      "readonly-server: 대상 DB 불일치 " + id.d + "#" + id.oid +
      " != " + RO_DB + "#" + RO_DB_OID + " — listen 거부",
    );
  const [g] = await probe.unsafe<{ default_transaction_read_only: string }[]>(
    "SHOW default_transaction_read_only",
  );
  if (g.default_transaction_read_only !== "on")
    throw new Error(
      "readonly-server: read-only GUC 미적용 (" + g.default_transaction_read_only + ") — listen 거부",
    );
} finally {
  await probe.end().catch(() => {});
}

// 검증 통과 후에만 실제 서버를 기동한다 — ensureDevDb()는 DATABASE_URL이
// 있으면 그대로 쓰므로 embedded PG는 뜨지 않는다.
const { start } = await import("../../src/server.ts");
await start();
