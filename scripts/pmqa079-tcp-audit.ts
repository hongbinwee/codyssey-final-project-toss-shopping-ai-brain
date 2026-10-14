// PMQA-079 — 신규 인증 TCP 읽기 전용 감사.
//
// 목적(사용자 승인 게이트):
//   - 127.0.0.1:5432 TCP로 새 credential(.secrets/pg-password 경유
//     DATABASE_URL 해석) 접속이 성공함을 입증
//   - 무작위 오암호는 PostgreSQL 인증 거부 SQLSTATE 28P01으로 거부됨을 입증
//     (missing-password는 선택 점검 — 실제 인증 거부 class만 명시 기록)
//   - 보호 DB 13테이블 지문·identity/OID/owner를 pinned preflight와 대조
//   - writer/query 열람 불가 세션 탐지
//
// 경계: docker exec psql 경로가 아니라 TCP 경로다. 어떤 mutation도 수행하지
// 않으며, credential·URL·비밀 값을 출력/저장하지 않는다. 결과 파일은
// reserveEvidenceRun으로 DB 접속 전 배타 예약('wx')하고 보유 핸들로만
// 기록한다 — 기존 파일 덮어쓰기 경로는 없다. verdict는 exit code로만 본다.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import "../src/config.ts";
import { databaseUrlForName } from "../src/db-url.ts";
import {
  snapDb,
  parseRoDbUrl,
  RO_DB,
  RO_DB_OID,
  RO_DEV_DB,
  RO_DEV_DB_OID,
  type DbSnap,
  type Q,
} from "../tests/e2e/readonly-db.ts";
import {
  loadPinnedPreflight,
  compareWithPreflight,
  PREFLIGHT_PATH,
  PREFLIGHT_SHA256,
  type PsqlSnapshot,
} from "./pmqa079-ro-snapshot.ts";
import { reserveEvidenceRun } from "../tests/helpers/capture-output.ts";

const RUN_ROOT = "shots/pmqa079-tcp-audit";
const RESULT_NAME = "result.json";

type IdRow = {
  role: string;
  owner: string;
  dro: string;
  tro: string;
};
type AuditDb = {
  db: string;
  oid: number;
  role: string;
  owner: string;
  defaultReadOnly: string;
  transactionReadOnly: string;
  writers: number[];
  unreadableActive: number[];
  writersErrorCategory: string | null;
  tables: Record<string, { n: number; h: string }>;
  match: boolean;
  reasons: string[];
};
type RejectProbe = {
  attempt: string;
  result: "REJECTED" | "ACCEPTED";
  errorClass: string | null;
  authClass: boolean;
};

// 인증 계열 SQLSTATE class 28 판정 — SQLSTATE는 5자리다(28P01).
// {2}로 쓰면 4자리만 매칭해 정상 거부를 인증 실패로 인정하지 못한다
// [Luna 정적검수]. 28P01=true, ECONNREFUSED=false.
export function isAuthClass(code: string): boolean {
  return /^28[0-9A-Z]{3}$/.test(code);
}

// writersError 원문은 드라이버 오류 문자열로 연결·인증 정보가 섞일 수
// 있어 결과 파일에는 고정 범주로만 기록한다 [PM/Luna — 비밀 출력 경로
// 차단]. 원문은 어떤 필드로도 나가지 않는다.
export function probeErrorCategory(raw: string): string {
  if (/\b28[0-9A-Z]{3}\b/.test(raw)) return "auth";
  if (/\b25[0-9A-Z]{3}\b/.test(raw)) return "transaction-state";
  if (/\b42[0-9A-Z]{3}\b/.test(raw)) return "schema-object";
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(raw))
    return "connection";
  return "other";
}

type PreflightDbEntry =
  ReturnType<typeof loadPinnedPreflight>["databases"][keyof ReturnType<
    typeof loadPinnedPreflight
  >["databases"]];

function toPsqlSnapshot(snap: DbSnap, id: IdRow): PsqlSnapshot {
  const tables: Record<string, { count: number; hash: string }> = {};
  for (const t of Object.keys(snap.tables))
    tables[t] = { count: snap.tables[t].n, hash: snap.tables[t].h };
  return {
    identity: { db: snap.db, oid: snap.oid, role: id.role, owner: id.owner },
    defaultReadOnly: id.dro,
    transactionReadOnly: id.tro,
    tables,
    writers: snap.writers,
    unreadableActive: snap.unreadableActive,
  };
}

async function auditDb(
  dbName: string,
  wantOid: number,
  baseUrl: string,
  baseline: PreflightDbEntry,
): Promise<AuditDb> {
  const url = parseRoDbUrl(databaseUrlForName(dbName, baseUrl), dbName);
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    const { snap, id } = await sql.begin(async (q) => {
      await q.unsafe(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const tq = {
        unsafe: ((query: string, params?: unknown[]) =>
          q.unsafe(query, params as never)) as unknown as Q["unsafe"],
      };
      const s = await snapDb(tq);
      const [i] = await q.unsafe<IdRow[]>(
        "SELECT current_user AS role, (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner, current_setting('default_transaction_read_only') AS dro, current_setting('transaction_read_only') AS tro",
      );
      return { snap: s, id: i };
    });
    const psqlSnap = toPsqlSnapshot(snap, id);
    const reasons = compareWithPreflight(psqlSnap, baseline);
    if (snap.oid !== wantOid)
      reasons.push("OID mismatch " + snap.oid + " != " + wantOid);
    const writersErrorCategory =
      snap.writersError === null ? null : probeErrorCategory(snap.writersError);
    if (writersErrorCategory !== null)
      reasons.push(
        "writer probe failed (category: " + writersErrorCategory + ")",
      );
    return {
      db: snap.db,
      oid: snap.oid,
      role: id.role,
      owner: id.owner,
      defaultReadOnly: id.dro,
      transactionReadOnly: id.tro,
      writers: snap.writers,
      unreadableActive: snap.unreadableActive,
      writersErrorCategory,
      tables: snap.tables,
      match: reasons.length === 0,
      reasons,
    };
  } finally {
    await sql.end();
  }
}

// 인증 거부 증명 — 연결 오류(ECONNREFUSED·timeout 등)는 인증 거부가 아니다.
// PostgreSQL 인증 실패만 SQLSTATE 28xxx로 분류하고 wrong-password는 정확히
// 28P01을 요구한다 [PM 정적검수].
async function rejectProbe(
  attempt: string,
  url: string,
): Promise<RejectProbe> {
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    await sql.unsafe("SELECT 1");
    return { attempt, result: "ACCEPTED", errorClass: null, authClass: false };
  } catch (e) {
    let code = "error";
    if (e && typeof e === "object" && "code" in e)
      code = String((e as { code: unknown }).code);
    else if (e instanceof Error && e.name) code = e.name;
    return {
      attempt,
      result: "REJECTED",
      errorClass: code,
      authClass: isAuthClass(code),
    };
  } finally {
    try {
      await sql.end();
    } catch {
      /* 종료 실패는 거부 판정을 덮지 않는다 */
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute") {
    console.error("tcp audit requires --execute");
    process.exitCode = 2;
    return;
  }

  // DB 접속 전 결과 파일을 새 run dir에 배타 예약('wx') — 기존 경로 덮어쓰기
  // 불가, 예약 실패 시 DB 접속 0으로 종료 [PM 정적검수].
  const writer = await reserveEvidenceRun(RUN_ROOT, [RESULT_NAME]);
  const runDir = writer.dir;

  let status = "FAIL";
  let failed: string | null = null;
  const databases: Record<string, AuditDb> = {};
  const auth: Record<string, string> = {};
  const rejects: RejectProbe[] = [];
  let credentialFromFile: boolean | null = null;

  try {
    const baseUrl = process.env.DATABASE_URL;
    if (!baseUrl) throw new Error("DATABASE_URL unavailable");

    // 새 인증이 실제 .secrets 파일 값을 반영했는지 boolean만 검증 — 값 자체는
    // 어떤 경로로도 출력/저장하지 않는다. URL에 다른 비밀이 박혀 있으면
    // databaseUrlWithPasswordFile이 config 단계에서 이미 fail-closed했다.
    const fileSecret = readFileSync(".secrets/pg-password", "utf8").replace(
      /\r?\n$/,
      "",
    );
    credentialFromFile =
      new URL(baseUrl).password === fileSecret && fileSecret.length > 0;

    const preflight = loadPinnedPreflight();

    for (const [db, oid] of [
      [RO_DEV_DB, RO_DEV_DB_OID],
      [RO_DB, RO_DB_OID],
    ] as const) {
      databases[db] = await auditDb(db, oid, baseUrl, preflight.databases[db]);
      auth[db] = "PASS";
      if (!databases[db].match) {
        failed = db;
        break;
      }
    }

    if (!failed) {
      const wrong = "wrong-" + randomBytes(16).toString("hex");
      rejects.push(
        await rejectProbe(
          "wrong-password",
          "postgres://commerce:" + wrong +
            "@127.0.0.1:5432/commerce?default_transaction_read_only=on",
        ),
      );
      rejects.push(
        await rejectProbe(
          "missing-password",
          "postgres://commerce@127.0.0.1:5432/commerce?default_transaction_read_only=on",
        ),
      );
      const wrongProbe = rejects.find((r) => r.attempt === "wrong-password");
      const missingProbe = rejects.find((r) => r.attempt === "missing-password");
      if (!wrongProbe || wrongProbe.errorClass !== "28P01")
        failed = "wrong-password not rejected with SQLSTATE 28P01";
      else if (!missingProbe || !missingProbe.authClass)
        failed = "missing-password was not an authentication-class rejection";
    }
  } catch (e) {
    failed = failed ?? (e instanceof Error ? e.name : "error");
  }

  status =
    failed === null &&
    credentialFromFile === true &&
    rejects.length === 2 &&
    Object.keys(databases).length === 2 &&
    Object.values(databases).every((d) => d.match)
      ? "PASS"
      : "FAIL";

  try {
    await writer.writeJson(RESULT_NAME, {
      status,
      at: new Date().toISOString(),
      tcpTarget: "127.0.0.1:5432",
      credentialFromFile,
      newAuthConnect: auth,
      rejection: rejects,
      databases,
      baselinePath: PREFLIGHT_PATH,
      baselineSha256: PREFLIGHT_SHA256,
      failedAt: failed,
      note: "TCP path audit with new credential; no docker exec, no mutation, no secret material in output. wrong-password requires SQLSTATE 28P01; missing-password records actual auth class. Table fingerprints compared to pinned preflight (13 tables n/h + identity/OID/owner).",
    });
  } finally {
    try {
      await writer.close();
    } catch {
      status = "FAIL";
      failed = failed ?? "evidence close failed";
    }
  }

  console.log(
    "tcp-audit " + status +
      " run=" + runDir +
      " newAuth=" + Object.keys(auth).join(",") +
      " rejects=" +
      rejects.map((r) => r.attempt + ":" + r.result + "(" + (r.errorClass ?? "-") + ")").join(","),
  );
  if (status !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
