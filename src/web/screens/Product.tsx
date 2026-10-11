// W02 상품 상세·옵션·리뷰 — COMMERCE_UI_SPEC §7-1.
// - 진입 시 구매 가능한 첫 옵션을 자동 선택(품절 제외), 전품절만 CTA disabled/품절.
//   read 실패→재시도 성공 시에도 동일한 초기화 규칙을 적용한다.
// - 옵션 변경은 공용 BottomSheet, 조합/수량/금액 즉시 동기화.
// - 담기는 서버 재검증(expected cart/variant version + idempotency).
//   intent는 전송 전 pending 저장소에 보존하고, 응답 유실(AMBIGUOUS)은
//   결과 조회/명시 재시도로 복구한다 — 같은 actor의 미확정 cart write가
//   하나라도 있으면 새 담기·옵션·수량 변경을 잠그고 카트 복구로 안내한다.
// - 리뷰는 실제 cursor 페이지네이션(total_matching은 실제 행 수).
//
// 05 FIDELITY 보정 — Reference product-detail/04·05·20 기준 구조 [Observed]:
// - 상단 내비는 별도 backbar가 아니라 hero 위 플로팅 아이콘(← · 검색 · 카트+배지).
//   hero를 거의 지나 스크롤되면 읽기용 solid 바로 전환한다.
// - 정보 계층: 이름 → 브랜드·설명 → 할인율+정가 → 판매가 → 평점·리뷰 진입 행 → 배송 행.
//   평점은 /api/products 목록에서 product_id 정확 매칭으로만 결정 — 요청 실패/미매칭은
//   별도 안내와 재시도를 제공하며 '아직 리뷰 없어요'로 오인시키지 않는다. 리뷰 수와
//   정확히 일치하는 요약만 사용하고 부분 로드 평균은 만들지 않는다.
// - 본문 하단은 [리뷰 (n개) | 상품 정보] sticky 탭. 정렬 UI는 없다 —
//   서버 getReviews는 최신순만 지원하므로 추천순을 흉내내지 않는다.
// - 리뷰 행은 카드 대신 flat row + divider — variant id가 아니라 옵션 라벨로 표시.
// - 하단 바는 [카트 진입][옵션 선택][N원 담기]. 찜·뽑기 등 미지원 기능은 없다 [Project].
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiSafe, fmtWon, newActionKey, AMBIGUOUS_CODES, type ApiResult } from "../api.ts";
import type {
  CartView, MatchedVariant, ProductDetail, ProductSummary, ReviewsResult, SearchResult,
} from "../../contracts.ts";
import { Empty, ErrorState, Loading } from "../components/CommerceState.tsx";
import { BottomSheet } from "../components/BottomSheet.tsx";
import { PRODUCT_META, SPEC_LABEL, productImg } from "../display-meta.ts";
import {
  listCartPending, putPending, removePending, lookupAction,
  type PendingWrite,
} from "../pending.ts";
import { IcBack, IcCart, IcChevronRight, IcSearch, IcStar } from "../icons.tsx";

type RatingLoad =
  | { state: "loading" }
  | { state: "error" }
  | { state: "unmatched" }
  | { state: "loaded"; summary: ProductSummary };

export function Product({
  productId,
  onBack,
  onOpenSearch,
  onOpenCart,
  onCartChanged,
  cartCount,
}: {
  productId: string;
  onBack: () => void;
  onOpenSearch: () => void;
  onOpenCart: () => void;
  onCartChanged: (v: CartView) => void;
  cartCount: number;
}) {
  const [detail, setDetail] = useState<ApiResult<ProductDetail> | null>(null);
  const [reviews, setReviews] = useState<ApiResult<ReviewsResult> | null>(null);
  // 목록 API의 rating_summary — product_id 정확 매칭만 사용한다.
  const [summary, setSummary] = useState<RatingLoad>({ state: "loading" });
  const [variantId, setVariantId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<"reviews" | "info">("reviews");
  const [navSolid, setNavSolid] = useState(false);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [addedOk, setAddedOk] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [pendings, setPendings] = useState<PendingWrite[]>(() => listCartPending());
  const [imgIdx, setImgIdx] = useState(0);
  const seq = useRef(0);
  const heroRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  // double-click 같은 동기 중복 호출 차단 — state 반영 전 두 번째 호출을 막는다.
  const busyRef = useRef(false);

  // pending 저장소 변경을 구독 — 같은 actor의 미확정 cart write를 전역 잠금에 쓴다.
  useEffect(() => {
    const on = () => setPendings(listCartPending());
    addEventListener("pending-writes", on);
    return () => removeEventListener("pending-writes", on);
  }, []);

  const pickDefault = (d: ProductDetail) =>
    d.variants.find((v) => v.availability === "AVAILABLE")?.variant_id ?? null;

  // 초기 로드: detail+reviews. 재시도도 같은 경로를 타야 초기화 규칙이 동일하다.
  const loadInitial = useCallback(async (pid: string, my: number) => {
    const r = await apiSafe<ProductDetail>("/api/products/" + pid);
    if (seq.current !== my) return;
    setDetail(r);
    if (r.ok) {
      setVariantId(pickDefault(r.data));
      setQty(1);
    }
  }, []);
  const loadReviews = useCallback(async (pid: string, my: number, limit = 4) => {
    const r = await apiSafe<ReviewsResult>(
      "/api/products/" + pid + "/reviews?limit=" + limit,
    );
    if (seq.current === my) setReviews(r);
  }, []);

  // 평점·리뷰 진입 행용 — 목록 응답에서 같은 product_id만 매칭한다.
  // 실패와 미포함은 별도 상태로 보존해 빈 리뷰와 혼동하지 않는다.
  const loadSummary = useCallback(async (pid: string, my: number) => {
    setSummary({ state: "loading" });
    const r = await apiSafe<SearchResult>("/api/products?limit=50");
    if (seq.current !== my) return;
    if (!r.ok) {
      setSummary({ state: "error" });
      return;
    }
    const match = r.data.items.find((x) => x.product_id === pid);
    setSummary(match ? { state: "loaded", summary: match } : { state: "unmatched" });
  }, []);

  // 플로팅 내비 → hero를 거의 지나면 읽기용 solid 바로 전환 [Observed 05 + Project].
  // hero가 없는 로딩/에러 상태는 detail-null 시 nav 쪽에서 solid를 강제한다.
  useEffect(() => {
    const on = () => {
      const h = heroRef.current?.offsetHeight ?? 0;
      setNavSolid(window.scrollY > Math.max(h - 56, 8));
    };
    on();
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, [detail?.ok]);

  // 확정 거절 뒤 최신화: 현재 선택이 아직 구매 가능하면 유지하고,
  // 품절됐으면 첫 AVAILABLE로 다시 고른다(초기화와 규칙 통일).
  const refreshDetail = useCallback(async (pid: string) => {
    const my = seq.current;
    const r = await apiSafe<ProductDetail>("/api/products/" + pid);
    if (seq.current !== my || !r.ok) return;
    setDetail(r);
    setVariantId((cur) => {
      const still =
        cur &&
        r.data.variants.some(
          (v) => v.variant_id === cur && v.availability === "AVAILABLE",
        );
      return still ? cur : pickDefault(r.data);
    });
  }, []);

  // productId 변경 → 모든 상태 리셋 + 후행 응답 차단(stale 누출 방지)
  useEffect(() => {
    const my = ++seq.current;
    setDetail(null);
    setReviews(null);
    setSummary({ state: "loading" });
    setVariantId(null);
    setQty(1);
    setImgIdx(0);
    setTab("reviews");
    setFeedback(null);
    setAddedOk(false);
    loadInitial(productId, my);
    loadReviews(productId, my);
    loadSummary(productId, my);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // 이 상품의 미확정 담기 + actor의 모든 미확정 cart write (전역 잠금)
  const pendingAdd =
    pendings.find(
      (p) => p.kind === "ADD_CART" && p.payload.product_id === productId,
    ) ?? null;
  const anyPending = pendings.length > 0;

  const selected: MatchedVariant | null = useMemo(
    () =>
      detail?.ok
        ? detail.data.variants.find((v) => v.variant_id === variantId) ?? null
        : null,
    [detail, variantId],
  );
  const anyAvailable = detail?.ok
    ? detail.data.variants.some((v) => v.availability === "AVAILABLE")
    : false;
  const totalWon = selected ? selected.unit_price_won * qty : 0;

  async function syncCart() {
    const c = await apiSafe<CartView>("/api/cart");
    if (c.ok) onCartChanged(c.data);
    return c;
  }

  async function add() {
    if (!selected || adding || busyRef.current || anyPending || !detail?.ok)
      return;
    busyRef.current = true;
    setAdding(true);
    setFeedback(null);
    setAddedOk(false);
    const key = newActionKey();
    const cartRes = await apiSafe<CartView>("/api/cart");
    if (!cartRes.ok) {
      busyRef.current = false;
      setAdding(false);
      setFeedback("카트를 확인하지 못했어요. 다시 시도해 주세요.");
      return;
    }
    const payload = {
      product_id: productId,
      variant_id: selected.variant_id,
      quantity: qty,
      expected_cart_version: cartRes.data.version,
      expected_variant_version: selected.version,
      idempotency_key: key,
    };
    // 응답 전에 intent를 보존 — 서버 commit 후 응답 유실·탭 종료 대비.
    const pw: PendingWrite = {
      uiKey: key,
      kind: "ADD_CART",
      path: "/api/cart/items",
      method: "POST",
      payload,
      label: detail.data.product.name,
      at: Date.now(),
    };
    putPending(pw);
    const r = await apiSafe<{ cart: CartView; changed_item_id: string }>(
      pw.path,
      { method: "POST", body: JSON.stringify(payload) },
    );
    busyRef.current = false;
    setAdding(false);
    if (r.ok) {
      removePending(key);
      setFeedback("장바구니에 담았어요");
      setAddedOk(true);
      // replay(저장 snapshot)면 최신 카트를 다시 읽는다 — 그 사이 다른 변경이
      // 있을 수 있어 replay 본문을 그대로 적용하지 않는다.
      if (r.replayed) await syncCart();
      else onCartChanged(r.data.cart);
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) return; // pending 유지 → 복구 UI
    // 확정 거절(VERSION_CONFLICT/OUT_OF_STOCK 등) — 자동 재실행 없이
    // 최신 상태를 다시 읽고 사용자 재확인을 요구한다.
    removePending(key);
    setFeedback("담기 실패: " + r.error.message);
    await refreshDetail(productId);
    await syncCart();
  }

  async function checkAddPending() {
    const p = pendingAdd;
    if (!p) return;
    const r = await lookupAction(p);
    if (!r.ok) {
      if (r.error.code === "NOT_FOUND") {
        // 서버에 기록이 없음 — 새 키 발급/자동 재전송 없이 사용자가
        // 같은 intent를 명시 재시도하도록 둔다.
        setFeedback(
          "요청 기록이 없어요. '다시 담기'로 같은 요청을 재시도할 수 있어요.",
        );
        return;
      }
      setFeedback("결과를 조회하지 못했어요. 잠시 후 다시 시도해 주세요.");
      return;
    }
    const st = r.data.status;
    if (st === "SUCCEEDED") {
      removePending(p.uiKey);
      // 조회 결과는 historical snapshot일 수 있으므로 최신 카트를 다시 읽는다.
      const c = await syncCart();
      if (c.ok) {
        setFeedback("담기가 완료된 요청이었어요. 카트에 반영했습니다.");
        setAddedOk(true);
      } else {
        setFeedback(
          "처리는 완료된 요청이었어요. 최신 카트는 장바구니에서 확인해 주세요.",
        );
      }
      return;
    }
    if (st === "REJECTED") {
      removePending(p.uiKey);
      setFeedback("요청이 거절되었어요. 최신 상태를 확인해 주세요.");
      await refreshDetail(productId);
      await syncCart();
      return;
    }
    if (st === "READY") {
      setFeedback("아직 처리 중이에요. 잠시 후 다시 확인해 주세요.");
      return;
    }
    // 서버 status는 READY|SUCCEEDED|REJECTED — 예상치 못한 값이면
    // intent를 유지한 채 다음 확인에 맡긴다.
    setFeedback("결과를 확인할 수 없어요. 잠시 후 다시 시도해 주세요.");
  }

  async function retryPendingAdd() {
    const p = pendingAdd;
    if (!p || busyRef.current) return;
    busyRef.current = true;
    setAdding(true);
    const r = await apiSafe<{ cart: CartView }>(p.path, {
      method: p.method,
      body: JSON.stringify(p.payload),
    });
    busyRef.current = false;
    setAdding(false);
    if (r.ok) {
      removePending(p.uiKey);
      // 재시도는 보통 replay — 저장 snapshot 대신 항상 최신 카트를 회수해 표시.
      await syncCart();
      setFeedback("장바구니에 담았어요");
      setAddedOk(true);
      return;
    }
    if (AMBIGUOUS_CODES.has(r.error.code)) {
      setFeedback("아직 결과를 확인할 수 없어요. '결과 확인'으로 이어서 확인하세요.");
      return;
    }
    removePending(p.uiKey);
    setFeedback("담기 실패: " + r.error.message);
    await refreshDetail(productId);
    await syncCart();
  }

  async function loadMoreReviews() {
    if (!reviews?.ok || !reviews.data.next_cursor || moreLoading) return;
    setMoreLoading(true);
    const my = seq.current;
    const r = await apiSafe<ReviewsResult>(
      "/api/products/" + productId + "/reviews?limit=10&cursor=" +
        encodeURIComponent(reviews.data.next_cursor),
    );
    setMoreLoading(false);
    if (seq.current !== my) return;
    if (r.ok)
      setReviews({
        ok: true,
        data: {
          ...r.data,
          reviews: [...reviews.data.reviews, ...r.data.reviews],
        },
      });
    else setFeedback("리뷰를 더 불러오지 못했어요");
  }

  // 리뷰 작성일 표기 — "26.6.22" 형태 [Observed reviews/19]
  const fmtDate = (iso: string) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const d = new Date(t);
    return String(d.getFullYear()).slice(2) + "." + (d.getMonth() + 1) + "." + d.getDate();
  };

  // 리뷰의 variant_id를 옵션 라벨로 resolve — 서버는 active variant만 돌려주므로
  // 목록에 없으면 내부 id 대신 '옵션 정보 없음'으로 둔다.
  const variantLabel = (vid: string | null): string | null => {
    if (!vid) return null;
    const v = detail?.ok
      ? detail.data.variants.find((x) => x.variant_id === vid)
      : undefined;
    return v ? Object.values(v.option_values).join(" · ") : "옵션 정보 없음";
  };

  const goReviews = () => {
    setTab("reviews");
    const el = tabsRef.current;
    if (el)
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.scrollY - 56,
        behavior: "smooth",
      });
  };

  // hero 위 플로팅 내비 — 로딩/에러(hero 없음)와 스크롤 후엔 solid로 읽기 배경 확보.
  const navEl = (
    <nav className={"detail-nav" + (navSolid || !detail?.ok ? " solid" : "")}>
      <button className="dn-btn" aria-label="뒤로가기" onClick={onBack}>
        <IcBack size={24} />
      </button>
      <div className="dn-side">
        <button className="dn-btn" aria-label="검색" onClick={onOpenSearch}>
          <IcSearch size={20} />
        </button>
        <button className="dn-btn" aria-label="장바구니" onClick={onOpenCart}>
          <IcCart size={21} />
          {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
        </button>
      </div>
    </nav>
  );

  if (!detail)
    return (
      <div className="screen detail bare">
        {navEl}
        <Loading />
      </div>
    );
  if (!detail.ok)
    return (
      <div className="screen detail bare">
        {navEl}
        <ErrorState
          text={"상품을 불러오지 못했어요 (" + detail.error.code + ")"}
          onRetry={() => {
            const my = ++seq.current;
            setDetail(null);
            loadInitial(productId, my);
            loadReviews(productId, my);
            loadSummary(productId, my);
          }}
        />
      </div>
    );
  const p = detail.data.product;
  const images = p.images?.length
    ? p.images
    : [productImg({ product_id: p.id, image: null })];
  // getProduct는 active variant만 반환 — 전부 비활성이면 variants=[]도 유효
  // 응답이다. 유효 단가가 없을 때 Math.min의 Infinity가 화면에 새지 않게
  // null로 둔다(판매 불가 상태는 soldOutAll이 표시한다).
  const unitPrices = detail.data.variants
    .map((v) => v.unit_price_won)
    .filter((x): x is number => Number.isFinite(x));
  const minWon = unitPrices.length ? Math.min(...unitPrices) : null;
  const orig = PRODUCT_META[p.id]?.original_price_won;
  // 할인율은 현재 표시 단가와 같은 기준으로 계산 — 고가 옵션(32인치 등) 선택 시
  // 최저가 기준 %와 본문 금액이 어긋나지 않게 한다.
  const shownWon = selected?.unit_price_won ?? minWon;
  const rate =
    shownWon != null && orig && orig > shownWon
      ? Math.round(((orig - shownWon) / orig) * 100)
      : 0;
  const delivery = PRODUCT_META[p.id]?.delivery;
  const soldOutAll = !anyAvailable;
  const reviewTotal = reviews?.ok ? reviews.data.total_matching : null;
  const exactRating =
    summary.state === "loaded" &&
    reviewTotal !== null &&
    summary.summary.rating_summary.count === reviewTotal &&
    summary.summary.rating_summary.avg !== null
      ? summary.summary.rating_summary.avg
      : null;
  const ratingText =
    !reviews
      ? "리뷰 정보를 확인 중이에요"
      : !reviews.ok
        ? "리뷰 정보를 확인할 수 없어요"
        : summary.state === "loading" && reviewTotal === 0
          ? "리뷰 정보를 확인 중이에요"
          : summary.state === "loaded" && summary.summary.rating_summary.count !== reviewTotal
            ? reviewTotal === 0
              ? "리뷰 정보가 일치하지 않아요"
              : "리뷰 " + reviewTotal + "개 · 평점 집계 확인 중"
            : reviewTotal === 0
              ? summary.state === "loaded"
                ? "아직 리뷰가 없어요"
                : "리뷰 0개 · 평점 요약을 확인할 수 없어요"
              : summary.state === "loading"
            ? "리뷰 " + reviewTotal + "개 · 평점 불러오는 중"
            : summary.state === "error"
              ? "리뷰 " + reviewTotal + "개 · 평점 정보를 불러오지 못했어요"
              : summary.state === "unmatched"
                ? "리뷰 " + reviewTotal + "개 · 상품 평점을 확인할 수 없어요"
                : exactRating === null
                  ? "리뷰 " + reviewTotal + "개 · 평점 집계 확인 중"
                  : null;

  return (
    <div className={"screen detail" + (anyPending ? " has-pending" : "")}>
      {navEl}
      <div className="detail-hero" ref={heroRef}>
        {images.length > 1 ? (
          <div
            className="hero-strip"
            onScroll={(e) => {
              const el = e.currentTarget;
              setImgIdx(Math.round(el.scrollLeft / el.clientWidth));
            }}
          >
            {images.map((src, i) => (
              <img key={i} src={src} alt={p.name} />
            ))}
          </div>
        ) : (
          <img
            src={images[0]}
            alt={p.name}
            onError={(e) => {
              const el = e.currentTarget;
              el.style.display = "none";
              el.parentElement?.setAttribute("data-fallback", p.name.slice(0, 1));
            }}
          />
        )}
        {soldOutAll && <div className="soldout-cover">품절</div>}
        <span className="hero-count">
          {imgIdx + 1}|{images.length}
        </span>
      </div>

      <h2 className="detail-name">{p.name}</h2>
      <div className="muted">
        {p.brand} · {p.description}
      </div>

      {rate > 0 && orig ? (
        <div className="price-line">
          <span className="rate">{rate}%</span>
          <s>{fmtWon(orig)}</s>
        </div>
      ) : null}
      {shownWon != null && <div className="price-main">{fmtWon(shownWon)}</div>}
      {/* Ref04의 가격 보조 행 — 서버 배송료만 표시한다 (단가·적립 등 미지원 정보는 없다). */}
      <div className="price-sub">
        {detail.data.shipping_fee_won > 0
          ? "배송비 " + fmtWon(detail.data.shipping_fee_won)
          : "무료배송"}
      </div>

      <div className="info-rows">
        <button className="info-row" onClick={goReviews}>
          <span className="info-k">평점 · 리뷰</span>
          <span className="info-v">
            <span className="info-rating-main">
              {exactRating != null && reviewTotal != null ? (
                <>
                  <IcStar size={13} className="info-star" /> {exactRating}
                  <span className="muted">({reviewTotal}개)</span>
                </>
              ) : (
                <span className="muted">{ratingText}</span>
              )}
            </span>
            <small className="review-provenance-note">
              저장된 실사용·시연 리뷰 전체 기준
            </small>
          </span>
          <IcChevronRight size={15} className="info-next" />
        </button>
        {delivery && (
          <div className="info-row static">
            <span className="info-k">배송</span>
            <span className="info-v">
              {delivery}
              <small className="signal-demo">데모</small>
            </span>
          </div>
        )}
      </div>
      {(summary.state === "error" || summary.state === "unmatched") && (
        <button className="link rating-retry" onClick={() => loadSummary(productId, seq.current)}>
          평점 다시 확인
        </button>
      )}

      <h3 className="section-title">옵션</h3>
      <button
        className="option-open"
        onClick={() => setSheetOpen(true)}
        disabled={soldOutAll || anyPending}
      >
        <span>
          {selected
            ? Object.values(selected.option_values).join(" · ")
            : soldOutAll
              ? "구매 가능한 옵션이 없어요"
              : "옵션을 선택하세요"}
        </span>
        <IcChevronRight size={16} />
      </button>
      {selected && (
        <div className="qty-row">
          <span>수량</span>
          <div className="qty-ctrl">
            <button
              onClick={() => setQty(Math.max(1, qty - 1))}
              disabled={qty <= 1 || anyPending}
            >
              −
            </button>
            <b>{qty}</b>
            <button
              onClick={() => setQty(qty + 1)}
              disabled={anyPending || qty >= selected.stock_qty}
              title={qty >= selected.stock_qty ? "재고를 초과할 수 없어요" : undefined}
            >
              +
            </button>
          </div>
          <span className="muted">재고 {selected.stock_qty}개</span>
        </div>
      )}

      <div className="detail-tabs" ref={tabsRef} role="tablist" aria-label="상품 상세 정보">
        <button
          role="tab"
          aria-selected={tab === "reviews"}
          className={tab === "reviews" ? "on" : ""}
          onClick={() => setTab("reviews")}
        >
          리뷰 ({reviewTotal ?? "…"}개)
        </button>
        <button
          role="tab"
          aria-selected={tab === "info"}
          className={tab === "info" ? "on" : ""}
          onClick={() => setTab("info")}
        >
          상품 정보
        </button>
      </div>

      {tab === "reviews" ? (
        <section className="detail-panel review-panel" role="tabpanel">
          {!reviews ? (
            <Loading text="리뷰 불러오는 중…" />
          ) : !reviews.ok ? (
            <ErrorState
              text="리뷰를 불러오지 못했어요"
              onRetry={() => {
                const my = seq.current;
                setReviews(null);
                loadReviews(productId, my);
              }}
            />
          ) : reviews.data.total_matching === 0 ? (
            <Empty text="아직 리뷰가 없어요. 근거로 쓸 실사용 평가가 부족합니다." />
          ) : (
            <>
              <div className="review-summary-head">
                <span className="muted">이 상품의 리뷰 전체</span>
                {exactRating != null && reviewTotal != null && (
                  <div className="review-rating">
                    <IcStar size={20} className="review-star" />
                    <b>{exactRating}</b>
                    <span className="muted">({reviewTotal}개)</span>
                  </div>
                )}
              </div>
              <div className="review-summary muted">
                리뷰 {reviews.data.total_matching}개
                {reviews.data.reviews.length < reviews.data.total_matching &&
                  " · " + reviews.data.reviews.length + "개 표시"}
              </div>
              <p className="review-provenance muted">
                평점과 리뷰 수는 저장된 모든 출처(실사용·시연)를 포함해요. 리뷰별 출처는 각 항목에 표시합니다.
              </p>
              <ul className="review-list">
                {reviews.data.reviews.map((rv) => (
                  <li key={rv.id} className="review-item">
                    <div className="review-head">
                      <b aria-label={"별점 " + rv.rating + "점"}>{"★".repeat(rv.rating)}</b>
                      <span
                        className={
                          "src-chip" + (rv.source_kind === "SYNTHETIC" ? " syn" : "")
                        }
                      >
                        {rv.source_kind === "SYNTHETIC" ? "시연 리뷰" : "실사용 리뷰"}
                      </span>
                      <time className="review-date" dateTime={rv.written_at}>{fmtDate(rv.written_at)}</time>
                    </div>
                    {rv.variant_id && (
                      <div className="review-option muted">옵션 {variantLabel(rv.variant_id)}</div>
                    )}
                    <p>{rv.body}</p>
                  </li>
                ))}
              </ul>
              {reviews.data.has_more && (
                <button className="link" onClick={loadMoreReviews} disabled={moreLoading}>
                  {moreLoading ? "불러오는 중…" : "리뷰 더 보기"}
                </button>
              )}
            </>
          )}
        </section>
      ) : (
        <section className="detail-panel detail-info-panel" role="tabpanel">
          <p>{p.description}</p>
          <dl>
            {Object.entries(p.specs).map(([k, v]) => (
              <div key={k} className="spec-row">
                <dt>{SPEC_LABEL[k] ?? k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className={"bottom-bar" + (anyPending ? " has-note" : "")}>
        {anyPending && (
          // 미확정 write가 있으면 고정 바 최상단에서 바로 복구로 진입 — 상세
          // state-box는 문서 하단이라 첫 화면에서 발견되지 않는다.
          <div className="bar-note" role="status">
            <span>결과를 확인하지 못한 요청이 있어요</span>
            <button className="link" onClick={onOpenCart}>
              장바구니에서 복구
            </button>
          </div>
        )}
        <div className="bar-row detail-actions">
          <button className="detail-cart-btn" aria-label="장바구니" onClick={onOpenCart}>
            <IcCart size={21} />
            {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          </button>
          <button
            className="detail-option-cta"
            disabled={soldOutAll || anyPending}
            onClick={() => setSheetOpen(true)}
          >
            옵션 선택
          </button>
          <button
            className="btn primary"
            aria-label={soldOutAll ? "품절" : adding ? "담는 중" : fmtWon(totalWon) + " 담기"}
            disabled={!selected || adding || anyPending || soldOutAll}
            onClick={add}
          >
            {soldOutAll ? "품절" : adding ? "담는 중…" : fmtWon(totalWon) + " 담기"}
          </button>
        </div>
      </div>

      {sheetOpen && detail.ok && (
        <BottomSheet title="옵션 선택" onClose={() => setSheetOpen(false)}>
          <div className="sheet-list">
            {detail.data.variants.map((v) => {
              const soldOut = v.availability !== "AVAILABLE";
              const on = v.variant_id === variantId;
              return (
                <button
                  key={v.variant_id}
                  className={"sort-item" + (on ? " on" : "")}
                  disabled={soldOut}
                  onClick={() => {
                    setVariantId(v.variant_id);
                    setQty(1);
                    setFeedback(null);
                    setSheetOpen(false);
                  }}
                >
                  <span>
                    {Object.values(v.option_values).join(" · ")}
                    <span className="desc">
                      {soldOut
                        ? v.availability === "SOLD_OUT"
                          ? "품절"
                          : "판매 중단"
                        : "재고 " + v.stock_qty + "개"}
                    </span>
                  </span>
                  <b>{fmtWon(v.unit_price_won)}</b>
                  {on && <span className="sort-check">✓</span>}
                </button>
              );
            })}
          </div>
        </BottomSheet>
      )}

      {pendingAdd ? (
        <div className="state-box">
          <b>담기 결과를 확인하지 못했어요</b>
          <p className="muted">
            {pendingAdd.label} — 같은 요청이 중복으로 들어가지 않게 잠겨 있어요.
          </p>
          <div className="sheet-actions">
            <button className="btn ghost" onClick={checkAddPending}>
              결과 확인
            </button>
            <button
              className="btn primary"
              onClick={retryPendingAdd}
              disabled={adding}
            >
              다시 담기
            </button>
          </div>
          <button className="link" onClick={onOpenCart}>
            장바구니에서 확인하기
          </button>
        </div>
      ) : anyPending ? (
        // 다른 화면에서 시작된 미확정 cart write — 결과가 확정되기 전엔
        // 새 담기·옵션·수량 변경을 잠그고 카트 복구로 안내한다.
        <div className="state-box">
          <b>확인되지 않은 이전 요청이 있어요</b>
          <p className="muted">결과가 확정되기 전에는 새 변경을 할 수 없어요.</p>
          <button className="btn ghost" onClick={onOpenCart}>
            장바구니에서 결과 확인
          </button>
        </div>
      ) : null}
      {feedback && (
        <div className="toast">
          {feedback}
          {addedOk && (
            <button className="link" onClick={onOpenCart}>
              장바구니 보기
            </button>
          )}
        </div>
      )}
    </div>
  );
}
