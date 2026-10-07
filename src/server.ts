import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extname, join, normalize, sep } from "node:path";
import { build } from "esbuild";
import { config } from "./config.ts";
import { connectDb, sql } from "./db.ts";
import { ensureDevDb } from "./devdb.ts";
import { contextFromRequest, signSession } from "./session.ts";
import { getProduct, getReviews, searchProducts } from "./catalog.ts";
import { addToCart, getCart, removeCartItem, updateCartQuantity } from "./cart.ts";
import { checkoutQuote, confirmCheckout } from "./checkout.ts";
import { getOrder, getShippingStatus, listOrders } from "./orders.ts";
import {
  approveCancel, checkCancelEligibility, getCancelQuote, requestCancelOrder,
} from "./cancellation.ts";
import { getActionResult } from "./actions.ts";
import { runAgentTurn } from "./agent.ts";
import { getProvider } from "./llm.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/web/app.js": "web/app.js",
  "/web/styles.css": "src/web/styles.css",
};

async function health() {
  try {
    await sql.unsafe("select 1");
    return { code: 200, body: JSON.stringify({ ok: true, db: "connected" }) };
  } catch {
    return { code: 503, body: JSON.stringify({ ok: false, db: "down" }) };
  }
}

const json = (res: ServerResponse, code: number, body: unknown, headers?: Record<string, string>) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c);
    if (Buffer.concat(chunks).length > 65536) throw new Error("body too large");
  }
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : {};
}

// ToolResult -> HTTP 변환. 비즈니스 판정은 서비스가 내렸고 여기선 매핑만 한다.
const send = (res: ServerResponse, r: { ok: boolean; error?: { code: string } }) => {
  if (r.ok) return json(res, 200, r);
  const code = r.error?.code === "NOT_FOUND" ? 404 : r.error?.code === "VALIDATION" ? 400 : 409;
  json(res, code, r);
};

const reqCtx = (req: IncomingMessage) =>
  contextFromRequest(
    new Request("http://x", {
      headers: {
        cookie: String(req.headers.cookie ?? ""),
        authorization: String(req.headers.authorization ?? ""),
      },
    }),
    config.sessionSecret,
  );

export async function start(port = config.port) {
  await ensureDevDb();
  connectDb(process.env.DATABASE_URL!);
  await build({
    entryPoints: ["src/web/app.tsx"],
    bundle: true,
    outfile: "web/app.js",
    jsx: "automatic",
    format: "esm",
    logLevel: "silent",
  });
  const provider = getProvider();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    try {
      if (p === "/health") {
        const h = await health();
        res.writeHead(h.code, { "content-type": "application/json" });
        return res.end(h.body);
      }

      // 세션: 테스트 접근 코드 -> 서명 쿠키. 코드는 서버 설정에만 존재한다.
      if (p === "/api/session") {
        if (req.method === "POST") {
          const b = (await body(req)) as { code?: string };
          const subject = b.code ? config.testUserCodes[b.code] : undefined;
          if (!subject) return json(res, 401, { ok: false, error: { code: "INVALID_CODE", message: "접근 코드가 올바르지 않습니다" } });
          const [u] = await sql.unsafe("SELECT id, display_name FROM users WHERE auth_subject=$1", [subject]);
          if (!u) return json(res, 401, { ok: false, error: { code: "INVALID_CODE", message: "사용자를 찾을 수 없습니다" } });
          const token = signSession(u.id, config.sessionSecret);
          return json(res, 200, { ok: true, user: { id: u.id, display_name: u.display_name } }, {
            "set-cookie": "session=" + encodeURIComponent(token) + "; HttpOnly; Path=/; SameSite=Lax",
          });
        }
        if (req.method === "GET") {
          const ctx = reqCtx(req);
          if (!ctx) return json(res, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다" } });
          const [u] = await sql.unsafe("SELECT id, display_name FROM users WHERE id=$1", [ctx.actorUserId]);
          if (!u) return json(res, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "세션 만료" } });
          return json(res, 200, { ok: true, user: { id: u.id, display_name: u.display_name } });
        }
        if (req.method === "DELETE") {
          return json(res, 200, { ok: true }, { "set-cookie": "session=; HttpOnly; Path=/; Max-Age=0" });
        }
      }

      // 정적 자산은 인증 없이 서빙한다.
      const file = req.method === "GET" && !p.startsWith("/api/") ? STATIC[p] : undefined;
      if (file) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
        return res.end(await readFile(file));
      }

      // 생성/테스트 에셋(상품 이미지 등)은 web/assets 아래 파일만 서빙한다.
      if (req.method === "GET" && p.startsWith("/assets/")) {
        const rel = decodeURIComponent(p.slice("/assets/".length));
        const filePath = normalize(join("web", "assets", rel));
        const base = normalize(join("web", "assets")) + sep;
        if (!filePath.startsWith(base) || filePath.endsWith(sep)) {
          res.writeHead(404);
          return res.end("Not found");
        }
        try {
          res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
          return res.end(await readFile(filePath));
        } catch {
          res.writeHead(404);
          return res.end("Not found");
        }
      }

      // 아래부터는 인증 필요
      const ctx = reqCtx(req);
      if (!ctx) return json(res, 401, { ok: false, error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다" } });

      if (p === "/api/products" && req.method === "GET") {
        return send(res, await searchProducts({
          query: url.searchParams.get("query") ?? undefined,
          category: url.searchParams.get("category") ?? undefined,
          max_unit_price_won: url.searchParams.get("max_unit_price_won") ? Number(url.searchParams.get("max_unit_price_won")) : undefined,
          sort: (url.searchParams.get("sort") as "RELEVANCE" | "PRICE_ASC") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }));
      }
      let m = p.match(/^\/api\/products\/([^/]+)$/);
      if (m && req.method === "GET") return send(res, await getProduct({ product_id: decodeURIComponent(m[1]) }));
      m = p.match(/^\/api\/products\/([^/]+)\/reviews$/);
      if (m && req.method === "GET")
        return send(res, await getReviews({
          product_id: decodeURIComponent(m[1]),
          variant_id: url.searchParams.get("variant_id") ?? undefined,
          query: url.searchParams.get("query") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }));

      if (p === "/api/cart" && req.method === "GET") return send(res, await getCart(ctx));
      if (p === "/api/cart/items" && req.method === "POST") {
        const b = (await body(req)) as { variant_id?: string; quantity?: number; expected_cart_version?: number; expected_variant_version?: number; idempotency_key?: string };
        if (!b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "idempotency_key가 필요합니다" } });
        return send(res, await addToCart({
          variant_id: String(b.variant_id ?? ""),
          quantity: Number(b.quantity),
          expected_cart_version: Number(b.expected_cart_version),
          expected_variant_version: Number(b.expected_variant_version),
        }, ctx, "ui-" + b.idempotency_key));
      }

      // 카트 항목 수량 변경·삭제 (W03). 화면과 Agent Tool이 같은 서비스를 쓴다.
      m = p.match(/^\/api\/cart\/items\/([^/]+)$/);
      if (m && req.method === "PATCH") {
        const b = (await body(req)) as { quantity?: number; expected_cart_version?: number; expected_variant_version?: number; idempotency_key?: string };
        if (!b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "idempotency_key가 필요합니다" } });
        return send(res, await updateCartQuantity({
          cart_item_id: decodeURIComponent(m[1]),
          quantity: Number(b.quantity),
          expected_cart_version: Number(b.expected_cart_version),
          expected_variant_version: Number(b.expected_variant_version),
        }, ctx, "ui-" + b.idempotency_key));
      }
      if (m && req.method === "DELETE") {
        const b = (await body(req)) as { expected_cart_version?: number; idempotency_key?: string };
        if (!b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "idempotency_key가 필요합니다" } });
        return send(res, await removeCartItem({
          cart_item_id: decodeURIComponent(m[1]),
          expected_cart_version: Number(b.expected_cart_version),
        }, ctx, "ui-" + b.idempotency_key));
      }

      // 실행 요청 결과 조회 (응답 유실 복구용. Agent Tool 아님)
      m = p.match(/^\/api\/actions\/([^/]+)$/);
      if (m && req.method === "GET")
        return send(res, await getActionResult(ctx, { operation_id: decodeURIComponent(m[1]) }));
      if (p === "/api/actions" && req.method === "GET")
        return send(res, await getActionResult(ctx, {
          kind: url.searchParams.get("kind") ?? undefined,
          idempotency_key: url.searchParams.get("idempotency_key") ?? undefined,
        }));

      // W04 견적/확인 — UI 전용. Agent Tool registry에 없으므로 A01이 호출할 수 없다.
      if (p === "/api/checkout/quote" && req.method === "GET")
        return send(res, await checkoutQuote(ctx));
      if (p === "/api/checkout/confirm" && req.method === "POST") {
        const b = (await body(req)) as { quote_token?: string; idempotency_key?: string };
        if (!b.quote_token || !b.idempotency_key)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "quote_token과 idempotency_key가 필요합니다" } });
        return send(res, await confirmCheckout(b.quote_token, ctx, "ui-" + b.idempotency_key));
      }

      // W05/W06 주문·배송 조회
      if (p === "/api/orders" && req.method === "GET")
        return send(res, await listOrders(ctx, {
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }));
      m = p.match(/^\/api\/orders\/([^/]+)\/shipping$/);
      if (m && req.method === "GET")
        return send(res, await getShippingStatus(ctx, decodeURIComponent(m[1])));

      // T3 취소 — 자격/견적은 READ, 승인은 UI 전용, 실행은 화면과 Agent이 같은 로직을 쓴다.
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/eligibility$/);
      if (m && req.method === "GET")
        return send(res, await checkCancelEligibility(ctx, decodeURIComponent(m[1])));
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/quote$/);
      if (m && req.method === "GET")
        return send(res, await getCancelQuote(
          ctx, decodeURIComponent(m[1]), url.searchParams.get("reason_code") ?? "",
        ));
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/approve$/);
      if (m && req.method === "POST") {
        const b = (await body(req)) as { quote_token?: string; reason_code?: string; action_key?: string };
        return send(res, await approveCancel(ctx, decodeURIComponent(m[1]), b));
      }
      m = p.match(/^\/api\/orders\/([^/]+)\/cancel\/execute$/);
      if (m && req.method === "POST") {
        const b = (await body(req)) as { confirmation_id?: string; reason_code?: string };
        return send(res, await requestCancelOrder(ctx, {
          order_id: decodeURIComponent(m[1]),
          reason_code: b.reason_code,
          confirmation_id: b.confirmation_id,
        }));
      }
      m = p.match(/^\/api\/orders\/([^/]+)$/);
      if (m && req.method === "GET")
        return send(res, await getOrder(ctx, decodeURIComponent(m[1])));

      if (p === "/api/agent/turn" && req.method === "POST") {
        const b = (await body(req)) as { user_message?: string; page_context?: unknown; client_action_id?: string; brain?: "shopping" | "cs" };
        if (!b.user_message || !b.client_action_id)
          return json(res, 400, { ok: false, error: { code: "VALIDATION", message: "user_message와 client_action_id가 필요합니다" } });
        // 이 경로에서 실행되는 Tool의 origin은 AGENT다.
        const agentCtx = { ...ctx, origin: "AGENT" as const };
        const result = await runAgentTurn(
          { user_message: b.user_message, page_context: b.page_context as never, client_action_id: b.client_action_id, brain: b.brain },
          agentCtx,
          provider,
        );
        return json(res, 200, { ok: true, data: result });
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (e) {
      json(res, 500, { ok: false, error: { code: "INTERNAL", message: String(e).slice(0, 200) } });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
  console.log("listening on http://localhost:" + config.port);
}
