// F07 전체 리뷰 전용 화면 — COMMERCE_UI_SPEC §7·Ref19 구조 [Observed].
// 상단 뒤로 아이콘만 → '이 상품의 모든 상점 리뷰' 라벨 → 큰 별+평점+개수
// 클러스터 → '전체 리뷰' + 정렬 영역 → divider 리뷰 행 + cursor 페이지네이션.
// 정렬은 Ref127의 우측 chevron→우측 정렬 둥근 팝오버로 구현한다 — 바텀시트로
// 단순 대체하지 않는다 [PMQA-068]. 서버는 최신순·별점 높은순·별점 낮은순
// 3종만 지원하고 '추천순'은 순위 알고리즘 계약이 없어 제공하지 않는다
// (데이터 Gap — 허위 알고리즘 UI 금지). 정렬 변경은 서버 재조회이며
// 진행 중인 이전 요청·커서는 세대 무효화로 차단한다. 사진/작성자/도움됨은
// 미지원 데이터라 만들지 않는다. 평점은 리뷰 수와 정확히 일치하는 목록
// 요약만 사용하고 부분 로드 평균은 만들지 않는다(상세와 같은 계약).
import { useCallback, useEffect, useRef, useState } from "react";
import { apiSafe, type ApiResult } from "../api.ts";
import type {
  ProductDetail,
  ProductSummary,
  ReviewSort,
  ReviewsResult,
  SearchResult,
} from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { ReviewRow, Stars } from "../components/ReviewBits.tsx";
import { IcBack, IcCheck, IcChevronDown } from "../icons.tsx";
import { createReviewPager } from "../review-pager.ts";

// Ref127 팝오버 — 서버 계약에 있는 3종만 노출한다 ('추천순' 제외 = 데이터 Gap).
const REVIEW_SORTS: { key: ReviewSort; label: string }[] = [
  { key: "LATEST", label: "최신순" },
  { key: "RATING_DESC", label: "별점 높은순" },
  { key: "RATING_ASC", label: "별점 낮은순" },
];

type RatingLoad =
  | { state: "loading" }
  | { state: "error" }
  | { state: "unmatched" }
  | { state: "loaded"; summary: ProductSummary };

export function Reviews({
  productId,
  onBack,
}: {
  productId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ApiResult<ProductDetail> | null>(null);
  const [reviews, setReviews] = useState<ApiResult<ReviewsResult> | null>(null);
  const [summary, setSummary] = useState<RatingLoad>({ state: "loading" });
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState(false);
  // Ref127 — '전체 리뷰' 우측 정렬 트리거의 현재값과 팝오버 개폐.
  const [sort, setSort] = useState<ReviewSort>("LATEST");
  const [sortOpen, setSortOpen] = useState(false);
  const seq = useRef(0);
  // 더보기 실행기 — 세대별 인스턴스. 최신 reviews는 ref mirror로 읽는다.
  const reviewsRef = useRef<ApiResult<ReviewsResult> | null>(null);
  reviewsRef.current = reviews;
  const pagerRef = useRef<ReturnType<typeof createReviewPager> | null>(null);

  const loadAll = useCallback(async (pid: string, srt: ReviewSort, my: number) => {
    const [d, rv, ls] = await Promise.all([
      apiSafe<ProductDetail>("/api/products/" + pid),
      apiSafe<ReviewsResult>("/api/products/" + pid + "/reviews?limit=10&sort=" + srt),
      apiSafe<SearchResult>("/api/products?limit=50"),
    ]);
    if (seq.current !== my) return;
    setDetail(d);
    setReviews(rv);
    if (!ls.ok) setSummary({ state: "error" });
    else {
      const match = ls.data.items.find((x) => x.product_id === pid);
      setSummary(match ? { state: "loaded", summary: match } : { state: "unmatched" });
    }
  }, []);

  useEffect(() => {
    const my = ++seq.current;
    // 이전 상품/요청 흐름의 로딩 표시를 해제하고 다시 시작한다.
    setMoreLoading(false);
    setMoreError(false);
    setSortOpen(false);
    setDetail(null);
    setReviews(null);
    setSummary({ state: "loading" });
    pagerRef.current = createReviewPager({
      getSeq: () => seq.current,
      getReviews: () => reviewsRef.current,
      fetchPage: (c) =>
        apiSafe<ReviewsResult>(
          "/api/products/" + productId + "/reviews?limit=10&sort=" + sort +
            "&cursor=" + encodeURIComponent(c),
        ),
      apply: setReviews,
      setBusy: setMoreLoading,
      onError: () => setMoreError(true),
    });
    loadAll(productId, sort, my);
    // 언마운트·productId/정렬 변경 시 진행 중 응답을 stale로 무효화한다 —
    // pager의 in-flight도 같은 세대를 읽으므로 함께 차단된다.
    return () => {
      seq.current++;
    };
  }, [productId, sort, loadAll]);

  // 정렬 팝오버 ESC 닫기 — Ref127은 앵커 팝오버라 공용 BottomSheet를
  // 재사용하지 않는다.
  useEffect(() => {
    if (!sortOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSortOpen(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sortOpen]);

  const loadMore = () => {
    setMoreError(false);
    pagerRef.current?.loadMore();
  };

  const reviewTotal = reviews?.ok ? reviews.data.total_matching : null;
  const exactRating =
    summary.state === "loaded" &&
    reviewTotal !== null &&
    summary.summary.rating_summary.count === reviewTotal &&
    summary.summary.rating_summary.avg !== null
      ? summary.summary.rating_summary.avg
      : null;

  const variantLabel = (vid: string | null): string | null => {
    if (!vid) return null;
    const v = detail?.ok
      ? detail.data.variants.find((x) => x.variant_id === vid)
      : undefined;
    return v ? Object.values(v.option_values).join(" · ") : "옵션 정보 없음";
  };
  const fmtDate = (iso: string) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t);
    return String(d.getFullYear()).slice(2) + "." + (d.getMonth() + 1) + "." + d.getDate();
  };

  return (
    <div className="screen reviews-full">
      <header className="rev-nav">
        <button className="back-btn" aria-label="뒤로가기" onClick={onBack}>
          <IcBack size={24} />
        </button>
      </header>

      {!reviews ? (
        <Loading text="리뷰 불러오는 중…" />
      ) : !reviews.ok ? (
        <ErrorState
          text="리뷰를 불러오지 못했어요"
          onRetry={() => {
            // ++seq로 진행 중인 stale 응답(더보기 포함)을 무효화한다.
            const my = ++seq.current;
            setMoreLoading(false);
            setMoreError(false);
            setReviews(null);
            loadAll(productId, sort, my);
          }}
        />
      ) : reviews.data.total_matching === 0 ? (
        <Empty text="아직 리뷰가 없어요. 근거로 쓸 실사용 평가가 부족합니다." />
      ) : (
        <>
          <div className="rev-scope muted">이 상품의 모든 상점 리뷰</div>
          {exactRating != null && reviewTotal != null && (
            <div className="rev-cluster">
              <Stars rating={exactRating} size={20} />
              <b className="rev-avg">{exactRating}</b>
              <span className="muted">({reviewTotal}개)</span>
            </div>
          )}
          <small className="review-provenance-note">실사용·시연 리뷰 기준</small>

          <div className="rev-list-head">
            <b>전체 리뷰</b>
            <div className="rev-sort-wrap">
              <button
                type="button"
                className="rev-sort-trigger"
                aria-haspopup="listbox"
                aria-expanded={sortOpen}
                onClick={() => setSortOpen((v) => !v)}
              >
                {REVIEW_SORTS.find((s) => s.key === sort)?.label}
                <IcChevronDown size={13} />
              </button>
              {sortOpen && (
                <>
                  {/* 스크림 — 팝오버 바깥 탭으로 닫는다 (시트 아님). */}
                  <div
                    className="rev-sort-scrim"
                    onClick={() => setSortOpen(false)}
                  />
                  <div className="rev-sort-pop" role="listbox" aria-label="리뷰 정렬">
                    {REVIEW_SORTS.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        role="option"
                        aria-selected={s.key === sort}
                        className={"rev-sort-item" + (s.key === sort ? " sel" : "")}
                        onClick={() => {
                          setSort(s.key);
                          setSortOpen(false);
                        }}
                      >
                        {s.label}
                        {s.key === sort && <IcCheck size={14} className="rev-sort-check" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          <ul className="review-list">
            {reviews.data.reviews.map((rv) => (
              <ReviewRow
                key={rv.id}
                rv={rv}
                optionLabel={rv.variant_id ? variantLabel(rv.variant_id) : null}
                dateText={fmtDate(rv.written_at)}
              />
            ))}
          </ul>
          {moreError && (
            <div className="review-more-error" role="alert">
              <span className="error-text">리뷰를 더 불러오지 못했어요.</span>
              <button className="link" onClick={loadMore}>
                다시 시도
              </button>
            </div>
          )}
          {reviews.data.has_more && (
            <button className="link" onClick={loadMore} disabled={moreLoading}>
              {moreLoading ? "불러오는 중…" : "리뷰 더 보기"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
