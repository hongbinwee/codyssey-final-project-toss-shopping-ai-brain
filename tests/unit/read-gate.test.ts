// read-gate — MAJOR069-07 회귀: 언마운트된 카트 조회가 부모에 과거 snapshot을
// 적용하는 경로를 deferred mock IO로 검증한다(DB-free·React 없음).
// 실제 사용 함수 guardedRead의 적용/차단 계약을 직접 검증한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const { createReadGate, guardedRead } = await import(
  "../../src/web/read-gate.ts"
);

// resolve를 밖에서 잡는 지연 응답 — fetch 타이밍을 테스트가 제어한다.
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe("guardedRead", () => {
  test("언마운트(kill) 후 도착한 응답은 apply를 호출하지 않는다 [MAJOR069-07]", async () => {
    const g = createReadGate();
    const d = deferred<string>();
    let applied = 0;
    const p = guardedRead(g, () => d.promise, () => applied++);
    g.kill(); // Cart 조회 중 상세 이동 — 언마운트
    d.resolve("old-cart");
    const r = await p;
    assert.equal(applied, 0); // setRes/onCartLoaded 0
    assert.equal(r, "old-cart"); // 응답 자체는 돌려준다
    assert.equal(g.alive(), false);
  });

  test("새 응답이 먼저 오면 늦게 온 구 응답은 적용되지 않는다", async () => {
    const g = createReadGate();
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const applied: string[] = [];
    const p1 = guardedRead(g, () => d1.promise, (r) => applied.push(r));
    const p2 = guardedRead(g, () => d2.promise, (r) => applied.push(r));
    d2.resolve("new");
    await p2;
    d1.resolve("old"); // 구 조회가 늦게 도착
    await p1;
    assert.deepEqual(applied, ["new"]); // 구 응답 적용 0
  });

  test("확정 쓰기(invalidate) 이후 도착한 구 read는 차단된다", async () => {
    const g = createReadGate();
    const d = deferred<string>();
    let applied = 0;
    const p = guardedRead(g, () => d.promise, () => applied++);
    g.invalidate(); // 쓰기 확정 — 진행 중 read보다 최신
    d.resolve("stale-after-write");
    await p;
    assert.equal(applied, 0);
  });

  test("정상 current read는 apply를 정확히 1회 호출한다", async () => {
    const g = createReadGate();
    const d = deferred<string>();
    const applied: string[] = [];
    const p = guardedRead(g, () => d.promise, (r) => applied.push(r));
    d.resolve("cart-v1");
    const r = await p;
    assert.deepEqual(applied, ["cart-v1"]);
    assert.equal(r, "cart-v1");
  });

  test("실패 응답도 current read면 그대로 전달한다", async () => {
    const g = createReadGate();
    const d = deferred<{ ok: boolean }>();
    const applied: { ok: boolean }[] = [];
    const p = guardedRead(g, () => d.promise, (r) => applied.push(r));
    d.resolve({ ok: false });
    const r = await p;
    assert.deepEqual(applied, [{ ok: false }]); // 오류 전달 — 조용히 삼키지 않는다
    assert.equal(r.ok, false);
  });

  test("재마운트(새 gate)는 새 조회가 정상 적용된다", async () => {
    const g1 = createReadGate();
    g1.kill(); // 이전 마운트
    const g2 = createReadGate(); // 재마운트 = 새 인스턴스
    const d = deferred<string>();
    let applied = 0;
    const p = guardedRead(g2, () => d.promise, () => applied++);
    d.resolve("fresh");
    await p;
    assert.equal(applied, 1);
  });

  test("my를 미리 묶으면 start() 없이도 같은 generation으로 적용된다", async () => {
    const g = createReadGate();
    const my = g.start(); // 마운트/재시도 경로처럼 호출부가 선배정
    const d = deferred<string>();
    let applied = 0;
    let loadingEnd = 0;
    const p = guardedRead(g, () => d.promise, () => applied++, my);
    const after = p.then(() => {
      if (g.current(my)) loadingEnd++;
    });
    d.resolve("v");
    await after;
    assert.equal(applied, 1);
    assert.equal(loadingEnd, 1); // setLoading 가드도 같은 generation
  });

  test("my로 묶인 조회가 stale이면 loading 해제도 차단된다", async () => {
    const g = createReadGate();
    const my = g.start();
    const d = deferred<string>();
    let applied = 0;
    let loadingEnd = 0;
    const p = guardedRead(g, () => d.promise, () => applied++, my);
    const after = p.then(() => {
      if (g.current(my)) loadingEnd++;
    });
    g.kill();
    d.resolve("v");
    await after;
    assert.equal(applied, 0);
    assert.equal(loadingEnd, 0); // 언마운트된 조회의 setLoading 차단 [PM]
  });
});

// MAJOR072-01 — loading 인계 회귀. Cart의 실제 apply 형태를 미러한다: 적용되는
// 최신 응답만 loading을 해제할 권한이 있고, stale·kill 응답은 그 권한을 되찾지
// 못한다. Cart는 reload의 apply에서 setLoading(false)를 호출하고, 확정 쓰기는
// invalidate + 직접 적용 경로에서 setLoading(false)를 호출한다.
describe("loading 인계 — MAJOR072-01", () => {
  test("kill 없이 invalidate된 뒤 확정 쓰기가 적용되면 진행 중 loading이 해제되고, 늦은 재시도 응답은 권한이 없다", async () => {
    const g = createReadGate();
    let loading = true; // Cart: 오류 재시도 직후 setLoading(true) 상태
    const applied: string[] = [];
    const d = deferred<string>();
    // 재시도 조회 — Cart onRetry의 reload()와 같은 적용 계약
    const p = guardedRead(g, () => d.promise, (r) => {
      applied.push(r);
      loading = false;
    });
    // 진행 중이던 쓰기가 확정 — Cart runWrite: invalidate + 최신 snapshot 적용
    // + 살아있는 화면의 loading 해제
    g.invalidate();
    applied.push("confirmed-write");
    loading = false;
    d.resolve("stale-retry-result");
    await p;
    assert.deepEqual(applied, ["confirmed-write"]); // stale 재시도 적용 0
    assert.equal(loading, false); // 영구 Loading 회귀 없음
  });

  test("로딩 조회를 새 조회가 대체하면 적용되는 최신 응답이 loading 해제를 인계한다", async () => {
    const g = createReadGate();
    let loading = true;
    const applied: string[] = [];
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const apply = (r: string) => {
      applied.push(r);
      loading = false; // Cart reload apply와 동일 계약
    };
    const p1 = guardedRead(g, () => d1.promise, apply); // loading 조회
    const p2 = guardedRead(g, () => d2.promise, apply); // 더 새 조회 — 구 조회 대체
    d2.resolve("newest");
    await p2;
    d1.resolve("older");
    await p1;
    assert.deepEqual(applied, ["newest"]); // 구 응답 적용 0
    assert.equal(loading, false); // 인계된 최신 응답이 loading 해제
  });

  test("kill 후에는 어떤 응답도 apply·loading 해제 권한이 없다", async () => {
    const g = createReadGate();
    let loading = true;
    let applied = 0;
    const d = deferred<string>();
    const p = guardedRead(g, () => d.promise, () => {
      applied++;
      loading = false;
    });
    g.kill();
    d.resolve("late");
    await p;
    assert.equal(applied, 0);
    assert.equal(loading, true); // 죽은 조회는 loading도 건드리지 못한다
  });

  test("current 응답은 정상·실패 모두 적용되고 loading을 해제한다 (기존 경로 보존)", async () => {
    const g = createReadGate();
    let loading = true;
    const applied: { ok: boolean }[] = [];
    const d1 = deferred<{ ok: boolean }>();
    const d2 = deferred<{ ok: boolean }>();
    const p1 = guardedRead(g, () => d1.promise, (r) => {
      applied.push(r);
      loading = false;
    });
    d1.resolve({ ok: true });
    await p1;
    assert.equal(loading, false); // 정상 경로 — 마운트 GET 성공과 동일
    assert.deepEqual(applied, [{ ok: true }]);
    loading = true; // 재시도 다시 진입
    const p2 = guardedRead(g, () => d2.promise, (r) => {
      applied.push(r);
      loading = false;
    });
    d2.resolve({ ok: false });
    await p2;
    assert.equal(loading, false); // 실패 응답도 적용 → ErrorState 재표시 가능
    assert.deepEqual(applied, [{ ok: true }, { ok: false }]);
  });
});
