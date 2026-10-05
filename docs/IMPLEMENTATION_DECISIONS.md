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
