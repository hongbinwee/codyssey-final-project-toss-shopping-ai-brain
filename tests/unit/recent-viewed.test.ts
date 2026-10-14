// 최근본 로컬 보관소 — 명시 actor 격리·계층 fallback 계약·손상 내성 검증.
// Node에는 Storage가 없으므로 in-memory stub을 심어 동작을 재현한다.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const local = new Map<string, string>();
const sess = new Map<string, string>();
let localReadFail = false;
let localWriteFail = false;
let sessReadFail = false;
let sessWriteFail = false;

(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => {
    if (localReadFail) throw new Error("denied");
    return local.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (localWriteFail) throw new Error("QuotaExceededError");
    local.set(k, v);
  },
  removeItem: (k: string) => {
    local.delete(k);
  },
};
(globalThis as Record<string, unknown>).sessionStorage = {
  getItem: (k: string) => {
    if (sessReadFail) throw new Error("denied");
    return sess.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (sessWriteFail) throw new Error("QuotaExceededError");
    sess.set(k, v);
  },
  removeItem: (k: string) => {
    sess.delete(k);
  },
};

const {
  recordRecentView,
  listRecentViews,
  removeRecentView,
  recentPersistence,
} = await import("../../src/web/recent-viewed.ts");

const KEY = (u: string) => "recent-viewed-v1:" + u;

beforeEach(() => {
  local.clear();
  sess.clear();
  localReadFail = localWriteFail = sessReadFail = sessWriteFail = false;
});

describe("recent-viewed 기록·순서", () => {
  test("최신 방문이 앞, 재방문은 맨 앞으로 이동(중복 없음)", () => {
    const u = "u-r1";
    recordRecentView(u, "p-a");
    recordRecentView(u, "p-b");
    recordRecentView(u, "p-c");
    assert.deepEqual(listRecentViews(u), ["p-c", "p-b", "p-a"]);
    recordRecentView(u, "p-a");
    assert.deepEqual(listRecentViews(u), ["p-a", "p-c", "p-b"]);
  });

  test("보관 상한을 넘으면 가장 오래된 것부터 잘린다", () => {
    const u = "u-r2";
    for (let i = 0; i < 55; i++) recordRecentView(u, "p-" + i);
    const ids = listRecentViews(u);
    assert.equal(ids.length, 50);
    assert.equal(ids[0], "p-54");
    assert.equal(ids.at(-1), "p-5");
  });

  test("null actor는 읽기·쓰기 모두 no-op", () => {
    recordRecentView(null, "p-a");
    recordRecentView("", "p-a");
    assert.deepEqual(listRecentViews(null), []);
    assert.equal(local.size, 0);
  });
});

describe("recent-viewed 계정 격리", () => {
  test("A→B→A 전환에서 각자 목록만 보인다", () => {
    recordRecentView("u-a1", "p-a");
    recordRecentView("u-a1", "p-a2");
    recordRecentView("u-b1", "p-b");
    assert.deepEqual(listRecentViews("u-b1"), ["p-b"]);
    assert.deepEqual(listRecentViews("u-a1"), ["p-a2", "p-a"]);
  });

  test("개별 삭제는 해당 id만 지우고 순서를 유지한다", () => {
    const u = "u-r3";
    recordRecentView(u, "p-a");
    recordRecentView(u, "p-b");
    recordRecentView(u, "p-c");
    removeRecentView(u, "p-b");
    assert.deepEqual(listRecentViews(u), ["p-c", "p-a"]);
    removeRecentView(u, "p-nope");
    assert.deepEqual(listRecentViews(u), ["p-c", "p-a"]);
  });
});

describe("recent-viewed storage fallback 계약", () => {
  test("local 쓰기 실패 시 session에 저장하고 reload 읽기는 최신 at을 고른다", () => {
    const u = "u-r4";
    // local에 과거 사본만 있는 상태에서 쓰기가 깨진 환경
    local.set(KEY(u), JSON.stringify({ at: 1, ids: ["p-old"] }));
    localWriteFail = true;
    recordRecentView(u, "p-new");
    // session에 최신본이 쓰였고, 읽기는 stale local이 아니라 session을 고른다.
    assert.ok(sess.has(KEY(u)), "session에 레코드가 있어야 한다");
    assert.deepEqual(listRecentViews(u), ["p-new", "p-old"]);
    assert.equal(recentPersistence(u), "session");
  });

  test("local 쓰기 회복 시 최신 레코드가 local로 이관되고 session 사본은 정리된다", () => {
    const u = "u-r5";
    localWriteFail = true;
    recordRecentView(u, "p-1");
    assert.equal(recentPersistence(u), "session");
    localWriteFail = false;
    recordRecentView(u, "p-2");
    assert.ok(local.has(KEY(u)), "local로 복귀 저장돼야 한다");
    assert.equal(sess.has(KEY(u)), false, "session 사본이 정리돼야 한다");
    assert.deepEqual(listRecentViews(u), ["p-2", "p-1"]);
    assert.equal(recentPersistence(u), "local");
  });

  test("local 읽기 자체가 불가면 session 계층 데이터를 읽는다", () => {
    const u = "u-r6";
    sess.set(KEY(u), JSON.stringify({ at: 7, ids: ["p-s1", "p-s2"] }));
    localReadFail = true;
    assert.deepEqual(listRecentViews(u), ["p-s1", "p-s2"]);
  });

  test("모든 storage 불가 → 인메모리 유지 + persistence=memory 정직 표시", () => {
    const u = "u-r7";
    localReadFail = localWriteFail = sessReadFail = sessWriteFail = true;
    recordRecentView(u, "p-m1");
    recordRecentView(u, "p-m2");
    assert.deepEqual(listRecentViews(u), ["p-m2", "p-m1"]);
    assert.equal(recentPersistence(u), "memory");
  });

  test("손상 JSON은 빈 목록으로 처리하고 다음 쓰기가 복구한다", () => {
    const u = "u-r8";
    local.set(KEY(u), "{broken json");
    assert.deepEqual(listRecentViews(u), []);
    recordRecentView(u, "p-ok");
    assert.deepEqual(listRecentViews(u), ["p-ok"]);
  });

  test("local 구버전 보유 + session 2회 쓰기 — 재읽기는 항상 최신 ids", () => {
    const u = "u-r9";
    // local에는 과거 사본만 있고 쓰기·지우기가 깨진 환경. 같은 ms에 두 번
    // 기록돼도 revision이 기존 at을 넘어야 재읽기가 최신을 고른다.
    local.set(KEY(u), JSON.stringify({ at: 50, ids: ["p-old"] }));
    localWriteFail = true;
    recordRecentView(u, "p-1");
    recordRecentView(u, "p-2");
    const sessRec = JSON.parse(sess.get(KEY(u)) ?? "{}");
    assert.ok(
      typeof sessRec.at === "number" && sessRec.at > 50,
      "session revision이 local 구버전보다 커야 한다",
    );
    assert.deepEqual(listRecentViews(u), ["p-2", "p-1", "p-old"]);
  });

  test("at 무효값(NaN·음수·문자열) 레코드는 무시된다", () => {
    const u = "u-r10";
    local.set(KEY(u), JSON.stringify({ at: "abc", ids: ["p-bad"] }));
    sess.set(KEY(u), JSON.stringify({ at: 3, ids: ["p-good"] }));
    assert.deepEqual(listRecentViews(u), ["p-good"]);
    local.set(KEY(u), JSON.stringify({ at: -9, ids: ["p-bad"] }));
    assert.deepEqual(listRecentViews(u), ["p-good"]);
  });

  test("저장된 중복·비문자열 id는 정제된다", () => {
    const u = "u-r11";
    local.set(
      KEY(u),
      JSON.stringify({ at: 2, ids: ["p-a", "p-a", 5, "", "p-b"] }),
    );
    assert.deepEqual(listRecentViews(u), ["p-a", "p-b"]);
  });
});
