// Phase별 seed 로더. db/seeds/*.json을 읽어 고정 ID로 upsert한다.
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";
import { readFileSync } from "node:fs";

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

// --demo: 개발/데모 DB 전용 Demo Catalog(db/seeds/demo-*.json).
// phase SEEDS에 넣지 않아 setupTestDb/eval 등 테스트 적재 경로와 완전히 분리된다.
// 네임스페이스 p-d-*/v-d-*/r-d-*에만 upsert+reconcile을 적용하며 fixture(p-a~c 등)는 건드리지 않는다.
const demo = process.argv.some((a) => a === "--demo");
const DEMO_FILES = ["demo-catalog.json", "demo-reviews.json"];

// --demo에 --phase가 없으면 전체 시드(=99)를 암시한다:
// "node scripts/seed.ts --demo" 한 번으로 fixture + demo가 갖춰진다.
const phase = Number(
  process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? (demo ? "99" : "0"),
);

const SEEDS: Record<number, string[]> = {
  0: [],
  1: ["users.json", "catalog.json", "reviews.json"],
  3: ["scenarios.json"],
};

const phaseFiles = Object.entries(SEEDS)
  .filter(([p]) => Number(p) <= phase)
  .flatMap(([, f]) => f);

// demo 파일은 products 계열 테이블이 있는 phase>=1에서만 적재한다.
const files = [...phaseFiles, ...(demo && phase >= 1 ? DEMO_FILES : [])];
if (demo && phase < 1) console.log("--demo는 phase>=1이 필요합니다. demo 시드를 건너뜁니다.");

if (files.length === 0) {
  console.log("no seeds defined for phase <= " + phase);
  await sql.end();
  process.exit(0);
}

const read = (f: string) => JSON.parse(readFileSync("db/seeds/" + f, "utf8"));

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
  } else if (f === "demo-catalog.json") {
    // deterministic fixture(catalog.json)와 구조는 같되, 충돌 시 active=true로 되돌려
    // 이전 reconcile로 비활성화된 행이 seed에 다시 포함됐을 때 복구되게 한다.
    for (const p of data.products) {
      await sql.unsafe(
        "INSERT INTO products (id, name, brand, category, description, image_urls, specs_json, active) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,true) " +
          "ON CONFLICT (id) DO UPDATE SET name=$2, brand=$3, category=$4, description=$5, image_urls=$6::jsonb, specs_json=$7::jsonb, active=true",
        [p.id, p.name, p.brand, p.category, p.description, p.image_urls, p.specs],
      );
    }
    for (const v of data.variants) {
      await sql.unsafe(
        "INSERT INTO product_variants (id, product_id, option_values_json, spec_overrides_json, unit_price_won, stock_qty, active) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,true) " +
          "ON CONFLICT (id) DO UPDATE SET product_id=$2, option_values_json=$3::jsonb, spec_overrides_json=$4::jsonb, unit_price_won=$5, stock_qty=$6, active=true, version=1",
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
  } else if (f === "demo-reviews.json") {
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

// demo reconcile: 이번 seed 파일에 없는 데모 네임스페이스 행을 정리한다.
// FK 순서 reviews → cart_items → product_variants → products.
// 주문 스냅샷(order_items)이 참조하는 variant는 삭제할 수 없으므로 active=false로 남기고,
// 참조가 없는 행만 DELETE한다. 같은 seed 파일을 반복 실행해도 결과가 같다(멱등).
if (demo && phase >= 1) {
  const cat = read("demo-catalog.json") as { products: { id: string }[]; variants: { id: string }[] };
  const rev = read("demo-reviews.json") as { id: string }[];
  const pids = cat.products.map((p) => p.id);
  const vids = cat.variants.map((v) => v.id);
  const rids = rev.map((r) => r.id);

  const [dr] = await sql.unsafe<{ c: number }[]>(
    "SELECT count(*)::int AS c FROM reviews WHERE (id LIKE 'r-d-%' OR product_id LIKE 'p-d-%') AND NOT (id = ANY($1))",
    [rids],
  );
  await sql.unsafe(
    "DELETE FROM reviews WHERE (id LIKE 'r-d-%' OR product_id LIKE 'p-d-%') AND NOT (id = ANY($1))",
    [rids],
  );
  await sql.unsafe(
    "DELETE FROM cart_items WHERE variant_id LIKE 'v-d-%' AND NOT (variant_id = ANY($1))",
    [vids],
  );
  const [regOi] = await sql.unsafe<{ r: string | null }[]>(
    "SELECT to_regclass('public.order_items') AS r",
  );
  if (regOi.r) {
    await sql.unsafe(
      "UPDATE product_variants SET active=false WHERE id LIKE 'v-d-%' AND NOT (id = ANY($1)) " +
        "AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.variant_id = product_variants.id)",
      [vids],
    );
    await sql.unsafe(
      "DELETE FROM product_variants WHERE id LIKE 'v-d-%' AND NOT (id = ANY($1)) " +
        "AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.variant_id = product_variants.id)",
      [vids],
    );
  } else {
    await sql.unsafe(
      "DELETE FROM product_variants WHERE id LIKE 'v-d-%' AND NOT (id = ANY($1))",
      [vids],
    );
  }
  // variant가 남은 stale 상품은 비활성화(주문 이력 표시용으로 보존), 없으면 삭제
  await sql.unsafe(
    "UPDATE products SET active=false WHERE id LIKE 'p-d-%' AND NOT (id = ANY($1)) " +
      "AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id)",
    [pids],
  );
  await sql.unsafe(
    "DELETE FROM products WHERE id LIKE 'p-d-%' AND NOT (id = ANY($1)) " +
      "AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = products.id)",
    [pids],
  );
  console.log("demo reconcile done (removed stale r-d reviews: " + dr.c + ")");
}
console.log("seed ok (phase <= " + phase + ")");
await sql.end();
