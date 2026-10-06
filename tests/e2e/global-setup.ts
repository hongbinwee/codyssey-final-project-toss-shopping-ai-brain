import { connectDb, sql } from "../../src/db.ts";
import { cleanUserData, setupTestDb, TEST_DB_URL } from "../helpers/testdb.ts";

// e2e는 commerce_test를 서버와 공유한다. 이전 실행의 장바구니/action이 남아 있으면
// 합산 수량 때문에 금액 assertion이 깨지므로 매번 사용자 데이터를 비운다.
export default async function () {
  await setupTestDb(4);
  connectDb(TEST_DB_URL);
  await cleanUserData();
  await sql.end();
}
