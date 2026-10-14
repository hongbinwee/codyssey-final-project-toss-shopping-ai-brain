// 실제 Commerce DB 연결을 명시적으로 설정해야 한다. 암호가 소스에 고정된
// embedded PostgreSQL fallback은 새 개발 환경에서 자동 실행하지 않는다.
import "./config.ts";

export async function ensureDevDb(): Promise<string> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required; embedded fallback is disabled");
  return url;
}
