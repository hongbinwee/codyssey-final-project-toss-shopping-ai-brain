// 검색 화면 — 최근 검색어(recents) / 자동완성(suggest) / 결과(results) 3상태.
// 표시 모드는 입력값과 마지막 제출어 비교로 결정한다. URL의 ?q=는 공유·뒤로가기용.
import { useEffect, useRef, useState } from "react";
import { api, type ApiResult } from "../api.ts";
import type { SearchResult } from "../../contracts.ts";
import { ProductCard } from "../components/ProductCard.tsx";
import { BottomSheet } from "../components/BottomSheet.tsx";
import { Empty, ErrorState } from "../components/CommerceState.tsx";
import { IcBack, IcCart, IcCheck, IcChevronDown, IcClock, IcClose, IcSearch } from "../icons.tsx";
import { CATEGORY_GROUPS, groupOf, groupLabel } from "../display-meta.ts";

const RECENTS_KEY = "recent-searches";
const loadRecents = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
};
const saveRecents = (list: string[]) =>
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 10)));

type Sort = "RELEVANCE" | "PRICE_ASC";
const SORT_LABEL: Record<Sort, string> = {
  RELEVANCE: "추천순",
  PRICE_ASC: "낮은 가격순",
};
const SORT_DESC: Record<Sort, string> = {
  RELEVANCE: "평점이 높은 상품부터 보여줘요",
  PRICE_ASC: "최저가 옵션 기준으로 정렬해요",
};

// 입력한 부분만 강조 (토스쇼핑 자동완성 패턴)
function Marked({ name, needle }: { name: string; needle: string }) {
  const i = name.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, i)}
      <mark>{name.slice(i, i + needle.length)}</mark>
      {name.slice(i + needle.length)}
    </>
  );
}

export function Search({
  query,
  onBack,
  onSubmit,
  onOpenProduct,
  cartCount = 0,
  onOpenCart,
}: {
  query: string;
  onBack: () => void;
  onSubmit: (q: string) => void;
  onOpenProduct: (id: string) => void;
  cartCount?: number;
  onOpenCart?: () => void;
}) {
  const [text, setText] = useState(query);
  const [submitted, setSubmitted] = useState(query);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [sugs, setSugs] = useState<ApiResult<SearchResult> | null>(null);
  const [res, setRes] = useState<ApiResult<SearchResult> | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [sort, setSort] = useState<Sort>("RELEVANCE");
  const [cat, setCat] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 뒤로가기 등으로 URL의 q가 바뀌면 입력값/제출어를 동기화
  useEffect(() => {
    setText(query);
    setSubmitted(query);
    setCat("");
  }, [query]);

  useEffect(() => inputRef.current?.focus(), []);

  // 자동완성 — 입력이 마지막 제출어와 다르고 비어있지 않을 때만
  useEffect(() => {
    if (!text || text === submitted) {
      setSugs(null);
      return;
    }
    const t = setTimeout(() => {
      api<SearchResult>("/api/products?query=" + encodeURIComponent(text) + "&limit=5").then(setSugs);
    }, 150);
    return () => clearTimeout(t);
  }, [text, submitted]);

  // 결과 조회
  useEffect(() => {
    if (!submitted) return;
    setLoading(true);
    api<SearchResult>(
      // 카테고리 칩은 상위 그룹(digital/beauty/...)으로, 결과에서 클라이언트 필터한다.
      // 서버 category 파라미터는 단일 값만 받아 monitor가 디지털 그룹에 못 들어가므로 쓰지 않는다.
      "/api/products?query=" + encodeURIComponent(submitted) + "&sort=" + sort,
    )
      .then(setRes)
      .finally(() => setLoading(false));
  }, [submitted, sort, tick]);

  const submit = (q: string) => {
    const v = q.trim();
    if (!v) return;
    setText(v);
    setSubmitted(v);
    setRecents((r) => {
      const next = [v, ...r.filter((x) => x !== v)];
      saveRecents(next);
      return next;
    });
    onSubmit(v);
    inputRef.current?.blur();
  };

  const removeRecent = (w: string) =>
    setRecents((r) => {
      const next = r.filter((x) => x !== w);
      saveRecents(next);
      return next;
    });

  const mode =
    text !== submitted ? (text ? "suggest" : "recents") : submitted ? "results" : "recents";

  // 결과에 등장한 상위 그룹으로 필터 칩을 만든다 (데이터 없는 필터는 보여주지 않는다)
  const resItems = res?.ok ? res.data.items : [];
  const cats = CATEGORY_GROUPS.filter((g) =>
    resItems.some((i) => groupOf(i.category) === g.id),
  ).map((g) => g.id);
  const shown = cat ? resItems.filter((i) => groupOf(i.category) === cat) : resItems;

  return (
    <div className="search-screen">
      <form
        className="search-head"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <button type="button" className="back-btn" aria-label="뒤로가기" onClick={onBack}>
          <IcBack size={24} />
        </button>
        <div className="search-field">
          <span className="field-ico"><IcSearch size={18} /></span>
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="검색어를 입력하세요"
            enterKeyHint="search"
          />
          {text && (
            <button
              type="button"
              className="clear-btn"
              aria-label="지우기"
              onClick={() => {
                setText("");
                inputRef.current?.focus();
              }}
            >
              <IcClose size={10} />
            </button>
          )}
        </div>
        <button type="button" className="icon-btn" aria-label="장바구니" onClick={onOpenCart}>
          <IcCart size={23} />
          {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
        </button>
      </form>

      {mode === "recents" && (
        <section className="search-body">
          <h3 className="section-h">최근 검색어</h3>
          {recents.length === 0 ? (
            <p className="muted sm">최근 검색 기록이 없어요</p>
          ) : (
            recents.map((w) => (
              <div key={w} className="recent-row">
                <button className="recent-word" onClick={() => submit(w)}>
                  <IcClock size={18} /> {w}
                </button>
                <button
                  className="rm"
                  aria-label={w + " 삭제"}
                  onClick={() => removeRecent(w)}
                >
                  <IcClose size={14} />
                </button>
              </div>
            ))
          )}
        </section>
      )}

      {mode === "suggest" && (
        <section className="search-body">
          {sugs?.ok && sugs.data.items.length > 0 ? (
            sugs.data.items.map((p) => (
              <button
                key={p.product_id}
                className="recent-row sug-row"
                onClick={() => submit(p.name)}
              >
                <Marked name={p.name} needle={text} />
              </button>
            ))
          ) : (
            <p className="muted sm">일치하는 상품명이 없어요</p>
          )}
        </section>
      )}

      {mode === "results" && (
        <section className="search-body results-zone">
          <div className="chip-row">
            <button className={"fchip" + (cat === "" ? " on" : "")} onClick={() => setCat("")}>
              전체
            </button>
            {cats.map((c) => (
              <button
                key={c}
                className={"fchip" + (cat === c ? " on" : "")}
                onClick={() => setCat(c)}
              >
                {groupLabel(c)}
              </button>
            ))}
            <button className="fchip sort-trigger" onClick={() => setSortOpen(true)}>
              {SORT_LABEL[sort]} <IcChevronDown size={14} />
            </button>
          </div>
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
          ) : shown.length === 0 ? (
            <Empty text="조건에 맞는 상품이 없어요" />
          ) : (
            <div className="product-grid">
              {shown.map((p) => (
                <ProductCard
                  key={p.product_id}
                  p={p}
                  onOpen={() => onOpenProduct(p.product_id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {sortOpen && (
        <BottomSheet title="정렬" onClose={() => setSortOpen(false)}>
          {(["RELEVANCE", "PRICE_ASC"] as Sort[]).map((s) => (
            <button
              key={s}
              className="sort-item"
              onClick={() => {
                setSort(s);
                setSortOpen(false);
              }}
            >
              <span>
                {SORT_LABEL[s]}
                <span className="desc">{SORT_DESC[s]}</span>
              </span>
              {sort === s && <span className="sort-check"><IcCheck size={18} /></span>}
            </button>
          ))}
        </BottomSheet>
      )}
    </div>
  );
}
