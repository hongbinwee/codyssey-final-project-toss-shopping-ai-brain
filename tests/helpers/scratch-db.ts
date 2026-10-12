// scratch DB 안전 소유권 — PMQA-040 사고(고정 이름 FORCE DROP으로 보존 DB
// 소실) 재발 방지를 위한 생성/삭제 보호 계층.
//
// 규칙:
// - opt-in(SCRATCH_DB_TESTS=1) 없이는 scratch DB 생성/삭제를 실행하지 않는다.
//   opt-in 확인은 어떤 DB 접속보다도 먼저다(connect 전 게이트).
//   기본 npm test/verify 경로에서는 관련 테스트가 skip되어 실행 자체가 없다.
// - 생성 이름은 이 실행이 만드는 무작위 이름(scratch_<16hex>)뿐이다.
//   고정 이름 사용·재사용은 허용하지 않는다.
// - 보호 DB(commerce/commerce_test/commerce_demo_verify/postgres/template*)와
//   이미 존재하는 이름은 절대 CREATE/DROP 대상이 아니다 — 실패 폐쇄.
// - DROP은 이 실행이 CREATE에 성공하고, 아래 소유 증거가 전부 일치할 때만이다:
//     pg_database OID + datdba(소유 role)가 CREATE 직후 기록과 정확히 동일
//     AND scratch DB 안에서 실측한 current_database() === 대상 이름
//     AND _scratch_owner.run_id === 이 실행의 runId
//   하나라도 어긋나면 DROP을 실행하지 않는다 — identity 변경은 끝까지
//   fail closed다. CREATE 실패 뒤 finally에서 기존 DB를 지우는 경로는 없다.
// - ?database= 같은 URL 옵션 우회는 두 겹으로 막는다 — adminUrl에 query가
//   있으면 connect 전에 거부하고(조용히 버리는 혼동도 없다), 대상 URL 생성
//   시 query를 전부 버리며, 실제 접속 후 current_database()를 다시 확인한다.
// - runId는 외부 입력·env가 아니라 이 함수 안에서 randomUUID()로만 만든다 —
//   외부가 marker 값을 맞춰 소유권 검증을 우회할 수 없다.
// - cleanup 전에 대상 DB를 쓰던 연결(테스트의 sql 풀 등)을 먼저 end 할 것.
//   열린 연결이 남으면 DROP이 실패한다 — 실패해도 fail closed이며 다른 DB는
//   건드리지 않는다.
// - 생성 후 단계(identity 기록·마커 삽입)가 실패하면 그 scratch DB는 마커
//   없이 남는다. 이후 cleanup은 소유권 미확인으로 거부한다 — 지우지 못해
//   남는 것이 잘못 지우는 것보다 안전하다.
// - 각 mutation SQL(CREATE DATABASE·marker CREATE·marker INSERT·DROP) 직전에
//   await 없이 동기 재검증한다 [PMQA-052-C]. events/identity/marker/end 각
//   await 경계에서 opt-in·adminUrl이 소실돼도 다음 mutation은 차단된다.
//   호출자는 deps.guard로 '더 제한하는' 동기 검사를 추가할 수 있다 — 허용을
//   넓히는 권한은 없고, thenable을 반환하는 async hook은 즉시 거부된다.
//   검사 순서는 guard hook → 기본 gate → SQL이다 — hook이 opt-in을 지운 채
//   정상 반환해도 기본 gate가 SQL 직전에 차단한다 [052-C P1 보정].
import { randomUUID } from "node:crypto";
import postgres from "postgres";

export const SCRATCH_OPTIN_ENV = "SCRATCH_DB_TESTS";
export const PROTECTED_DBS = new Set([
  "commerce",
  "commerce_test",
  "commerce_demo_verify",
  "postgres",
  "template0",
  "template1",
]);

// 허용 이름 패턴 — 이 실행 소유인지 이름으로 1차 판별한다.
const NAME_RE = /^scratch_[0-9a-f]{16}$/;
// adminUrl은 명시 로컬 postgres admin 컨텍스트만 허용한다. 보호 DB에 붙는
// admin 경로 자체를 차단한다(대상 CREATE 이름 보호와는 별개의 게이트).
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const ADMIN_PORT = "5432";
const ADMIN_PATH = "/postgres";

// 단계별 소유 이벤트 — runner가 evidence에 wx 기록한다 [PMQA-052].
// 기록 자체가 실패하면 그 단계에서 throw한다: planned 실패 → CREATE 미실행,
// created/identified 실패 → 마커 없는 scratch retain(추정 cleanup 없음).
export type ScratchEvent =
  | { stage: "planned"; dbName: string; runId: string }
  | { stage: "created"; dbName: string }
  | { stage: "identified"; dbName: string; oid: number; owner: number };

/** pg_database에서 읽는 DB 신원 — 이름이 같아도 재생성되면 oid가 달라진다. */
export type DbIdentity = { oid: number; owner: number };
export type CreatePlan =
  | { ok: true; dbName: string }
  | { ok: false; reason: string };
export type DropPlan = { ok: true } | { ok: false; reason: string };

/** 접속 전 게이트 — opt-in과 adminUrl 형태. 부작용 없는 결정 함수. */
export function planScratchConnect(opts: {
  optin: string | undefined;
  adminUrl: string;
}): { ok: true } | { ok: false; reason: string } {
  if (opts.optin !== "1")
    return {
      ok: false,
      reason: "opt-in 없음: " + SCRATCH_OPTIN_ENV + "=1 필요",
    };
  if (opts.adminUrl.includes("?") || opts.adminUrl.includes("#"))
    return {
      ok: false,
      reason:
        "adminUrl query/fragment 금지 — ?database= 우회/조용한 무시 혼동 방지",
    };
  // 명시 admin 형태 — credential이 든 원문은 reason에 넣지 않는다.
  let u: URL;
  try {
    u = new URL(opts.adminUrl);
  } catch {
    return { ok: false, reason: "adminUrl 파싱 불가" };
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:")
    return { ok: false, reason: "adminUrl 프로토콜 불일치" };
  if (!LOCAL_HOSTS.has(u.hostname))
    return { ok: false, reason: "adminUrl 로컬 호스트 외 거부" };
  if (u.port !== ADMIN_PORT)
    return { ok: false, reason: "adminUrl 포트 불일치 — " + ADMIN_PORT + "만" };
  if (u.pathname !== ADMIN_PATH)
    return { ok: false, reason: "adminUrl 경로 불일치 — " + ADMIN_PATH + "만" };
  return { ok: true };
}

/** 생성 계획 — 부작용 없는 결정 함수. existing은 pg_database 실측 목록. */
export function planScratchCreate(opts: {
  rand?: () => string;
  existing: string[];
}): CreatePlan {
  const rand =
    opts.rand ?? (() => randomUUID().replaceAll("-", "").slice(0, 16));
  const dbName = ("scratch_" + rand()).toLowerCase();
  if (!NAME_RE.test(dbName))
    return { ok: false, reason: "허용되지 않는 scratch 이름: " + dbName };
  if (PROTECTED_DBS.has(dbName))
    return { ok: false, reason: "보호 DB 이름과 충돌: " + dbName };
  if (opts.existing.includes(dbName))
    return {
      ok: false,
      reason: "이미 존재하는 DB — 우연일치 fail closed: " + dbName,
    };
  return { ok: true, dbName };
}

/**
 * DROP 허용 판정 — 부작용 없는 결정 함수.
 * 소유 증거가 하나라도 어긋나면 거부한다. 어느 경로에서도 DROP은 이 판정을
 * 통과한 뒤에만 실행된다.
 */
export function planScratchDrop(opts: {
  dbName: string;
  identity: DbIdentity | null; // cleanup 시점 pg_database 실측(부재면 null)
  expected: DbIdentity; // 이 실행이 CREATE 직후 기록한 값
  currentDb: string | null; // scratch DB 안에서 실측한 current_database()
  marker: string | null; // _scratch_owner.run_id 실측(정확히 1행이 아니면 null)
  markerCount: number; // _scratch_owner 전체 행 수 — 정확히 1이어야 소유권 성립
  runId: string; // 이 실행이 CREATE 시 기록한 소유 표시
}): DropPlan {
  if (!NAME_RE.test(opts.dbName) || PROTECTED_DBS.has(opts.dbName))
    return { ok: false, reason: "보호/비허용 이름 DROP 거부: " + opts.dbName };
  if (opts.identity === null)
    return { ok: false, reason: "대상 DB 부재 — 삭제 불요/불가" };
  if (
    opts.identity.oid !== opts.expected.oid ||
    opts.identity.owner !== opts.expected.owner
  )
    return {
      ok: false,
      reason:
        "DB identity 변경 — 같은 이름의 다른 DB일 수 있음, DROP 거부 " +
        "(oid " +
        String(opts.identity.oid) +
        "!=" +
        String(opts.expected.oid) +
        " 또는 owner " +
        String(opts.identity.owner) +
        "!=" +
        String(opts.expected.owner) +
        ")",
    };
  if (opts.currentDb !== opts.dbName)
    return {
      ok: false,
      reason:
        "접속 DB 불일치: " + String(opts.currentDb) + " != " + opts.dbName,
    };
  // marker 행이 0개든 복수든 '정확히 1행'이 아니면 소유권이 성립하지 않는다
  // — LIMIT 1로 첫 행만 보면 복수 마커를 구분할 수 없다 [PMQA-052].
  if (opts.marker === null || opts.markerCount !== 1)
    return {
      ok: false,
      reason:
        "소유 마커 부재(행 수 " +
        String(opts.markerCount) +
        ") — 소유권 미확인, DROP 거부",
    };
  if (opts.marker !== opts.runId)
    return { ok: false, reason: "소유 마커 불일치 — 다른 실행 소유, DROP 거부" };
  return { ok: true };
}

export type ScratchDb = Readonly<{
  dbName: string;
  runId: string;
  dbUrl: string;
  // CREATE 직후 pg_database에서 실측한 원본 identity의 불변 사본.
  // 소비자는 이 snapshot을 EXPECT 출처로 쓴다 — 이후 probe 값을 EXPECT로
  // 채택하는 순환 검증을 금지한다 [PMQA-050-B]. cleanup closure의 기준
  // (expectedId)과는 별개 객체이며 수정해도 cleanup 동작에 영향이 없다.
  // 반환 핸들 자체도 freeze — createdIdentity 속성을 새 객체로 교체하는
  // 경로까지 차단한다 [MJ-B2 정정].
  createdIdentity: Readonly<DbIdentity>;
  cleanup: () => Promise<void>;
}>;

type SqlLike = {
  unsafe: (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;
  end: () => Promise<void>;
};
type Connect = (url: string, o?: { max?: number }) => SqlLike;

// adminUrl의 마지막 path 세그먼트만 치환해 대상 DB URL을 만든다.
// ?database= 등 query는 전부 버린다 — planScratchConnect가 query 있는
// adminUrl 자체를 거부하므로 여기서 버려지는 query는 없어야 정상이다.
export function scratchDbUrl(adminUrl: string, dbName: string): string {
  const u = adminUrl.split("?")[0];
  return u.replace(/\/[^/]+$/, "/" + dbName);
}

async function readIdentity(
  admin: SqlLike,
  dbName: string,
): Promise<DbIdentity | null> {
  const rows = await admin.unsafe(
    "SELECT oid, datdba AS owner FROM pg_database WHERE datname=$1",
    [dbName],
  );
  const r = rows[0];
  return r ? { oid: r.oid as number, owner: r.owner as number } : null;
}

// deps.connect는 단위 테스트 주입용 — 실제 경로는 postgres.
export async function createOwnedScratchDb(
  adminUrl: string,
  deps: {
    connect?: Connect;
    // 단계 이벤트 — runner evidence 기록용. await 된다: 기록 실패가 곧
    // 해당 단계의 실패다(planned 실패 → CREATE 미실행).
    events?: (e: ScratchEvent) => void | Promise<void>;
    // 호출자 제공 '추가' 동기 불변 검사 — 각 mutation SQL 직전에 await 없이
    // 호출된다. 더 제한하는 것만 가능하다(통과시키는 권한은 없다). async hook은
    // 검사 누락 경로이므로 thenable 반환을 런타임에 거부한다 [PMQA-052-C].
    // hook 종료 후 await 없이 기본 gate가 이어진다 — hook이 opt-in을 지워도
    // SQL dispatch 전에 차단된다 [052-C P1].
    guard?: () => void;
  } = {},
): Promise<ScratchDb> {
  const connect: Connect =
    deps.connect ?? ((url, o) => postgres(url, o) as unknown as SqlLike);
  // connect 전 게이트 — opt-in 없이는 어떤 DB 접속도 열지 않는다.
  const gate = planScratchConnect({
    optin: process.env[SCRATCH_OPTIN_ENV],
    adminUrl,
  });
  if (!gate.ok) throw new Error("scratch create 거부: " + gate.reason);
  // runId는 이 함수 안에서만 만든다 — 호출자·env 주입 경로가 없다.
  const runId = randomUUID();
  // mutation 직전 동기 게이트 — deps.guard(추가 제한 hook)를 먼저 실행하고,
  // hook 종료 후 await 없이 helper 자체의 global opt-in·adminUrl 기본 gate를
  // 재검증한다. 기본 gate → guard 순이면 guard가 지운 flag로 SQL이 dispatch
  // 되므로 guard → 기본 gate 순을 유지한다 [PMQA-052-C P1 보정].
  const writeGate = () => {
    if (deps.guard !== undefined) {
      const r = deps.guard() as unknown;
      if (
        r !== undefined &&
        r !== null &&
        (typeof r === "object" || typeof r === "function") &&
        typeof (r as { then?: unknown }).then === "function"
      )
        throw new Error("guard hook은 동기 계약 — thenable 반환 금지");
    }
    // guard hook 종료 직후 await 없는 기본 gate — hook이 opt-in·adminUrl을
    // 지웠어도 여기서 차단된다 [052-C P1].
    const g = planScratchConnect({
      optin: process.env[SCRATCH_OPTIN_ENV],
      adminUrl,
    });
    if (!g.ok) throw new Error("scratch write 거부: " + g.reason);
  };
  const admin = connect(adminUrl, { max: 1 });
  try {
    const dbs = (await admin.unsafe("SELECT datname FROM pg_database")).map(
      (r) => r.datname as string,
    );
    const plan = planScratchCreate({ existing: dbs });
    if (!plan.ok) throw new Error("scratch create 거부: " + plan.reason);
    // planned 기록이 완료된 뒤에만 CREATE — 기록 실패는 CREATE 전 실패다.
    await deps.events?.({ stage: "planned", dbName: plan.dbName, runId });
    writeGate(); // CREATE 직전 — planned 기록 await 경계의 flag 소실 재검증
    // CREATE 실패는 그대로 throw — 이후 cleanup은 등록되지 않는다.
    await admin.unsafe("CREATE DATABASE " + plan.dbName);
    await deps.events?.({ stage: "created", dbName: plan.dbName });
    // 생성 직후 identity(oid+owner)를 기록한다 — cleanup에서 '같은 이름의
    // 다른 DB'를 걸러내는 근거다.
    const expected = await readIdentity(admin, plan.dbName);
    if (!expected)
      throw new Error("생성 직후 identity 조회 실패: " + plan.dbName);
    await deps.events?.({
      stage: "identified",
      dbName: plan.dbName,
      oid: expected.oid,
      owner: expected.owner,
    });
    const dbUrl = scratchDbUrl(adminUrl, plan.dbName);
    const owned = connect(dbUrl, { max: 1 });
    try {
      // ?database= 등으로 다른 DB에 붙었는지 실제 접속명을 확인한다.
      const [cd] = await owned.unsafe("SELECT current_database() AS db");
      if (cd.db !== plan.dbName)
        throw new Error(
          "접속 DB 불일치: " + String(cd.db) + " != " + plan.dbName,
        );
      writeGate(); // marker CREATE 직전 — identified await 경계의 재검증
      await owned.unsafe(
        "CREATE TABLE _scratch_owner (run_id text PRIMARY KEY)",
      );
      writeGate(); // marker INSERT 직전 — CREATE await 경계의 재검증
      await owned.unsafe("INSERT INTO _scratch_owner (run_id) VALUES ($1)", [
        runId,
      ]);
    } finally {
      await owned.end().catch(() => {});
    }
    const dbName = plan.dbName;
    const expectedId = expected;
    return Object.freeze({
      dbName,
      runId,
      dbUrl,
      createdIdentity: Object.freeze({
        oid: expected.oid,
        owner: expected.owner,
      }),
      cleanup: async () => {
        // connect 전 게이트 — opt-in이 cleanup 시점에 사라졌어도 거부한다.
        const g = planScratchConnect({
          optin: process.env[SCRATCH_OPTIN_ENV],
          adminUrl,
        });
        if (!g.ok) throw new Error("scratch cleanup 거부: " + g.reason);
        const adm = connect(adminUrl, { max: 1 });
        try {
          const identity = await readIdentity(adm, dbName);
          let currentDb: string | null = null;
          let marker: string | null = null;
          let markerCount = 0;
          // identity가 기록과 정확히 같을 때만 scratch DB 안을 들여다본다 —
          // 같은 이름의 다른 DB에 접속하는 경로를 없앤다.
          if (
            identity !== null &&
            identity.oid === expectedId.oid &&
            identity.owner === expectedId.owner
          ) {
            const c = connect(dbUrl, { max: 1 });
            try {
              const [cd2] = await c.unsafe(
                "SELECT current_database() AS db",
              );
              currentDb = cd2.db as string;
              const [reg] = await c.unsafe(
                "SELECT to_regclass('public._scratch_owner') AS r",
              );
              if (reg.r) {
                // LIMIT 없이 전체 행 수를 본다 — 복수 마커는 소유권 실패다.
                const rows = await c.unsafe(
                  "SELECT run_id FROM _scratch_owner",
                );
                markerCount = rows.length;
                marker =
                  rows.length === 1
                    ? ((rows[0].run_id as string) ?? null)
                    : null;
              }
            } finally {
              await c.end().catch(() => {});
            }
          }
          const d = planScratchDrop({
            dbName,
            identity,
            expected: expectedId,
            currentDb,
            marker,
            markerCount,
            runId,
          });
          if (!d.ok) throw new Error("scratch drop 거부: " + d.reason);
          writeGate(); // DROP 직전 — identity·marker·end 각 await 경계의 재검증
          // IF EXISTS 금지 — 정확히 이 실행 소유로 검증된 이름만 DROP한다.
          await adm.unsafe("DROP DATABASE " + dbName);
        } finally {
          await adm.end().catch(() => {});
        }
      },
    });
  } finally {
    await admin.end().catch(() => {});
  }
}
