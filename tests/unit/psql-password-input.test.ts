import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { runPsqlPasswordChange } from "../../scripts/rotate-db-password.ts";

async function loadRunner(): Promise<typeof runPsqlPasswordChange> {
  const mod = await import("../../scripts/rotate-db-password.ts").catch(() => null);
  assert.ok(mod && typeof mod.runPsqlPasswordChange === "function", "password runner is not implemented");
  return mod.runPsqlPasswordChange;
}

function fakeSpawn(exitCode: number, capture: { args?: string[]; input?: string; stdio?: unknown; env?: NodeJS.ProcessEnv }) {
  return ((_command: string, args: string[], options: SpawnOptions) => {
    capture.args = args;
    capture.stdio = options.stdio;
    capture.env = options.env;
    const child = new EventEmitter() as ChildProcess;
    const input = new PassThrough();
    child.stdin = input;
    capture.input = "";
    input.on("data", (chunk: Buffer) => (capture.input += chunk.toString("utf8")));
    setImmediate(() => child.emit("close", exitCode, null));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

test("psql password change keeps the password out of argv, child env, and output streams", async () => {
  const run = await loadRunner();
  const password = randomBytes(32).toString("hex");
  const inheritedDbUrl = process.env.DATABASE_URL;
  const inheritedAdminUrl = process.env.SCRATCH_ADMIN_URL;
  process.env.DATABASE_URL = `postgres://commerce:${password}@127.0.0.1:5432/commerce`;
  process.env.SCRATCH_ADMIN_URL = `postgres://commerce:${password}@127.0.0.1:5432/postgres`;
  const capture: { args?: string[]; input?: string; stdio?: unknown; env?: NodeJS.ProcessEnv } = {};
  let ok: boolean;
  try {
    ok = await run(password, fakeSpawn(0, capture));
  } finally {
    if (inheritedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = inheritedDbUrl;
    if (inheritedAdminUrl === undefined) delete process.env.SCRATCH_ADMIN_URL;
    else process.env.SCRATCH_ADMIN_URL = inheritedAdminUrl;
  }
  assert.equal(ok, true);
  assert.equal(capture.args?.some((arg) => arg.includes(password)), false);
  assert.equal(JSON.stringify(capture.env).includes(password), false);
  assert.equal(capture.env?.DATABASE_URL, undefined);
  assert.equal(capture.env?.SCRATCH_ADMIN_URL, undefined);
  assert.deepEqual(capture.stdio, ["pipe", "ignore", "ignore"]);
  assert.equal(capture.input === `\\password commerce\n${password}\n${password}\n\\q\n`, true);
});

test("psql password change reports only failure when child exits nonzero", async () => {
  const run = await loadRunner();
  const capture: { args?: string[]; input?: string; stdio?: unknown } = {};
  assert.equal(await run(randomBytes(32).toString("hex"), fakeSpawn(1, capture)), false);
});

test("psql password change rejects line breaks before spawning", async () => {
  const run = await loadRunner();
  let called = false;
  const spawn = (() => {
    called = true;
    throw new Error("must not spawn");
  }) as unknown as typeof import("node:child_process").spawn;
  assert.equal(await run("invalid\ninput", spawn), false);
  assert.equal(called, false);
});
