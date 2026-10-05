# Implementation Decisions

2026-10-05 · Phase 0 환경 확정. IMPLEMENTATION_PLAN.md가 위임한 스택 선택을 여기에 기록한다.

## 스택 최종 결정 (계획의 권장안 대비 변경)

| 항목 | 계획 권장안 | 실제 채택 | 이유 |
| --- | --- | --- | --- |
| 런타임 | Node + npm | **Node 24** (설치 확인됨. .ts 네이티브 실행) | bun 1.3.13이 한국어 경로 `C:\문서\codyssey_final`에서 cwd/tsconfig 읽기 실패(`bun -e`도 EBADFD)로 스크립트 실행·빌드 불가. node는 정상 동작 |
| HTTP 서버 | Fastify | **node:http** (내장) + 소형 라우팅 | P0 라우팅은 path param + JSON이면 충분. 프레임워크 의존성 제거 |
| Postgres 클라이언트 | pg | **postgres.js** (`postgres` 1개) | 실제 Postgres·행 잠금·트랜잭션 지원. 가벼운 드라이버 1개 |
| 단위/통합 테스트 | Vitest | **node --test** (내장) | vitest 의존성 제거 |
| 웹 번들/개발 | Vite + plugin-react | **esbuild** (1개, 서버 시작 시 자동 번들) | React TSX 번들에 필요한 최소 도구. vite 설정 제거 |
| UI | React | React 19 유지 | A01/A02 패널·상태 UI에 컴포넌트 모델이 필요해 유지 |
| E2E | Playwright | 동일 | 필수 검증 범위 |
| 타입 체크 | tsc | 동일 | node strip-types는 타입 검사 안 하므로 tsc --noEmit 유지 |
| LLM 연동 | Provider Adapter | **fetch 기반 OpenAI 호환 adapter** (Phase 1에서 구현) | SDK 의존성 없이 tool calling 사용 |

## 계획의 파일 경로 대응

계획의 세분화된 경로를 ponytail 원칙으로 병합했다. 기능 책임은 동일하다.

- `src/server/{app,main,config}.ts` -> `src/server.ts` + `src/config.ts`
- `src/server/db/{pool,transaction}.ts` -> `src/db.ts`
- `src/server/auth/session.ts` -> `src/session.ts`
- `src/shared/{contracts,tool-contracts}.ts` -> `src/contracts.ts`
- `src/web/...` -> `src/web/app.tsx` + `src/web/styles.css` (Phase 1에서 화면 분리)
- `scripts/{migrate,seed,verify-phase}.ts` -> `scripts/{migrate,seed,verify}.ts` + `build-web.ts`

## 환경 메모

- Node v24.15.0, npm 11.12.1, Docker 29.7.2 확인됨. bun은 경로 버그로 사용하지 않는다.
- 로컬 PostgreSQL 미설치 -> compose.yaml의 postgres:17-alpine 컨테이너 사용.
- 2026-10-06: 개발 DB는 Docker `codyssey_final-db-1` (localhost:5432, commerce/commerce)로 고정. `.env`의 `DATABASE_URL`이 이를 가리킨다. `DATABASE_URL`이 없을 때만 `embedded-postgres`가 `.pgdata/`(5433)에 fallback으로 뜬다. 샌드박스에서 실행된 프로세스는 localhost TCP가 차단되므로 DB·서버·브라우저를 여는 명령은 승인된 실행으로 돌린다.
- LLM API 키·모델 미확정. `.env.example`에 이름만 정의. Phase 1 live 평가는 키 확보 시 진행하고, 없으면 해당 항목을 BLOCKED로 표기한다.
- 실제 리뷰 데이터 출처 미확보. Phase 1은 합성 seed로 시작하고 `source_kind=SYNTHETIC`을 유지한다.
- 실행 명령은 `npm run ...` (또는 `node ...`). `bun run`은 이 경로에서 동작하지 않는다.

2026-10-06 · Phase 1 구현 결정 (ponytail 적용 — P0 최소 구현)

| 항목 | 결정 | 이유/메모 |
| --- | --- | --- |
| LLM 연동 | `src/llm.ts` — fetch 기반 OpenAI 호환 `/chat/completions` + tool calling. SDK 없음 | 계획대로. `LLM_API_KEY` 있으면 live, 없으면 read-only stub |
| stub provider | 조회 Tool만 호출(search→첫 상품 리뷰). 요청 어미(~해줘/추천/비교 등)를 떼고 마지막 토큰을 검색어로 사용 | 쓰기 Tool은 절대 호출 안 함. 실제 모델 실행으로 보고하지 않음 |
| 멱등성 | `action_requests` 테이블 + `runAction`: 같은 actor+kind+key는 결과 행을 replay(READY→SUCCEEDED/REJECTED 저장). 23505면 커밋된 행을 읽어 복구 | 다른 payload면 IDEMPOTENCY_CONFLICT. 거부(OUT_OF_STOCK/VERSION_CONFLICT)도 REJECTED로 저장해 같은 에러 재현 |
| 비즈니스 규칙 | 가격/재고/거부 판단은 전부 서버(`src/cart.ts` 등). LLM은 결과 설명만 | DATA_TOOL_DESIGN 원칙 유지 |
| 카트 담기 | 재고 차감 없음(주문 시점은 Phase 3). 같은 variant는 수량 병합. cart 행 잠금 + version 검사 | P0 최소. 결제/재고 감소는 후속 Phase |
| 배송비 | 장바구니 비어 있지 않으면 고정 3,000원 | P0 단순화(무료배송 조건 없음) |
| 커서 | 불투명 base64 offset + limit<=50 | ponytail: 구조 숨기기만 하면 됨 |
| 화면 | `src/web/screens/{Shopping,Product,Cart}.tsx` + `components/{AgentPanel,CommerceState,ProductCard}` — Toss류 다크 테마 1파일 CSS | UI는 W01~W03 최소 + A01 패널. 주문 버튼은 Phase 3까지 미노출 |
| Agent | `src/agent.ts` — TOOL_REGISTRY 5종(search_products/get_product/get_reviews/get_cart/add_to_cart), 인자 allowed-keys 검증, ≤8 calls/60s, evidence_refs = Tool 결과에 실제 등장한 id만 | eval의 인용 근거 검사가 이 세트를 사용 |
| 라우팅/정적 | 정적 파일은 auth 게이트보다 먼저 서빙 | `/`가 401로 막히는 회귀 수정 |
