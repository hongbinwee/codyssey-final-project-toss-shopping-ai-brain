// .env를 읽어 process.env를 채운다. 이미 있는 환경 변수는 덮어쓰지 않는다
// (테스트가 DATABASE_URL 등을 주입할 수 있게 하기 위함).
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // .env가 없으면 실제 환경 변수만 사용한다.
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // 개발 기본값. 운영에서는 SESSION_SECRET을 반드시 설정한다.
  sessionSecret: process.env.SESSION_SECRET ?? "dev-secret-change-me",
  llmBaseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",
};
