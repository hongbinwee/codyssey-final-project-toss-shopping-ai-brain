// tests/helpers/isolated-db.ts의 DB-free 단위 검증 [PMQA-050-B].
// 실제 PostgreSQL 없이 mock exec로, 순수 판정 함수의 거부 결정과
// verifyOwnedExec의 'query 0건 / SELECT 측정만' 범위를 실증한다 —
// 실DB 연결·통합 실행 차단의 증거는 아니다(실PG 검증은 별도 승인).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIsolatedChildEnv,
  contractFromScratch,
  parseIsolatedContract,
  planIsolatedConnect,
  verifyOwnedExec,
  ISOLATED_ENV_KEYS,
} from "../helpers/isolated-db.ts";

const CONTRACT = {
  dbUrl: "postgres://commerce:commerce@localhost:5432/scratch_0123456789abcdef",
  dbName: "scratch_0123456789abcdef",
  dbOid: 70001,
  dbOwner: 10,
  runId: "11111111-2222-3333-4444-555555555555",
};

const FULL_ENV = {
  SCRATCH_DB_TESTS: "1",
  ISOLATED_STRICT: "1",
  ISOLATED_DB_URL: CONTRACT.dbUrl,
  ISOLATED_DB_NAME: CONTRACT.dbName,
  ISOLATED_DB_OID: String(CONTRACT.dbOid),
  ISOLATED_DB_OWNER: String(CONTRACT.dbOwner),
  ISOLATED_RUN_ID: CONTRACT.runId,
};

// mock exec — 실행한 query를 기록하고 handler 응답을 돌려준다.
function fakeExec(handler: (q: string) => Record<string, unknown>[]) {
  const queries: string[] = [];
  return {
    queries,
    unsafe: async <T = Record<string, unknown>[]>(q: string): Promise<T> => {
      queries.push(q);
      return handler(q) as T;
    },
  };
}

const OK_IDENTITY = (q: string) => {
  if (q.includes("current_database()"))
    return [{ d: CONTRACT.dbName, oid: CONTRACT.dbOid, owner: CONTRACT.dbOwner }];
  if (q.includes("_scratch_owner")) return [{ run_id: CONTRACT.runId }];
  throw new Error("unexpected: " + q);
};

// source env에 필요한 최소 필드 — DATABASE_URL은 계약과 동일해야 한다.
const SRC_ENV = {
  ...FULL_ENV,
  DATABASE_URL: CONTRACT.dbUrl,
};

describe("parseIsolatedContract", () => {
  test("전체 계약이 유효하면 통과", () => {
    const p = parseIsolatedContract(FULL_ENV);
    assert.ok(p.ok);
    assert.deepEqual(p.contract, CONTRACT);
  });

  test("계약 부재 → 거부", () => {
    const p = parseIsolatedContract({});
    assert.equal(p.ok, false);
  });

  test("부분 계약(4/5) → 거부", () => {
    for (const drop of ISOLATED_ENV_KEYS) {
      const env = { ...FULL_ENV } as Record<string, string | undefined>;
      delete env[drop];
      const p = parseIsolatedContract(env);
      assert.equal(p.ok, false, drop + " 누락이 허용됨");
    }
  });

  test("보호 DB 이름(commerce_test/commerce/postgres) → 거부", () => {
    for (const name of ["commerce_test", "commerce", "postgres"]) {
      const p = parseIsolatedContract({
        ...FULL_ENV,
        ISOLATED_DB_NAME: name,
        ISOLATED_DB_URL: "postgres://commerce:commerce@localhost:5432/" + name,
      });
      assert.equal(p.ok, false, name + " 허용됨");
    }
  });

  test("DB URL: 부재 형식·query·fragment·원격·경로 불일치 → 거부", () => {
    const cases = [
      "not-a-url",
      CONTRACT.dbUrl + "?database=commerce_test",
      CONTRACT.dbUrl + "#frag",
      "postgres://commerce:commerce@remote.example.com:5432/" + CONTRACT.dbName,
      "postgres://commerce:commerce@localhost:5432/other_db",
      "http://localhost:5432/" + CONTRACT.dbName,
    ];
    for (const url of cases) {
      const p = parseIsolatedContract({ ...FULL_ENV, ISOLATED_DB_URL: url });
      assert.equal(p.ok, false, url + " 허용됨");
      // 오류 메시지에 credential URL 전문이 들어가지 않는다
      if (!p.ok) assert.ok(!p.reason.includes("commerce:commerce@"));
    }
  });

  test("OID/OWNER 비숫자·RUN_ID 비UUID/하이픈 구조 위반 → 거부", () => {
    assert.equal(
      parseIsolatedContract({ ...FULL_ENV, ISOLATED_DB_OID: "abc" }).ok,
      false,
    );
    assert.equal(
      parseIsolatedContract({ ...FULL_ENV, ISOLATED_DB_OWNER: "0" }).ok,
      false,
    );
    assert.equal(
      parseIsolatedContract({ ...FULL_ENV, ISOLATED_RUN_ID: "not-a-uuid" }).ok,
      false,
    );
    // {36} 패턴이 통과시키던 하이픈 36개·그룹 구조 위반도 전부 거부한다
    assert.equal(
      parseIsolatedContract({
        ...FULL_ENV,
        ISOLATED_RUN_ID: "------------------------------------",
      }).ok,
      false,
    );
    assert.equal(
      parseIsolatedContract({
        ...FULL_ENV,
        ISOLATED_RUN_ID: "11111111222233334444555555555555",
      }).ok,
      false,
    );
    assert.equal(
      parseIsolatedContract({
        ...FULL_ENV,
        ISOLATED_RUN_ID: "11111111-2222-3333-4444-5555555555",
      }).ok,
      false,
    );
  });
});

describe("planIsolatedConnect", () => {
  test("strict 소실 → 거부", () => {
    const env = { ...FULL_ENV } as Record<string, string | undefined>;
    delete env.ISOLATED_STRICT;
    assert.equal(planIsolatedConnect(env).ok, false);
  });

  test("opt-in 소실 → 거부", () => {
    const env = { ...FULL_ENV } as Record<string, string | undefined>;
    delete env.SCRATCH_DB_TESTS;
    assert.equal(planIsolatedConnect(env).ok, false);
  });

  test("strict·opt-in·계약 전부 있으면 통과", () => {
    const p = planIsolatedConnect(FULL_ENV);
    assert.ok(p.ok);
  });
});

describe("verifyOwnedExec — 실측 검증(read-only query만)", () => {
  test("모든 필드 일치 → 통과 + SELECT query만 실행됨(2회 측정)", async () => {
    const exec = fakeExec(OK_IDENTITY);
    const r = await verifyOwnedExec(exec, CONTRACT);
    assert.ok(r.ok);
    assert.equal(exec.queries.length, 2);
    for (const q of exec.queries)
      assert.ok(q.trimStart().startsWith("SELECT"), "write query 감지: " + q);
  });

  test("계약 형식 무효(보호 DB·비로컬·부분) → DB 조회 0건으로 거부 [MJ-B1]", async () => {
    // parse를 우회한 caller가 들고 온 잘못된 계약 — 실제 name/marker가
    // 일치한다고 해도 조회 전에 거부돼야 한다.
    for (const bad of [
      { ...CONTRACT, dbName: "commerce_test" },
      { ...CONTRACT, dbName: "commerce" },
      {
        ...CONTRACT,
        dbUrl: "postgres://commerce:commerce@remote.example.com:5432/" +
          CONTRACT.dbName,
      },
      { ...CONTRACT, dbUrl: CONTRACT.dbUrl + "?database=commerce_test" },
      { ...CONTRACT, dbOid: -1 },
      { ...CONTRACT, runId: "------------------------------------" },
    ]) {
      const exec = fakeExec(OK_IDENTITY);
      const r = await verifyOwnedExec(exec, bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(exec.queries.length, 0, "형식 무효 계약인데 조회 실행됨");
    }
  });

  test("async 대기 중 caller contract 변조는 진입 시점 snapshot으로 판단 [MJ-B1]", async () => {
    const mutable = { ...CONTRACT };
    const exec = fakeExec((q) => {
      // 첫 측정 query 실행 사이에 호출자가 계약을 변조한다
      if (q.includes("current_database()")) {
        mutable.dbOid = 99999;
        mutable.dbName = "commerce_test";
        return [{ d: CONTRACT.dbName, oid: CONTRACT.dbOid, owner: CONTRACT.dbOwner }];
      }
      return OK_IDENTITY(q);
    });
    const r = await verifyOwnedExec(exec, mutable);
    assert.ok(r.ok, "snapshot이 아니라 변조값으로 판단됨");
  });

  test("identity 행이 0행/복수행이면 거부 [MJ-B1]", async () => {
    for (const rows of [[], [{}, {}]]) {
      const exec = fakeExec((q) =>
        q.includes("current_database()") ? rows : OK_IDENTITY(q),
      );
      assert.equal((await verifyOwnedExec(exec, CONTRACT)).ok, false);
    }
  });

  test("첫 실측 query 오류는 credential 원문을 노출하지 않는다 [MJ-B1]", async () => {
    const exec = fakeExec(() => {
      throw new Error(
        "connect ECONNREFUSED postgres://commerce:commerce@localhost:5432/x",
      );
    });
    const r = await verifyOwnedExec(exec, CONTRACT);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(!r.reason.includes("commerce:commerce"));
      assert.ok(!r.reason.includes("ECONNREFUSED"));
    }
  });

  test("접속 DB 이름 불일치 → 거부", async () => {
    const exec = fakeExec((q) =>
      q.includes("current_database()")
        ? [{ d: "commerce_test", oid: CONTRACT.dbOid, owner: CONTRACT.dbOwner }]
        : OK_IDENTITY(q),
    );
    assert.equal((await verifyOwnedExec(exec, CONTRACT)).ok, false);
  });

  test("OID 불일치(같은 이름의 다른 DB) → 거부", async () => {
    const exec = fakeExec((q) =>
      q.includes("current_database()")
        ? [{ d: CONTRACT.dbName, oid: 99999, owner: CONTRACT.dbOwner }]
        : OK_IDENTITY(q),
    );
    assert.equal((await verifyOwnedExec(exec, CONTRACT)).ok, false);
  });

  test("owner 불일치 → 거부", async () => {
    const exec = fakeExec((q) =>
      q.includes("current_database()")
        ? [{ d: CONTRACT.dbName, oid: CONTRACT.dbOid, owner: 42 }]
        : OK_IDENTITY(q),
    );
    assert.equal((await verifyOwnedExec(exec, CONTRACT)).ok, false);
  });

  test("마커 부재/0행/복수행/불일치 → 전부 거부", async () => {
    const cases: Record<string, unknown>[][] = [
      [], // 0행
      [{ run_id: CONTRACT.runId }, { run_id: CONTRACT.runId }], // 복수행
      [{ run_id: "99999999-8888-7777-6666-555555555555" }], // 다른 실행
    ];
    for (const markerRows of cases) {
      const exec = fakeExec((q) =>
        q.includes("_scratch_owner") ? markerRows : OK_IDENTITY(q),
      );
      assert.equal((await verifyOwnedExec(exec, CONTRACT)).ok, false);
    }
    // 테이블 부재로 query 자체가 실패
    const exec2 = fakeExec((q) => {
      if (q.includes("_scratch_owner")) throw new Error("relation absent");
      return OK_IDENTITY(q);
    });
    assert.equal((await verifyOwnedExec(exec2, CONTRACT)).ok, false);
  });
});

describe("contractFromScratch / buildIsolatedChildEnv", () => {
  test("계약은 핸들의 CREATE-시 snapshot에서만 나온다", () => {
    // 이후 probe 값(90009)이 아니라 생성 시 identity(70001)가 EXPECT다.
    const c = contractFromScratch({
      dbName: CONTRACT.dbName,
      runId: CONTRACT.runId,
      dbUrl: CONTRACT.dbUrl,
      createdIdentity: { oid: 70001, owner: 10 },
    });
    assert.equal(c.dbOid, 70001);
    assert.equal(c.dbOwner, 10);
  });

  test("잘못된 소스(보호 이름·형식 위반)의 계약 생성은 거부된다 [MJ-B1]", () => {
    assert.throws(() =>
      contractFromScratch({
        dbName: "commerce_test",
        runId: CONTRACT.runId,
        dbUrl: "postgres://commerce:commerce@localhost:5432/commerce_test",
        createdIdentity: { oid: 1, owner: 1 },
      }),
    );
    assert.throws(() =>
      contractFromScratch({
        dbName: CONTRACT.dbName,
        runId: "------------------------------------",
        dbUrl: CONTRACT.dbUrl,
        createdIdentity: { oid: CONTRACT.dbOid, owner: CONTRACT.dbOwner },
      }),
    );
  });

  test("자식 env는 전체 계약 source에서만 구성된다 [MJ-B2]", () => {
    const r = buildIsolatedChildEnv(SRC_ENV);
    assert.ok(r.ok);
    const env = r.ok ? r.env : {};
    assert.equal(env.DATABASE_URL, CONTRACT.dbUrl);
    assert.equal(env.ISOLATED_DB_NAME, CONTRACT.dbName);
    assert.equal(env.ISOLATED_DB_OID, String(CONTRACT.dbOid));
    assert.equal(env.ISOLATED_DB_OWNER, String(CONTRACT.dbOwner));
    assert.equal(env.ISOLATED_RUN_ID, CONTRACT.runId);
    assert.equal(env.ISOLATED_STRICT, "1");
    assert.equal(env.SCRATCH_DB_TESTS, "1");
  });

  test("source에 strict·opt-in·계약이 없으면 구성 거부 — '복원' 기능 없음 [MJ-B2]", () => {
    for (const drop of ["SCRATCH_DB_TESTS", "ISOLATED_STRICT", "ISOLATED_DB_NAME"]) {
      const src = { ...SRC_ENV } as Record<string, string | undefined>;
      delete src[drop];
      assert.equal(buildIsolatedChildEnv(src).ok, false, drop + " 부재인데 구성됨");
    }
    // source DATABASE_URL이 계약과 다르면 조용한 덮어쓰기가 아니라 거부
    assert.equal(
      buildIsolatedChildEnv({ ...SRC_ENV, DATABASE_URL: "postgres://x@localhost:5432/other" }).ok,
      false,
    );
    // 빈 source도 거부
    assert.equal(buildIsolatedChildEnv({}).ok, false);
  });

  test("allowlist 외 임의 키(NODE_OPTIONS·NODE_PATH·임의 실행 제어)는 전달되지 않는다 [MJ-B2]", () => {
    const r = buildIsolatedChildEnv({
      ...SRC_ENV,
      NODE_OPTIONS: "--require /tmp/evil.js",
      NODE_PATH: "/tmp/evil",
      LD_PRELOAD: "/tmp/evil.so",
      PATH: "/usr/bin",
      TEST_USER_CODES: "it-a=u-a",
    });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.env.NODE_OPTIONS, undefined);
      assert.equal(r.env.NODE_PATH, undefined);
      assert.equal(r.env.LD_PRELOAD, undefined);
      // allowlist 안 키만 통과한다
      assert.equal(r.env.PATH, "/usr/bin");
      assert.equal(r.env.TEST_USER_CODES, "it-a=u-a");
    }
  });
});
