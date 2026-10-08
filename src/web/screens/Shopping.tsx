// 쇼핑 홈 — Toss Shopping 캡처 기준 재구성(04-C).
// 상단 탭은 그룹 필터가 아니라 콘텐츠가 다른 쇼핑 홈들이다:
// 쇼핑 홈/뷰티/식품/카테고리/특가/시즌 추천. 디지털·패션·리빙은 카테고리 탭과
// 숏컷으로 진입하는 리스팅 뷰. 가격·재고·평점은 API가 정본이고
// 정가·배송 라벨·섹션 태그는 display-meta의 표시용 메타다.
import { useEffect, useRef, useState, type ComponentType } from "react";
import { api, fmtWon, type ApiResult } from "../api.ts";
import type { ProductSummary, SearchResult } from "../../contracts.ts";
import { ProductCard } from "../components/ProductCard.tsx";
import { Empty, ErrorState } from "../components/CommerceState.tsx";
import {
  IcBulb, IcCart, IcChevronRight, IcClock, IcCup, IcDrop, IcGrid,
  IcMonitor, IcReceipt, IcShirt, IcStar, IcTag,
} from "../icons.tsx";
import {
  CATEGORY_GROUPS, CONTENT_TABS, GROUP_HERO, HOME_HERO, PRODUCT_META,
  SEASONAL, SUBCATS, TOP_TABS, groupOf, groupLabel, minPriceOf,
  productImg, rateOf, subcatOf,
} from "../display-meta.ts";

/* ── 히어로 캐러셀 — 카드형(좌 텍스트+우 이미지) / cover형(풀블리드 이미지+하단 텍스트) ── */
function Hero({
  products,
  cover,
  onOpen,
}: {
  products: ProductSummary[];
  cover?: boolean;
  onOpen: (id: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [, setIdx] = useState(0);
  if (!products.length) return null;
  const onScroll = () => {
    const el = trackRef.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!el || !first) return;
    const step = first.offsetWidth + 8;
    setIdx(Math.min(products.length - 1, Math.round(el.scrollLeft / step)));
  };
  return (
    <div className="hero-track" ref={trackRef} onScroll={onScroll}>
      {products.map((p, i) => {
        const meta = PRODUCT_META[p.product_id];
        const rate = rateOf(p);
        return (
          <button
            key={p.product_id}
            className={"hero-slide" + (cover ? " cover" : "")}
            onClick={() => onOpen(p.product_id)}
          >
            {cover && <img className="hero-bg" src={productImg(p)} alt="" />}
            <span className="hero-txt">
              {rate > 0 && <b className="hero-rate">{rate}% 특가</b>}
              <b className="hero-name">{p.name}</b>
              <b className="hero-price">{fmtWon(minPriceOf(p))}</b>
              <span className="hero-sub">
                {[p.brand, meta?.delivery].filter(Boolean).join(" · ")}
              </span>
            </span>
            {!cover && <img className="hero-img" src={productImg(p)} alt={p.name} />}
            <span className="hero-idx">{i + 1}|{products.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── 리스트형 딜 카드 — 특가/시즌 탭의 큰 이미지 카드 [Observed 34/50] ── */
function DealCard({ p, dealTag, onOpen }: { p: ProductSummary; dealTag?: string; onOpen: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  const meta = PRODUCT_META[p.product_id];
  const rate = rateOf(p);
  const min = minPriceOf(p);
  return (
    <button className="deal-card" onClick={onOpen}>
      <div className="deal-thumb">
        {imgErr ? (
          <span className="thumb-fallback">{p.name.slice(0, 1)}</span>
        ) : (
          <img src={productImg(p)} alt={p.name} loading="lazy" onError={() => setImgErr(true)} />
        )}
        {rate > 0 && (
          <span className="thumb-badge">{dealTag ? dealTag + " " + rate + "%" : rate + "% 특가"}</span>
        )}
        <span className="deal-cart" aria-hidden><IcCart size={18} /></span>
      </div>
      <div className="deal-info">
        <div className="deal-name">{p.name}</div>
        <div className="deal-price">
          {fmtWon(min)}
          {rate > 0 && meta?.original_price_won && (
            <span className="price-orig">{fmtWon(meta.original_price_won)}</span>
          )}
        </div>
        {p.rating_summary.avg !== null && (
          <div className="product-meta">
            <IcStar size={12} /> {p.rating_summary.avg}{" "}
            <span className="muted">({p.rating_summary.count})</span>
          </div>
        )}
      </div>
    </button>
  );
}

/* ── 서브카테고리 아이템 (원형/스퀘어 아이콘 + 라벨) ── */
function SubcatItem({
  groupId,
  subId,
  square,
  items,
  onNav,
}: {
  groupId: string;
  subId: string;
  square?: boolean;
  items: ProductSummary[];
  onNav: (cat: string, sub?: string) => void;
}) {
  const s = subcatOf(groupId, subId);
  if (!s) return null;
  const rep = items.find((i) => i.product_id === s.productIds[0]);
  return (
    <button className="sub-item" onClick={() => onNav(groupId, s.id)}>
      <span className={"sub-circle" + (square ? " sq" : "")}>
        {rep && <img src={productImg(rep)} alt="" loading="lazy" />}
      </span>
      <span className="sub-label">{s.label}</span>
    </button>
  );
}

/* ── 뷰 ───────────────────────────────────────────────── */

function HomeView({
  items,
  userName,
  onNav,
  onOpen,
  onOpenOrders,
  onOpenCart,
}: {
  items: ProductSummary[];
  userName: string;
  onNav: (cat: string, sub?: string) => void;
  onOpen: (id: string) => void;
  onOpenOrders: () => void;
  onOpenCart: () => void;
}) {
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const hero = HOME_HERO.map((id) => byId.get(id)).filter(Boolean) as ProductSummary[];
  const maxRate = Math.max(0, ...items.map(rateOf));
  // 정적 추천 — 그룹별 recommended 우선 정렬 후 카테고리 라운드로빈.
  // 홈 첫 화면이 디지털 등 한 카테고리로 치우치지 않게 섞는다 [Observed: 원본은 식품·생활 중심 혼합].
  const GROUP_ORDER = ["food", "beauty", "living", "digital", "fashion"];
  const buckets = new Map<string, ProductSummary[]>();
  for (const p of items) {
    const g = groupOf(p.category);
    const arr = buckets.get(g);
    if (arr) arr.push(p);
    else buckets.set(g, [p]);
  }
  for (const arr of buckets.values()) {
    arr.sort(
      (a, b) =>
        (PRODUCT_META[b.product_id]?.sections?.includes("recommended") ? 1 : 0) -
        (PRODUCT_META[a.product_id]?.sections?.includes("recommended") ? 1 : 0),
    );
  }
  const keys = [
    ...GROUP_ORDER.filter((g) => buckets.has(g)),
    ...[...buckets.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];
  const ordered: ProductSummary[] = [];
  for (let i = 0, more = true; more; i++) {
    more = false;
    for (const g of keys) {
      const p = buckets.get(g)![i];
      if (p) {
        ordered.push(p);
        more = true;
      }
    }
  }
  const shortcuts: { icon: ComponentType<{ size?: number }>; label: string; run: () => void }[] = [
    { icon: IcGrid, label: "카테고리", run: () => onNav("category") },
    { icon: IcTag, label: "오늘의 특가", run: () => onNav("sale") },
    { icon: IcDrop, label: "뷰티", run: () => onNav("beauty") },
    { icon: IcCup, label: "식품", run: () => onNav("food") },
    { icon: IcMonitor, label: "디지털", run: () => onNav("digital") },
    { icon: IcShirt, label: "패션", run: () => onNav("fashion") },
    { icon: IcBulb, label: "리빙", run: () => onNav("living") },
    { icon: IcReceipt, label: "내 주문", run: onOpenOrders },
    { icon: IcCart, label: "장바구니", run: onOpenCart },
  ];
  return (
    <>
      <Hero products={hero} onOpen={onOpen} />
      <button className="benefit" onClick={() => onNav("sale")}>
        <b>특가 · 배송 혜택 모아보기</b>
        <span className="benefit-chip">최대 {maxRate}%</span>
      </button>
      <div className="shortcut-rail">
        {shortcuts.map((s) => (
          <button key={s.label} className="sc-item" onClick={s.run}>
            <span className="sc-ico"><s.icon size={24} /></span>
            <span className="sc-label">{s.label}</span>
          </button>
        ))}
      </div>
      <h3 className="section-h rec-h">{userName}님을 위한 추천 상품</h3>
      <div className="product-grid">
        {ordered.map((p) => (
          <ProductCard key={p.product_id} p={p} onOpen={() => onOpen(p.product_id)} />
        ))}
      </div>
    </>
  );
}

function GroupHome({
  cat,
  items,
  userName,
  onNav,
  onOpen,
}: {
  cat: string;
  items: ProductSummary[];
  userName: string;
  onNav: (cat: string, sub?: string) => void;
  onOpen: (id: string) => void;
}) {
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const hero = (GROUP_HERO[cat] ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean) as ProductSummary[];
  const subs = SUBCATS[cat] ?? [];
  const gItems = items.filter((i) => groupOf(i.category) === cat);
  return (
    <>
      <Hero products={hero} cover onOpen={onOpen} />
      {subs.length > 0 && (
        <div className="icon-rail">
          {subs.map((s) => (
            <SubcatItem key={s.id} groupId={cat} subId={s.id} square items={items} onNav={onNav} />
          ))}
        </div>
      )}
      <h3 className="section-h rec-h">{userName}님을 위한 {groupLabel(cat)} 추천</h3>
      {gItems.length === 0 ? (
        <Empty text="이 카테고리의 상품이 아직 없어요" />
      ) : (
        <div className="product-grid">
          {gItems.map((p) => (
            <ProductCard key={p.product_id} p={p} onOpen={() => onOpen(p.product_id)} />
          ))}
        </div>
      )}
    </>
  );
}

function CategoryBrowser({
  items,
  onNav,
}: {
  items: ProductSummary[];
  onNav: (cat: string, sub?: string) => void;
}) {
  const [g, setG] = useState(CATEGORY_GROUPS[0].id);
  const subs = SUBCATS[g] ?? [];
  return (
    <div className="cat-browser">
      <div className="cat-rail">
        {CATEGORY_GROUPS.map((x) => (
          <button
            key={x.id}
            className={"cat-rail-i" + (x.id === g ? " on" : "")}
            onClick={() => setG(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="cat-pane">
        <div className="cat-pane-head">
          <b>{groupLabel(g)}</b>
          <button className="cat-all" onClick={() => onNav(g)}>
            전체보기 <IcChevronRight size={14} />
          </button>
        </div>
        <div className="sub-grid">
          {subs.map((s) => (
            <SubcatItem key={s.id} groupId={g} subId={s.id} items={items} onNav={onNav} />
          ))}
        </div>
      </div>
    </div>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function SaleView({
  items,
  onNav,
  onOpen,
}: {
  items: ProductSummary[];
  onNav: (cat: string) => void;
  onOpen: (id: string) => void;
}) {
  const [left, setLeft] = useState("00:00:00");
  useEffect(() => {
    const f = () => {
      const n = Date.now();
      const e = new Date();
      e.setHours(24, 0, 0, 0);
      const d = Math.max(0, e.getTime() - n);
      setLeft(
        pad2(Math.floor(d / 3600000)) +
          ":" + pad2(Math.floor((d / 60000) % 60)) +
          ":" + pad2(Math.floor((d / 1000) % 60)),
      );
    };
    f();
    const t = setInterval(f, 1000);
    return () => clearInterval(t);
  }, []);
  const deals = items.filter(
    (i) =>
      i.availability !== "SOLD_OUT" &&
      PRODUCT_META[i.product_id]?.sections?.includes("flash-sale"),
  );
  const promo = deals[0];
  return (
    <>
      {/* 상단 프로모 카드 + 보조 탭 [Observed 34]. 미지원 탭은 disabled로 Demo임을 드러낸다. */}
      {promo && (
        <button className="sale-promo" onClick={() => onOpen(promo.product_id)}>
          <span className="sp-txt">
            <b>
              오늘만 이 가격
              <br />
              하루 특가 모음
            </b>
            <span className="sp-sub">매일 자정 새로운 특가</span>
          </span>
          <img src={productImg(promo)} alt="" />
        </button>
      )}
      <nav className="sale-tabs">
        <button className="sale-tab on">하루 특가</button>
        <button className="sale-tab" disabled title="준비 중">
          셀러 특가
        </button>
        <button className="sale-tab" onClick={() => onNav("season")}>
          기획전
        </button>
        <button className="sale-tab" disabled title="준비 중">
          쿠폰 혜택
        </button>
      </nav>
      <div className="sale-timer">
        <IcClock size={15} />
        <b>{left}</b>
        <span>동안만 특가</span>
      </div>
      <h2 className="sale-title">오늘만 이 가격에 살 수 있어요</h2>
      {deals.map((p) => (
        <DealCard key={p.product_id} p={p} dealTag="하루특가" onOpen={() => onOpen(p.product_id)} />
      ))}
    </>
  );
}

function SeasonView({
  items,
  userName,
  onOpen,
}: {
  items: ProductSummary[];
  userName: string;
  onOpen: (id: string) => void;
}) {
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const picks = SEASONAL.map((id) => byId.get(id)).filter(Boolean) as ProductSummary[];
  const heroP = byId.get("p-d-lamp-2");
  return (
    <>
      <div className="season-hero">
        <span className="season-txt">
          <b>쌀쌀해지는 계절</b>
          <b>홈카페 · 무드등 기획전</b>
          <span>따뜻하게 준비하는 우리 집</span>
        </span>
        {heroP && <img className="season-img" src={productImg(heroP)} alt="" />}
      </div>
      <h3 className="section-h rec-h">
        <em className="accent">{userName}</em>님이 좋아할 만한 상품
      </h3>
      {picks.map((p) => (
        <DealCard key={p.product_id} p={p} onOpen={() => onOpen(p.product_id)} />
      ))}
    </>
  );
}

function ListView({
  cat,
  sub,
  items,
  onOpen,
}: {
  cat: string;
  sub: string;
  items: ProductSummary[];
  onOpen: (id: string) => void;
}) {
  const sc = sub ? subcatOf(cat, sub) : undefined;
  const list = sc
    ? items.filter((i) => sc.productIds.includes(i.product_id))
    : items.filter((i) => groupOf(i.category) === cat);
  return (
    <>
      <h3 className="section-h list-h">
        {sc ? sc.label : groupLabel(cat)}
        <span className="muted cnt">{list.length}</span>
      </h3>
      {list.length === 0 ? (
        <Empty text="조건에 맞는 상품이 없어요" />
      ) : (
        <div className="product-grid">
          {list.map((p) => (
            <ProductCard key={p.product_id} p={p} onOpen={() => onOpen(p.product_id)} />
          ))}
        </div>
      )}
    </>
  );
}

export function Shopping({
  category,
  sub,
  userName,
  onNav,
  onOpenProduct,
  onOpenOrders,
  onOpenCart,
}: {
  category: string;
  sub: string;
  userName: string;
  onNav: (cat: string, sub?: string) => void;
  onOpenProduct: (id: string) => void;
  onOpenOrders: () => void;
  onOpenCart: () => void;
}) {
  const [res, setRes] = useState<ApiResult<SearchResult> | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    api<SearchResult>("/api/products?limit=50")
      .then(setRes)
      .finally(() => setLoading(false));
  }, [tick]);

  const items = res?.ok ? res.data.items : [];

  // 상단 탭 활성 상태 — 그룹 리스팅 진입 시 해당 콘텐츠 탭을 유지한다.
  const grp = groupOf(category);
  const activeTab =
    !category ? ""
    : category === "sale" ? "sale"
    : category === "season" ? "season"
    : category === "category" ? "category"
    : grp === "beauty" ? "beauty"
    : grp === "food" ? "food"
    : "category";

  const view =
    !category ? "home"
    : category === "sale" ? "sale"
    : category === "season" ? "season"
    : category === "category" ? "category"
    : sub ? "list"
    : CONTENT_TABS.has(grp) ? "cathome"
    : "list";

  return (
    <div className="screen">
      <nav className="shop-tabs">
        {TOP_TABS.map((t) => (
          <button
            key={t.id}
            className={"shop-tab" + (activeTab === t.id ? " on" : "")}
            onClick={() => onNav(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {loading ? (
        <div className="product-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skel-card">
              <div className="skel-thumb" />
              <div className="skel-line" />
              <div className="skel-line sm" />
            </div>
          ))}
        </div>
      ) : !res ? null : !res.ok ? (
        <ErrorState
          text={"조회에 실패했어요 (" + res.error.code + ")"}
          onRetry={() => setTick((t) => t + 1)}
        />
      ) : view === "home" ? (
        <HomeView
          items={items}
          userName={userName}
          onNav={onNav}
          onOpen={onOpenProduct}
          onOpenOrders={onOpenOrders}
          onOpenCart={onOpenCart}
        />
      ) : view === "cathome" ? (
        <GroupHome
          cat={grp}
          items={items}
          userName={userName}
          onNav={onNav}
          onOpen={onOpenProduct}
        />
      ) : view === "category" ? (
        <CategoryBrowser items={items} onNav={onNav} />
      ) : view === "sale" ? (
        <SaleView items={items} onNav={onNav} onOpen={onOpenProduct} />
      ) : view === "season" ? (
        <SeasonView items={items} userName={userName} onOpen={onOpenProduct} />
      ) : (
        <ListView cat={grp} sub={sub} items={items} onOpen={onOpenProduct} />
      )}
    </div>
  );
}
