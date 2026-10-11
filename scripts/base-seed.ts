// base phase 시드 본문 — scripts/seed.ts에서 추출 [PMQA-051-A].
// executor(q 같은 unsafe 쿼리 실행기)를 인자로 받으므로 호출자의
// 트랜잭션 안에서도 재사용할 수 있다. 이 모듈은 config/devdb/connect를
// import하지 않고 top-level 부작용도 없다.
// JSON/SQL/params·reseed stock+version·cancel/payment/refund/shipping
// 의미는 추출 전 원본과 정확히 동일하다.
import { readFileSync } from "node:fs";

export type SeedExec = {
  unsafe: <T = Record<string, unknown>[]>(
    q: string,
    p?: unknown[],
  ) => Promise<T>;
};

// 원본 seed.ts의 SEEDS 매핑과 동일 — phase ≤ N까지의 fixture 파일 목록.
export const BASE_SEED_FILES: Record<number, string[]> = {
  0: [],
  1: ["users.json", "catalog.json", "reviews.json"],
  3: ["scenarios.json"],
};

export function baseSeedFiles(phase: number): string[] {
  return Object.entries(BASE_SEED_FILES)
    .filter(([p]) => Number(p) <= phase)
    .flatMap(([, f]) => f);
}

/**
 * fixture 파일을 읽어 고정 ID로 upsert한다. 실행한 파일 목록을 돌려준다.
 * opts.read 주입은 테스트용 — 기본은 원본과 같은 db/seeds/*.json 디스크 읽기.
 */
export async function seedBase(
  q: SeedExec,
  phase: number,
  opts: { read?: (f: string) => unknown } = {},
): Promise<{ seeded: string[] }> {
  const read =
    opts.read ??
    ((f: string) => JSON.parse(readFileSync("db/seeds/" + f, "utf8")));
  const files = baseSeedFiles(phase);
  const seeded: string[] = [];

  for (const f of files) {
    const data = read(f) as never;
    if (f === "users.json") {
      for (const u of data as { id: string; auth_subject: string; display_name: string; test_address: unknown }[]) {
        await q.unsafe(
          "INSERT INTO users (id, auth_subject, display_name, test_address_json) VALUES ($1,$2,$3,$4::jsonb) " +
            "ON CONFLICT (id) DO UPDATE SET auth_subject=$2, display_name=$3, test_address_json=$4::jsonb",
          [u.id, u.auth_subject, u.display_name, u.test_address],
        );
      }
    } else if (f === "catalog.json") {
      const cat = data as {
        products: { id: string; name: string; brand: string; category: string; description: string; image_urls: unknown; specs: unknown }[];
        variants: { id: string; product_id: string; option_values: unknown; spec_overrides: unknown; unit_price_won: number; stock_qty: number }[];
      };
      for (const p of cat.products) {
        await q.unsafe(
          "INSERT INTO products (id, name, brand, category, description, image_urls, specs_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) " +
            "ON CONFLICT (id) DO UPDATE SET name=$2, brand=$3, category=$4, description=$5, image_urls=$6::jsonb, specs_json=$7::jsonb",
          [p.id, p.name, p.brand, p.category, p.description, p.image_urls, p.specs],
        );
      }
      for (const v of cat.variants) {
        await q.unsafe(
          "INSERT INTO product_variants (id, product_id, option_values_json, spec_overrides_json, unit_price_won, stock_qty) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6) " +
            "ON CONFLICT (id) DO UPDATE SET product_id=$2, option_values_json=$3::jsonb, spec_overrides_json=$4::jsonb, unit_price_won=$5, stock_qty=$6, version=1",
          [v.id, v.product_id, v.option_values, v.spec_overrides, v.unit_price_won, v.stock_qty],
        );
      }
    } else if (f === "reviews.json") {
      for (const r of data as { id: string; product_id: string; variant_id: string | null; rating: number; body: string; source_kind: string; source_ref: string; written_at: string }[]) {
        await q.unsafe(
          "INSERT INTO reviews (id, product_id, variant_id, rating, body, source_kind, source_ref, written_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) " +
            "ON CONFLICT (id) DO UPDATE SET product_id=$2, variant_id=$3, rating=$4, body=$5, source_kind=$6, source_ref=$7, written_at=$8",
          [r.id, r.product_id, r.variant_id, r.rating, r.body, r.source_kind, r.source_ref, r.written_at],
        );
      }
    } else if (f === "scenarios.json") {
      const sc = data as {
        orders: {
          id: string; user_id: string; status: string;
          items_total_won: number; shipping_fee_won: number; total_won: number;
          address: unknown; created_at: string;
          items: { variant_id: string; product_name: string; option_values: Record<string, string>; unit_price_won: number; quantity: number }[];
          payment?: { paid_amount_won: number; paid_at: string };
          shipment?: { status: string; events: { occurred_at?: string }[] };
        }[];
      };
      // Phase 3 주문 시나리오. seed 주문은 결제 완료 상태로 직접 넣는다 — 재고 차감 없음.
      // (checkout 경로로 만든 주문만 재고를 차감한다. provenance.md 참고)
      for (const o of sc.orders) {
        // Phase 4: 재시드는 시나리오 주문의 취소/환불 상태도 초기 상태로 되돌린다.
        // (phase<4 DB에는 cancel_requests가 없을 수 있으므로 존재를 먼저 확인)
        const [reg] = await q.unsafe<{ r: string | null }[]>(
          "SELECT to_regclass('public.cancel_requests') AS r",
        );
        if (reg.r)
          await q.unsafe("DELETE FROM cancel_requests WHERE order_id=$1", [o.id]);
        await q.unsafe(
            "INSERT INTO orders (id, user_id, status, items_total_won, shipping_fee_won, total_won, address_snapshot_json, created_at, version, cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,1,NULL) " +
              "ON CONFLICT (id) DO UPDATE SET status=$3, items_total_won=$4, shipping_fee_won=$5, total_won=$6, address_snapshot_json=$7::jsonb, created_at=$8, version=1, cancelled_at=NULL",
            [o.id, o.user_id, o.status, o.items_total_won, o.shipping_fee_won, o.total_won, o.address, o.created_at],
        );
        for (const [idx, it] of o.items.entries()) {
          await q.unsafe(
              "INSERT INTO order_items (id, order_id, variant_id, product_name_snapshot, option_snapshot_json, unit_price_won, quantity, line_total_won) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) " +
                "ON CONFLICT (id) DO UPDATE SET variant_id=$3, product_name_snapshot=$4, option_snapshot_json=$5::jsonb, unit_price_won=$6, quantity=$7, line_total_won=$8",
              [o.id + "-it-" + idx, o.id, it.variant_id, it.product_name, it.option_values, it.unit_price_won, it.quantity, it.unit_price_won * it.quantity],
          );
        }
        if (o.payment) {
          await q.unsafe(
            "INSERT INTO payments (id, order_id, method, status, paid_amount_won, paid_at, refund_status, refunded_amount_won, refunded_at) VALUES ($1,$2,'SIMULATED','PAID',$3,$4,'NONE',0,NULL) " +
              "ON CONFLICT (order_id) DO UPDATE SET paid_amount_won=$3, paid_at=$4, refund_status='NONE', refunded_amount_won=0, refunded_at=NULL",
            [o.id + "-pay", o.id, o.payment.paid_amount_won, o.payment.paid_at],
          );
        }
        if (o.shipment) {
          await q.unsafe(
              "INSERT INTO shipments (id, order_id, status, events_json, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5) " +
                "ON CONFLICT (order_id) DO UPDATE SET status=$3, events_json=$4::jsonb, updated_at=$5",
              [o.id + "-ship", o.id, o.shipment.status, o.shipment.events, o.shipment.events[o.shipment.events.length - 1]?.occurred_at ?? o.created_at],
          );
        }
      }
    }
    seeded.push(f);
  }
  return { seeded };
}
