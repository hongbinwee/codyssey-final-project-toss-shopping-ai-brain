// Phase별 SQL migration 적용기. 적용된 파일의 내용 변경을 감지한다.
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

const PHASE_MIGRATIONS: Record<number, string[]> = {
  0: [],
  1: ["001_catalog_cart_actions.sql"],
  2: [],
  3: ["002_orders_payments_shipments.sql"],
  4: ["003_cancel_requests.sql"],
  5: [],
};

const phase = Number(
  process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "0",
);
const wanted = new Set(
  Object.entries(PHASE_MIGRATIONS)
    .filter(([p]) => Number(p) <= phase)
    .flatMap(([, files]) => files),
);

await sql.unsafe(
  "CREATE TABLE IF NOT EXISTS _migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())",
);

const dir = "db/migrations";
let files: string[] = [];
try {
  files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
} catch {
  files = [];
}

let applied = 0;
for (const f of files) {
  const body = readFileSync(dir + "/" + f, "utf8");
  const sha = createHash("sha256").update(body).digest("hex");
  const rows = await sql.unsafe("SELECT sha256 FROM _migrations WHERE name = $1", [f]);
  const row = rows[0];
  if (row) {
    if (row.sha256 !== sha) throw new Error("migration changed after apply: " + f);
    continue;
  }
  if (!wanted.has(f)) throw new Error("migration has no phase mapping: " + f);
  await sql.begin(async (q) => {
    await q.unsafe(body);
    await q.unsafe("INSERT INTO _migrations (name, sha256) VALUES ($1, $2)", [f, sha]);
  });
  applied++;
  console.log("applied " + f);
}
console.log("migrations ok (phase <= " + phase + ", applied " + applied + ")");
await sql.end();
