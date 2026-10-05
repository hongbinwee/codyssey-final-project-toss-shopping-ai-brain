# AI Commerce P0

토스쇼핑과 유사한 흐름의 테스트용 커머스 환경 + Shopping/CS Brain Agent. P0 범위는 [CORE_TASK_SCOPE.md](CORE_TASK_SCOPE.md), 실행 계획은 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## 실행

요구: Node 24+, Docker(Postgres용).

    docker compose up -d
    npm install
    npm run db:migrate -- --phase=0
    npm run dev

http://localhost:3000

## 검증

    npm run verify -- --phase=0

typecheck + build + unit + integration + e2e

## 구조

- `src/server.ts` — node:http: API + 웹 정적 서빙, /health, 시작 시 esbuild로 웹 번들
- `src/db.ts` — postgres.js + 트랜잭션 헬퍼
- `src/session.ts` — HMAC 세션·RequestContext (actor는 세션에서만)
- `src/contracts.ts` — ToolResult 공통 응답 봉투
- `src/web/` — React SPA (esbuild 번들)
- `scripts/` — migrate / seed / verify / build-web
- `tests/` — unit·integration(node --test) / e2e(Playwright)
