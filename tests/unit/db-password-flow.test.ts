import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const runConfigProbe = (source: string, extraEnv: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DATABASE_URL: "",
      DATABASE_PASSWORD_FILE: "",
      ...extraEnv,
    },
  });

test("config resolves a passwordless DATABASE_URL from the local password file", () => {
  const dir = mkdtempSync(join(tmpdir(), "commerce-db-config-"));
  const passwordFile = join(dir, "pg-password");
  writeFileSync(passwordFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFileSync } from "node:fs"; const expected=readFileSync(process.env.DATABASE_PASSWORD_FILE,"utf8").replace(/\\r?\\n$/,""); await import("./src/config.ts"); const u=new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.password)===expected?"MATCH":"MISMATCH");`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DATABASE_URL: "postgres://commerce@127.0.0.1:5432/commerce",
          DATABASE_PASSWORD_FILE: passwordFile,
        },
      },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "MATCH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("derived commerce_test URL keeps the canonical credentials and changes only the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "commerce-db-target-"));
  const passwordFile = join(dir, "pg-password");
  writeFileSync(passwordFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFileSync } from "node:fs"; const passwordFile=process.env.DATABASE_PASSWORD_FILE; const expected=readFileSync(passwordFile,"utf8").replace(/\\r?\\n$/,""); await import("./src/config.ts"); const m=await import("./src/config.ts"); if(typeof m.databaseUrlForName!=="function"){process.stdout.write("MISSING");process.exit(0)} const u=new URL(m.databaseUrlForName("commerce_test",process.env.DATABASE_URL)); process.stdout.write(u.pathname==="/commerce_test"&&decodeURIComponent(u.password)===expected?"MATCH":"MISMATCH");`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DATABASE_URL: "postgres://commerce@127.0.0.1:5432/commerce",
          DATABASE_PASSWORD_FILE: passwordFile,
        },
      },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "MATCH");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config rejects a DATABASE_URL credential that differs from the canonical password file", () => {
  const dir = mkdtempSync(join(tmpdir(), "commerce-db-mismatch-"));
  const passwordFile = join(dir, "pg-password");
  writeFileSync(passwordFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const stale = new URL("postgres://commerce@127.0.0.1:5432/commerce");
  stale.password = randomBytes(32).toString("hex");
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `try{await import("./src/config.ts");process.stdout.write("ACCEPTED")}catch{process.stdout.write("REJECTED")}`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DATABASE_URL: stale.toString(),
          DATABASE_PASSWORD_FILE: passwordFile,
        },
      },
    );
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "REJECTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session secret uses a non-static development key and is required in production", () => {
  const dev = runConfigProbe(
    'const {config}=await import("./src/config.ts"); process.stdout.write(config.sessionSecret.length >= 40 && config.sessionSecret !== "dev-secret-change-me" ? "SAFE" : "UNSAFE");',
    { NODE_ENV: "test", SESSION_SECRET: "" },
  );
  assert.equal(dev.status, 0);
  assert.equal(dev.stdout, "SAFE");

  const prod = runConfigProbe(
    'try { await import("./src/config.ts"); process.stdout.write("ACCEPTED"); } catch { process.stdout.write("REJECTED"); }',
    { NODE_ENV: "production", SESSION_SECRET: "" },
  );
  assert.equal(prod.status, 0);
  assert.equal(prod.stdout, "REJECTED");
});

test("database startup fails closed without DATABASE_URL and performs no embedded DB setup", () => {
  const child = runConfigProbe(
    'try { const {ensureDevDb}=await import("./src/devdb.ts"); await ensureDevDb(); process.stdout.write("ACCEPTED"); } catch { process.stdout.write("DENIED"); }',
    { NODE_ENV: "test", SESSION_SECRET: "unit-test-only" },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "DENIED");
});
