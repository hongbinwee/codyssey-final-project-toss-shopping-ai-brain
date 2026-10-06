// 통합 테스트 전용 DB (commerce_test). seed로 매번 같은 상태에서 시작한다.
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { connectDb, sql } from "../../src/db.ts";
import { readFileSync } from "node:fs";

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

// 테스트가 만든 사용자 데이터만 비운다. seed 카탈로그와 seed 주문(ord-*)은 그대로 둔다.
export async function cleanUserData() {
  const uids = ["u-a", "u-b", "u-c"];
  await sql.unsafe(
    "DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = ANY($1))",
    [uids],
  );
  await sql.unsafe(
    "DELETE FROM action_requests WHERE actor_user_id = ANY($1)",
    [uids],
  );
  await sql.unsafe("UPDATE carts SET version=1 WHERE user_id = ANY($1)", [uids]);
  // orders 테이블은 Phase 3부터 존재한다. checkout이 만든 주문만 지우고 시나리오 seed는 보존.
  const [reg] = await sql.unsafe<{ r: string | null }[]>(
    "SELECT to_regclass('public.orders') AS r",
  );
  if (reg.r) {
    let seedIds: string[] = [];
    try {
      seedIds = (JSON.parse(readFileSync("db/seeds/scenarios.json", "utf8")).orders as { id: string }[]).map((o) => o.id);
    } catch {
      seedIds = [];
    }
    const rows = await sql.unsafe<{ id: string }[]>(
      "SELECT id FROM orders WHERE user_id = ANY($1) AND NOT (id = ANY($2))",
      [uids, seedIds],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await sql.unsafe("DELETE FROM order_items WHERE order_id = ANY($1)", [ids]);
      await sql.unsafe("DELETE FROM payments WHERE order_id = ANY($1)", [ids]);
      await sql.unsafe("DELETE FROM shipments WHERE order_id = ANY($1)", [ids]);
      await sql.unsafe("DELETE FROM orders WHERE id = ANY($1)", [ids]);
    }
  }
}
