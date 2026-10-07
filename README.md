# AI Commerce P0

토스쇼핑과 유사한 흐름의 테스트용 커머스 환경 + Shopping/CS Brain Agent. P0 범위는 [CORE_TASK_SCOPE.md](CORE_TASK_SCOPE.md), 실행 계획은 [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

> 현재 최상위 방향·로드맵(Commerce Environment 선행 → Brain)은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) §현재 프로젝트 방향 참조.

## 무엇을 하는 프로젝트인가

실제 쇼핑 흐름(검색→상세→옵션→장바구니→주문서→모의 결제→주문/배송→취소) 위에서 동작하는 두 개의 AI Agent를 검증하는 환경이다.

- **Shopping Brain (A01)**: 상품 검색/비교/리뷰 근거 조회와 장바구니 조작을 Tool Calling으로 수행
- **CS Brain (A02 맥락)**: 주문 식별·배송 조회·취소 자격/견적 설명을 수행. 취소 실행은 사용자가 UI에서 최종 확인한 뒤에만 가능

결제·배송 전환·환불은 모두 **모의 처리**다(실제 PG/물류 연동 없음). AI 답변 영역에는 "AI 생성 답변" 표시가 있다.

LLM은 조건 해석·근거 비교·설명을 담당하고, 재고/가격/소유권/취소 가능 여부/환불액은 전부 서버가 결정한다. 쓰기 작업은 멱등 키와 버전 검사로 중복·경합을 방지한다.

## 실행

요구: Node 24+, Docker(Postgres용).

    docker compose up -d
    npm install
    npm run db:migrate -- --phase=4
    npm run db:seed -- --phase=4
    npm run dev

http://localhost:3000

`.env`의 `TEST_USER_CODES`가 "접근 코드=사용자" 매핑이다(코드는 서버 비밀 설정, 클라이언트/로그에 목록을 노출하지 않는다).

`LLM_API_KEY`를 설정하면 실제 OpenAI 호환 chat completions + tool calling으로 동작한다. 미설정 시 조회만 하는 로컬 stub provider로 동작하며, stub 결과는 live 평가로 보고하지 않는다.

## 검증

    npm run verify -- --phase=5

typecheck + build + unit + integration + e2e(전체 스펙) + dev eval + holdout eval(케이스당 3회).

개별 실행:

    npm run eval -- --mode=stub --split=dev                  # 개발 케이스 16개
    npm run eval -- --mode=stub --split=holdout --repeat=3   # holdout 6개 ×3
    npm run eval -- --mode=live --split=dev                  # 실제 LLM 평가 (LLM_API_KEY 필요)

## 배포

`Dockerfile`이 실행 이미지를 만든다. Postgres는 외부에서 준비하고 `DATABASE_URL`·`SESSION_SECRET`·`TEST_USER_CODES`·(선택)`LLM_*` 환경 변수를 전달한다.

    docker build -t ai-commerce-p0 .
    docker run -p 3000:3000 -e DATABASE_URL=... -e SESSION_SECRET=... ai-commerce-p0

배포 후 `db:migrate`/`db:seed`를 대상 DB에 1회 적용한다.

## 구조

- `src/server.ts` — node:http: API + 웹 정적 서빙, /health, 시작 시 esbuild로 웹 번들
- `src/db.ts` — postgres.js + 트랜잭션 헬퍼
- `src/session.ts` — HMAC 세션·RequestContext (actor는 세션에서만)
- `src/agent.ts` — Shopping/CS Brain 공용 runtime + Tool registry(13개, brain별 노출 분리)
- `src/cart.ts` `src/checkout.ts` `src/orders.ts` `src/cancellation.ts` — 화면 API와 Agent Tool이 공유하는 커머스 로직
- `src/actions.ts` — 멱등 실행(action_requests): 같은 actor+kind+key는 결과 재생
- `src/contracts.ts` — ToolResult 공통 응답 봉투
- `src/web/` — React SPA (esbuild 번들)
- `scripts/` — migrate / seed / verify / build-web / eval / simulate(내부 배송·취소·환불 전환)
- `tests/` — unit·integration(node --test) / e2e(Playwright) / eval 케이스(dev·holdout)

## 한계

- 장기 개인화, 이미지 검색, 반품/교환, 쿠폰/포인트, 실제 PG·배송사 연동은 P0 범위 밖이다.
- 리뷰 시드는 합성 데이터다(`source_kind=SYNTHETIC`). 실제 리뷰 표본 검증은 미완료다.
- 배포 실행과 실사용자 5명 테스트는 Phase 5 진행 항목이다(`docs/USER_TEST_REPORT.md`).
