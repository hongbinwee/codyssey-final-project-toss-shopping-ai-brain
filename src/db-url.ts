import { readFileSync } from "node:fs";

export function databaseUrlWithPasswordFile(
  baseUrl: string | undefined,
  passwordFile: string,
): string {
  if (!baseUrl) throw new Error("DATABASE_URL is required with a password file");

  let password: string;
  try {
    password = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Error("database password file is unavailable");
  }
  if (!password || /[\r\n]/.test(password))
    throw new Error("database password file must contain one non-empty line");

  try {
    const url = new URL(baseUrl);
    if (url.password && decodeURIComponent(url.password) !== password)
      throw new Error("database credential source mismatch");
    if (!url.password) url.password = password;
    return url.toString();
  } catch (error) {
    if (error instanceof Error && error.message === "database credential source mismatch")
      throw error;
    throw new Error("DATABASE_URL is invalid");
  }
}

export function databaseUrlForName(databaseName: string, baseUrl: string): string {
  if (!/^[a-z0-9_]+$/.test(databaseName))
    throw new Error("database name is invalid");
  try {
    const url = new URL(baseUrl);
    if (url.search) throw new Error("unsupported options");
    url.pathname = `/${databaseName}`;
    return url.toString();
  } catch {
    throw new Error("DATABASE_URL is invalid or has unsupported options");
  }
}
