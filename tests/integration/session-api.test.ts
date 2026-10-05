import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { ensureTestDb, TEST_DB_URL } from "../helpers/testdb.ts";

const PORT = 3997;
let proc: ChildProcess | undefined;

async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch("http://localhost:" + PORT + "/health");
      if (r.status === 200) return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("server did not start");
}

describe("session api", () => {
  test("code -> cookie -> scoped cart; spoofed actor ignored", async () => {
    await ensureTestDb(1);
    proc = spawn("node", ["src/server.ts"], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATABASE_URL: TEST_DB_URL,
        TEST_USER_CODES: "it-a=u-a,it-b=u-b",
      },
      stdio: "ignore",
    });
    await waitUp();

    // 잘못된 코드
    const bad = await fetch("http://localhost:" + PORT + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "wrong" }),
    });
    assert.equal(bad.status, 401);

    // 올바른 코드
    const good = await fetch("http://localhost:" + PORT + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "it-a" }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers.get("set-cookie")!.split(";")[0];
    assert.ok(cookie.startsWith("session="));

    const cart = await fetch("http://localhost:" + PORT + "/api/cart", {
      headers: { cookie },
    });
    assert.equal(cart.status, 200);
    const cj = await cart.json();
    assert.ok(cj.ok);

    // 인증 없는 요청
    const anon = await fetch("http://localhost:" + PORT + "/api/cart");
    assert.equal(anon.status, 401);

    // x-user-id 스푸핑 시도 — 세션 없이는 401
    const spoof = await fetch("http://localhost:" + PORT + "/api/cart", {
      headers: { "x-user-id": "u-b" },
    });
    assert.equal(spoof.status, 401);
  });
  after(() => proc?.kill());
});

