// Phase별 seed 로더. db/seeds/*.json을 읽어 고정 ID로 upsert한다.
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";
import { readFileSync } from "node:fs";
import type postgres from "postgres";

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

// --demo: 개발/데모 DB 전용 Demo Catalog(db/seeds/demo-*.json) — 독립 모드.
// phase 시드(users/catalog/reviews/scenarios)를 실행하지 않는다.
// 데모 시드가 소유하는 범위는 p-d-*/v-d-*/r-d-* 네임스페이스뿐이며,
// fixture(p-a~c)·users·주문·결제·배송·취소·환불·재고 등은 절대 변경하지 않는다.
const demo = process.argv.some((a) => a === "--demo");

const phaseArg = process.argv.find((a) => a.startsWith("--phase="));
if (demo && phaseArg) {
  // 암묵적 base 재시드(주문/취소/재고 리셋)를 막기 위해 두 모드는 반드시 따로 실행한다.
  console.error("--demo와 --phase는 함께 사용할 수 없습니다. base 시드: npm run db:seed -- --phase=N / 데모: npm run db:seed:demo");
  process.exit(1);
}
const phase = phaseArg ? Number(phaseArg.split("=")[1]) : 0;

const SEEDS: Record<number, string[]> = {
  0: [],
  1: ["users.json", "catalog.json", "reviews.json"],
  3: ["scenarios.json"],
};

const phaseFiles = Object.entries(SEEDS)
  .filter(([p]) => Number(p) <= phase)
  .flatMap(([, f]) => f);

const read = (f: string) => JSON.parse(readFileSync("db/seeds/" + f, "utf8"));

// --demo 허용 DB. URL pathname이 아니라 트랜잭션 안의 current_database()로
// 실제 접속 DB를 확인해 ?database= 같은 URL 옵션 우회를 막는다.
const DEMO_DBS = ["commerce", "commerce_demo_verify"];

// --demo는 base 시드와 섞이지 않는 독립 모드. reconcile+upsert 전체가
// 하나의 트랜잭션으로 커밋되거나 함께 롤백된다(runDemoSeed).
if (demo) {
  try {
    await runDemoSeed();
    console.log("demo seed ok");
  } catch (e) {
    console.error("demo seed failed — 트랜잭션 전체 롤백:", e instanceof Error ? e.message : e);
    try {
      await sql.end();
    } catch {
      // noop
    }
    process.exit(1);
  }
  await sql.end();
  process.exit(0);
}

const files = phaseFiles;

if (files.length === 0) {
  console.log("no seeds defined for phase <= " + phase);
  await sql.end();
  process.exit(0);
}

for (const f of files) {
  const data = read(f);
  if (f === "users.json") {
    for (const u of data) {
      await sql.unsafe(
        "INSERT INTO users (id, auth_subject, display_name, test_address_json) VALUES ($1,$2,$3,$4::jsonb) " +
          "ON CONFLICT (id) DO UPDATE SET auth_subject=$2, display_name=$3, test_address_json=$4::jsonb",
 [u.id, u.auth_subject, u.display_name, u.test_address],
      );
    }
  } else if (f === "catalog.json") {
    for (const p of data.products) {
      await sql.unsafe(
        "INSERT INTO products (id, name, brand, category, description, image_urls, specs_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) " +
          "ON CONFLICT (id) DO UPDATE SET name=$2, brand=$3, category=$4, description=$5, image_urls=$6::jsonb, specs_json=$7::jsonb",
 [p.id, p.name, p.brand, p.category, p.description, p.image_urls, p.specs],
      );
    }
    for (const v of data.variants) {
      await sql.unsafe(
        "INSERT INTO product_variants (id, product_id, option_values_json, spec_overrides_json, unit_price_won, stock_qty) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6) " +
          "ON CONFLICT (id) DO UPDATE SET product_id=$2, option_values_json=$3::jsonb, spec_overrides_json=$4::jsonb, unit_price_won=$5, stock_qty=$6, version=1",
        [v.id, v.product_id, v.option_values, v.spec_overrides, v.unit_price_won, v.stock_qty],
      );
    }
  } else if (f === "reviews.json") {
    for (const r of data) {
      await sql.unsafe(
        "INSERT INTO reviews (id, product_id, variant_id, rating, body, source_kind, source_ref, written_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) " +
          "ON CONFLICT (id) DO UPDATE SET product_id=$2, variant_id=$3, rating=$4, body=$5, source_kind=$6, source_ref=$7, written_at=$8",
        [r.id, r.product_id, r.variant_id, r.rating, r.body, r.source_kind, r.source_ref, r.written_at],
      );
    }
  } else if (f === "scenarios.json") {
    // Phase 3 주문 시나리오. seed 주문은 결제 완료 상태로 직접 넣는다 — 재고 차감 없음.
    // (checkout 경로로 만든 주문만 재고를 차감한다. provenance.md 참고)
    for (const o of data.orders) {
      // Phase 4: 재시드는 시나리오 주문의 취소/환불 상태도 초기 상태로 되돌린다.
      // (phase<4 DB에는 cancel_requests가 없을 수 있으므로 존재를 먼저 확인)
      const [reg] = await sql.unsafe<{ r: string | null }[]>(
        "SELECT to_regclass('public.cancel_requests') AS r",
      );
      if (reg.r)
        await sql.unsafe("DELETE FROM cancel_requests WHERE order_id=$1", [o.id]);
      await sql.unsafe(
          "INSERT INTO orders (id, user_id, status, items_total_won, shipping_fee_won, total_won, address_snapshot_json, created_at, version, cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,1,NULL) " +
            "ON CONFLICT (id) DO UPDATE SET status=$3, items_total_won=$4, shipping_fee_won=$5, total_won=$6, address_snapshot_json=$7::jsonb, created_at=$8, version=1, cancelled_at=NULL",
          [o.id, o.user_id, o.status, o.items_total_won, o.shipping_fee_won, o.total_won, o.address, o.created_at],
      );
      for (const [idx, it] of (o.items as { variant_id: string; product_name: string; option_values: Record<string,string>; unit_price_won: number; quantity: number }[]).entries()) {
        await sql.unsafe(
            "INSERT INTO order_items (id, order_id, variant_id, product_name_snapshot, option_snapshot_json, unit_price_won, quantity, line_total_won) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) " +
              "ON CONFLICT (id) DO UPDATE SET variant_id=$3, product_name_snapshot=$4, option_snapshot_json=$5::jsonb, unit_price_won=$6, quantity=$7, line_total_won=$8",
            [o.id + "-it-" + idx, o.id, it.variant_id, it.product_name, it.option_values, it.unit_price_won, it.quantity, it.unit_price_won * it.quantity],
        );
      }
      if (o.payment) {
        await sql.unsafe(
          "INSERT INTO payments (id, order_id, method, status, paid_amount_won, paid_at, refund_status, refunded_amount_won, refunded_at) VALUES ($1,$2,'SIMULATED','PAID',$3,$4,'NONE',0,NULL) " +
            "ON CONFLICT (order_id) DO UPDATE SET paid_amount_won=$3, paid_at=$4, refund_status='NONE', refunded_amount_won=0, refunded_at=NULL",
          [o.id + "-pay", o.id, o.payment.paid_amount_won, o.payment.paid_at],
        );
      }
      if (o.shipment) {
        await sql.unsafe(
            "INSERT INTO shipments (id, order_id, status, events_json, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5) " +
              "ON CONFLICT (order_id) DO UPDATE SET status=$3, events_json=$4::jsonb, updated_at=$5",
            [o.id + "-ship", o.id, o.shipment.status, o.shipment.events, o.shipment.events[o.shipment.events.length - 1]?.occurred_at ?? o.created_at],
        );
      }
    }
  }
  console.log("seeded " + f);
}

console.log("seed ok (phase <= " + phase + ")");
await sql.end();

// --demo 실행 계약
// - 허용 DB: DEMO_DBS만. URL pathname이 아니라 실제 접속 DB(current_database())로
//   판단해 ?database= 같은 URL 옵션 우회를 막고, 검사 연결과 쓰기 연결을 같게 한다.
// - 원자성: reconcile(stale 정리/비활성화) + upsert 전체를 sql.begin 하나로 실행.
//   중간 실패 시 절반만 반영되지 않는다.
// - 소유 경계: r-d-*/v-d-*/p-d-* 네임스페이스뿐. 외부 참조(사용자 cart_item,
//   주문 스냅샷, 비-demo 리뷰)가 붙은 stale 행은 DELETE 대신 active=false 보존.
// - 순서: reconcile(리뷰→variant→product) 먼저, upsert 나중 — stale 리뷰가
//   지워져야 그것을 참조하던 stale variant가 고아로 판정돼 삭제될 수 있다.
async function runDemoSeed(): Promise<void> {
  const cat = read("demo-catalog.json") as {
    products: {
      id: string; name: string; brand: string; category: string;
      description: string; image_urls: string[]; specs: Record<string, unknown>;
    }[];
    variants: {
      id: string; product_id: string; option_values: Record<string, unknown>;
      spec_overrides: Record<string, unknown>; unit_price_won: number; stock_qty: number;
    }[];
  };
  const rev = read("demo-reviews.json") as {
    id: string; product_id: string; variant_id: string | null; rating: number;
    body: string; source_kind: string; source_ref: string; written_at: string;
  }[];
  const pids = cat.products.map((p) => p.id);
  const vids = cat.variants.map((v) => v.id);
  const rids = rev.map((r) => r.id);

  let removedStaleReviews = 0;
  await sql.begin(async (q) => {
    // 0) 가드 — 첫 write 전에 실제 접속 DB를 확인한다.
    const [dbr] = await q.unsafe<{ d: string }[]>("SELECT current_database() AS d");
    if (!DEMO_DBS.includes(dbr.d)) {
      throw new Error(
        "--demo는 DB '" + dbr.d + "'에서 실행할 수 없습니다. 허용 DB: " + DEMO_DBS.join(", "),
      );
    }

    // 1) stale demo 리뷰 — demo 소유(r-d-*)만 삭제한다. product_id가 p-d-*이어도
    //    사용자가 작성한 비-demo 리뷰(r-custom 등)는 보존한다.
    const [dr] = await q.unsafe<{ c: number }[]>(
      "SELECT count(*)::int AS c FROM reviews WHERE id LIKE 'r-d-%' AND NOT (id = ANY($1))",
      [rids],
    );
    removedStaleReviews = dr.c;
    await q.unsafe("DELETE FROM reviews WHERE id LIKE 'r-d-%' AND NOT (id = ANY($1))", [rids]);

    // 2) stale demo variant — 외부 참조가 있으면 active=false 보존,
    //    없을 때만 삭제한다. cart_items는 사용자 소유라 건드리지 않는다.
    const refs: string[] = [];
    const [regOi] = await q.unsafe<{ r: string | null }[]>(
      "SELECT to_regclass('public.order_items') AS r",
    );
    const [regCi] = await q.unsafe<{ r: string | null }[]>(
      "SELECT to_regclass('public.cart_items') AS r",
    );
    if (regOi.r)
      refs.push("EXISTS (SELECT 1 FROM order_items oi WHERE oi.variant_id = product_variants.id)");
    if (regCi.r)
      refs.push("EXISTS (SELECT 1 FROM cart_items ci WHERE ci.variant_id = product_variants.id)");
    refs.push("EXISTS (SELECT 1 FROM reviews r WHERE r.variant_id = product_variants.id)");
    const refSql = refs.join(" OR ");
    await q.unsafe(
      "UPDATE product_variants SET active=false WHERE id LIKE 'v-d-%' AND NOT (id = ANY($1)) AND (" + refSql + ")",
      [vids],
    );
    await q.unsafe(
      "DELETE FROM product_variants WHERE id LIKE 'v-d-%' AND NOT (id = ANY($1)) AND NOT (" + refSql + ")",
      [vids],
    );

    // 3) stale demo product — 남은 variant나 리뷰가 있으면 active=false로 보존
    //    (주문 이력/사용자 리뷰 표시용), 완전히 고아인 행만 삭제한다.
    await q.unsafe(
      "UPDATE products SET active=false WHERE id LIKE 'p-d-%' AND NOT (id = ANY($1)) " +
        "AND (EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id) " +
        "OR EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = products.id))",
      [pids],
    );
    await q.unsafe(
      "DELETE FROM products WHERE id LIKE 'p-d-%' AND NOT (id = ANY($1)) " +
        "AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id) " +
        "AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.product_id = products.id)",
      [pids],
    );

    // 4) demo 카탈로그 upsert — 충돌 시 active=true로 되돌려 이전 reconcile로
    //    비활성화된 행이 seed에 다시 포함됐을 때 복구되게 한다.
    for (const p of cat.products) {
      await q.unsafe(
          "INSERT INTO products (id, name, brand, category, description, image_urls, specs_json, active) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,true) " +
          "ON CONFLICT (id) DO UPDATE SET name=$2, brand=$3, category=$4, description=$5, image_urls=$6::jsonb, specs_json=$7::jsonb, active=true",
        [p.id, p.name, p.brand, p.category, p.description, p.image_urls as postgres.JSONValue, p.specs as postgres.JSONValue],
      );
    }
    for (const v of cat.variants) {
      await q.unsafe(
        "INSERT INTO product_variants (id, product_id, option_values_json, spec_overrides_json, unit_price_won, stock_qty, active) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,true) " +
          "ON CONFLICT (id) DO UPDATE SET product_id=$2, option_values_json=$3::jsonb, spec_overrides_json=$4::jsonb, unit_price_won=$5, stock_qty=$6, active=true, version=1",
        [v.id, v.product_id, v.option_values as postgres.JSONValue, v.spec_overrides as postgres.JSONValue, v.unit_price_won, v.stock_qty],
      );
    }
    for (const r of rev) {
      await q.unsafe(
        "INSERT INTO reviews (id, product_id, variant_id, rating, body, source_kind, source_ref, written_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) " +
          "ON CONFLICT (id) DO UPDATE SET product_id=$2, variant_id=$3, rating=$4, body=$5, source_kind=$6, source_ref=$7, written_at=$8",
        [r.id, r.product_id, r.variant_id, r.rating, r.body, r.source_kind, r.source_ref, r.written_at],
      );
    }
  });
  console.log("demo reconcile+upsert committed (removed stale r-d reviews: " + removedStaleReviews + ")");
}
