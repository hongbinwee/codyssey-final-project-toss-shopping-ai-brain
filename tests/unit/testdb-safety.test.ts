// tests/helpers/testdb.ts의 DB-free 안전 검증(PMQA-040-B0).
// 실제 DB 없이 executor를 가짜로 주입해, 잘못된 대상·fixture 로드 실패 시
// cleanup이 DELETE/UPDATE를 0건도 실행하지 않는 것을 증명한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSeedIds,
  assertExecTargetsTestDb,
  assertSafeDbUrl,
  cleanUserData,
  loadSeedOrderIds,
  TEST_DB,
} from "../helpers/testdb.ts";
import { readFileSync } from "node:fs";

type Row = Record<string, unknown>;

// 실행한 SQL·파라미터를 전부 기록하는 가짜 executor.
function fakeExec(db: string, orders: { id: string }[] = []) {
  const queries: { q: string; p?: unknown[] }[] = [];
  const exec = {
    unsafe: async <T = Row[]>(q: string, p?: unknown[]): Promise<T> => {
      queries.push({ q, p });
      if (q.startsWith("SELECT current_database()")) return [{ d: db }] as T;
      if (q.includes("to_regclass('public.cancel_requests')"))
        return [{ r: "cancel_requests" }] as T;
      if (q.includes("to_regclass('public.orders')"))
        return [{ r: "orders" }] as T;
      if (q.includes("SELECT id FROM orders")) return orders as T;
      return [] as T;
    },
  };
  return { exec, queries };
}

const writes = (queries: { q: string; p?: unknown[] }[]) =>
  queries.filter((x) => /^(DELETE|UPDATE|INSERT|DROP|TRUNCATE)/.test(x.q));

describe("testdb 안전 계약 — DB-free", () => {
  test("assertSafeDbUrl: query가 있으면 거부, 없으면 통과", () => {
    assert.throws(
      () =>
        assertSafeDbUrl(
          "postgres://u:u@localhost:5432/commerce_test?database=commerce",
        ),
      /query/,
    );
    assertSafeDbUrl("postgres://u:u@localhost:5432/commerce_test");
  });

  test("assertExecTargetsTestDb: 다른 DB면 거부", async () => {
    const { exec } = fakeExec("commerce");
    await assert.rejects(() => assertExecTargetsTestDb(exec), /불일치/);
    const ok = fakeExec(TEST_DB);
    await assertExecTargetsTestDb(ok.exec);
  });

  test("cleanUserData: 대상이 commerce_test가 아니면 write 0건으로 거부", async () => {
    const { exec, queries } = fakeExec("commerce"); // 운영 DB를 가리키는 상황
    await assert.rejects(() => cleanUserData(exec, () => ["ord-seed-1"]));
    assert.equal(writes(queries).length, 0);
  });

  test("cleanUserData: seed id 로드 실패면 write 0건으로 거부(빈 집합 fallback 금지)", async () => {
    const { exec, queries } = fakeExec(TEST_DB);
    await assert.rejects(() =>
      cleanUserData(exec, () => {
        throw new Error("scenarios.json 읽기 실패");
      }),
    );
    assert.equal(writes(queries).length, 0);
  });

  test("cleanUserData: 주입 loadIds가 빈 배열/깨진 id/중복을 돌려줘도 write 0건", async () => {
    for (const bad of [[], ["ok", ""], ["a", "a"], [null], [123], ["  "] as unknown[]]) {
      const { exec, queries } = fakeExec(TEST_DB);
      await assert.rejects(() => cleanUserData(exec, () => bad as string[]));
      assert.equal(writes(queries).length, 0, JSON.stringify(bad));
    }
  });

  test("cleanUserData: 정상 경로 — 모든 write가 fixture uids/비-seed ids로만 스코프된다", async () => {
    // 'ord-seed-1'은 보호 대상 — SELECT가 비-seed만 돌려주는 계약을 검증한다.
    const { exec, queries } = fakeExec(TEST_DB, [
      { id: "ord-tmp-1" },
      { id: "ord-tmp-2" },
    ]);
    await cleanUserData(exec, () => ["ord-seed-1"]);

    const ws = writes(queries);
    assert.ok(ws.length > 0); // 실제로 cleanup이 실행된 경로
    for (const w of ws) {
      const params = (w.p ?? []).flat() as unknown[];
      const flat = JSON.stringify(params);
      // 어떤 write도 seed 주문 id를 파라미터로 쓰지 않는다
      assert.equal(flat.includes("ord-seed-1"), false, w.q);
      // 스코프는 fixture uids 집합이나 비-seed 주문 id 집합 둘 중 하나다
      const scoped =
        flat.includes("u-a") ||
        flat.includes("ord-tmp-1") ||
        flat.includes("ord-tmp-2");
      assert.equal(scoped, true, w.q);
    }
    // SELECT orders에 전달된 보호 집합이 loadIds 결과와 일치하는지 확인
    // (cancel_requests DELETE 안의 IN 서브쿼리가 같은 문자열을 포함하므로 startsWith)
    const sel = queries.find((x) => x.q.startsWith("SELECT id FROM orders"));
    assert.deepEqual(sel?.p?.[1], ["ord-seed-1"]);
  });

  test("loadSeedOrderIds: 정상·파싱 실패·orders 배열 부재", () => {
    assert.deepEqual(
      loadSeedOrderIds('{"orders":[{"id":"ord-a"},{"id":"ord-b"}]}'),
      ["ord-a", "ord-b"],
    );
    assert.throws(() => loadSeedOrderIds("{bad json"));
    assert.throws(() => loadSeedOrderIds("{}"));
    assert.throws(() => loadSeedOrderIds('{"orders":"not-array"}'));
    // 빈 배열·비문자열/빈 id·객체 누락·null 요소·중복도 전부 fail closed
    assert.throws(() => loadSeedOrderIds('{"orders":[]}'));
    assert.throws(() => loadSeedOrderIds('{"orders":[{}]}'));
    assert.throws(() => loadSeedOrderIds('{"orders":[{"id":""}]}'));
    assert.throws(() => loadSeedOrderIds('{"orders":[null]}'));
    assert.throws(() => loadSeedOrderIds('{"orders":[{"id":1}]}'));
    assert.throws(() => loadSeedOrderIds('{"orders":[{"id":"a"},{"id":"a"}]}'));
  });

  test("loadSeedOrderIds: 실제 scenarios.json은 현재 fixture seed 4건과 일치", () => {
    const ids = loadSeedOrderIds(readFileSync("db/seeds/scenarios.json", "utf8"));
    assert.deepEqual(ids.sort(), ["ord-a-done", "ord-a-pre", "ord-a-ship", "ord-b-none"]);
  });

  test("assertSeedIds: 유효 집합은 통과, 무효는 전부 거부", () => {
    assert.deepEqual(assertSeedIds(["ord-a"]), ["ord-a"]);
    for (const bad of [undefined, null, [], ["a", ""], ["a", "a"], [1], [null], "x"])
      assert.throws(() => assertSeedIds(bad), String(bad));
  });
});
