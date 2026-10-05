// Phase별 seed 로더. Phase 0은 seed가 없다. Phase 1에서 catalog/reviews/users JSON 로더 추가.
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

const phase = Number(
  process.argv.find((a) => a.startsWith("--phase="))?.split("=")[1] ?? "0",
);

const SEEDS: Record<number, string[]> = {
  0: [],
  // 1: ["users.json", "catalog.json", "reviews.json"],
};

const files = Object.entries(SEEDS)
  .filter(([p]) => Number(p) <= phase)
  .flatMap(([, f]) => f);

await sql.unsafe("select 1");
if (files.length === 0) {
  console.log("no seeds defined for phase <= " + phase);
  await sql.end();
  process.exit(0);
}
await sql.end();
throw new Error("seed loader not implemented for: " + files.join(", "));
