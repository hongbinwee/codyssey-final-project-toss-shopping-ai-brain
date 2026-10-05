# Verification Log

명령 실행과 결과를 기록한다.

## 2026-10-05 Phase 0

### 환경 복구 후 재검증 (Docker PostgreSQL 5432)

| 명령 | 결과 |
| --- | --- |
| `npm run db:migrate -- --phase=0` | PASS — `_migrations` 테이블 생성, 적용 파일 0개 (Phase 0은 업무 migration 없음) |
| `npm run db:seed -- --phase=0` | PASS — "no seeds defined for phase <= 0" (예상 동작) |
| `npm run check` (tsc --noEmit) | PASS — 오류 0 |
| `npm run build` (esbuild) | PASS — web/app.js 생성 |
| `npm run test:unit` | PASS — 3/3 (session 서명·위조 거부·actor 스푸핑 차단) |
| `npm run test:integration` | PASS — 2/2 (health connected, db down -> 503) |
| `npm run test:e2e` | PASS — 1/1 (앱 셸 + DB 연결 표시, chromium) |
| `npm run verify -- --phase=0` | PASS — 위 전체 순차 통과 |

메모:
- `.env`의 `DATABASE_URL=postgres://commerce:commerce@localhost:5432/commerce` (Docker compose 컨테이너 `codyssey_final-db-1`) 사용 확인.
- `src/config.ts`가 `.env`를 로드하며, 이미 설정된 환경 변수는 덮어쓰지 않음(테스트 주입 가능).
- `src/devdb.ts`는 `config.ts`를 먼저 import해 `.env`를 읽은 뒤 `DATABASE_URL` 유무로 embedded fallback 여부를 결정.

## 2026-10-06 Phase 1

### T1 Vertical Slice — 카탈로그/장바구니/Agent Tool 경계

| 명령 | 결과 |
| --- | --- |
| `npm run db:migrate -- --phase=1` | PASS — `001_catalog_cart_actions.sql` 적용 (users/products/product_variants/reviews/carts/cart_items/action_requests). 개발 DB 확인: products 3 / variants 6 / reviews 8 / users 2 |
| `npm run db:seed -- --phase=1` | PASS — users(u-a/u-b), catalog(모니터 A/B/C, 옵션 6개), SYNTHETIC 리뷰 8건 |
| `npm run check` (tsc --noEmit) | PASS — 오류 0 |
| `npm run build` | PASS — web/app.js 1.2mb |
| `npm run test:unit` | PASS — 6/6 (availability, specs matching, payload hash, session 3건) |
| `npm run test:integration` | PASS — 12/12 (health 2, session-api 1, t1-cart 9: 담기/멱등 replay/IDEMPOTENCY_CONFLICT/유실 응답 복구/수량 병합/OUT_OF_STOCK·과수량 거부/VERSION_CONFLICT/사용자 격리) |
| `npm run test:e2e` | PASS — 3/3 (smoke, T1 slice: 로그인→검색→옵션→담기→합계 183,000원, A01 stub 패널) |
| `node scripts/eval.ts --mode=stub --split=dev` | PASS — 4/4 (추천-only/담기/품절 거부/모호 요청 확인 질문) |
| `node scripts/eval.ts --mode=live` | BLOCKED — `LLM_API_KEY` 미설정. stub PASS로 대체하지 않음 (계획 규칙) |

메모:
- `verify --phase=1` 래퍼 실행 중 호스트 셀이 중간 회수되는 환경 이슈가 있었으나, 구성 단계(tsc/build/unit/integration/e2e/eval)를 각각 직접 실행해 모두 PASS 확인. verify.ts 스크립트 자체 결함 아님.
- e2e는 `commerce_test` DB 공유 — global-setup에서 u-a/u-b 카트·action_requests를 매번 비움(누적 수량으로 금액 assertion이 깨지는 것 방지).
- eval 케이스 `t1-recommend-only`: 예산 캡 검색 후 전체 검색 1회를 추가해 예산 초과 후보(p-c) 인용을 Tool 결과에 근거하도록 수정.
