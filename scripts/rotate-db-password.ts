import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function runPsqlPasswordChange(
  password: string,
  spawnImpl: typeof spawn = spawn,
): Promise<boolean> {
  if (!password || /[\r\n]/.test(password)) return false;

  let child;
  try {
    const env = { ...process.env };
    for (const key of [
      "DATABASE_URL",
      "TEST_DB_URL",
      "SCRATCH_ADMIN_URL",
      "ISOLATED_DB_URL",
      "DATABASE_PASSWORD_FILE",
    ])
      delete env[key];
    child = spawnImpl(
      "docker",
      ["compose", "exec", "-T", "db", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "commerce", "-d", "postgres"],
      { env, stdio: ["pipe", "ignore", "ignore"] },
    );
  } catch {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    if (!child.stdin) return finish(false);
    child.stdin.once("error", () => finish(false));
    child.stdin.end(`\\password commerce\n${password}\n${password}\n\\q\n`);
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute") {
    console.error("password change requires explicit --execute");
    process.exitCode = 2;
    return;
  }

  let password: string;
  try {
    password = readFileSync(".secrets/pg-password", "utf8").replace(/\r?\n$/, "");
  } catch {
    console.error("password change failed: local secret unavailable");
    process.exitCode = 1;
    return;
  }

  const ok = await runPsqlPasswordChange(password);
  console.log(ok ? "password change command succeeded" : "password change command failed");
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
