// tests/helpers/scratch-db.ts의 DB-free 단위 검증.
// 실제 PostgreSQL 없이 deps.connect를 가짜로 주입해, 모든 거부 경로에서
// DROP DATABASE가 0회 실행되는 것을 증명한다(PMQA-040 회귀 방지).
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createOwnedScratchDb,
  planScratchConnect,
  planScratchCreate,
  planScratchDrop,
  scratchDbUrl,
  SCRATCH_OPTIN_ENV,
} from "../helpers/scratch-db.ts";

const ADMIN = "postgres://commerce:commerce@localhost:5432/postgres";
const PG18_ADMIN = "postgres://commerce:commerce@localhost:5433/postgres";
const PG18_SYSTEM_ID = "7696770435959939111";

type Row = Record<string, unknown>;
type Handler = (q: string, p: unknown[] | undefined, url: string) => Row[];

// 가짜 postgres — 실행한 SQL을 전부 기록하고 handler 응답을 돌려준다.
function fake(handler: Handler) {
  const queries: { url: string; q: string }[] = [];
  const connect = (url: string) => ({
    unsafe: async (q: string, p?: unknown[]) => {
      queries.push({ url, q });
      return handler(q, p, url);
    },
    end: async () => {},
  });
  return { connect, queries };
}

// opts.markerList가 있으면 _scratch_owner 조회가 그 행 목록을 그대로 돌려준다
// — 복수/0행 마커 상황을 만든다 [PMQA-052].

const dropQueries = (queries: { q: string }[]) =>
  queries.filter((x) => x.q.startsWith("DROP DATABASE"));

// 정상 경로 responder. identityAtCleanup·currentDbAtCleanup을 주면
// cleanup 시점의 pg_database/current_database 응답을 바꿔 '같은 이름의
// 다른 DB' 상황을 재현한다.
function okHandler(
  opts: {
    existing?: string[];
    identity?: { oid: number; owner: number } | null;
    identityAtCleanup?: { oid: number; owner: number } | null;
    currentDb?: string;
    currentDbAtCleanup?: string;
    marker?: string | null | "captured";
    markerList?: { run_id: string }[];
    failOn?: string;
    systemIdentifier?: string;
    systemIdentifierAtCleanup?: string;
  } = {},
) {
  let capturedRunId: string | null = null;
  let identityCalls = 0;
  let currentDbCalls = 0;
  let systemIdentifierCalls = 0;
  const firstIdentity =
    opts.identity === undefined ? { oid: 70001, owner: 10 } : opts.identity;
  return (q: string, p: unknown[] | undefined, url: string): Row[] => {
    if (opts.failOn && q.startsWith(opts.failOn))
      throw new Error("주입 실패: " + opts.failOn);
    if (q.startsWith("SELECT system_identifier::text")) {
      systemIdentifierCalls++;
      return [{
        system_identifier:
          systemIdentifierCalls < 3
            ? (opts.systemIdentifier ?? PG18_SYSTEM_ID)
            : (opts.systemIdentifierAtCleanup ?? opts.systemIdentifier ?? PG18_SYSTEM_ID),
      }];
    }
    if (q.startsWith("SELECT datname FROM pg_database"))
      return (opts.existing ?? ["commerce", "commerce_test", "postgres"]).map(
        (d) => ({ datname: d }),
      );
    if (q.startsWith("SELECT oid, datdba")) {
      identityCalls++;
      const id =
        identityCalls === 1
          ? firstIdentity
          : opts.identityAtCleanup !== undefined
            ? opts.identityAtCleanup
            : firstIdentity;
      return id ? [{ oid: id.oid, owner: id.owner }] : [];
    }
    if (q.startsWith("SELECT current_database()")) {
      currentDbCalls++;
      const db =
        currentDbCalls === 1
          ? (opts.currentDb ?? url.replace(/^.*\//, ""))
          : (opts.currentDbAtCleanup ??
            opts.currentDb ??
            url.replace(/^.*\//, ""));
      return [{ db }];
    }
    if (q.includes("to_regclass"))
      return [{ r: opts.marker === null ? null : "_scratch_owner" }];
    if (q.includes("INSERT INTO _scratch_owner")) {
      capturedRunId = (p?.[0] as string) ?? null;
      return [];
    }
    if (q.includes("SELECT run_id FROM _scratch_owner")) {
      if (opts.markerList !== undefined) return opts.markerList;
      if (opts.marker === null) return [];
      if (opts.marker === undefined || opts.marker === "captured")
        return [{ run_id: capturedRunId }];
      return [{ run_id: opts.marker }];
    }
    if (
      q.startsWith("CREATE DATABASE") ||
      q.startsWith("CREATE TABLE") ||
      q.startsWith("DROP DATABASE")
    )
      return [];
    throw new Error("fake가 모르는 SQL: " + q);
  };
}

describe("scratch-db 결정 함수", () => {
  test("planScratchConnect: opt-in 없으면 거부", () => {
    assert.equal(planScratchConnect({ optin: undefined, adminUrl: ADMIN }).ok, false);
    assert.equal(planScratchConnect({ optin: "0", adminUrl: ADMIN }).ok, false);
    assert.equal(planScratchConnect({ optin: "1", adminUrl: ADMIN }).ok, true);
  });

  test("planScratchConnect: PG18은 5433만 허용하고 기본 PG17은 5432를 유지", () => {
    assert.equal(
      planScratchConnect({ optin: "1", adminUrl: PG18_ADMIN, target: "pg18" }).ok,
      true,
    );
    assert.equal(
      planScratchConnect({ optin: "1", adminUrl: ADMIN, target: "pg18" }).ok,
      false,
    );
    assert.equal(
      planScratchConnect({ optin: "1", adminUrl: PG18_ADMIN }).ok,
      false,
    );
  });

  test("planScratchConnect: adminUrl에 query(?database= 등)가 있으면 거부 — reason에 credential 원문 없음", () => {
    const r = planScratchConnect({
      optin: "1",
      adminUrl: ADMIN + "?database=commerce_test",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason.includes("commerce:commerce"), false);
      assert.equal(r.reason.includes("database=commerce_test"), false);
    }
  });

  test("planScratchConnect: admin shape — 비로컬·비postgres·포트·경로·fragment 거부, reason에 URL 원문 0", () => {
    const bad = [
      "postgres://commerce:secret@example.com:5432/postgres",
      "postgres://commerce:secret@localhost:5433/postgres",
      "postgres://commerce:secret@localhost:5432/commerce",
      "postgres://commerce:secret@localhost:5432/",
      "postgres://commerce:secret@localhost:5432/postgres#frag",
      "http://localhost:5432/postgres",
      "not-a-url",
    ];
    for (const u of bad) {
      const r = planScratchConnect({ optin: "1", adminUrl: u });
      assert.equal(r.ok, false, u);
      if (!r.ok) {
        assert.equal(r.reason.includes("commerce:secret"), false);
        assert.equal(r.reason.includes(u), false);
      }
    }
    // 정상 호출 계약은 유지된다 — 명시 로컬 admin URL은 통과.
    assert.equal(planScratchConnect({ optin: "1", adminUrl: ADMIN }).ok, true);
  });

  test("planScratchCreate: 이미 존재하는 이름은 거부", () => {
    const p = planScratchCreate({
      rand: () => "0000000000000001",
      existing: ["scratch_0000000000000001"],
    });
    assert.equal(p.ok, false);
  });

  test("planScratchCreate: 이름 패턴을 벗어나면 거부", () => {
    const p = planScratchCreate({ rand: () => "ZZZZ", existing: [] });
    assert.equal(p.ok, false);
    const ok = planScratchCreate({ rand: () => "abcdef0123456789", existing: [] });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.dbName, "scratch_abcdef0123456789");
  });

  test("planScratchDrop: 보호 이름·비허용 이름은 즉시 거부", () => {
    const base = {
      identity: { oid: 1, owner: 1 },
      expected: { oid: 1, owner: 1 },
      currentDb: "x",
      marker: "x",
      markerCount: 1,
      runId: "x",
    };
    assert.equal(planScratchDrop({ ...base, dbName: "commerce", currentDb: "commerce" }).ok, false);
    assert.equal(planScratchDrop({ ...base, dbName: "commerce_demo_verify", currentDb: "commerce_demo_verify" }).ok, false);
    assert.equal(planScratchDrop({ ...base, dbName: "anything", currentDb: "anything" }).ok, false);
  });

  test("planScratchDrop: 소유 증거가 하나라도 어긋나면 거부", () => {
    const base = {
      dbName: "scratch_0000000000000001",
      expected: { oid: 100, owner: 10 },
      currentDb: "scratch_0000000000000001",
      marker: "run-1",
      markerCount: 1,
      runId: "run-1",
    };
    // 전부 일치 → 허용
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 } }).ok, true);
    // DB 부재
    assert.equal(planScratchDrop({ ...base, identity: null }).ok, false);
    // oid 불일치(같은 이름으로 재생성된 다른 DB)
    assert.equal(planScratchDrop({ ...base, identity: { oid: 999, owner: 10 } }).ok, false);
    // owner 불일치
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 99 } }).ok, false);
    // 접속 DB 불일치
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 }, currentDb: "commerce" }).ok, false);
    // 마커 부재·불일치(외부가 runId를 모르면 우회 불가)
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 }, marker: null, markerCount: 0 }).ok, false);
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 }, marker: "attacker-guess" }).ok, false);
    // marker 행 수 != 1 — 복수 마커는 첫 행과 무관하게 소유권 실패다
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 }, marker: null, markerCount: 2 }).ok, false);
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 }, markerCount: 2 }).ok, false);
  });
});

describe("createOwnedScratchDb — DB-free mock 검증", () => {
  const saved = process.env[SCRATCH_OPTIN_ENV];
  beforeEach(() => {
    process.env[SCRATCH_OPTIN_ENV] = "1";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[SCRATCH_OPTIN_ENV];
    else process.env[SCRATCH_OPTIN_ENV] = saved;
  });

  test("opt-in 없으면 connect 자체를 하지 않는다 — SQL 0회", async () => {
    delete process.env[SCRATCH_OPTIN_ENV];
    const { connect, queries } = fake(okHandler());
    await assert.rejects(() => createOwnedScratchDb(ADMIN, { connect }), /opt-in/);
    assert.equal(queries.length, 0);
  });

  test("adminUrl query는 connect 전 거부 — SQL 0회", async () => {
    const { connect, queries } = fake(okHandler());
    await assert.rejects(
      () => createOwnedScratchDb(ADMIN + "?database=commerce_test", { connect }),
      /query/,
    );
    assert.equal(queries.length, 0);
  });

  test("CREATE DATABASE 실패 — throw만, cleanup 자체가 없고 DROP 0회", async () => {
    const { connect, queries } = fake(okHandler({ failOn: "CREATE DATABASE" }));
    await assert.rejects(() => createOwnedScratchDb(ADMIN, { connect }), /주입 실패/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("생성 후 접속 DB 불일치 — 거부, DROP 0회", async () => {
    const { connect, queries } = fake(okHandler({ currentDb: "commerce_test" }));
    await assert.rejects(() => createOwnedScratchDb(ADMIN, { connect }), /불일치/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("PG18 cluster identity가 다르면 DB 목록 조회와 CREATE 전에 중단", async () => {
    const { connect, queries } = fake(okHandler({ systemIdentifier: "wrong" }));
    await assert.rejects(
      () => createOwnedScratchDb(PG18_ADMIN, { target: "pg18", connect }),
      /cluster identity/,
    );
    assert.equal(queries.some((x) => x.q.startsWith("SELECT datname FROM pg_database")), false);
    assert.equal(queries.some((x) => x.q.startsWith("CREATE DATABASE")), false);
  });

  test("PG18 경로는 5433에서만 생성·접속하고 같은 cluster를 cleanup에서도 확인", async () => {
    const { connect, queries } = fake(okHandler());
    const s = await createOwnedScratchDb(PG18_ADMIN, { target: "pg18", connect });
    assert.equal(new URL(s.dbUrl).port, "5433");
    await s.cleanup();
    assert.equal(queries.every((x) => new URL(x.url).port === "5433"), true);
    assert.equal(
      queries.filter((x) => x.q.startsWith("SELECT system_identifier::text")).length,
      4,
    );
    assert.equal(dropQueries(queries).length, 1);
  });

  test("PG18 cleanup cluster identity drift는 DROP 전에 거부", async () => {
    const { connect, queries } = fake(okHandler({
      systemIdentifierAtCleanup: "other-cluster",
    }));
    const s = await createOwnedScratchDb(PG18_ADMIN, { target: "pg18", connect });
    await assert.rejects(() => s.cleanup(), /cluster identity/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("정상 생성·정리 — DROP은 정확히 1회, 대상 이름과 일치", async () => {
    const { connect, queries } = fake(okHandler());
    const s = await createOwnedScratchDb(ADMIN, { connect });
    assert.match(s.dbName, /^scratch_[0-9a-f]{16}$/);
    assert.equal(s.dbUrl.endsWith("/" + s.dbName), true);
    assert.equal(s.dbUrl.includes("?"), false);
    await s.cleanup();
    const drops = dropQueries(queries);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].q, "DROP DATABASE " + s.dbName);
    // IF EXISTS/FORCE 같은 완화 옵션이 없어야 한다
    assert.equal(/IF EXISTS|FORCE/.test(drops[0].q), false);
  });

  test("cleanup: pg_database identity(oid)가 바뀌면 DROP 0회", async () => {
    const { connect, queries } = fake(
      okHandler({ identityAtCleanup: { oid: 99999, owner: 10 } }),
    );
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /identity/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("cleanup: owner가 바뀌면 DROP 0회", async () => {
    const { connect, queries } = fake(
      okHandler({ identityAtCleanup: { oid: 70001, owner: 77 } }),
    );
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /identity/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("cleanup: 대상 DB가 사라졌으면 DROP 0회(실패 아닌 거부)", async () => {
    const { connect, queries } = fake(okHandler({ identityAtCleanup: null }));
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /부재/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("cleanup: 마커 테이블 부재 — DROP 0회", async () => {
    const { connect, queries } = fake(okHandler({ marker: null }));
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /마커/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("cleanup: 마커 불일치(다른 실행 소유) — DROP 0회", async () => {
    const { connect, queries } = fake(okHandler({ marker: "other-run-id" }));
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /마커/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("cleanup: 접속 DB 불일치 — DROP 0회", async () => {
    const { connect, queries } = fake(
      okHandler({ currentDbAtCleanup: "commerce" }),
    );
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /불일치/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("cleanup 시점에 opt-in이 사라지면 DROP 0회", async () => {
    const { connect, queries } = fake(okHandler());
    const s = await createOwnedScratchDb(ADMIN, { connect });
    delete process.env[SCRATCH_OPTIN_ENV];
    await assert.rejects(() => s.cleanup(), /opt-in/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("runId는 외부 주입이 아니라 실행마다 새로 만든다 — 호출자가 marker를 맞출 수 없다", async () => {
    const { connect } = fake(okHandler());
    const a = await createOwnedScratchDb(ADMIN, { connect });
    const b = await createOwnedScratchDb(ADMIN, { connect });
    assert.notEqual(a.runId, b.runId);
    // 시그니처에 runId 입력이 없다 — env로도 바꿀 수 없다(코드 계약).
  });

  test("scratchDbUrl은 query를 버리고 마지막 세그먼트만 바꾼다", () => {
    assert.equal(
      scratchDbUrl(ADMIN, "scratch_0000000000000001"),
      "postgres://commerce:commerce@localhost:5432/scratch_0000000000000001",
    );
  });

  test("createdIdentity는 CREATE 직후 원본 identity의 불변 사본이다", async () => {
    // okHandler의 firstIdentity = {oid:70001, owner:10} — CREATE 직후 실측값.
    const { connect, queries } = fake(okHandler());
    const s = await createOwnedScratchDb(ADMIN, { connect });
    assert.deepEqual(s.createdIdentity, { oid: 70001, owner: 10 });
    assert.equal(Object.isFrozen(s.createdIdentity), true);
    // 핸들 자체도 frozen — createdIdentity 속성을 새 객체로 교체할 수 없다.
    assert.equal(Object.isFrozen(s), true);
    const desc = Object.getOwnPropertyDescriptor(s, "createdIdentity")!;
    assert.equal(desc.writable, false);
    // 반환 사본과 cleanup closure의 기준(expectedId)은 별개다 — cleanup은
    // 여전히 원본 값으로 검증해 정상 DROP까지 간다.
    await s.cleanup();
    assert.equal(dropQueries(queries).length, 1);
  });

  test("cleanup: marker 행이 복수면 첫 행과 무관하게 DROP 0회 [PMQA-052]", async () => {
    // LIMIT 1 조회라면 첫 행만 보고 통과했을 상황 — 전체 행 수를 본다.
    const twoRows = [{ run_id: "run-a" }, { run_id: "run-b" }];
    const { connect, queries } = fake(okHandler({ markerList: twoRows }));
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /마커/);
    assert.equal(dropQueries(queries).length, 0);
    // 조회된 마커 SELECT에는 LIMIT가 없어야 한다 — 행 수를 모른 채 첫 행만
    // 보면 복수 마커를 구분할 수 없다.
    const markerSelect = queries.filter((x) =>
      x.q.includes("SELECT run_id FROM _scratch_owner"),
    );
    assert.equal(markerSelect.length > 0, true);
    for (const m of markerSelect) assert.equal(/LIMIT/i.test(m.q), false);
  });

  test("create events: planned→created→identified 순서로 기록된다", async () => {
    const seen: string[] = [];
    const { connect } = fake(okHandler());
    const s = await createOwnedScratchDb(ADMIN, {
      connect,
      events: async (e) => {
        seen.push(e.stage + ":" + e.dbName);
      },
    });
    assert.deepEqual(
      seen,
      [
        "planned:" + s.dbName,
        "created:" + s.dbName,
        "identified:" + s.dbName,
      ],
    );
  });

  test("create events: 'planned' 기록 실패 시 CREATE DATABASE는 실행되지 않는다", async () => {
    const { connect, queries } = fake(okHandler());
    await assert.rejects(
      () =>
        createOwnedScratchDb(ADMIN, {
          connect,
          events: async () => {
            throw new Error("evidence 쓰기 실패");
          },
        }),
      /evidence 쓰기 실패/,
    );
    assert.equal(
      queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length,
      0,
    );
  });

  test("create events: 'created' 기록 실패 시 retain — handle·DROP 없이 throw", async () => {
    const { connect, queries } = fake(okHandler());
    let n = 0;
    await assert.rejects(
      () =>
        createOwnedScratchDb(ADMIN, {
          connect,
          events: async () => {
            n++;
            if (n === 2) throw new Error("created 기록 실패");
          },
        }),
      /created 기록 실패/,
    );
    // CREATE는 실행됐지만 핸들이 없다 — cleanup 자체가 등록되지 않아 DROP 0.
    assert.equal(
      queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length,
      1,
    );
    assert.equal(dropQueries(queries).length, 0);
  });

  // ── PMQA-052-C — 각 await 경계의 flag 소실이 다음 mutation 직전에 차단된다 ──
  // helper는 mutation SQL(CREATE DATABASE·marker CREATE·marker INSERT·DROP)
  // 직전마다 await 없이 동기 재검증한다 — events/identity/marker/end 각 await
  // 경계에서 opt-in이 소실돼도 후속 mutation·DROP은 0이어야 한다.

  test("flag 소실 — 'created' 이벤트 await 중 opt-in 소실이면 marker CREATE/INSERT 0 [052-C]", async () => {
    const { connect, queries } = fake(okHandler());
    await assert.rejects(
      () =>
        createOwnedScratchDb(ADMIN, {
          connect,
          events: async (e) => {
            if (e.stage === "created") delete process.env[SCRATCH_OPTIN_ENV];
          },
        }),
      /opt-in|write/,
    );
    assert.equal(queries.filter((x) => x.q.startsWith("CREATE TABLE")).length, 0);
    assert.equal(queries.filter((x) => x.q.includes("INSERT INTO _scratch_owner")).length, 0);
  });

  test("flag 소실 — 'identified' 이벤트 await 중 opt-in 소실이면 marker CREATE/INSERT 0 [052-C]", async () => {
    const { connect, queries } = fake(okHandler());
    await assert.rejects(
      () =>
        createOwnedScratchDb(ADMIN, {
          connect,
          events: async (e) => {
            if (e.stage === "identified") delete process.env[SCRATCH_OPTIN_ENV];
          },
        }),
      /opt-in|write/,
    );
    assert.equal(queries.filter((x) => x.q.startsWith("CREATE TABLE")).length, 0);
    assert.equal(queries.filter((x) => x.q.includes("INSERT INTO _scratch_owner")).length, 0);
  });

  test("flag 소실 — marker CREATE await 중 opt-in 소실이면 marker INSERT 0 [052-C]", async () => {
    const base = okHandler();
    const { connect, queries } = fake((q, p, url) => {
      const r = base(q, p, url);
      if (q.startsWith("CREATE TABLE")) delete process.env[SCRATCH_OPTIN_ENV];
      return r;
    });
    await assert.rejects(() => createOwnedScratchDb(ADMIN, { connect }), /opt-in|write/);
    // CREATE TABLE은 flag가 있을 때 이미 실행됨 — 소실 이후의 INSERT만 0이면 된다.
    assert.equal(queries.filter((x) => x.q.includes("INSERT INTO _scratch_owner")).length, 0);
  });

  test("flag 소실 — cleanup identity 조회 await 중 opt-in 소실이면 DROP 0 [052-C]", async () => {
    const base = okHandler();
    let idCalls = 0;
    const { connect, queries } = fake((q, p, url) => {
      const r = base(q, p, url);
      if (q.startsWith("SELECT oid, datdba")) {
        idCalls++;
        if (idCalls === 2) delete process.env[SCRATCH_OPTIN_ENV]; // cleanup의 identity 조회
      }
      return r;
    });
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /opt-in|write/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("flag 소실 — cleanup marker SELECT await 중 opt-in 소실이면 DROP 0 [052-C]", async () => {
    const base = okHandler();
    const { connect, queries } = fake((q, p, url) => {
      const r = base(q, p, url);
      if (q.includes("SELECT run_id FROM _scratch_owner"))
        delete process.env[SCRATCH_OPTIN_ENV];
      return r;
    });
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /opt-in|write/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("flag 소실 — cleanup 내부 연결 end await 중 opt-in 소실이면 DROP 0 [052-C]", async () => {
    const base = okHandler();
    const queries: { url: string; q: string }[] = [];
    let scratchEnds = 0;
    const connect = (url: string) => ({
      unsafe: async (q: string, p?: unknown[]) => {
        queries.push({ url, q });
        return base(q, p, url);
      },
      end: async () => {
        // scratch 연결 end의 2회차 = cleanup 내부 owned 연결의 end await 경계
        // (1회차는 create 경로의 owned end).
        if (url.includes("/scratch_")) {
          scratchEnds++;
          if (scratchEnds === 2) delete process.env[SCRATCH_OPTIN_ENV];
        }
      },
    });
    const s = await createOwnedScratchDb(ADMIN, { connect });
    await assert.rejects(() => s.cleanup(), /opt-in|write/);
    assert.equal(dropQueries(queries).length, 0);
  });

  test("guard hook — 각 mutation 직전 동기 호출·throw 시 후속 mutation 0 [052-C]", async () => {
    const calls: string[] = [];
    const { connect, queries } = fake(okHandler());
    await assert.rejects(
      () =>
        createOwnedScratchDb(ADMIN, {
          connect,
          guard: () => {
            calls.push("g");
            if (calls.length >= 2) throw new Error("guard 거부");
          },
        }),
      /guard 거부/,
    );
    // 첫 호출은 CREATE DATABASE 직전(통과·CREATE 1회), 두 번째는 marker
    // CREATE 직전 — 거부되어 CREATE TABLE·INSERT는 dispatch되지 않는다.
    assert.equal(queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length, 1);
    assert.equal(queries.filter((x) => x.q.startsWith("CREATE TABLE")).length, 0);
    assert.equal(queries.filter((x) => x.q.includes("INSERT INTO _scratch_owner")).length, 0);
    assert.equal(calls.length >= 2, true);
  });

  test("guard hook이 thenable을 반환하면 즉시 거부 — async 검사 누락 경로 차단 [052-C]", async () => {
    const { connect, queries } = fake(okHandler());
    await assert.rejects(
      () =>
        createOwnedScratchDb(ADMIN, {
          connect,
          guard: (() => Promise.resolve()) as never,
        }),
      /동기|thenable/i,
    );
    assert.equal(queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length, 0);
  });

  test("guard hook — cleanup의 DROP 직전에도 호출된다 [052-C]", async () => {
    const calls: string[] = [];
    const { connect, queries } = fake(okHandler());
    const s = await createOwnedScratchDb(ADMIN, {
      connect,
      guard: () => {
        calls.push("g");
        // 생성 경로의 3개 mutation 직전 호출(CREATE·marker CREATE·INSERT)은
        // 통과하고, DROP 직전 호출에서만 거부한다.
        if (calls.length >= 4) throw new Error("guard 거부");
      },
    });
    await assert.rejects(() => s.cleanup(), /guard 거부/);
    assert.equal(dropQueries(queries).length, 0);
    assert.equal(calls.length, 4);
  });

  test("guard hook이 opt-in을 지우고 정상 return해도 CREATE/DROP 0 [052-C P1]", async () => {
    // 회귀: 기본 gate → guard 순이면 guard가 flag를 지운 뒤 이미 통과한
    // 기본 gate를 다시 거치지 않고 SQL이 dispatch된다. guard → 기본 gate
    // 순이면 flag 소실이 SQL 직전에 걸린다.
    const { connect, queries } = fake(okHandler());
    await assert.rejects(
      () =>
        createOwnedScratchDb(ADMIN, {
          connect,
          guard: () => {
            delete process.env[SCRATCH_OPTIN_ENV]; // 지우고 정상 return
          },
        }),
      /opt-in|write/,
    );
    assert.equal(
      queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length,
      0,
    );
    assert.equal(queries.filter((x) => x.q.startsWith("CREATE TABLE")).length, 0);
    assert.equal(
      queries.filter((x) => x.q.includes("INSERT INTO _scratch_owner")).length,
      0,
    );
    assert.equal(dropQueries(queries).length, 0);
  });

  test("guard hook이 cleanup 경계에서 opt-in을 지우고 return해도 DROP 0 [052-C P1]", async () => {
    // 생성 경로의 3개 mutation 직전 호출(CREATE·marker CREATE·INSERT)은
    // flag를 유지하고, cleanup의 DROP 직전 호출에서만 지우고 정상 return한다 —
    // cleanup 자체의 connect gate는 통과한 뒤라 writeGate 순서가 유일한 방어다.
    let calls = 0;
    const { connect, queries } = fake(okHandler());
    const s = await createOwnedScratchDb(ADMIN, {
      connect,
      guard: () => {
        calls++;
        if (calls >= 4) delete process.env[SCRATCH_OPTIN_ENV];
      },
    });
    await assert.rejects(() => s.cleanup(), /opt-in|write/);
    assert.equal(
      queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length,
      1,
    );
    assert.equal(dropQueries(queries).length, 0);
    assert.equal(calls, 4);
  });
});
