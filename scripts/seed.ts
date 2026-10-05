// Phase별 seed 로더. db/seeds/*.json을 읽어 고정 ID로 upsert한다.
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";
import { readFileSync } from "node:fs";

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

const phase = Number(
  process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "0",
);

const SEEDS: Record<number, string[]> = {
  0: [],
  1: ["users.json", "catalog.json", "reviews.json"],
};

const files = Object.entries(SEEDS)
  .filter(([p]) => Number(p) <= phase)
  .flatMap(([, f]) => f);

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
          "ON CONFLICT (id) DO UPDATE SET product_id=$2, option_values_json=$3::jsonb, spec_overrides_json=$4::jsonb, unit_price_won=$5, stock_qty=$6",
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
  }
  console.log("seeded " + f);
}
console.log("seed ok (phase <= " + phase + ")");
await sql.end();
