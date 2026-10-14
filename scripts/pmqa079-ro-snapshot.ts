import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  RO_TABLES,
  RO_WRITER_SQL,
  RO_UNREADABLE_SQL,
} from "../tests/e2e/readonly-db.ts";

export const PMQA079_DATABASES = ["commerce", "commerce_test"] as const;
export const PMQA079_RO_TABLES = RO_TABLES;
export const PREFLIGHT_PATH =
  "shots/pmqa079-network-review/run-83e56fe9-55ff-4a57-a239-87768c8556e2/preflight.json";
export const PREFLIGHT_SHA256 =
  "D9F7FB2D05A9C093ED54FAD4937727D22095FBB1ABADDF81CF930FC9A32A1551";
export const PMQA079_CONTAINER_ID =
  "6f8801d712351c30cbf5e509079ade7f9b3ce0665485530246eb2c0686eb166b";
export const PMQA079_IMAGE_ID =
  "sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
export const PMQA079_VOLUME_NAME = "codyssey_final_pgdata";
const PMQA079_VOLUME_TARGET = "/var/lib/postgresql/data";
const DOCKER_TARGET_OVERRIDE_KEYS = [
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION", "DOCKER_CONFIG", "COMPOSE_FILE",
  "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES",
  "COMPOSE_PATH_SEPARATOR",
] as const;

type DbName = (typeof PMQA079_DATABASES)[number];
type TableHash = { count: number; hash: string };
type Identity = { db: string; oid: number; role: string; owner: string };
export type PsqlSnapshot = {
  identity: Identity;
  defaultReadOnly: string;
  transactionReadOnly: string;
  tables: Record<string, TableHash>;
  writers: number[];
  unreadableActive: number[];
};
type PreflightDb = {
  identity: Identity & { pass: boolean };
  snapshot: {
    db: string;
    oid: number;
    tables: Record<string, { n: number; h: string }>;
    pass: boolean;
  };
  pass: boolean;
};
type Preflight = { databases: Record<DbName, PreflightDb> };
export type SnapshotExec = (
  db: DbName,
  input: string,
) => Promise<{ code: number | null; stdout: string }>;
export type DockerMetadataExec = (
  args: string[],
) => Promise<{ code: number | null; stdout: string }>;

const READONLY_BATCH = [
  "SET SESSION default_transaction_read_only=on;",
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
  "SELECT json_build_object('kind','identity','db',current_database(),'oid',(SELECT oid::int FROM pg_database WHERE datname=current_database()),'role',current_user,'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()))::text;",
  "SELECT json_build_object('kind','settings','defaultReadOnly',current_setting('default_transaction_read_only'),'transactionReadOnly',current_setting('transaction_read_only'))::text;",
  ...RO_TABLES.map(
    (table) =>
      "SELECT json_build_object('kind','table','name','" + table +
      "','count',count(*)::int,'hash',coalesce(md5(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text))), ''))::text FROM " +
      table +
      " x;",
  ),
  "SELECT json_build_object('kind','writers','pids',coalesce(json_agg(pid),'[]'::json))::text FROM (" +
    RO_WRITER_SQL +
    ") AS w;",
  "SELECT json_build_object('kind','unreadable','pids',coalesce(json_agg(pid),'[]'::json))::text FROM (" +
    RO_UNREADABLE_SQL +
    ") AS u;",
  "COMMIT;",
].join("\n");

export function buildReadOnlyPsqlInput(): string {
  return READONLY_BATCH;
}

export function buildPsqlArgs(context: string, db: DbName): string[] {
  if (!PMQA079_DATABASES.includes(db)) throw new Error("unapproved database");
  if (!/^[A-Za-z0-9_.-]+$/.test(context)) throw new Error("invalid Docker context");
  return [
    "--context", context, "exec", "-i", PMQA079_CONTAINER_ID, "psql",
    "-X", "-q", "-t", "-A", "-w", "-v", "ON_ERROR_STOP=1",
    "-U", "commerce", "-d", db,
  ];
}

function targetOverrideKeys(env: NodeJS.ProcessEnv): string[] {
  return DOCKER_TARGET_OVERRIDE_KEYS.filter((key) => Boolean(env[key]?.trim()));
}

export async function resolveDockerTarget(
  exec: DockerMetadataExec = runDockerCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ context: string }> {
  const overrides = targetOverrideKeys(env);
  if (overrides.length)
    throw new Error("Docker target override is not allowed: " + overrides.join(", "));

  const contextResult = await exec(["context", "show"]);
  const context = contextResult.stdout.trim();
  if (contextResult.code !== 0 || !/^[A-Za-z0-9_.-]+$/.test(context))
    throw new Error("active Docker context could not be confirmed");

  const format =
    "{{.Id}}|{{.Image}}|{{.State.Running}}|{{range .Mounts}}{{if eq .Destination \"" +
    PMQA079_VOLUME_TARGET +
    "\"}}{{.Type}}|{{.Name}}|{{.Destination}}{{end}}{{end}}";
  const inspect = await exec([
    "--context", context, "inspect", "--format", format, PMQA079_CONTAINER_ID,
  ]);
  const fields = inspect.stdout.trim().split("|");
  if (
    inspect.code !== 0 || fields.length !== 6 ||
    fields[0] !== PMQA079_CONTAINER_ID || fields[1] !== PMQA079_IMAGE_ID ||
    fields[2] !== "true" || fields[3] !== "volume" ||
    fields[4] !== PMQA079_VOLUME_NAME || fields[5] !== PMQA079_VOLUME_TARGET
  ) throw new Error("pinned Docker container metadata mismatch");
  return { context };
}

function parseSnapshot(stdout: string, expectedDb: DbName): PsqlSnapshot {
  const rows = stdout.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error("snapshot output is not valid JSON-lines");
    }
  });
  const takeOne = (kind: string) => {
    const matches = rows.filter((row) => row.kind === kind);
    if (matches.length !== 1) throw new Error("snapshot record missing or duplicated: " + kind);
    return matches[0];
  };
  const meta = takeOne("identity");
  const settings = takeOne("settings");
  const writersRow = takeOne("writers");
  const unreadableRow = takeOne("unreadable");
  const identity: Identity = {
    db: String(meta.db),
    oid: Number(meta.oid),
    role: String(meta.role),
    owner: String(meta.owner),
  };
  if (identity.db !== expectedDb || !Number.isSafeInteger(identity.oid) || !identity.role || !identity.owner)
    throw new Error("database identity mismatch or incomplete");

  const tables: Record<string, TableHash> = {};
  for (const row of rows.filter((item) => item.kind === "table")) {
    const name = String(row.name);
    if (!PMQA079_RO_TABLES.includes(name as (typeof PMQA079_RO_TABLES)[number]) || name in tables)
      throw new Error("unexpected or duplicate table record");
    const count = Number(row.count);
    const hash = String(row.hash);
    if (!Number.isSafeInteger(count) || count < 0 || (hash !== "" && !/^[a-f0-9]{32}$/.test(hash)))
      throw new Error("invalid table fingerprint");
    tables[name] = { count, hash };
  }
  if (Object.keys(tables).length !== PMQA079_RO_TABLES.length || rows.length !== 17)
    throw new Error("snapshot record count mismatch");

  const writers = writersRow.pids;
  const unreadableActive = unreadableRow.pids;
  if (!Array.isArray(writers) || !writers.every(Number.isSafeInteger) ||
      !Array.isArray(unreadableActive) || !unreadableActive.every(Number.isSafeInteger))
    throw new Error("invalid activity probe result");
  const snapshot: PsqlSnapshot = {
    identity,
    defaultReadOnly: String(settings.defaultReadOnly),
    transactionReadOnly: String(settings.transactionReadOnly),
    tables,
    writers,
    unreadableActive,
  };
  if (snapshot.defaultReadOnly !== "on" || snapshot.transactionReadOnly !== "on")
    throw new Error("read-only transaction/session setting is not on");
  if (writers.length !== 0 || unreadableActive.length !== 0)
    throw new Error("writer or unreadable active session detected");
  return snapshot;
}

export async function readDatabaseSnapshot(
  db: DbName,
  exec: SnapshotExec,
): Promise<PsqlSnapshot> {
  const result = await exec(db, READONLY_BATCH);
  if (result.code !== 0) throw new Error("snapshot command failed");
  return parseSnapshot(result.stdout, db);
}

export function compareWithPreflight(
  live: PsqlSnapshot,
  baseline: PreflightDb,
): string[] {
  const reasons: string[] = [];
  const identity = baseline.identity;
  const prior = baseline.snapshot;
  if (baseline.pass !== true || identity.pass !== true || prior.pass !== true)
    reasons.push("pinned preflight did not pass");
  for (const key of ["db", "oid", "role", "owner"] as const) {
    if (live.identity[key] !== identity[key]) reasons.push("identity " + key + " mismatch");
  }
  if (live.identity.db !== prior.db || live.identity.oid !== prior.oid)
    reasons.push("snapshot DB identity mismatch");
  const baselineTables = Object.keys(prior.tables).sort();
  const currentTables = Object.keys(live.tables).sort();
  if (JSON.stringify(baselineTables) !== JSON.stringify([...PMQA079_RO_TABLES].sort()))
    reasons.push("preflight table set mismatch");
  if (JSON.stringify(currentTables) !== JSON.stringify([...PMQA079_RO_TABLES].sort()))
    reasons.push("live table set mismatch");
  for (const table of PMQA079_RO_TABLES) {
    const want = prior.tables[table];
    const got = live.tables[table];
    if (!want || !got || got.count !== want.n || got.hash !== want.h)
      reasons.push("table count/hash mismatch: " + table);
  }
  if (live.writers.length !== 0) reasons.push("writer session detected");
  if (live.unreadableActive.length !== 0) reasons.push("unreadable active session detected");
  if (live.defaultReadOnly !== "on" || live.transactionReadOnly !== "on")
    reasons.push("read-only setting mismatch");
  return reasons;
}

export function loadPinnedPreflight(): Preflight {
  const bytes = readFileSync(PREFLIGHT_PATH);
  const sha = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (sha !== PREFLIGHT_SHA256) throw new Error("pinned preflight SHA mismatch");
  return JSON.parse(bytes.toString("utf8")) as Preflight;
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ComSpec"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function runDockerCommand(
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("docker", args, {
        env: dockerEnv(),
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      reject(new Error("snapshot command could not start"));
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("snapshot command timed out"));
    }, 30_000);
    child.once("error", () => finish(new Error("snapshot command failed to start")));
    child.once("close", (code) => finish(undefined, code));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 128_000) {
        child.kill();
        finish(new Error("snapshot output exceeded limit"));
      }
    });
    child.stdin?.once("error", () => finish(new Error("snapshot input failed")));
    child.stdin?.end(input);
  });
}

function runPsql(context: string, db: DbName, input: string) {
  return runDockerCommand(buildPsqlArgs(context, db), input);
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute") {
    console.error("read-only snapshot requires explicit --execute");
    process.exitCode = 2;
    return;
  }
  try {
    const preflight = loadPinnedPreflight();
    const target = await resolveDockerTarget();
    const results: { db: DbName; identity: Identity; tables: Record<string, TableHash>; writers: number[]; unreadableActive: number[]; match: boolean; reasons: string[] }[] = [];
    for (const db of PMQA079_DATABASES) {
      const snapshot = await readDatabaseSnapshot(
        db,
        (targetDb, input) => runPsql(target.context, targetDb, input),
      );
      const reasons = compareWithPreflight(snapshot, preflight.databases[db]);
      results.push({ db, identity: snapshot.identity, tables: snapshot.tables, writers: snapshot.writers, unreadableActive: snapshot.unreadableActive, match: reasons.length === 0, reasons });
      if (reasons.length) break;
    }
    const pass = results.length === PMQA079_DATABASES.length && results.every((item) => item.match);
    console.log(JSON.stringify({
      status: pass ? "PASS" : "FAIL",
      baselinePath: PREFLIGHT_PATH,
      baselineSha256: PREFLIGHT_SHA256,
      results,
      note: "Existing 77-row/36-action checks are historical transition evidence only; this run compares 13 table count/hash snapshots and does not re-read those row sets.",
    }));
    if (!pass) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      status: "FAIL",
      baselinePath: PREFLIGHT_PATH,
      baselineSha256: PREFLIGHT_SHA256,
      error: error instanceof Error ? error.message : "snapshot failed",
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
