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
    failOn?: string;
  } = {},
) {
  let capturedRunId: string | null = null;
  let identityCalls = 0;
  let currentDbCalls = 0;
  const firstIdentity =
    opts.identity === undefined ? { oid: 70001, owner: 10 } : opts.identity;
  return (q: string, p: unknown[] | undefined, url: string): Row[] => {
    if (opts.failOn && q.startsWith(opts.failOn))
      throw new Error("주입 실패: " + opts.failOn);
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

  test("planScratchConnect: adminUrl에 query(?database= 등)가 있으면 거부", () => {
    const r = planScratchConnect({
      optin: "1",
      adminUrl: ADMIN + "?database=commerce_test",
    });
    assert.equal(r.ok, false);
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
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 }, marker: null }).ok, false);
    assert.equal(planScratchDrop({ ...base, identity: { oid: 100, owner: 10 }, marker: "attacker-guess" }).ok, false);
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
});
