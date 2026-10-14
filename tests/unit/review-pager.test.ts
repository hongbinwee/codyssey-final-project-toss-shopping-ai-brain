// src/web/review-pager.ts의 DB-free 검증 — '리뷰 더 보기' 실행기의 연타
// 단일 요청·실패 시 기존 리뷰/cursor 보존·명시 재시도·stale 응답 무변경을
// 실제 배선에 deferred mock을 꽂아 회귀한다 [PMQA-066 — PM 지적 배선 검증].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ApiResult } from "../../src/web/api.ts";
import type { ReviewItem, ReviewsResult } from "../../src/contracts.ts";
import { createReviewPager } from "../../src/web/review-pager.ts";

const rv = (id: string): ReviewItem => ({
  id,
  product_id: "p-t",
  variant_id: null,
  rating: 5,
  body: "body " + id,
  source_kind: "SYNTHETIC",
  source_ref: "test",
  written_at: "2026-01-01T00:00:00Z",
});

const page = (
  reviews: ReviewItem[],
  next_cursor: string | null,
): ApiResult<ReviewsResult> => ({
  ok: true,
  data: {
    reviews,
    total_matching: 99,
    returned_count: reviews.length,
    next_cursor,
    has_more: next_cursor !== null,
    sort: "LATEST",
  },
});

const deferred = <T>() => {
  let res!: (v: T) => void;
  let rej!: (e?: unknown) => void;
  const p = new Promise<T>((a, b) => {
    res = a;
    rej = b;
  });
  return { p, res, rej };
};

type Deps = {
  seq: number;
  reviews: ApiResult<ReviewsResult> | null;
  fetchPage: (c: string) => Promise<ApiResult<ReviewsResult>>;
  calls: { fetch: string[]; apply: ApiResult<ReviewsResult>[]; busy: boolean[]; errors: number };
};

const make = (over: Partial<Deps> = {}) => {
  const d: Deps = {
    seq: 0,
    reviews: page([rv("r1"), rv("r2"), rv("r3"), rv("r4")], "c1"),
    fetchPage: () => Promise.resolve(page([rv("r5")], null)),
    calls: { fetch: [], apply: [], busy: [], errors: 0 },
    ...over,
  };
  const { loadMore } = createReviewPager({
    getSeq: () => d.seq,
    getReviews: () => d.reviews,
    fetchPage: (c) => {
      d.calls.fetch.push(c);
      return d.fetchPage(c);
    },
    apply: (r) => d.calls.apply.push(r),
    setBusy: (b) => d.calls.busy.push(b),
    onError: () => d.calls.errors++,
  });
  return { d, loadMore };
};

describe("review-pager 더보기 실행기", () => {
  test("연타는 요청 1회만 발생시킨다", async () => {
    const { d, loadMore } = make();
    const df = deferred<ApiResult<ReviewsResult>>();
    d.fetchPage = () => df.p;
    const a = loadMore();
    const b = loadMore();
    const c = loadMore();
    // 첫 호출이 fetch를 동기 시작한 뒤 두 번째·세 번째는 잠금에 걸린다
    assert.deepEqual(d.calls.fetch, ["c1"]);
    df.res(page([rv("r5")], null));
    await Promise.all([a, b, c]);
    assert.equal(d.calls.apply.length, 1);
  });

  test("성공 페이지는 기존 리뷰 뒤에 이어 붙고 busy가 내려간다", async () => {
    const { d, loadMore } = make();
    await loadMore();
    assert.equal(d.calls.apply.length, 1);
    const applied = d.calls.apply[0];
    assert.ok(applied.ok);
    assert.deepEqual(
      applied.data.reviews.map((x) => x.id),
      ["r1", "r2", "r3", "r4", "r5"],
    );
    assert.deepEqual(d.calls.busy, [true, false]);
    assert.equal(d.calls.errors, 0);
  });

  test("next_cursor가 없으면 요청하지 않는다", async () => {
    const { d, loadMore } = make();
    d.reviews = page([rv("r1")], null);
    await loadMore();
    assert.equal(d.calls.fetch.length, 0);
    assert.equal(d.calls.busy.length, 0);
  });

  test("페이지 실패 → 기존 리뷰·cursor 보존 + 오류 신호 + 명시 재시도 성공", async () => {
    const { d, loadMore } = make();
    d.fetchPage = () =>
      Promise.resolve({ ok: false, error: { code: "HTTP_500", message: "x" } });
    await loadMore();
    // apply는 호출되지 않아 기존 리뷰·cursor가 그대로다
    assert.equal(d.calls.apply.length, 0);
    assert.equal(d.calls.errors, 1);
    assert.deepEqual(d.calls.busy, [true, false]);
    assert.ok(d.reviews?.ok && d.reviews.data.next_cursor === "c1");
    // 명시 재시도 — 잠금이 풀려 같은 cursor로 다시 요청한다
    d.fetchPage = () => Promise.resolve(page([rv("r5"), rv("r6")], null));
    await loadMore();
    assert.deepEqual(d.calls.fetch, ["c1", "c1"]);
    assert.equal(d.calls.apply.length, 1);
    assert.equal(
      d.calls.apply[0].ok && d.calls.apply[0].data.reviews.length,
      6,
    );
  });

  test("stale 응답은 목록·busy·error를 건드리지 않고 pager는 계속 쓸 수 있다", async () => {
    const { d, loadMore } = make();
    const df = deferred<ApiResult<ReviewsResult>>();
    d.fetchPage = () => df.p;
    const p1 = loadMore();
    // 응답 전에 세대 갱신(다른 상품·리로드·언마운트)
    d.seq = 1;
    df.res(page([rv("old")], null));
    await p1;
    assert.equal(d.calls.apply.length, 0);
    assert.equal(d.calls.errors, 0);
    // setBusy(true) 한 번뿐 — stale 응답이 새 세대의 로딩 표시를 내리지 않는다
    assert.deepEqual(d.calls.busy, [true]);
    // 같은 pager도 잠금이 남지 않아 다음 요청을 진행한다
    d.seq = 1;
    await loadMore();
    assert.equal(d.calls.fetch.length, 2);
    assert.equal(d.calls.apply.length, 1);
  });
});
