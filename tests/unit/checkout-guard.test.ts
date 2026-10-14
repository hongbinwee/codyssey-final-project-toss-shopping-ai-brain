// src/web/checkout-guard.ts의 DB-free 검증 — PMQA-067-R2 늦은 응답 가드:
// ① stale(대상 변경·계정 전환·unmount) 응답은 서버 성공이어도
//    상태·pending intent·화면 이동을 건드리지 않고 intent를 보존한다.
// ② 견적은 발급 대상(targetKey)+actor에 묶인다.
// ③ 계정 전환은 targetKey 변경 없이 발생하므로 scope도 판정에 포함한다.
// ④ 새 start() 없이 targetKey만 바뀌어도 이전 작업의 응답은 stale이다 —
//    렌더 후 passive effect 이전 창의 늦은 응답까지 차단한다.
// 실제 React 렌더·fetch·DB는 NOT_RUN — 판정 로직만 시험한다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  boundFor,
  createOpGuard,
  sameOpContext,
  type Bound,
} from "../../src/web/checkout-guard.ts";

describe("sameOpContext — 세대·actor 일치 판정", () => {
  const start = { seq: 3, scope: "u-a", target: "t1" };

  test("같은 세대·같은 actor만 fresh", () => {
    assert.equal(
      sameOpContext(start, { seq: 3, scope: "u-a", target: "t1" }),
      true,
    );
  });

  test("세대가 밀리면 stale", () => {
    assert.equal(
      sameOpContext(start, { seq: 4, scope: "u-a", target: "t1" }),
      false,
    );
  });

  test("계정 전환은 세대가 같아도 stale — seq만으로는 감지 불가", () => {
    assert.equal(
      sameOpContext(start, { seq: 3, scope: "u-b", target: "t1" }),
      false,
    );
    assert.equal(
      sameOpContext(start, { seq: 3, scope: null, target: "t1" }),
      false,
    );
  });

  test("구매 대상만 바뀌어도 stale — 세대·actor가 같아도 안전하지 않다", () => {
    assert.equal(
      sameOpContext(start, { seq: 3, scope: "u-a", target: "t2" }),
      false,
    );
  });
});

describe("createOpGuard — 실패 주입 시나리오", () => {
  test("대상 변경(새 작업 시작) 후 도착한 confirm 성공 응답은 stale → 보존", () => {
    let scope: string | null = "u-a";
    let target = "t1";
    const g = createOpGuard(() => scope, () => target);

    const pay = g.start(); // confirm() 전송 — intent는 u-a 버킷에 기록됨
    assert.equal(g.stale(pay), false);

    target = "t2";
    g.start(); // targetKey 변경 → loadQuote가 새 세대를 시작
    // pay의 늦은 성공 응답 — 호출자는 stale=true면 removePending·
    // onOpenComplete·setState 전부를 건너뛰어 intent를 보존한다.
    assert.equal(g.stale(pay), true);
  });

  test("새 start() 없이 targetKey만 바뀌어도 이전 op는 stale — effect 이전 창 차단", () => {
    // 렌더 직후 passive effect(loadQuote의 start)가 돌기 전 창에 도착한
    // 이전 대상의 응답이 새 대상 화면에 적용되면 안 된다.
    let scope: string | null = "u-a";
    let target = "sel:a,b";
    const g = createOpGuard(() => scope, () => target);

    const op = g.start();
    assert.equal(g.stale(op), false);

    target = "direct:v-9"; // 새 start 없이 대상만 교체 (targetKeyRef 갱신)
    assert.equal(g.stale(op), true);
  });

  test("계정 전환은 새 작업 없이 발생 — 같은 세대라도 actor가 다르면 stale", () => {
    let scope: string | null = "u-a";
    const g = createOpGuard(() => scope, () => "t1");
    const op = g.start();

    scope = "u-b"; // 로그아웃·계정 전환 — targetKey는 바뀌지 않는다
    assert.equal(g.stale(op), true);

    scope = null; // 세션 만료
    assert.equal(g.stale(op), true);
  });

  test("계정 전환은 unmount로 무효화된다 — scope 복귀 후에도 응답은 stale 유지", () => {
    let scope: string | null = "u-a";
    const g = createOpGuard(() => scope, () => "t1");
    const op = g.start();
    scope = "u-b";
    g.invalidate(); // 실제 계정 전환은 Checkout 언마운트를 동반한다
    scope = "u-a"; // 원 계정 복귀 — 세대가 밀렸으므로 늦은 응답은 여전히 stale
    assert.equal(g.stale(op), true);
  });

  test("unmount(invalidate) 이후 도착한 응답은 전부 stale", () => {
    const g = createOpGuard(() => "u-a", () => "t1");
    const op = g.start();
    g.invalidate(); // 화면 언마운트
    assert.equal(g.stale(op), true);
  });

  test("unbound(null scope)에서 시작한 작업 — actor 바인딩 후 도착한 응답은 stale", () => {
    // 세션 복원·직접 해시 진입 시 scope=null로 loadQuote가 시작될 수 있다.
    // 호출자는 scope null에 견적을 발급하지 않지만(loadQuote 조기 반환),
    // 이미 시작된 작업은 바인딩 후 응답이 와도 적용되지 않는다.
    let scope: string | null = null;
    const g = createOpGuard(() => scope, () => "t1");
    const op = g.start();
    assert.equal(op.scope, null); // 전송 전 차단 근거 — intent도 기록 불가
    scope = "u-a"; // bindPendingUser로 actor 바인딩
    assert.equal(g.stale(op), true);
  });
});

describe("boundFor — 견적의 대상·actor 바인딩", () => {
  const bound: Bound<{ token: string }> = {
    key: "sel:a,b",
    scope: "u-a",
    value: { token: "tok-1" },
  };

  test("같은 targetKey+같은 actor만 견적을 푼다", () => {
    assert.deepEqual(boundFor(bound, "sel:a,b", "u-a"), { token: "tok-1" });
  });

  test("대상이 바뀌면 이전 견적은 null — 이전 대상의 결제 버튼이 남지 않는다", () => {
    assert.equal(boundFor(bound, "sel:c", "u-a"), null);
    assert.equal(boundFor(bound, "direct:v-9", "u-a"), null);
  });

  test("actor가 바뀌면 같은 targetKey의 견적도 null — 타인 견적 결제 금지", () => {
    assert.equal(boundFor(bound, "sel:a,b", "u-b"), null);
    assert.equal(boundFor(bound, "sel:a,b", null), null);
  });

  test("견적 자체가 없으면 null", () => {
    assert.equal(boundFor(null, "sel:a,b", "u-a"), null);
  });

  test("unbound 견적·null scope 조회는 절대 풀리지 않는다 — 발급·사용 전 차단", () => {
    const unbound: Bound<{ token: string }> = {
      key: "k",
      scope: null,
      value: { token: "x" },
    };
    assert.equal(boundFor(unbound, "k", null), null); // 미바인딩 견적 사용 금지
    assert.equal(boundFor(bound, "sel:a,b", null), null); // 세션 없이 타인 견적 금지
  });

  test("같은 targetKey라도 actor가 바뀌면 재발급이 필요하다", () => {
    // 동일 대상으로 보이는 견적도 actor가 다르면 절대 재사용하지 않는다 —
    // 컴포넌트는 scope state 변경으로 effect를 재실행해 새 견적을 받는다.
    assert.equal(boundFor(bound, "sel:a,b", "u-b"), null);
    assert.deepEqual(boundFor(bound, "sel:a,b", "u-a"), { token: "tok-1" });
  });
});
