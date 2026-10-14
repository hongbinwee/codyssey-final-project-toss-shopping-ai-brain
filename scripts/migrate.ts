// Phase별 SQL migration 적용기. 적용된 파일의 내용 변경을 감지한다.
import { connectDb, sql } from "../src/db.ts";
import { ensureDevDb } from "../src/devdb.ts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  parsePhaseArg, planMigrations,
} from "./migrations-manifest.ts";

// phase 인자는 DB 접속(ensureDevDb/connect/advisory lock)보다 먼저 검증한다 —
// invalid phase는 어떤 연결도 열기 전에 실패해야 한다 [PMQA-070 독립 검수].
const rawPhase = process.argv
  .find((a) => a.startsWith("--phase="))
  ?.split("=")[1];
const phase = parsePhaseArg(rawPhase);
if (phase === null) {
  console.error("--phase는 유효 정수 범위여야 합니다 (got: " + rawPhase + ")");
  process.exit(1);
}

await ensureDevDb();
connectDb(process.env.DATABASE_URL!);

// 동시 실행(병렬 테스트 파일) 시 커밋 전 CREATE TABLE 경합을 막는다.
await sql.unsafe("SELECT pg_advisory_lock(727272)");

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
// 적용 기록을 먼저 읽어 계획을 세운다 — 미적용+등록 상위 phase 파일은
// skip하고, 미등록 파일만 fail closed로 거부한다(기존: 전부 거부 — 신규
// opt-in 파일이 있으면 기존 setup 명령이 깨지는 문제를 해소) [PMQA-070].
const reg = await sql.unsafe<{ name: string; sha256: string }[]>(
  "SELECT name, sha256 FROM _migrations",
);
const appliedMap = new Map(reg.map((r) => [r.name, r.sha256]));
const plan = planMigrations(files, new Set(appliedMap.keys()), phase);
if (plan.unknown.length)
  throw new Error("migration has no phase mapping: " + plan.unknown.join(", "));
for (const f of files) {
  const row = appliedMap.get(f);
  if (!row) continue;
  const sha = createHash("sha256")
    .update(readFileSync(dir + "/" + f, "utf8"))
    .digest("hex");
  if (row !== sha) throw new Error("migration changed after apply: " + f);
}
if (plan.skip.length)
  console.log("skipped higher-phase migrations: " + plan.skip.join(", "));
for (const f of plan.apply) {
  const body = readFileSync(dir + "/" + f, "utf8");
  const sha = createHash("sha256").update(body).digest("hex");
  await sql.begin(async (q) => {
    await q.unsafe(body);
    await q.unsafe("INSERT INTO _migrations (name, sha256) VALUES ($1, $2)", [f, sha]);
  });
  applied++;
  console.log("applied " + f);
}
console.log("migrations ok (phase <= " + phase + ", applied " + applied + ")");
await sql.end();
