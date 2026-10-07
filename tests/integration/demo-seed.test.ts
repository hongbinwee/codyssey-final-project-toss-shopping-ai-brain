// --demo 시드 안전성 검증. scratch DB(commerce_demo_verify)를 만들어
// commerce_test/dev를 건드리지 않고 demo reconcile의 소유 경계를 증명한다.
// - demo reconcile은 p-d-*/v-d-*/r-d-*만 소유한다
// - 비-demo 상태(fixture stock/version, 주문, 결제/환불)는 demo 시드가 변경하지 않는다
// - 데모 상품의 비-demo 리뷰(r-custom)는 보존, stale r-d-*는 정리
// - 외부 참조가 붙은 stale v-d-*/p-d-*는 삭제 대신 active=false 보존
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { connectDb, sql } from "../../src/db.ts";

const DB = "commerce_demo_verify";
const DB_URL = "postgres://commerce:commerce@localhost:5432/" + DB;
const ADMIN_URL = "postgres://commerce:commerce@localhost:5432/postgres";

const seed = (extra: string[] = [], url = DB_URL) =>
  spawnSync("node", ["scripts/seed.ts", ...extra], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

test("--demo는 테스트 DB(commerce_test)에서 실행을 거부한다", () => {
  const r = seed(["--demo"], "postgres://commerce:commerce@localhost:5432/commerce_test");
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr) + String(r.stdout), /commerce_test/);
});

test("--demo와 --phase 동시 사용을 거부한다", () => {
  const r = seed(["--demo", "--phase=1"]);
  assert.notEqual(r.status, 0);
});

test("demo seed는 비-demo 상태를 보존하고 demo 행만 reconcile한다", { timeout: 120000 }, async () => {
  const admin = postgres(ADMIN_URL);
  await admin.unsafe("DROP DATABASE IF EXISTS " + DB + " WITH (FORCE)");
  await admin.unsafe("CREATE DATABASE " + DB);
  await admin.end();

  for (const step of [
    ["scripts/migrate.ts", "--phase=4"],
    ["scripts/seed.ts", "--phase=4"],
    ["scripts/seed.ts", "--demo"],
  ]) {
    const r = spawnSync("node", step, {
      env: { ...process.env, DATABASE_URL: DB_URL },
      stdio: "pipe",
    });
    assert.equal(r.status, 0, step.join(" ") + "\n" + r.stderr);
  }
  connectDb(DB_URL);

  // --- demo 시드 전에 비-demo 상태를 의도적으로 변경한다 ---
  // fixture variant 재고/버전
  await sql.unsafe("UPDATE product_variants SET stock_qty=41, version=7 WHERE id='v-a-24'");
  // 시나리오 주문 상태 + 취소 시각
  await sql.unsafe("UPDATE orders SET version=9, cancelled_at=now() WHERE id='ord-a-pre'");
  // 결제/환불 상태 (payments CHECK상 전액 환불만 허용)
  await sql.unsafe("UPDATE payments SET refund_status='REFUNDED', refunded_amount_won=paid_amount_won, refunded_at=now() WHERE order_id='ord-a-pre'");

  // 데모 상품에 사용자가 쓴 비-demo 리뷰 — reconcile이 보존해야 한다
  await sql.unsafe(
    "INSERT INTO reviews (id, product_id, variant_id, rating, body, source_kind, source_ref, written_at) " +
      "VALUES ('r-custom-1','p-d-ear-lite',NULL,5,'사용자가 직접 남긴 리뷰','REAL','user','2026-10-08')",
  );
  // 시드 목록에 없는 stale demo 리뷰 — 정리 대상
  await sql.unsafe(
    "INSERT INTO reviews (id, product_id, variant_id, rating, body, source_kind, source_ref, written_at) " +
      "VALUES ('r-d-stale','p-d-ear-lite',NULL,1,'stale demo review','SYNTHETIC','x','2026-10-08')",
  );
  // 사용자 카트가 참조하는 stale demo variant → 삭제가 아닌 비활성화 대상
  await sql.unsafe(
    "INSERT INTO product_variants (id, product_id, unit_price_won, stock_qty) VALUES ('v-d-stale','p-d-ear-lite',1000,1)",
  );
  await sql.unsafe("INSERT INTO carts (id, user_id) VALUES ('cart-verify','u-a')");
  await sql.unsafe(
    "INSERT INTO cart_items (id, cart_id, variant_id, quantity) VALUES ('ci-verify','cart-verify','v-d-stale',1)",
  );
  // 주문 이력이 참조하는 stale demo product+variant → 둘 다 비활성화 보존 대상
  await sql.unsafe("INSERT INTO products (id, name, brand, category) VALUES ('p-d-stale','스테일 상품','데모','digital')");
  await sql.unsafe(
    "INSERT INTO product_variants (id, product_id, unit_price_won, stock_qty) VALUES ('v-d-stalekeep','p-d-stale',1000,1)",
  );
  await sql.unsafe(
    "INSERT INTO orders (id, user_id, status, items_total_won, shipping_fee_won, total_won, address_snapshot_json) " +
      "VALUES ('ord-verify','u-a','CONFIRMED',1000,0,1000,'{}'::jsonb)",
  );
  await sql.unsafe(
    "INSERT INTO order_items (id, order_id, variant_id, product_name_snapshot, option_snapshot_json, unit_price_won, quantity, line_total_won) " +
      "VALUES ('oi-verify','ord-verify','v-d-stalekeep','스테일 상품','{}'::jsonb,1000,1,1000)",
  );
  // 외부 참조가 없는 stale demo product+variant → 삭제 대상
  await sql.unsafe("INSERT INTO products (id, name, brand, category) VALUES ('p-d-gone','지워질 상품','데모','digital')");
  await sql.unsafe(
    "INSERT INTO product_variants (id, product_id, unit_price_won, stock_qty) VALUES ('v-d-gone','p-d-gone',1000,1)",
  );

  // --- demo 시드 3회 반복 (멱등 + 보존) ---
  for (let i = 0; i < 3; i++) {
    const r = seed(["--demo"]);
    assert.equal(r.status, 0, "demo seed run " + i + "\n" + r.stderr);
  }

  // A. 비-demo 상태 보존
  const [v] = await sql.unsafe<{ stock_qty: number; version: number }[]>(
    "SELECT stock_qty, version FROM product_variants WHERE id='v-a-24'",
  );
  assert.equal(v.stock_qty, 41);
  assert.equal(v.version, 7);
  const [o] = await sql.unsafe<{ version: number; cancelled_at: Date | null }[]>(
    "SELECT version, cancelled_at FROM orders WHERE id='ord-a-pre'",
  );
  assert.equal(o.version, 9);
  assert.ok(o.cancelled_at !== null);
  const [pay] = await sql.unsafe<{ refund_status: string; refunded_amount_won: number; paid_amount_won: number }[]>(
    "SELECT refund_status, refunded_amount_won, paid_amount_won FROM payments WHERE order_id='ord-a-pre'",
  );
  assert.equal(pay.refund_status, "REFUNDED");
  assert.equal(pay.refunded_amount_won, pay.paid_amount_won);

  // B. 데모 상품의 비-demo 리뷰 보존
  const [rc] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM reviews WHERE id='r-custom-1'",
  );
  assert.equal(rc.c, 1);

  // C. stale demo 리뷰 정리
  const [rs] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM reviews WHERE id='r-d-stale'",
  );
  assert.equal(rs.c, 0);

  // 외부 참조 stale variant/product → active=false 보존, 사용자 cart_item도 보존
  const [vs] = await sql.unsafe<{ active: boolean }[]>(
    "SELECT active FROM product_variants WHERE id='v-d-stale'",
  );
  assert.equal(vs.active, false);
  const [ci] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM cart_items WHERE id='ci-verify'",
  );
  assert.equal(ci.c, 1);
  const [vk] = await sql.unsafe<{ active: boolean }[]>(
    "SELECT active FROM product_variants WHERE id='v-d-stalekeep'",
  );
  assert.equal(vk.active, false);
  const [pk] = await sql.unsafe<{ active: boolean }[]>(
    "SELECT active FROM products WHERE id='p-d-stale'",
  );
  assert.equal(pk.active, false);

  // 참조 없는 stale product/variant → 삭제
  const [pg] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM products WHERE id='p-d-gone'",
  );
  assert.equal(pg.c, 0);
  const [vg] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM product_variants WHERE id='v-d-gone'",
  );
  assert.equal(vg.c, 0);

  // D. 기존 fixture + 데모 카탈로그 정상
  const [pc] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM products WHERE id IN ('p-a','p-b','p-c') AND active",
  );
  assert.equal(pc.c, 3);
  const [fr] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM reviews WHERE id LIKE 'r-0%'",
  );
  assert.equal(fr.c, 9);
  const [dp] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM products WHERE id LIKE 'p-d-%' AND active",
  );
  assert.equal(dp.c, 25);
  const [dv] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM product_variants WHERE id LIKE 'v-d-%' AND active",
  );
  assert.equal(dv.c, 55);

  await sql.end();
  const admin2 = postgres(ADMIN_URL);
  await admin2.unsafe("DROP DATABASE IF EXISTS " + DB + " WITH (FORCE)");
  await admin2.end();
});

// sql 풀 연결을 닫아야 서브프로세스가 종료하고 다음 파일로 진행된다.
after(async () => {
  try {
    await sql.end();
  } catch {
    // 이미 닫혔을 수 있다
  }
});
