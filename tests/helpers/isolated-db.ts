// 격리 테스트 DB의 소유권 계약 전달·검증 기반 [PMQA-050-B].
//
// 이 모듈은 config/devdb/.env 등 환경 파일을 읽지 않고, 모듈 top-level에서
// connect/spawn도 하지 않는다. 제공하는 것은 순수 계약 파싱·핸들→계약/env
// 생성·호출자가 넘긴 exec에서의 read-only 실측 검증뿐이다 — 실제 launcher·
// 트랜잭션·seed 오케스트레이션은 이번 범위가 아니다.
//
// 계약(5필드 전체가 있어야 유효):
//   ISOLATED_DB_URL    postgres://…@localhost:PORT/scratch_<16hex>
//                     (query·fragment 금지, path 마지막 세그먼트=NAME)
//   ISOLATED_DB_NAME   scratch_[0-9a-f]{16}
//   ISOLATED_DB_OID    생성 핸들이 CREATE 직후 기록한 pg_database.oid
//   ISOLATED_DB_OWNER  같은 시점의 pg_database.datdba(소유 role oid)
//   ISOLATED_RUN_ID    _scratch_owner.run_id와 같은 UUID
//
// env는 '전달 수단'일 뿐 증거가 아니다 — 실제 증거는 소비자가 같은 연결에서
// 실측한 name/OID/owner/marker다. 계약이 부분이거나 strict·opt-in이
// 소실되면 default deny다.

export const ISOLATED_STRICT_ENV = "ISOLATED_STRICT";
export const ISOLATED_ENV_KEYS = [
  "ISOLATED_DB_URL",
  "ISOLATED_DB_NAME",
  "ISOLATED_DB_OID",
  "ISOLATED_DB_OWNER",
  "ISOLATED_RUN_ID",
] as const;

export type IsolatedContract = {
  dbUrl: string;
  dbName: string;
  dbOid: number;
  dbOwner: number;
  runId: string;
};

export type Plan =
  | { ok: true; contract: IsolatedContract }
  | { ok: false; reason: string };

// scratch-db.ts의 NAME_RE와 동일한 형식 — 소유권 생성 경로만이 만들 수 있는
// 이름 패턴이다(보호 DB 이름은 이 패턴에 걸리지 않는다).
const SCRATCH_NAME_RE = /^scratch_[0-9a-f]{16}$/;
// UUID는 정확한 8-4-4-4-12 그룹 구조까지 검증한다 — {36} 패턴은
// 하이픈 36개 같은 문자열도 통과시키므로 부족하다.
const RUN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const OPTIN_ENV = "SCRATCH_DB_TESTS";

// 계약·오류 메시지에는 credential이 든 URL을 출력하지 않는다 — 호스트·경로
// 형태만 최소 표기한다.
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * 계약 형식 공통 검증 — parse·verify·fromScratch·childEnv가 전부 이 함수를
 * 재사용해, parse를 우회한 caller가 잘못된 계약을 들고 와도 어떤 DB 조회보다
 * 먼저 거부된다. 보호/비로컬/비허용 형식이면 조회 0건으로 거부다.
 */
function validateContractShape(c: IsolatedContract): { ok: true } | { ok: false; reason: string } {
  if (!SCRATCH_NAME_RE.test(c.dbName))
    return { ok: false, reason: "허용되지 않는 DB 이름: " + String(c.dbName) };
  if (!Number.isSafeInteger(c.dbOid) || c.dbOid <= 0)
    return { ok: false, reason: "DB OID 형식 오류" };
  if (!Number.isSafeInteger(c.dbOwner) || c.dbOwner <= 0)
    return { ok: false, reason: "DB owner 형식 오류" };
  if (!RUN_ID_RE.test(c.runId))
    return { ok: false, reason: "RUN_ID 형식 오류" };
  const dbUrl = c.dbUrl;
  if (typeof dbUrl !== "string" || dbUrl.includes("?") || dbUrl.includes("#"))
    return { ok: false, reason: "DB URL query/fragment 금지" };
  let u: URL;
  try {
    u = new URL(dbUrl);
  } catch {
    return { ok: false, reason: "DB URL 파싱 불가" };
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
    return { ok: false, reason: "DB URL 프로토콜 불일치" };
  if (!LOCAL_HOSTS.has(u.hostname))
    return { ok: false, reason: "로컬 호스트 외 DB 거부: " + u.hostname };
  if (u.pathname !== "/" + c.dbName)
    return { ok: false, reason: "DB URL 경로 불일치" };
  return { ok: true };
}

/** 생성 핸들 → 계약. EXPECT 출처는 핸들의 CREATE-시 snapshot뿐이다. */
export function contractFromScratch(h: {
  dbName: string;
  runId: string;
  dbUrl: string;
  createdIdentity: { oid: number; owner: number };
}): IsolatedContract {
  const c = {
    dbUrl: h.dbUrl,
    dbName: h.dbName,
    dbOid: h.createdIdentity.oid,
    dbOwner: h.createdIdentity.owner,
    runId: h.runId,
  };
  // 잘못된 소스(보호 이름·비로컬·형식 위반)로 만든 계약은 생성 자체를 거부한다.
  const v = validateContractShape(c);
  if (!v.ok) throw new Error("isolated 계약 생성 거부: " + v.reason);
  return c;
}

/** 계약 필드 형식 검증 — 부분 계약·형식 위반·보호/비로컬 대상은 거부. */
export function parseIsolatedContract(
  env: Record<string, string | undefined>,
): Plan {
  const present = ISOLATED_ENV_KEYS.filter((k) => env[k] !== undefined);
  if (present.length === 0)
    return { ok: false, reason: "isolated 계약 없음(부재)" };
  if (present.length !== ISOLATED_ENV_KEYS.length) {
    const missing = ISOLATED_ENV_KEYS.filter((k) => env[k] === undefined);
    return { ok: false, reason: "isolated 계약 부분 누락: " + missing.join(",") };
  }
  const dbOid = Number(env.ISOLATED_DB_OID);
  const dbOwner = Number(env.ISOLATED_DB_OWNER);
  if (!Number.isSafeInteger(dbOid))
    return { ok: false, reason: "ISOLATED_DB_OID 형식 오류" };
  if (!Number.isSafeInteger(dbOwner))
    return { ok: false, reason: "ISOLATED_DB_OWNER 형식 오류" };
  const contract = {
    dbUrl: env.ISOLATED_DB_URL!,
    dbName: env.ISOLATED_DB_NAME!,
    dbOid,
    dbOwner,
    runId: env.ISOLATED_RUN_ID!,
  };
  const v = validateContractShape(contract);
  if (!v.ok) return v;
  return { ok: true, contract };
}

/**
 * 연결 결정 — 계약 파싱 + strict + opt-in 게이트를 한 번에 판정한다.
 * 어느 하나라도 소실되면 default deny다.
 */
export function planIsolatedConnect(
  env: Record<string, string | undefined>,
): Plan {
  if (env[OPTIN_ENV] !== "1")
    return { ok: false, reason: "opt-in 없음: " + OPTIN_ENV + "=1 필요" };
  if (env[ISOLATED_STRICT_ENV] !== "1")
    return { ok: false, reason: "strict 없음: " + ISOLATED_STRICT_ENV + "=1 필요" };
  return parseIsolatedContract(env);
}

// 자식에게 전달을 허용하는 키 — 이 목록 외의 값(NODE_OPTIONS·NODE_PATH 등
// 임의 실행 제어 포함)은 절대 통과시키지 않는다.
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "TEST_USER_CODES",
  "LLM_PROVIDER",
  "CI",
] as const;

/**
 * 자식 env 생성 — raw source env를 인가 입력으로 받아, 전체 계약+strict+
 * opt-in이 source에 실제로 존재할 때만 자식 env를 구성한다.
 * - source에 DATABASE_URL이 있고 계약과 다르면 거부한다(조용한 덮어쓰기 금지).
 * - 허용 목록 외 임의 키는 전달되지 않는다 — 권한을 '복원'하는 기능은 없다.
 */
export function buildIsolatedChildEnv(
  source: Record<string, string | undefined>,
): { ok: true; env: Record<string, string> } | { ok: false; reason: string } {
  const p = planIsolatedConnect(source);
  if (!p.ok) return p;
  const c = p.contract;
  const srcDb = source.DATABASE_URL;
  if (srcDb !== undefined && srcDb !== c.dbUrl)
    return { ok: false, reason: "source DATABASE_URL이 계약과 다름 — 덮어쓰기 거부" };
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  env.DATABASE_URL = c.dbUrl;
  env.ISOLATED_DB_URL = c.dbUrl;
  env.ISOLATED_DB_NAME = c.dbName;
  env.ISOLATED_DB_OID = String(c.dbOid);
  env.ISOLATED_DB_OWNER = String(c.dbOwner);
  env.ISOLATED_RUN_ID = c.runId;
  env[ISOLATED_STRICT_ENV] = "1";
  env[OPTIN_ENV] = "1";
  return { ok: true, env };
}

type Exec = {
  unsafe: <T = Record<string, unknown>[]>(
    q: string,
    p?: unknown[],
  ) => Promise<T>;
};

/**
 * 같은 exec에서 소유권 실측 — read-only 측정 query만 실행한다.
 * name·OID·owner·정확히 1행의 marker가 계약과 전부 일치해야 통과다.
 */
export async function verifyOwnedExec(
  exec: Exec,
  contract: IsolatedContract,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // 1) 어떤 DB 조회보다 먼저 계약 형식을 검증한다 — parse를 우회한 caller의
  //    보호/비로컬/부분 계약은 여기서 조회 0건으로 거부다 [MJ-B1].
  const shape = validateContractShape(contract);
  if (!shape.ok) return { ok: false, reason: "계약 형식 거부: " + shape.reason };
  // 2) 판단 기준은 진입 시점의 불변 사본 — async 대기 중 caller가 contract를
  //    변조해도 이 snapshot으로 판단한다.
  const snap: IsolatedContract = {
    dbUrl: contract.dbUrl,
    dbName: contract.dbName,
    dbOid: contract.dbOid,
    dbOwner: contract.dbOwner,
    runId: contract.runId,
  };
  let rows: Record<string, unknown>[];
  try {
    rows = await exec.unsafe(
    "SELECT current_database() AS d, " +
      "(SELECT oid::int FROM pg_database WHERE datname=current_database()) AS oid, " +
      "(SELECT datdba::int FROM pg_database WHERE datname=current_database()) AS owner",
    );
  } catch {
    // 원문 오류에는 접속 문자열·credential이 섞일 수 있다 — sanitized 응답만.
    return { ok: false, reason: "소유권 실측 조회 실패" };
  }
  if (rows.length !== 1)
    return { ok: false, reason: "identity 행 수 != 1: " + rows.length };
  const r = rows[0] as { d?: string; oid?: number; owner?: number } | undefined;
  if (!r || r.d !== snap.dbName)
    return {
      ok: false,
      reason: "접속 DB 불일치: " + String(r?.d) + " != " + snap.dbName,
    };
  if (r.oid !== snap.dbOid)
    return {
      ok: false,
      reason: "DB OID 불일치: " + String(r.oid) + " != " + snap.dbOid,
    };
  if (r.owner !== snap.dbOwner)
    return {
      ok: false,
      reason: "DB owner 불일치: " + String(r.owner) + " != " + snap.dbOwner,
    };
  let marker: unknown[];
  try {
    marker = await exec.unsafe("SELECT run_id FROM _scratch_owner");
  } catch {
    return { ok: false, reason: "소유 마커 조회 실패(테이블 부재/접근 불가)" };
  }
  if (marker.length !== 1)
    return {
      ok: false,
      reason: "소유 마커 행 수 != 1: " + marker.length,
    };
  const runId = (marker[0] as { run_id?: unknown }).run_id;
  if (runId !== snap.runId)
    return { ok: false, reason: "소유 마커 불일치 — 다른 실행 소유" };
  return { ok: true };
}
