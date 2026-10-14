// src/web/wishlist.ts의 DB-free 검증 — mock WishlistIO를 실제 핸들러에
// 주입해 계정 스코프·이중 가드(fetchSeq+gen)·pending 계약·복구/재시도를
// 회귀한다 [PMQA-070]. React 훅(useWishlist/useWishToggle)의 실제 효과
// 순서는 브라우저 후속 검증 대상이라 여기서는 컨트롤러 함수만 다룬다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ApiResult } from "../../src/web/api.ts";
import type { PendingWrite } from "../../src/web/pending.ts";
import type { WishlistView, SetWishlistResult } from "../../src/contracts.ts";
import {
  ensureWishlist, refreshWishlist, toggleWishlist,
  recoverWishlistPending, retryWishlistPending, wishPendingError,
  wishlistSnap,
  type WishlistIO, type WishlistOutcome,
} from "../../src/web/wishlist.ts";

// ---- mock IO ----
// 모듈 스토어는 userId 키 버킷 — 테스트마다 고유 uid로 격리한다.

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (code: string, message = code): ApiResult<never> => ({
  ok: false,
  error: { code, message },
});

function mkIo(handlers: Partial<WishlistIO> = {}, scope: string | null = "u-a") {
  const calls: string[] = [];
  const pending = new Map<string, PendingWrite>();
  const state = { scope: scope as string | null };
  const io: WishlistIO = {
    getList: () => {
      calls.push("getList");
      return handlers.getList
        ? handlers.getList()
        : Promise.resolve(ok<WishlistView>({ items: [] }));
    },
    putSaved: (path, body) => {
      calls.push("putSaved:" + path + ":" + JSON.stringify(body));
      return handlers.putSaved
        ? handlers.putSaved(path, body)
        : Promise.resolve(ok<SetWishlistResult>({
            product_id: body.product_id,
            saved: body.saved,
            wishlist_count: 1,
          }));
    },
    lookupAction: (uiKey) => {
      calls.push("lookup:" + uiKey);
      return handlers.lookupAction
        ? handlers.lookupAction(uiKey)
        : Promise.resolve(fail("NOT_FOUND"));
    },
    putPending: (pw) => {
      calls.push("putPending:" + pw.uiKey);
      if (handlers.putPending) return handlers.putPending(pw);
      pending.set(pw.uiKey, pw);
    },
    removePending: (k) => {
      calls.push("removePending:" + k);
      if (handlers.removePending) return handlers.removePending(k);
      pending.delete(k);
    },
    listPending: handlers.listPending ?? (() => [...pending.values()]),
    scope: handlers.scope ?? (() => state.scope),
  };
  return { io, calls, pending, state };
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const item = (pid: string, over: Record<string, unknown> = {}) => ({
  product_id: pid,
  saved_at: "2026-10-13T00:00:00.000Z",
  name: "상품 " + pid,
  image: "/assets/" + pid + ".webp",
  active: true,
  min_price_won: 10000,
  ...over,
});

const wishPw = (
  over: Partial<PendingWrite> = {},
  payload: Record<string, unknown> = {},
): PendingWrite => ({
  uiKey: "wk1",
  kind: "SET_WISHLIST",
  path: "/api/wishlist/" + encodeURIComponent("p-x"),
  method: "PUT",
  payload: {
    product_id: "p-x",
    saved: true,
    idempotency_key: "wk1",
    ...payload,
  },
  label: "p-x",
  at: 0,
  ...over,
});

const kind = (o: WishlistOutcome) => o.kind;
const gets = (calls: string[]) => calls.filter((c) => c === "getList");
const puts = (calls: string[]) => calls.filter((c) => c.startsWith("putSaved"));

describe("ensureWishlist — 적재·dedupe·scope", () => {
  test("동시 호출은 진행 중 GET을 공유하고 ready 이후 비강제 호출은 새 GET을 만들지 않는다", async () => {
    const d = deferred<ApiResult<WishlistView>>();
    const { io, calls } = mkIo({ getList: () => d.promise }, "u-t1");
    const p1 = ensureWishlist("u-t1", { io });
    const p2 = ensureWishlist("u-t1", { io });
    assert.ok(p1 && p2);
    assert.equal(p1, p2);                          // 같은 inflight promise
    assert.equal(gets(calls).length, 1);
    d.resolve(ok<WishlistView>({ items: [item("p-1")] }));
    await p1;
    assert.equal(wishlistSnap("u-t1").status, "ready");
    assert.equal(wishlistSnap("u-t1").count, 1);
    assert.equal(ensureWishlist("u-t1", { io }), null);
    assert.equal(gets(calls).length, 1);
  });

  test("시작 시점 scope 불일치 — GET을 시작하지 않는다", () => {
    const { io, calls } = mkIo({}, "u-other");
    assert.equal(ensureWishlist("u-t2", { io }), null);
    assert.equal(calls.length, 0);
    assert.equal(wishlistSnap("u-t2").status, "idle");
  });

  test("await 중 scope 변경 — 응답을 버리고 idle로 되돌린다", async () => {
    const d = deferred<ApiResult<WishlistView>>();
    const { io, state } = mkIo({ getList: () => d.promise }, "u-t3");
    const p = ensureWishlist("u-t3", { io });
    assert.ok(p);
    state.scope = "u-b";                            // 계정 전환 발생
    d.resolve(ok<WishlistView>({ items: [item("p-1")] }));
    await p;
    const snap = wishlistSnap("u-t3");
    assert.equal(snap.status, "idle");              // loading에 머물지 않는다
    assert.equal(snap.count, 0);                    // 다른 계정 컨텍스트 응답 미적용
  });

  test("GET 진행 중 PUT 확정 → force 새 GET이 시작되고 늦은 구 GET 응답은 폐기된다", async () => {
    // PM070 재검수 핵심 시나리오 — 확정 PUT(gen++) 이후 도착한 구 GET이
    // 상태를 덮지 못하고, force는 구 inflight를 기다리지 않고 새 GET을 연다.
    const d1 = deferred<ApiResult<WishlistView>>();
    const d2 = deferred<ApiResult<WishlistView>>();
    const queue = [d1, d2];
    const { io, calls } = mkIo({
      getList: () => (queue.length ? queue.shift()!.promise : Promise.resolve(ok<WishlistView>({ items: [] }))),
    }, "u-t4");
    const g1 = ensureWishlist("u-t4", { io });      // GET#1 시작 (느린 응답)
    assert.equal(gets(calls).length, 1);
    const out = await toggleWishlist("u-t4", "p-x", true, io); // PUT 확정
    assert.equal(kind(out), "SAVED");
    assert.equal(gets(calls).length, 2);            // display 보강 force GET#2
    d1.resolve(ok<WishlistView>({ items: [] }));    // stale 빈 목록이 늦게 도착
    await g1;
    assert.equal(wishlistSnap("u-t4").count, 1);    // 확정 p-x 유지 — 폐기 증거
    const g2 = ensureWishlist("u-t4", { io });      // 진행 중 GET#2 promise
    d2.resolve(ok<WishlistView>({ items: [item("p-x")] }));
    await g2;
    const snap = wishlistSnap("u-t4");
    assert.equal(snap.status, "ready");
    assert.equal(snap.display.has("p-x"), true);    // 표시 정보 보강 완료
  });

  test("GET 진행 중 복구 SUCCEEDED → force GET이 무효화된 구 GET을 대신한다", async () => {
    const d1 = deferred<ApiResult<WishlistView>>();
    const queue = [d1];
    const { io, pending, calls } = mkIo({
      getList: () => (queue.length ? queue.shift()!.promise : Promise.resolve(ok<WishlistView>({ items: [item("p-x")] }))),
      lookupAction: () => Promise.resolve(ok({ status: "SUCCEEDED" })),
    }, "u-t5");
    const g1 = ensureWishlist("u-t5", { io });
    const pw = wishPw();
    pending.set(pw.uiKey, pw);
    const out = await recoverWishlistPending("u-t5", pw, io); // 내부에서 force refresh
    assert.equal(kind(out), "DONE");
    assert.equal(gets(calls).length, 2);
    d1.resolve(ok<WishlistView>({ items: [] }));
    await g1;
    assert.equal(wishlistSnap("u-t5").saved.has("p-x"), true); // 최신 GET만 반영
  });

  test("GET 실패 → status error · error 상태는 재조회를 허용한다", async () => {
    const { io, calls } = mkIo({
      getList: () => Promise.resolve(fail("NETWORK")),
    }, "u-t6");
    await ensureWishlist("u-t6", { io });
    assert.equal(wishlistSnap("u-t6").status, "error");
    const p = ensureWishlist("u-t6", { io });       // error는 ready/loading이 아니라 재시도 가능
    assert.ok(p);
    await p;
    assert.equal(gets(calls).length, 2);
  });

  test("refreshWishlist — ready 상태에서도 실제 새 GET을 시작한다", async () => {
    const { io, calls } = mkIo({
      getList: () => Promise.resolve(ok<WishlistView>({ items: [item("p-1")] })),
    }, "u-t7");
    await ensureWishlist("u-t7", { io });
    assert.equal(gets(calls).length, 1);
    await refreshWishlist("u-t7", io);
    assert.equal(gets(calls).length, 2);
  });
});

describe("toggleWishlist — intent·scope·outcome", () => {
  test("정상 저장: intent 선보존 → PUT ok → 해제 + 저장 반영 + display 보강 GET", async () => {
    const { io, calls, pending } = mkIo({
      getList: () => Promise.resolve(ok<WishlistView>({ items: [item("p-x")] })),
    }, "u-t8");
    const out = await toggleWishlist("u-t8", "p-x", true, io);
    assert.equal(kind(out), "SAVED");
    assert.equal(pending.size, 0);                  // 확정 시 intent 해제
    assert.equal(calls.filter((c) => c.startsWith("putPending")).length, 1);
    assert.equal(wishlistSnap("u-t8").saved.has("p-x"), true);
    // PUT 응답에 표시 정보가 없어 force 재조회가 트리거된다
    assert.equal(gets(calls).length, 1);
  });

  test("같은 상품 쓰기 진행 중 → BUSY (추가 PUT 0)", async () => {
    const d = deferred<ApiResult<SetWishlistResult>>();
    const { io, calls } = mkIo({ putSaved: () => d.promise }, "u-t9");
    const p1 = toggleWishlist("u-t9", "p-x", true, io);
    const out2 = await toggleWishlist("u-t9", "p-x", true, io);
    assert.equal(kind(out2), "BUSY");
    assert.equal(puts(calls).length, 1);            // PUT은 한 번뿐
    d.resolve(ok<SetWishlistResult>({ product_id: "p-x", saved: true, wishlist_count: 1 }));
    const out1 = await p1;
    assert.equal(kind(out1), "SAVED");
    // busy 해제 — 같은 상품의 다음 쓰기가 가능하다
    assert.equal(wishlistSnap("u-t9").busy.has("p-x"), false);
  });

  test("모호 실패(NETWORK) → LOST + intent 유지 → 같은 상품 재토글은 PENDING_EXISTS", async () => {
    const { io, pending, calls } = mkIo({
      putSaved: () => Promise.resolve(fail("NETWORK")),
    }, "u-t10");
    const out = await toggleWishlist("u-t10", "p-x", true, io);
    assert.equal(kind(out), "LOST");
    assert.equal(pending.size, 1);                  // intent 유지 — 복구 근거
    const again = await toggleWishlist("u-t10", "p-x", true, io);
    assert.equal(kind(again), "PENDING_EXISTS");    // 새 키 생성 차단
    assert.equal(puts(calls).length, 1);            // PUT은 여전히 한 번
  });

  test("확정 거절 → REJECTED + intent 해제", async () => {
    const { io, pending } = mkIo({
      putSaved: () => Promise.resolve(fail("UNAVAILABLE", "판매 중단 상품은 찜할 수 없어요")),
    }, "u-t11");
    const out = await toggleWishlist("u-t11", "p-x", true, io);
    assert.equal(kind(out), "REJECTED");
    if (out.kind === "REJECTED") assert.equal(out.code, "UNAVAILABLE");
    assert.equal(pending.size, 0);
  });

  test("await 중 scope 변경 → ABORTED · intent는 원 계정 버킷에 보존·스토어 미반영", async () => {
    const d = deferred<ApiResult<SetWishlistResult>>();
    const { io, pending, state } = mkIo({ putSaved: () => d.promise }, "u-t12");
    const p = toggleWishlist("u-t12", "p-x", true, io);
    await Promise.resolve();                        // putPending이 먼저 실행되도록 양보
    state.scope = "u-b";                            // 전송 후 계정 전환
    d.resolve(ok<SetWishlistResult>({ product_id: "p-x", saved: true, wishlist_count: 1 }));
    const out = await p;
    assert.equal(kind(out), "ABORTED");
    assert.equal(pending.size, 1);                  // removePending 미호출 — 원 버킷 보존
    assert.equal(wishlistSnap("u-t12").saved.has("p-x"), false); // 새어쓰기 없음
  });

  test("NOACTOR — userId null·scope 불일치면 putPending조차 호출하지 않는다", async () => {
    const { io, calls } = mkIo({}, "u-t13");
    assert.equal(kind(await toggleWishlist(null, "p-x", true, io)), "NOACTOR");
    assert.equal(kind(await toggleWishlist("u-other", "p-x", true, io)), "NOACTOR");
    assert.equal(calls.length, 0);
  });

  test("계정 격리 — 다른 계정의 스토어를 읽지 않는다", async () => {
    const { io } = mkIo({
      getList: () => Promise.resolve(ok<WishlistView>({ items: [item("p-1")] })),
    }, "u-t14");
    await ensureWishlist("u-t14", { io });
    assert.equal(wishlistSnap("u-t14").count, 1);
    assert.equal(wishlistSnap("u-t15").count, 0);   // 미적재 계정은 EMPTY
    assert.equal(wishlistSnap(null).count, 0);
  });
});

describe("wishPendingError — intent 형식·소속 검증", () => {
  const ioOf = (list: PendingWrite[]) => ({ listPending: () => list });
  test("kind/method/path·product/saved/key 불일치는 각각 거절", () => {
    const base = wishPw();
    const empty = ioOf([]);
    assert.equal(wishPendingError(base, empty), null);
    assert.ok(wishPendingError({ ...base, kind: "ADD_CART" }, empty));
    assert.ok(wishPendingError({ ...base, method: "POST" }, empty));
    assert.ok(wishPendingError({ ...base, path: "/api/wishlist/other" }, empty));
    assert.ok(wishPendingError(wishPw({}, { saved: "yes" }), empty));
    assert.ok(wishPendingError(wishPw({}, { idempotency_key: "different" }), empty));
  });
  test("requireListed — 현재 계정 버킷에 없는 intent는 재시도 대상이 아니다", () => {
    const pw = wishPw();
    assert.ok(wishPendingError(pw, ioOf([]), { requireListed: true }));
    assert.equal(wishPendingError(pw, ioOf([pw]), { requireListed: true }), null);
  });
});

describe("recoverWishlistPending / retryWishlistPending — 복구·재시도", () => {
  test("lookup SUCCEEDED → DONE + intent 해제 + 최신 목록으로 확정", async () => {
    const { io, pending, calls } = mkIo({
      lookupAction: () => Promise.resolve(ok({ status: "SUCCEEDED" })),
      getList: () => Promise.resolve(ok<WishlistView>({ items: [item("p-x")] })),
    }, "u-t16");
    const pw = wishPw();
    pending.set(pw.uiKey, pw);
    const out = await recoverWishlistPending("u-t16", pw, io);
    assert.equal(kind(out), "DONE");
    assert.equal(pending.size, 0);
    assert.equal(gets(calls).length, 1);            // refresh 발생
    assert.equal(wishlistSnap("u-t16").saved.has("p-x"), true);
  });

  test("lookup REJECTED → REJECTED + intent 해제 + 최신 목록 재확정", async () => {
    const { io, pending, calls } = mkIo({
      lookupAction: () => Promise.resolve(ok({ status: "REJECTED", error_code: "UNAVAILABLE" })),
      getList: () => Promise.resolve(ok<WishlistView>({ items: [] })),
    }, "u-t17");
    const pw = wishPw();
    pending.set(pw.uiKey, pw);
    const out = await recoverWishlistPending("u-t17", pw, io);
    assert.equal(kind(out), "REJECTED");
    assert.equal(pending.size, 0);
    assert.equal(gets(calls).length, 1);
  });

  test("lookup NOT_FOUND → RETRYABLE · 처리 중(READY) → UNKNOWN_KEEP · intent 유지", async () => {
    const { io, pending, calls } = mkIo({}, "u-t18"); // 기본 lookup은 NOT_FOUND
    const pw = wishPw();
    pending.set(pw.uiKey, pw);
    assert.equal(kind(await recoverWishlistPending("u-t18", pw, io)), "RETRYABLE");
    assert.equal(pending.size, 1);                  // 자동 재전송 없이 유지
    assert.equal(puts(calls).length, 0);
    const { io: io2, pending: pending2 } = mkIo({
      lookupAction: () => Promise.resolve(ok({ status: "READY" })),
    }, "u-t18");
    pending2.set(pw.uiKey, pw);
    assert.equal(kind(await recoverWishlistPending("u-t18", pw, io2)), "UNKNOWN_KEEP");
    assert.equal(pending2.size, 1);
  });

  test("retry 정상 — 같은 키·같은 payload 명시 재전송 → DONE + 해제", async () => {
    const { io, pending, calls } = mkIo({
      getList: () => Promise.resolve(ok<WishlistView>({ items: [item("p-x")] })),
    }, "u-t19");
    const pw = wishPw();
    pending.set(pw.uiKey, pw);
    const out = await retryWishlistPending("u-t19", pw, io);
    assert.equal(kind(out), "DONE");
    assert.equal(pending.size, 0);
    const put = puts(calls)[0] ?? "";
    assert.ok(put.includes(String.fromCharCode(34) + "idempotency_key" + String.fromCharCode(34) + ":" + String.fromCharCode(34) + "wk1"));
    assert.ok(put.includes(String.fromCharCode(34) + "saved" + String.fromCharCode(34) + ":true"));
  });

  test("retry 거절 — 변조 payload·비소속 intent는 재전송하지 않는다", async () => {
    const { io, pending, calls } = mkIo({}, "u-t20");
    // 다른 계정 버킷 소유 가능 intent — requireListed에서 거절
    const ghost = wishPw({ uiKey: "ghost" }, { idempotency_key: "ghost" });
    assert.equal(kind(await retryWishlistPending("u-t20", ghost, io)), "REJECTED");
    // 변조 payload — saved 비boolean을 임의 값으로 강제 변환하지 않는다
    const bad = wishPw();
    bad.payload.saved = "yes";
    pending.set(bad.uiKey, bad);
    assert.equal(kind(await retryWishlistPending("u-t20", bad, io)), "REJECTED");
    assert.equal(puts(calls).length, 0);            // 어떤 PUT도 발생하지 않는다
  });

  test("retry 모호 실패 → LOST + intent 유지", async () => {
    const { io, pending } = mkIo({
      putSaved: () => Promise.resolve(fail("NETWORK")),
    }, "u-t21");
    const pw = wishPw();
    pending.set(pw.uiKey, pw);
    assert.equal(kind(await retryWishlistPending("u-t21", pw, io)), "LOST");
    assert.equal(pending.size, 1);
  });

  test("recover 변조 intent → VALIDATION REJECTED · lookup도 호출하지 않는다", async () => {
    const { io, calls } = mkIo({}, "u-t22");
    const bad = wishPw({}, { idempotency_key: "different" });
    const out = await recoverWishlistPending("u-t22", bad, io);
    assert.equal(kind(out), "REJECTED");
    assert.equal(calls.filter((c) => c.startsWith("lookup")).length, 0);
  });
});
