// 통합 테스트 전용 DB (commerce_test). seed로 매번 같은 상태에서 시작한다.
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { connectDb, sql } from "../../src/db.ts";

export const TEST_DB_URL =
  "postgres://commerce:commerce@localhost:5432/commerce_test";

export async function setupTestDb(phase = 1) {
  const admin = postgres(TEST_DB_URL.replace(/commerce_test$/, "postgres"));
  await admin.unsafe("CREATE DATABASE commerce_test").catch(() => {});
  await admin.end();
  for (const s of [
    ["scripts/migrate.ts", "--phase=" + phase],
    ["scripts/seed.ts", "--phase=" + phase],
  ]) {
    const r = spawnSync("node", s, {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: "pipe",
    });
    if (r.status !== 0)
      throw new Error("setup failed: " + s.join(" ") + "\n" + r.stderr);
  }
}

export async function ensureTestDb(phase = 1) {
  await setupTestDb(phase);
  connectDb(TEST_DB_URL);
}

// 테스트가 만든 사용자 데이터만 비운다. seed 카탈로그는 그대로 둔다.
export async function cleanUserData() {
  await sql.unsafe(
    "DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id IN ('u-a','u-b'))",
  );
  await sql.unsafe(
    "DELETE FROM action_requests WHERE actor_user_id IN ('u-a','u-b')",
  );
  await sql.unsafe("UPDATE carts SET version=1 WHERE user_id IN ('u-a','u-b')");
}

