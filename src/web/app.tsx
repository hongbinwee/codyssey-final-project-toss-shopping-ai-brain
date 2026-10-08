import { useCallback, useEffect, useState } from "react";
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
import { IcBack, IcCart, IcHome, IcReceipt, IcSearch, IcSparkle, IcUser } from "./icons.tsx";

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

const goto = (r: Route) => {
  location.hash =
    r.name === "search" ? "#/search" + (r.query ? "?q=" + encodeURIComponent(r.query) : "")
    : r.name === "product" ? "#/p/" + encodeURIComponent(r.id)
    : r.name === "cart" ? "#/cart"
    : r.name === "checkout" ? "#/checkout"
    : r.name === "orders" ? "#/orders"
    : r.name === "order" ? "#/orders/" + encodeURIComponent(r.id)
    : "#/" + (r.category
        ? "?cat=" + encodeURIComponent(r.category) + (r.sub ? "&sub=" + encodeURIComponent(r.sub) : "")
        : "");
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

  useEffect(() => {
    api<{ user: { display_name: string } }>("/api/session").then((r) => {
      if (r.ok) setUser(r.data.user.display_name);
      setChecked(true);
    });
    const onHash = () => setRoute(parseHash());
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

  return (
    <div className={"shell" + (showNav ? " has-nav" : "")}>
      {route.name === "shop" && (
        <header className="top">
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
      {BACK_ROUTES.has(route.name) && (
        <header className="backbar">
          <button
            className="back-btn"
            aria-label="뒤로가기"
            onClick={() => history.back()}
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
        <nav className="bottom-nav">
          <button className="nav-item on" onClick={() => goto({ name: "shop", category: "", sub: "" })}>
            <IcHome size={22} />홈
          </button>
          <button className="nav-item" onClick={() => goto({ name: "search", query: "" })}>
            <IcSearch size={22} />검색
          </button>
          <button className="nav-item" onClick={() => goto({ name: "cart" })}>
            <IcCart size={22} />장바구니
            {cartCount > 0 && <span className="cart-badge nav-badge">{cartCount}</span>}
          </button>
          <button className="nav-item" onClick={() => goto({ name: "orders" })}>
            <IcReceipt size={22} />내 주문
          </button>
          <button className="nav-item" onClick={() => setAgentOpen("shopping")}>
            <IcSparkle size={22} />AI
          </button>
        </nav>
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
