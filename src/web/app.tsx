import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
import type { CartView } from "../contracts.ts";
import { Shopping } from "./screens/Shopping.tsx";
import { Search } from "./screens/Search.tsx";
import { Product } from "./screens/Product.tsx";
import { Cart } from "./screens/Cart.tsx";
import { Checkout } from "./screens/Checkout.tsx";
import { Orders } from "./screens/Orders.tsx";
import { OrderDetail } from "./screens/OrderDetail.tsx";
import { AgentPanel, type AgentReply } from "./components/AgentPanel.tsx";
import type { AgentBrain } from "./api.ts";
import { IcBack, IcBagFill, IcCart, IcHome, IcMenu, IcReceipt, IcSearch, IcSparkle, IcTag, IcUser } from "./icons.tsx";

type Route =
  | { name: "shop"; category: string; sub: string }
  | { name: "search"; query: string }
  | { name: "product"; id: string }
  | { name: "cart" }
  | { name: "checkout" }
  | { name: "orders" }
  | { name: "order"; id: string };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, "");
  const [path, qs] = h.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (path === "/search") return { name: "search", query: params.get("q") ?? "" };
  if (path.startsWith("/p/")) return { name: "product", id: decodeURIComponent(path.slice(3)) };
  if (path === "/cart") return { name: "cart" };
  if (path === "/checkout") return { name: "checkout" };
  if (path === "/orders") return { name: "orders" };
  if (path.startsWith("/orders/")) return { name: "order", id: decodeURIComponent(path.slice(8)) };
  return { name: "shop", category: params.get("cat") ?? "", sub: params.get("sub") ?? "" };
}

// 앱 내부 해시 이력은 history.state 마커로 추적한다.
// pushState로 만든 엔트리는 {app:1, internal:1} — 직전 엔트리가 앱 내부 화면임을 보장한다.
// 외부/직접 해시 진입 엔트리는 mount·hashchange 시 {app:1}로만 마킹(internal 없음).
// 뒤로가기: internal 플래그가 있으면 history.back(), 없으면 커머스 parent로
// **replace** fallback — 일반 push로 대체하면 parent→back이 원 화면으로 되돌아가는
// 루프(directCheckout→cart→back→checkout)가 생긴다. replace면 back마다 상위로 올라간다.
// URL 문자열 비교나 global history.length로 내부 이력을 추정하지 않는다 [PM 지침, Project]
const markCurrent = (internal: boolean) =>
  history.replaceState(
    internal ? { app: 1, internal: 1 } : { app: 1 },
    "",
    location.hash || "#/",
  );

const toHash = (r: Route) =>
  r.name === "search" ? "#/search" + (r.query ? "?q=" + encodeURIComponent(r.query) : "")
  : r.name === "product" ? "#/p/" + encodeURIComponent(r.id)
  : r.name === "cart" ? "#/cart"
  : r.name === "checkout" ? "#/checkout"
  : r.name === "orders" ? "#/orders"
  : r.name === "order" ? "#/orders/" + encodeURIComponent(r.id)
  : "#/" + (r.category
      ? "?cat=" + encodeURIComponent(r.category) + (r.sub ? "&sub=" + encodeURIComponent(r.sub) : "")
      : "");

// pushState/replaceState는 hashchange를 발생시키지 않으므로 라우트 갱신은 직접 알린다.
const emitRoute = () => dispatchEvent(new Event("hashchange"));

const goto = (r: Route) => {
  history.pushState({ app: 1, internal: 1 }, "", toHash(r));
  emitRoute();
  // 새 화면 진입은 스크롤을 초기화한다 — 딥스크롤에서 네비 탭 전환해도
  // 이전 스크롤 위치가 남지 않게 한다 [Project]. 뒤로가기(pop)는 브라우저의
  // 자동 스크롤 복원에 맡겨 건드리지 않는다.
  scrollTo(0, 0);
};

const gotoReplace = (r: Route) => {
  history.replaceState({ app: 1 }, "", toHash(r));
  emitRoute();
  scrollTo(0, 0);
};

function Login({ onLogin }: { onLogin: (name: string) => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function submit() {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const j = await r.json();
    if (j.ok) onLogin(j.user.display_name);
    else setErr(j.error?.message ?? "로그인 실패");
  }
  return (
    <div className="login">
      <h1>AI Commerce</h1>
      <p className="muted">테스트 접근 코드를 입력하세요</p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="접근 코드"
      />
      <button className="btn primary" onClick={submit}>시작하기</button>
      {err && <p className="error-text">{err}</p>}
    </div>
  );
}

// 하단 네비는 홈(탭 루트)에만 표시한다 — 카트/주문/상세는 푸시 화면이며
// 자체 고정 CTA(.bottom-bar)가 있어 겹치지 않게 한다.
const NAV_ROUTES = new Set(["shop"]);
// 뒤로가기 바를 붙이는 푸시 화면
const BACK_ROUTES = new Set(["product", "cart", "checkout", "orders", "order"]);

// 내부 이동 이력이 없을 때 뒤로가기 fallback 목적지 [Project]
const BACK_PARENT: Record<string, Route> = {
  product: { name: "shop", category: "", sub: "" },
  cart: { name: "shop", category: "", sub: "" },
  checkout: { name: "cart" },
  orders: { name: "shop", category: "", sub: "" },
  order: { name: "orders" },
};

function App() {
  const [user, setUser] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [route, setRoute] = useState<Route>(parseHash());
  const [agentOpen, setAgentOpen] = useState<AgentBrain | null>(null);
  // Brain별 대화를 따로 유지한다 (서버도 user:brain 단위로 히스토리를 나눈다).
  const [agentMsgs, setAgentMsgs] = useState<Record<AgentBrain, AgentReply[]>>({
    shopping: [],
    cs: [],
  });
  const [cart, setCart] = useState<CartView | null>(null);
  const [search, setSearch] = useState("");
  // 쇼핑 홈 스크롤 시 검색 필드가 사라지고 플로팅 아이콘만 남는다 [Observed home/02]
  const [miniTop, setMiniTop] = useState(false);
  // 딥스크롤에서 하단 네비가 사라진다 [Observed home/02]. 복귀 트리거는 미관측이라
  // 내릴 때 숨기고 올릴 때 복귀하는 방향 인식 패턴을 채택한다 [Inferred→Project]
  const [navHidden, setNavHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const lastY = useRef(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const allBtnRef = useRef<HTMLButtonElement | null>(null);
  // '전체' 메뉴 시트 — 열 때 첫 항목 포커스, ESC로 닫기, 닫을 때 전체 버튼으로 포커스 복귀 [Project]
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>(".menu-item")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      allBtnRef.current?.focus();
    };
  }, [menuOpen]);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setMiniTop(y > 72);
      setNavHidden(y > 120 && y > lastY.current);
      lastY.current = y;
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    // GET /api/session은 ToolResult 봉투가 아니라 {ok, user}를 최상위로 반환한다 —
    // api() 봉투의 data.user로 읽으면 undefined에서 throw하고 setChecked가 실행되지
    // 않아 세션 복원(reload)이 blank가 된다 [Observed 계약, PM 발견 결함 수정]
    fetch("/api/session")
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && j?.user?.display_name) setUser(j.user.display_name);
        setChecked(true);
      })
      .catch(() => setChecked(true));
    // 최초 진입 엔트리를 앱 소유로 마킹 — 직접 해시 진입(#/cart 등)은
    // internal 없음으로 두어 뒤로가기가 커머스 parent로 fallback하게 한다.
    // 복원된 세션(reload·browser back 복귀)의 앱 마커는 보존한다.
    if (!(history.state as { app?: number } | null)?.app) markCurrent(false);
    const onHash = () => {
      // 수동 해시 편집·마커 없는 구세대 엔트리는 내부 이력 없음으로 간주해 마킹
      if (!(history.state as { app?: number } | null)?.app) markCurrent(false);
      setRoute(parseHash());
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const refreshCart = useCallback(() => {
    api<CartView>("/api/cart").then((r) => r.ok && setCart(r.data));
  }, []);
  useEffect(() => { if (user) refreshCart(); }, [user, refreshCart]);

  if (!checked) return null;
  if (!user) return <Login onLogin={setUser} />;

  const pageContext = {
    screen: route.name,
    product_id: route.name === "product" ? route.id : undefined,
    order_id: route.name === "order" ? route.id : undefined,
  };
  const cartCount = cart?.items.length ?? 0;
  const showNav = NAV_ROUTES.has(route.name);
  // 쇼핑/검색 화면은 Toss 기준 좁은 좌우 여백을 쓴다 [Observed ~10px]
  const shopPad = route.name === "shop" || route.name === "search";

  return (
    <div className={"shell" + (showNav ? " has-nav" : "") + (shopPad ? " shop-pad" : "")}>
      {route.name === "shop" && (
        <header className={"top" + (miniTop ? " mini" : "")}>
          <form
            className="search-field"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) goto({ name: "search", query: search.trim() });
            }}
          >
            <span className="field-ico"><IcSearch size={18} /></span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="상품 검색"
            />
          </form>
          <button
            className="icon-btn"
            aria-label="내 쇼핑"
            onClick={() => goto({ name: "orders" })}
          >
            <IcUser size={23} />
          </button>
          <button
            className="icon-btn"
            aria-label="장바구니"
            onClick={() => goto({ name: "cart" })}
          >
            <IcCart size={23} />
            {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          </button>
        </header>
      )}
      {route.name === "shop" && miniTop && (
        <div className="float-nav">
          <button
            className="float-btn"
            aria-label="검색"
            onClick={() => goto({ name: "search", query: "" })}
          >
            <IcSearch size={19} />
          </button>
          <button
            className="float-btn"
            aria-label="장바구니"
            onClick={() => goto({ name: "cart" })}
          >
            <IcCart size={19} />
            {cartCount > 0 && <span className="cart-badge">{cartCount}</span>}
          </button>
        </div>
      )}
      {BACK_ROUTES.has(route.name) && (
        <header className="backbar">
          <button
            className="back-btn"
            aria-label="뒤로가기"
            onClick={() => {
              // 내부 이력이 있으면 브라우저 뒤로가기, 없으면 커머스 parent로 fallback
              // (엔트리 마커 기준 — replace fallback으로 상위 체인을 오름)
              const st = history.state as { internal?: number } | null;
              if (st?.internal) history.back();
              else gotoReplace(BACK_PARENT[route.name]);
            }}
          >
            <IcBack size={24} />
          </button>
        </header>
      )}
      <main>
        {route.name === "shop" && (
          <Shopping
            category={route.category}
            sub={route.sub}
            userName={user}
            onNav={(c, s) => goto({ name: "shop", category: c, sub: s ?? "" })}
            onOpenProduct={(id) => goto({ name: "product", id })}
            onOpenOrders={() => goto({ name: "orders" })}
            onOpenCart={() => goto({ name: "cart" })}
          />
        )}
        {route.name === "search" && (
          <Search
            query={route.query}
            onBack={() => goto({ name: "shop", category: "", sub: "" })}
            onSubmit={(q) => goto({ name: "search", query: q })}
            onOpenProduct={(id) => goto({ name: "product", id })}
            cartCount={cartCount}
            onOpenCart={() => goto({ name: "cart" })}
          />
        )}
        {route.name === "product" && (
          <Product
            productId={route.id}
            onOpenCart={() => goto({ name: "cart" })}
            onCartChanged={setCart}
          />
        )}
        {route.name === "cart" && (
          <Cart
            cart={cart}
            onCartLoaded={setCart}
            onOpenShop={() => goto({ name: "shop", category: "", sub: "" })}
            onCheckout={() => goto({ name: "checkout" })}
          />
        )}
        {route.name === "checkout" && (
          <Checkout
            onOpenOrder={(id) => goto({ name: "order", id })}
            onOpenCart={() => goto({ name: "cart" })}
          />
        )}
        {route.name === "orders" && (
          <Orders
            onOpenOrder={(id) => goto({ name: "order", id })}
            onOpenShop={() => goto({ name: "shop", category: "", sub: "" })}
          />
        )}
        {route.name === "order" && (
          <OrderDetail
            orderId={route.id}
            onBack={() => goto({ name: "orders" })}
            onAskAgent={() => setAgentOpen("cs")}
          />
        )}
      </main>
      {showNav && (
        <nav className={"bottom-nav" + (navHidden ? " hidden" : "")}>
          {/* Toss 하단 네비 5슬롯 구조(홈/혜택/쇼핑/증권/전체)를 따르되,
              우리 서비스에 없는 목적지는 구매 관련 화면으로 대체한다.
              홈=앱 루트(쇼핑 홈), 혜택=특가 탭 진입, 쇼핑=쇼핑 서비스 루트(active 슬롯),
              증권→AI(프로젝트 핵심 진입), 전체=메뉴 시트 [Observed 구조 / Project 매핑] */}
          <button
            className="nav-item"
            onClick={() => goto({ name: "shop", category: "", sub: "" })}
          >
            <IcHome size={22} />홈
          </button>
          <button
            className="nav-item"
            onClick={() => goto({ name: "shop", category: "sale", sub: "" })}
          >
            <IcTag size={22} />혜택
          </button>
          <button
            className={"nav-item" + (route.name === "shop" ? " on" : "")}
            aria-current={route.name === "shop" ? "page" : undefined}
            onClick={() => goto({ name: "shop", category: "", sub: "" })}
          >
            {/* 선택 상태는 채움 아이콘 — Reference의 filled bag [Observed→Project] */}
            {route.name === "shop" ? <IcBagFill size={22} /> : <IcCart size={22} />}쇼핑
          </button>
          <button className="nav-item" onClick={() => setAgentOpen("shopping")}>
            <IcSparkle size={22} />AI
          </button>
          <button
            ref={allBtnRef}
            className="nav-item"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <IcMenu size={22} />전체
          </button>
        </nav>
      )}
      {menuOpen && (
        <div className="sheet-overlay" onClick={() => setMenuOpen(false)}>
          <div
            className="sheet menu-sheet"
            role="menu"
            ref={menuRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-grabber" />
            {(
              [
                { icon: IcReceipt, label: "내 쇼핑", run: () => goto({ name: "orders" }) },
                { icon: IcCart, label: "장바구니", run: () => goto({ name: "cart" }) },
                { icon: IcSearch, label: "검색", run: () => goto({ name: "search", query: "" }) },
                { icon: IcSparkle, label: "AI 쇼핑 도우미", run: () => setAgentOpen("shopping") },
              ] as const
            ).map((m) => (
              <button
                key={m.label}
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  m.run();
                }}
              >
                <m.icon size={20} />
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {agentOpen && (
        <AgentPanel
          brain={agentOpen}
          messages={agentMsgs[agentOpen]}
          setMessages={(m) => setAgentMsgs((prev) => ({ ...prev, [agentOpen]: m }))}
          pageContext={pageContext}
          onOpenProduct={(id) => goto({ name: "product", id })}
          onCartChanged={refreshCart}
          onClose={() => setAgentOpen(null)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
