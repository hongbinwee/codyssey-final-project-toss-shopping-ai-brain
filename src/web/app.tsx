import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
 import type { CartView } from "../contracts.ts";
import { Shopping } from "./screens/Shopping.tsx";
import { Product } from "./screens/Product.tsx";
import { Cart } from "./screens/Cart.tsx";
import { Checkout } from "./screens/Checkout.tsx";
import { Orders } from "./screens/Orders.tsx";
import { OrderDetail } from "./screens/OrderDetail.tsx";
import { AgentPanel, type AgentReply } from "./components/AgentPanel.tsx";
import type { AgentBrain } from "./api.ts";

type Route =
  | { name: "shop"; query: string }
  | { name: "product"; id: string }
  | { name: "cart" }
  | { name: "checkout" }
  | { name: "orders" }
  | { name: "order"; id: string };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, "");
  const [path, qs] = h.split("?");
  const params = new URLSearchParams(qs ?? "");
  if (path.startsWith("/p/")) return { name: "product", id: decodeURIComponent(path.slice(3)) };
  if (path === "/cart") return { name: "cart" };
  if (path === "/checkout") return { name: "checkout" };
  if (path === "/orders") return { name: "orders" };
  if (path.startsWith("/orders/")) return { name: "order", id: decodeURIComponent(path.slice(8)) };
  return { name: "shop", query: params.get("q") ?? "" };
}

const goto = (r: Route) => {
  location.hash =
    r.name === "product" ? "#/p/" + encodeURIComponent(r.id)
    : r.name === "cart" ? "#/cart"
    : r.name === "checkout" ? "#/checkout"
    : r.name === "orders" ? "#/orders"
    : r.name === "order" ? "#/orders/" + encodeURIComponent(r.id)
    : "#/" + (r.query ? "?q=" + encodeURIComponent(r.query) : "");
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
  const [search, setSearch] = useState(route.name === "shop" ? route.query : "");

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

  return (
    <div className="shell">
      <header className="top">
        <a className="logo" href="#/">AI Commerce</a>
        {route.name === "shop" && (
          <form
            className="search"
            onSubmit={(e) => { e.preventDefault(); goto({ name: "shop", query: search }); }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="상품 검색"
            />
          </form>
        )}
        <nav>
          <button className="nav-btn" onClick={() => setAgentOpen("shopping")}>🤖 AI</button>
          <button className="nav-btn" onClick={() => goto({ name: "orders" })}>내 주문</button>
          <button className="nav-btn" onClick={() => goto({ name: "cart" })}>
            장바구니{cart && cart.items.length > 0 ? " " + cart.items.length : ""}
          </button>
        </nav>
      </header>
      <main>
        {route.name === "shop" && (
          <Shopping
            query={route.query}
            onSearch={(q) => goto({ name: "shop", query: q })}
            onOpenProduct={(id) => goto({ name: "product", id })}
            onOpenAgent={() => setAgentOpen("shopping")}
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
            onOpenShop={() => goto({ name: "shop", query: "" })}
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
            onOpenShop={() => goto({ name: "shop", query: "" })}
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
