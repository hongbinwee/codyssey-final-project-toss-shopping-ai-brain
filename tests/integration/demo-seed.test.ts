// --demo 시드 안전성 검증 (현재 상태: 전체 5건 DISABLED — PMQA-040)
//
// 검증 의도(재활성 시 기준): scratch DB를 만들어 commerce_test/dev를 건드리지
// 않고 demo reconcile의 소유 경계를 증명한다.
// - demo reconcile은 p-d-*/v-d-*/r-d-*만 소유한다
// - 비-demo 상태(fixture stock/version, 주문, 결제/환불)는 demo 시드가 변경하지 않는다
// - 데모 상품의 비-demo 리뷰(r-custom)는 보존, stale r-d-*는 정리
// - 외부 참조가 붙은 stale v-d-*/p-d-*는 삭제 대신 active=false 보존
// - reconcile+upsert는 단일 트랜잭션 — 중간 실패 시 전체 롤백
// - DB 가드는 URL이 아니라 current_database() 기준이라 ?database= 우회를 막는다
//
// ── PMQA-040 비활성 사유 ────────────────────────────────────────────────
// 이 파일은 원래 고정 이름 DB(commerce_demo_verify)를
//   DROP DATABASE IF EXISTS ... WITH (FORCE)
// 로 만들고 지웠다. 040에서 이 코드가 보존 대상 DB와 그 안 데이터를 소실시킨
// 사고의 직접 원인이 됐다 — 해당 DROP 코드는 전부 제거됐다.
//
// 재활성이 막힌 구조적 이유: scratch_* 이름은 scripts/seed.ts의 --demo 허용
// DB(DEMO_DBS = commerce, commerce_demo_verify)에 없다. 소유권 검증된
// scratch 경로로는 --demo를 실행할 수 없고, 보호 DB 허용 목록 확대는 금지다.
//
// 재활성 조건(미래 작업 — 현재 승인 범위 아님):
//   createOwnedScratchDb(tests/helpers/scratch-db.ts)로 만든 scratch DB에
//   대해서만 --demo가 허용되도록, seed.ts에 '동일 runId 마커 +
//   current_database() + pg_database OID/owner 검증을 통과한 scratch_*'를
//   허용하는 좁은 조건을 명시적으로 추가하는 안. 그 조건이 승인·구현되기
//   전까지 이 파일은 전체 skip을 유지한다.
//
// 참고: test 1~3은 DB 변경 없는 거부(refusal) 검증이라 재활성 후보지만,
// PM 지시로 이번 검증에서는 파일 전체를 제외한다.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { connectDb, sql } from "../../src/db.ts";

const DB = "commerce_demo_verify";
const DB_URL = "postgres://commerce:commerce@localhost:5432/" + DB;

// PMQA-040 — 파일 전체 skip 사유는 상단 주석 참조.
const SKIP_040 = "PMQA-040: scratch 수명주기 비활성 — 파일 상단 주석 참조";

const seed = (extra: string[] = [], url = DB_URL) =>
  spawnSync("node", ["scripts/seed.ts", ...extra], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

test("--demo는 테스트 DB(commerce_test)에서 실행을 거부한다", { skip: SKIP_040 }, () => {
  const r = seed(["--demo"], "postgres://commerce:commerce@localhost:5432/commerce_test");
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr) + String(r.stdout), /commerce_test/);
});

test("--demo 가드는 ?database= 우회도 막는다(실제 접속 DB 기준)", { skip: SKIP_040 }, async () => {
  // postgres.js는 ?database= 옵션을 실제 접속에 사용한다 — URL의 pathname은
  // commerce지만 접속 DB는 commerce_test가 되는 우회. 가드가 실제 DB명을
  // 검사하므로 거부돼야 하고 commerce_test에는 어떤 변경도 없어야 한다.
  const tdb = postgres("postgres://commerce:commerce@localhost:5432/commerce_test");
  const before = await tdb.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM products WHERE id LIKE 'p-d-%'",
  );
  const r = seed(
    ["--demo"],
    "postgres://commerce:commerce@localhost:5432/commerce?database=commerce_test",
  );
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr) + String(r.stdout), /commerce_test/);
  const afterRows = await tdb.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM products WHERE id LIKE 'p-d-%'",
  );
  assert.equal(afterRows[0].c, before[0].c);
  await tdb.end();
});

test("--demo와 --phase 동시 사용을 거부한다", { skip: SKIP_040 }, () => {
  const r = seed(["--demo", "--phase=1"]);
  assert.notEqual(r.status, 0);
});

test("demo seed는 비-demo 상태를 보존하고 demo 행만 reconcile한다", { skip: SKIP_040, timeout: 120000 }, async () => {
  // PMQA-040 DISABLED — 기존에는 여기서 admin 접속으로
  //   DROP DATABASE IF EXISTS commerce_demo_verify WITH (FORCE)
  //   CREATE DATABASE commerce_demo_verify
  // 를 실행했다(040 사고 원인 — 코드 제거됨). scratch 수명주기는
  // tests/helpers/scratch-db.ts의 createOwnedScratchDb로 대체하되,
  // seed.ts DEMO_DBS가 scratch_*를 허용하는 좁은 조건이 먼저 필요하다.
  // 아래 본문은 재활성 시 참조용으로 보존한다.
  try {
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
  // 취소 요청(action_requests 1:1 연결) — demo 시드가 건드리면 안 되는 CS 상태
  await sql.unsafe(
    "INSERT INTO action_requests (id, actor_user_id, kind, idempotency_key, payload_json, payload_hash, status, confirmed_at, completed_at) " +
      "VALUES ('ar-verify','u-a','CANCEL_ORDER','idem-verify','{}'::jsonb,'h','SUCCEEDED',now(),now())",
  );
  await sql.unsafe(
    "INSERT INTO cancel_requests (id, order_id, action_request_id, reason_code, status, refund_amount_won, completed_at) " +
      "VALUES ('cr-verify','ord-verify','ar-verify','CHANGE_OF_MIND','COMPLETED',1000,now())",
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
  // 취소 요청 + 주문 상태 보존
  const [ov] = await sql.unsafe<{ status: string }[]>(
    "SELECT status FROM orders WHERE id='ord-verify'",
  );
  assert.equal(ov.status, "CONFIRMED");
  const [crv] = await sql.unsafe<{ status: string; refund_amount_won: number }[]>(
    "SELECT status, refund_amount_won FROM cancel_requests WHERE id='cr-verify'",
  );
  assert.equal(crv.status, "COMPLETED");
  assert.equal(crv.refund_amount_won, 1000);

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
  } finally {
    // PMQA-040 DISABLED — 원래는 여기서 FORCE DROP으로 scratch DB를 정리했다.
    try {
      await sql.end();
    } catch {
      // 이미 닫혔을 수 있다
    }
  }
});

test("demo seed 도중 실패하면 reconcile+upsert 전체가 롤백된다", { skip: SKIP_040, timeout: 120000 }, async () => {
  // PMQA-040 DISABLED — 기존에는 여기서 admin 접속으로
  //   DROP DATABASE IF EXISTS commerce_demo_verify WITH (FORCE)
  //   CREATE DATABASE commerce_demo_verify
  // 를 실행했다(040 사고 원인 — 코드 제거됨). 재활성 조건은 위 테스트와 동일.
  try {
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

    // 롤백으로 확인할 상태:
    //  - reconcile이 실행된 뒤(demo 순서: 정리→upsert) upsert 중간에서 실패 유발
    //  - 삭제 예정 stale 행, 비활성화 예정 행, upsert 대상 행이 모두 사전 상태로 남는지 확인
    await sql.unsafe("UPDATE products SET name='BROKEN' WHERE id='p-d-ear-lite'"); // upsert 롤백 확인용
    await sql.unsafe(
      "INSERT INTO reviews (id, product_id, variant_id, rating, body, source_kind, source_ref, written_at) " +
        "VALUES ('r-d-rbstale','p-d-ear-lite',NULL,1,'stale demo review','SYNTHETIC','x','2026-10-08')",
    );
    // 외부 참조 없는 stale demo product+variant → 정상 경로에선 삭제 대상
    await sql.unsafe("INSERT INTO products (id, name, brand, category) VALUES ('p-d-rb1','삭제대상','데모','digital')");
    await sql.unsafe(
      "INSERT INTO product_variants (id, product_id, unit_price_won, stock_qty) VALUES ('v-d-rb1','p-d-rb1',1000,1)",
    );
    // 주문이 참조하는 stale demo product+variant → 정상 경로에선 active=false 대상
    await sql.unsafe("INSERT INTO products (id, name, brand, category) VALUES ('p-d-rb2','보존대상','데모','digital')");
    await sql.unsafe(
      "INSERT INTO product_variants (id, product_id, unit_price_won, stock_qty) VALUES ('v-d-rb2','p-d-rb2',1000,1)",
    );
    await sql.unsafe(
      "INSERT INTO orders (id, user_id, status, items_total_won, shipping_fee_won, total_won, address_snapshot_json) " +
        "VALUES ('ord-rb','u-a','CONFIRMED',1000,0,1000,'{}'::jsonb)",
    );
    await sql.unsafe(
      "INSERT INTO order_items (id, order_id, variant_id, product_name_snapshot, option_snapshot_json, unit_price_won, quantity, line_total_won) " +
        "VALUES ('oi-rb','ord-rb','v-d-rb2','보존대상','{}'::jsonb,1000,1,1000)",
    );
    await sql.unsafe("UPDATE product_variants SET stock_qty=99 WHERE id='v-a-24'");

    // 실패 주입: products upsert가 p-d-tone(카탈로그 중간 지점)에서 깨지도록
    // CHECK를 건다. NOT VALID로 기존 행 검증은 건너뛰고 신규 write만 막는다.
    await sql.unsafe(
      "ALTER TABLE products ADD CONSTRAINT chk_demo_tx CHECK (id <> 'p-d-tone') NOT VALID",
    );

    const r = seed(["--demo"]);
    assert.notEqual(r.status, 0, "실패 주입 시 demo seed는 실패해야 함\n" + r.stdout + r.stderr);

    // --- 롤백 검증: 어느 write도 커밋되지 않았어야 함 ---
    const [p1] = await sql.unsafe<{ name: string }[]>(
      "SELECT name FROM products WHERE id='p-d-ear-lite'",
    );
    assert.equal(p1.name, "BROKEN"); // upsert 롤백 — BROKEN이 그대로여야 함
    const [rc] = await sql.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM reviews WHERE id='r-d-rbstale'",
    );
    assert.equal(rc.c, 1); // review reconcile 롤백 — stale 행 생존
    const [pc] = await sql.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM products WHERE id='p-d-rb1'",
    );
    assert.equal(pc.c, 1); // product 삭제 롤백
    const [v1] = await sql.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM product_variants WHERE id='v-d-rb1'",
    );
    assert.equal(v1.c, 1); // variant 삭제 롤백
    const [v2] = await sql.unsafe<{ active: boolean }[]>(
      "SELECT active FROM product_variants WHERE id='v-d-rb2'",
    );
    assert.equal(v2.active, true); // active=false 롤백 — 참조된 행이 active 유지
    const [fv] = await sql.unsafe<{ stock_qty: number }[]>(
      "SELECT stock_qty FROM product_variants WHERE id='v-a-24'",
    );
    assert.equal(fv.stock_qty, 99); // 비-demo 상태 불변

    // 실패 주입을 제거하면 같은 seed가 정상 동작해야 한다(부분 적용 잔재 없음)
    await sql.unsafe("ALTER TABLE products DROP CONSTRAINT chk_demo_tx");
    const r2 = seed(["--demo"]);
    assert.equal(r2.status, 0, "제약 제거 후 정상\n" + r2.stderr);
    const [p1b] = await sql.unsafe<{ name: string }[]>(
      "SELECT name FROM products WHERE id='p-d-ear-lite'",
    );
    assert.notEqual(p1b.name, "BROKEN");
    const [rc2] = await sql.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM reviews WHERE id='r-d-rbstale'",
    );
    assert.equal(rc2.c, 0);
    const [v2b] = await sql.unsafe<{ active: boolean }[]>(
      "SELECT active FROM product_variants WHERE id='v-d-rb2'",
    );
    assert.equal(v2b.active, false);
  } finally {
    // PMQA-040 DISABLED — 원래는 여기서 FORCE DROP으로 scratch DB를 정리했다.
    try {
      await sql.end();
    } catch {
      // 이미 닫혔을 수 있다
    }
  }
});

// sql 풀 연결을 닫아야 서브프로세스가 종료하고 다음 파일로 진행된다.
after(async () => {
  try {
    await sql.end();
  } catch {
    // 이미 닫혔을 수 있다
  }
});
