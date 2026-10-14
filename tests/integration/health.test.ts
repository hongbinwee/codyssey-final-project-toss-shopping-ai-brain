import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { isolatedContractFromEnv } from "../helpers/testdb.ts";

async function startServer(env: Record<string, string>, port: number) {
  const proc = spawn("node", ["src/server.ts"], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://localhost:" + port + "/health");
      if (r.status) return proc;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  proc.kill();
  throw new Error("server did not start");
}

const stop = (p: ChildProcess) => p.kill();

describe("health", () => {
  test("reports db connected when database is reachable", async () => {
    const proc = await startServer({}, 3999);
    try {
      const res = await fetch("http://localhost:3999/health");
      assert.equal(res.status, 200);
      assert.equal((await res.json()).db, "connected");
    } finally {
      stop(proc);
    }
  });

  test("health_requires_database: db down -> 503", async () => {
    if (isolatedContractFromEnv()) {
      // 격리 실행에서는 다른 DB를 열어 health 503을 만들지 않는다. 같은
      // isolated contract에서 DATABASE_URL만 바꾼 child가 listen 전에
      // fail-closed 종료하는지 확인한다. health()의 503 매핑은 DB-free unit이
      // 별도로 검증한다.
      const child = spawn("node", ["src/server.ts"], {
        env: {
          ...process.env,
          PORT: "3998",
          DATABASE_URL: "postgres://commerce@127.0.0.1:1/none",
        },
        stdio: "ignore",
      });
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
      const outcome = await Promise.race([
        exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (!outcome) {
        child.kill();
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
        assert.fail("isolated DB mismatch가 listen 전에 종료되지 않음");
      }
      assert.notEqual(outcome.code, 0);
      assert.equal(outcome.signal, null);
      return;
    }

    const proc = await startServer(
      { DATABASE_URL: "postgres://commerce@127.0.0.1:1/none" },
      3998,
    );
    try {
      const res = await fetch("http://localhost:3998/health");
      assert.equal(res.status, 503);
      assert.equal((await res.json()).db, "down");
    } finally {
      stop(proc);
    }
  });
});
