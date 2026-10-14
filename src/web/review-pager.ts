// 상세 인라인 리뷰와 전체 리뷰 화면이 공용으로 쓰는 '리뷰 더 보기' 실행기 —
// cursor 페이지네이션·동기 잠금·stale 가드의 단일 배선이다 [PMQA-066].
// 화면별 상태만 deps로 꽂고 호출 경로는 이 팩토리가 만든 함수 하나다.
import type { ApiResult } from "./api.ts";
import type { ReviewsResult } from "../contracts.ts";

export type ReviewPagerDeps = {
  // 세대 식별 — 값이 바뀌면(다른 상품·리로드·언마운트) 이후 도착하는
  // 응답은 stale로 버린다.
  getSeq: () => number;
  // 현재 화면의 리뷰 상태 — ref mirror라 비동기 콜백도 최신 값을 읽는다.
  getReviews: () => ApiResult<ReviewsResult> | null;
  fetchPage: (cursor: string) => Promise<ApiResult<ReviewsResult>>;
  apply: (r: ApiResult<ReviewsResult>) => void;
  setBusy: (busy: boolean) => void;
  onError: () => void;
};

export function createReviewPager(deps: ReviewPagerDeps) {
  let busy = false;
  let reqSeq = 0;
  async function loadMore() {
    const cur = deps.getReviews();
    if (!cur?.ok || !cur.data.next_cursor || busy) return;
    // state set보다 먼저 동기 잠금 — 연타의 두 번째 호출은 여기서 멈춘다.
    busy = true;
    const req = ++reqSeq;
    deps.setBusy(true);
    const my = deps.getSeq();
    const r = await deps.fetchPage(cur.data.next_cursor);
    if (deps.getSeq() !== my) {
      // stale — 목록·busy·error 등 화면 상태는 새 세대가 관리한다.
      // 자신이 아직 최신 요청이면 내부 잠금만 풀어 pager가 죽지 않게 한다.
      if (req === reqSeq) busy = false;
      return;
    }
    busy = false;
    deps.setBusy(false);
    if (r.ok)
      deps.apply({
        ok: true,
        data: {
          ...r.data,
          reviews: [...cur.data.reviews, ...r.data.reviews],
        },
      });
    else deps.onError();
  };
  return { loadMore };
}
