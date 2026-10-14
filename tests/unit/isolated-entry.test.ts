// PMQA-078 — 격리 DB 계약의 API·테스트 경계는 DB-free 판정으로 검증한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanUserData,
  isolatedContractFromEnv,
  setupTestDb,
} from "../helpers/testdb.ts";
import { verifyOwnedTransaction } from "../helpers/isolated-db.ts";
import {
  E2E_ADDITION_SPECS,
  E2E_BASELINE_SPECS,
  E2E_SOURCE_INVENTORY,
  EXCLUDED_INTEGRATION,
  INTEGRATION_SPECS,
} from "../helpers/isolated-suite.ts";
import { planSuiteEnv } from "../../scripts/isolated-suite.ts";
import {
  health,
  isolatedStartContract,
  start,
  type ServerStartDeps,
} from "../../src/server.ts";

const CONTRACT = {
  dbUrl: "postgres://commerce:commerce@localhost:5432/scratch_0123456789abcdef",
  dbName: "scratch_0123456789abcdef",
  dbOid: 70001,
  dbOwner: 10,
  runId: "11111111-2222-3333-4444-555555555555",
};

const ENV = {
  SCRATCH_DB_TESTS: "1",
  ISOLATED_STRICT: "1",
  ISOLATED_DB_URL: CONTRACT.dbUrl,
  ISOLATED_DB_NAME: CONTRACT.dbName,
  ISOLATED_DB_OID: String(CONTRACT.dbOid),
  ISOLATED_DB_OWNER: String(CONTRACT.dbOwner),
  ISOLATED_RUN_ID: CONTRACT.runId,
  DATABASE_URL: CONTRACT.dbUrl,
};

describe("isolated runtime entry guards", () => {
  test("일반 실행은 legacy DB 경로를 유지한다", () => {
    assert.equal(isolatedContractFromEnv({}), null);
    assert.equal(isolatedStartContract({}), null);
  });

  test("완전한 owned 계약만 test helper와 API start에서 허용한다", () => {
    assert.deepEqual(isolatedContractFromEnv(ENV), CONTRACT);
    assert.deepEqual(isolatedStartContract(ENV), CONTRACT);
  });

  test("owned identity와 marker 검증은 같은 transaction executor에서 실행한다", async () => {
    const events: string[] = [];
    const poolQueries: string[] = [];
    const txQueries: string[] = [];
    const txUnsafe = async <T = Record<string, unknown>[]>(query: string): Promise<T> => {
      txQueries.push(query);
      if (query.includes("current_database()"))
        return [{ d: CONTRACT.dbName, oid: CONTRACT.dbOid, owner: CONTRACT.dbOwner }] as T;
      if (query.includes("_scratch_owner"))
        return [{ run_id: CONTRACT.runId }] as T;
      throw new Error("unexpected query");
    };
    const tx = {
      unsafe: txUnsafe,
    };
    const pool = {
      unsafe: async <T = Record<string, unknown>[]>(query: string): Promise<T> => {
        poolQueries.push(query);
        return [] as T;
      },
      begin: async <T>(fn: (q: typeof tx) => Promise<T>): Promise<T> => {
        events.push("BEGIN");
        const result = await fn(tx);
        events.push("COMMIT");
        return result;
      },
    };
    const result = await verifyOwnedTransaction(pool, CONTRACT);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(events, ["BEGIN", "COMMIT"]);
    assert.equal(txQueries.length, 2);
    assert.equal(poolQueries.length, 0);
  });

  test("격리 키가 일부라도 있으면 계약 누락으로 fail closed한다", () => {
    const partial = { ...ENV };
    delete (partial as Record<string, string | undefined>).ISOLATED_DB_OID;
    assert.throws(() => isolatedContractFromEnv(partial), /부분 누락/);
    assert.throws(() => isolatedStartContract(partial), /부분 누락/);
  });

  test("isolated test phase 7은 DB connection 전에 거부한다", async () => {
    const keys = Object.keys(ENV);
    const previous = new Map(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    try {
      await assert.rejects(setupTestDb(7), /phase는 1~6/);
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("fixed suite는 baseline 68, 신규 5, legacy capture NOT_READY를 분리한다", () => {
    assert.equal(E2E_BASELINE_SPECS.length, 9);
    assert.deepEqual(E2E_ADDITION_SPECS, [
      "checkout-c.spec.ts",
      "wishlist.spec.ts",
    ]);
    assert.equal(E2E_SOURCE_INVENTORY.baselineRegularStaticCalls, 68);
    assert.equal(E2E_SOURCE_INVENTORY.newStaticCalls, 5);
    assert.equal(E2E_SOURCE_INVENTORY.legacyCapture.status, "NOT_READY");
    assert.equal(E2E_SOURCE_INVENTORY.legacyCapture.historicalStaticCalls, 1);
    assert.equal((INTEGRATION_SPECS as readonly string[]).includes("demo-seed.test.ts"), false);
    assert.equal(EXCLUDED_INTEGRATION.status, "NOT_RUN");
  });

  test("isolated launcher는 명시 opt-in/admin만 받고 상속 DB·사용자 인자를 거부한다", () => {
    const env = {
      SCRATCH_DB_TESTS: "1",
      ISOLATED_STRICT: "1",
      SCRATCH_ADMIN_URL: "postgres://commerce:commerce@localhost:5432/postgres",
    };
    assert.deepEqual(planSuiteEnv(env, []), {
      ok: true,
      adminUrl: env.SCRATCH_ADMIN_URL,
    });
    assert.equal(planSuiteEnv(env, ["--grep=wishlist"]).ok, false);
    assert.equal(planSuiteEnv({ ...env, DATABASE_URL: ENV.DATABASE_URL }, []).ok, false);
    assert.equal(
      planSuiteEnv({ ...env, SCRATCH_ADMIN_URL: env.SCRATCH_ADMIN_URL + "?database=commerce_test" }, []).ok,
      false,
    );
  });

  test("DATABASE_URL이 owned 계약과 다르면 대체 연결하지 않는다", () => {
    const mismatch = { ...ENV, DATABASE_URL: "postgres://commerce@localhost/commerce_test" };
    assert.throws(() => isolatedContractFromEnv(mismatch), /DATABASE_URL.*contract/);
    assert.throws(() => isolatedStartContract(mismatch), /DATABASE_URL.*contract/);
  });

  test("health는 주입된 DB 상태를 200/503으로 매핑한다", async () => {
    const up = await health({ unsafe: async () => [] } as never);
    assert.equal(up.code, 200);
    assert.deepEqual(JSON.parse(up.body), { ok: true, db: "connected" });

    const down = await health({ unsafe: async () => { throw new Error("offline"); } } as never);
    assert.equal(down.code, 503);
    assert.deepEqual(JSON.parse(down.body), { ok: false, db: "down" });
  });

  test("격리 health는 업무 연결의 같은 트랜잭션에서 DB와 marker를 검증한다", async () => {
    const queries: string[] = [];
    const pool = {
      unsafe: async () => { throw new Error("pool query must not be used"); },
      begin: async <T>(fn: (q: unknown) => Promise<T>): Promise<T> => fn({
        unsafe: async (query: string) => {
          queries.push(query);
          return query.includes("current_database()")
            ? [{ d: CONTRACT.dbName, oid: CONTRACT.dbOid, owner: CONTRACT.dbOwner }]
            : [{ run_id: CONTRACT.runId }];
        },
      }),
    };
    const result = await health(pool as never, CONTRACT);
    assert.equal(result.code, 200);
    assert.deepEqual(JSON.parse(result.body), {
      ok: true, db: "connected",
      isolated: {
        dbName: CONTRACT.dbName, dbOid: CONTRACT.dbOid,
        dbOwner: CONTRACT.dbOwner, runId: CONTRACT.runId,
      },
    });
    assert.equal(queries.length, 2);
    assert.equal(result.body.includes(CONTRACT.dbUrl), false);
  });

  test("격리 health는 DB 이름/OID/소유자/marker 불일치와 연결 실패를 503으로 거부한다", async () => {
    for (const mismatch of ["name", "oid", "owner", "marker", "connection"]) {
      const pool = {
        unsafe: async () => [],
        begin: async <T>(fn: (q: unknown) => Promise<T>): Promise<T> => fn({
          unsafe: async (query: string) => {
            if (mismatch === "connection") throw new Error("connection failure");
            return query.includes("current_database()")
              ? [{
                d: mismatch === "name" ? "commerce_test" : CONTRACT.dbName,
                oid: mismatch === "oid" ? 1 : CONTRACT.dbOid,
                owner: mismatch === "owner" ? 1 : CONTRACT.dbOwner,
              }]
              : [{ run_id: mismatch === "marker" ? "other-run" : CONTRACT.runId }];
          },
        }),
      };
      const result = await health(pool as never, CONTRACT);
      assert.equal(result.code, 503, mismatch);
      assert.deepEqual(JSON.parse(result.body), { ok: false, db: "down" });
    }
  });

  test("API startup은 같은 owned URL을 검증하고 guard 실패 뒤 build/listen을 하지 않는다", async () => {
    const calls = { connectUrl: "", begin: 0, end: 0, ensureDevDb: 0, build: 0, listen: 0 };
    const unsafe = async <T = Record<string, unknown>[]>(query: string): Promise<T> => {
      if (query.includes("current_database()"))
        return [{ d: "commerce_test", oid: 16516, owner: 10 }] as T;
      if (query.includes("_scratch_owner"))
        return [{ run_id: CONTRACT.runId }] as T;
      throw new Error("unexpected query");
    };
    const pool = {
      unsafe,
      begin: async <T>(fn: (q: { unsafe: typeof unsafe }) => Promise<T>): Promise<T> => {
        calls.begin++;
        return fn({ unsafe });
      },
      end: async () => { calls.end++; },
    };
    const deps = {
      env: ENV,
      ensureDevDb: async () => { calls.ensureDevDb++; },
      connectDb: (url: string) => {
        calls.connectUrl = url;
        return pool;
      },
      build: async () => { calls.build++; },
      createServer: () => {
        calls.listen++;
        return {};
      },
    } as unknown as ServerStartDeps;

    await assert.rejects(start(3997, deps), /접속 DB 불일치/);
    assert.equal(calls.connectUrl, CONTRACT.dbUrl);
    assert.equal(calls.begin, 1);
    assert.equal(calls.end, 1);
    assert.equal(calls.ensureDevDb, 0);
    assert.equal(calls.build, 0);
    assert.equal(calls.listen, 0);
  });

  test("isolated API만 loopback에 bind하고 일반 start는 기존 listen 호출을 유지한다", async () => {
    const listenCalls: unknown[][] = [];
    const queries: string[] = [];
    const txUnsafe = async <T = Record<string, unknown>[]>(query: string): Promise<T> => {
      queries.push(query);
      if (query.includes("current_database()"))
        return [{ d: CONTRACT.dbName, oid: CONTRACT.dbOid, owner: CONTRACT.dbOwner }] as T;
      if (query.includes("_scratch_owner"))
        return [{ run_id: CONTRACT.runId }] as T;
      throw new Error("unexpected query");
    };
    const pool = {
      unsafe: txUnsafe,
      begin: async <T>(fn: (q: { unsafe: typeof txUnsafe }) => Promise<T>) =>
        fn({ unsafe: txUnsafe }),
      end: async () => {},
    };
    const deps = {
      env: ENV,
      ensureDevDb: async () => {},
      connectDb: () => pool,
      build: async () => {},
      createServer: () => ({
        listen: (...args: unknown[]) => {
          listenCalls.push(args);
          const cb = args.at(-1);
          if (typeof cb === "function") cb();
        },
      }),
    } as unknown as ServerStartDeps;

    await start(3998, deps);
    assert.deepEqual(queries.map((q) => q.includes("current_database()") ? "identity" : "marker"), ["identity", "marker"]);
    assert.equal(listenCalls[0]?.[0], 3998);
    assert.equal(listenCalls[0]?.[1], "127.0.0.1");
    assert.equal(typeof listenCalls[0]?.[2], "function");

    const normalListen: unknown[][] = [];
    await start(3999, {
      ...deps,
      env: { DATABASE_URL: "postgres://commerce@localhost/commerce" },
      createServer: () => ({
        listen: (...args: unknown[]) => {
          normalListen.push(args);
          const cb = args.at(-1);
          if (typeof cb === "function") cb();
        },
      }),
    } as unknown as ServerStartDeps);
    assert.equal(normalListen[0]?.[0], 3999);
    assert.equal(normalListen[0]?.length, 2);
    assert.equal(typeof normalListen[0]?.[1], "function");
  });

  test("isolated cleanup은 동일 transaction q에서 verify 후에만 DELETE한다", async () => {
    const keys = Object.keys(ENV);
    const previous = new Map(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    try {
      const run = async (identity: Record<string, unknown>) => {
        const events: string[] = [];
        const queries: string[] = [];
        const outsideQueries: string[] = [];
        const txUnsafe = async <T = Record<string, unknown>[]>(query: string, _params?: unknown[]): Promise<T> => {
          queries.push(query);
          if (query.includes("current_database()")) return [identity] as T;
          if (query.includes("_scratch_owner"))
            return [{ run_id: CONTRACT.runId }] as T;
          if (query.includes("to_regclass")) return [{ r: null }] as T;
          return [] as T;
        };
        const tx = {
          unsafe: txUnsafe,
        };
        const exec = {
          unsafe: async <T = Record<string, unknown>[]>(query: string): Promise<T> => {
            outsideQueries.push(query);
            throw new Error("pool-level unsafe must not be used");
          },
          begin: async <T>(fn: (q: typeof tx) => Promise<T>): Promise<T> => {
            events.push("BEGIN");
            try {
              const result = await fn(tx);
              events.push("COMMIT");
              return result;
            } catch (error) {
              events.push("ROLLBACK");
              throw error;
            }
          },
        };
        const result = cleanUserData(exec, () => ["ord-fixture"]);
        return { result, events, queries, outsideQueries };
      };

      const good = await run({
        d: CONTRACT.dbName,
        oid: CONTRACT.dbOid,
        owner: CONTRACT.dbOwner,
      });
      await good.result;
      assert.deepEqual(good.events, ["BEGIN", "COMMIT"]);
      assert.ok(good.queries[0].includes("current_database()"));
      assert.ok(good.queries[1].includes("_scratch_owner"));
      assert.ok(good.queries.some((q) => q.startsWith("DELETE FROM cart_items")));
      assert.equal(good.outsideQueries.length, 0);

      const bad = await run({ d: "commerce_test", oid: 16516, owner: 10 });
      await assert.rejects(bad.result, /접속 DB 불일치/);
      assert.deepEqual(bad.events, ["BEGIN", "ROLLBACK"]);
      assert.equal(
        bad.queries.some((q) => /^(DELETE|UPDATE|INSERT)\b/i.test(q)),
        false,
      );
      assert.equal(bad.outsideQueries.length, 0);
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
