import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

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
    const proc = await startServer(
      { DATABASE_URL: "postgres://commerce:commerce@127.0.0.1:1/none" },
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
