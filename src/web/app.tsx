import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [db, setDb] = useState("checking");
  useEffect(() => {
    fetch("/health")
      .then((r) => r.json())
      .then((j) => setDb(j.db === "connected" ? "연결됨" : "연결 안 됨"))
      .catch(() => setDb("서버 오류"));
  }, []);

  return (
    <div className="shell">
      <header className="top">
        <h1>AI Commerce</h1>
        <nav>
          <a href="#/shop">쇼핑</a>
          <a href="#/cart">장바구니</a>
          <a href="#/orders">내 주문</a>
        </nav>
      </header>
      <main>
        <p>Phase 0 앱 셸 — DB 상태: {db}</p>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
