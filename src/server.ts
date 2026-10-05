import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extname } from "node:path";
import { build } from "esbuild";
import { config } from "./config.ts";
import { connectDb, sql } from "./db.ts";
import { ensureDevDb } from "./devdb.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// URL -> 디스크 파일. 새 정적 자산이 필요하면 여기에만 추가한다.
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/web/app.js": "web/app.js",
  "/web/styles.css": "src/web/styles.css",
};

async function health(): Promise<{ code: number; body: string }> {
  try {
    await sql.unsafe("select 1");
    return { code: 200, body: JSON.stringify({ ok: true, db: "connected" }) };
  } catch {
    return { code: 503, body: JSON.stringify({ ok: false, db: "down" }) };
  }
}

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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    if (url.pathname === "/health") {
      const h = await health();
      res.writeHead(h.code, { "content-type": "application/json" });
      res.end(h.body);
      return;
    }
    const file = req.method === "GET" ? STATIC[url.pathname] : undefined;
    if (file) {
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
      res.end(await readFile(file));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
  console.log("listening on http://localhost:" + config.port);
}
