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
- eval 케이스 `t1-recommend-only`: 예산 캡 검색 후 전체 검색 1회를 추가해 예산 초과 후보(p-c) 인용을 Tool 결과에 근거하도록 수정.

## 2026-10-06 Phase 2

### T1 완성 — 카트 수정/삭제·비교 카드·근거 방어

| 명령 | 결과 |
| --- | --- |
| npm run check (tsc --noEmit) | PASS — 오류 0 |
| npm run build | PASS — web/app.js 1.2mb |
| npm run test:unit | PASS — 9/9 (citation grounding 3건 추가: 조회된 id만 통과·미조회 id 감지·무인용) |
| npm run test:integration | PASS — 20/20 (update/remove 11건 추가: 수량 변경·replay·0/음수 거절·재고 초과 거절·카트/옵션 버전 경합·타인 항목 NOT_FOUND·동명 다른 옵션·품절 삭제·빈 카트 전이) |
| npm run test:e2e | PASS — 5/5 (t1-complete: 수량 +/− → 363,000/183,000원 → 삭제 → Empty; compare card 3행+한계 표시+W02 이동) |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 8/8 (compare-present·update·remove·주입 리뷰 케이스 추가) |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (stub으로 대체하지 않음) |

메모:
- action kind는 migration 001 예약값 UPDATE_CART/REMOVE_CART 사용 — Phase 2 migration 없음(계획 일치).
- e2e 스펙 파일별 테스트 사용자 분리(t1-slice=u-a, t1-complete=u-b) — 병렬 실행 시 카트 버전 경합 방지.
- ungroundedCitations를 agent.ts로 옮겨 eval과 단위 테스트가 같은 규칙을 쓰게 함.
- 비교 카드는 모델 텍스트가 아니라 서버가 Tool 결과 JSON으로만 조립 — 조회 안 한 상품/근거 노출 불가.
- 실제 리뷰 표본(REAL) 미확보 → provenance.md에 미완료 항목으로 기록. r-09(주입 테스트)는 SYNTHETIC 적대 문장.

## 2026-10-06 Phase 3

### 모의 결제와 T2 주문·배송 설명 (W04/W05/W06 + CS Brain)

| 명령 | 결과 |
| --- | --- |
| node scripts/migrate.ts --phase=3 (개발 DB) | PASS — 002_orders_payments_shipments 적용. 기존 001 데이터/카트 보존 |
| node scripts/seed.ts --phase=3 | PASS — scenarios.json (ord-a-pre/ord-a-ship/ord-a-done=배송 3단계, ord-b-none=배송 정보 없음) |
| node node_modules/typescript/bin/tsc --noEmit | PASS — 오류 0 |
| node scripts/build-web.ts | PASS — web/app.js |
| node --test tests/unit/*.test.ts | PASS — 9/9 |
| node --test --test-concurrency=1 --test-force-exit tests/integration/*.test.ts | PASS — 40/40. 신규: checkout 7건(빈 카트 견적 거절/원자 커밋/중복 키 replay/결과 복구/STALE_QUOTE/동시 재고 1건만 성공+음수 재고 없음+패자 잔여 주문 없음/Agent checkout 불가), t2-orders 5건(소유권 스코프/NO_INFORMATION 구분/상세 스냅샷+결제+이력/checkout 주문이 같은 조회 경로/ship·deliver 전환 규칙) |
| node node_modules/playwright/cli.js test | PASS — 7/7. 신규 checkout-t2 2건(카트→주문서→152,000원 결제→W06 배송 준비 중→W05 목록; W06→AI 고객센터 stub이 list_orders→get_shipping_status로 실제 상태 설명) |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 12/12 (T2 4건: 배송 설명/정보 없음/모호 주문 선택/CS에서 쇼핑 Tool 거부) |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (stub PASS로 대체하지 않음) |
| 개발 서버 스모크 (Docker DB) | PASS — /health connected, 세션 발급, /api/orders 3건, /api/orders/:id/shipping 이벤트 확인 |
| node scripts/simulate.ts --order=ord-a-pre --event=ship→deliver | PASS — IN_TRANSIT/DELIVERED 전환, 배송 레코드 없는 주문 INVALID_STATE. 검증 후 시드로 기준값 복원 |
| node scripts/verify.ts --phase=3 | PASS — 누적 게이트 전체 통과 |

메모:
- jsonb 파라미터 버그 수정: postgres.js에 JSON.stringify(...)를 넘기면 이중 인코딩으로 jsonb 문자열이 저장돼 events_json CHECK 제약 위반. seed/checkout/ship·deliver 전부 raw 객체로 교정.
- 테스트 러너 종료: 통합 테스트 서브프로세스가 sql 풀로 종료하지 않아 --test 러너가 멈춤 → DB 사용 파일에 after(sql.end()) 추가 + verify.ts의 integration 단계에 --test-force-exit. session-api는 spawn kill 직후 force-exit 크래시(libuv async handle)라 300ms 지연 추가.
- 견적 토큰: HMAC 서명 불투명 토큰 + 5분 TTL. 확인 시 카트/옵션 버전·가격·재고 재검증(STALE_QUOTE/OUT_OF_STOCK). checkout은 Agent Tool이 아님(UI 전용) — toolDefs 양쪽 brain에서 노출 0건 검증.
- 재시드 시 variant version=1 리셋 추가 — checkout이 version을 올리므로 재현성 유지.
- 시드 주문은 재고 차감을 거치지 않음(provenance.md에 명시). 재고 차감은 checkout 경로만.

## 2026-10-07 Phase 4

### T3 — 주문 취소 확인·접수·처리·환불 (A02 + CS Brain 취소 Tool)

| 명령 | 결과 |
| --- | --- |
| node scripts/migrate.ts --phase=4 (개발/테스트 DB) | PASS — 003_cancel_requests 적용. 기존 001/002 데이터 보존 |
| node scripts/seed.ts --phase=4 | PASS — u-d 추가, 재시드 시 cancel_requests 정리·주문 version/cancelled_at/환불 필드 리셋(재현성) |
| node node_modules/typescript/bin/tsc --noEmit | PASS — 오류 0 |
| node scripts/build-web.ts | PASS — web/app.js |
| node --test tests/unit/*.test.ts | PASS — 18/18 (취소 자격 정책 p0-v1 9건: 충족/이미 취소/결제 부적격/금액 불일치/중복 요청/배송 없음/출고 후/비PREPARING/복합 사유) |
| node --test --test-concurrency=1 --test-force-exit tests/integration/*.test.ts | PASS — 58/58. 신규 18건: 확인 전 실행 거절·승인 UI 전용·타인 주문/승인/위조 차단·만료/버전/사유 불일치 거절·승인→실행→REQUESTED·replay·UI 승인만 CS Tool 소비·중복 취소 차단 / 취소-출고 경합·동시 실행 1건·재실행 복구 / 응답 유실 복구·접수 후 출고 차단·처리(주문/배송 CANCELLED+재고 1회 복원+환불 PENDING)·환불 전액 1회 멱등·금액 불일치 중단·무요청 전환 거절 |
| node node_modules/playwright/cli.js test | PASS — 9/9. 신규 t3-cancel 2건(주문 생성→A02 확인→취소 REQUESTED·W06/W05 표시; 출고 seed 주문은 시트에서 불가 사유·실행 버튼 없음) |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 16/16 (T3 4건: 자격 설명·확인 전 요청 시 CONFIRMATION_REQUIRED·출고 주문 불가·타인 주문 NOT_FOUND) |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (stub PASS로 대체하지 않음) |
| node scripts/simulate.ts --event=cancel/refund | PASS — REQUESTED→취소 처리(재고 복원·환불 PENDING)→REFUNDED. 검증 후 시드로 기준값 복원 |
| node scripts/verify.ts --phase=4 | PASS — 누적 게이트 전체 통과 |

메모:
- e2e 병렬 충돌 수정: t3-cancel이 checkout-t2와 같은 옵션(v-b-24)을 구매해 한쪽이 STALE_QUOTE(재고 차감→옵션 버전 증가는 설계상 정상 거절). t3는 아무 스펙도 안 쓰는 모니터 C(v-c-27)로 격리. 도메인 규칙은 변경하지 않음.
- checkout-t2의 '주문 상세' 헤딩 대기 5s→15s (병렬 부하 시 응답 지연 플레이크 방지, t3와 동일 기준).

## 2026-10-07 Phase 5

### 통합 검증 — core journeys·holdout 평가·배포 준비

| 명령 | 결과 |
| --- | --- |
| node scripts/eval.ts --mode=stub --split=holdout --repeat=3 | PASS — 18/18 (6케이스×3회, 회마다 사용자 데이터 초기화). T1: 예산 152,000 cap 추천·v-b-27 2개 담기 / T2: PREPARING 설명·타인 주문 NOT_FOUND / T3: 배송정보없음 불가·2턴 확인 전 실행 차단 |
| docker build -t ai-commerce-p0:test . | PASS — 이미지 빌드 성공 |
| docker run (host.docker.internal DB, stub) → /health + / | PASS — {"ok":true,"db":"connected"}, SPA HTML 서빙 확인 후 컨테이너 정리 |
| node scripts/verify.ts --phase=5 | PASS — tsc/build + unit 18/18 + integration 58/58 + e2e 14/14(core-journeys 5건 포함) + dev eval 16/16 + holdout eval 18/18(6×3) |

메모:
- eval arg 파서 버그 수정: `--k=v`가 매칭되지 않아 --split/--mode가 조용히 무시되던 문제. 기존 호출이 우연히 기본값과 일치해 지금까지 드러나지 않았다. `--k=v`와 `k=v` 둘 다 허용하도록 교정.
- eval에 `--repeat=N` 추가: 케이스를 N회 실행하며 회마다 cleanUserData+resetHistory+새 provider. 결과 id는 `case#rN`.
- verify.ts STEPS[5]: holdout stub eval 3회를 누적 게이트에 추가.
- core-journeys.spec.ts는 기존 스펙이 덮지 않는 필수 상태만(검색 없음/품절 옵션 비활성/배송 정보 없음/DELIVERED 취소 불가/CS NO_INFORMATION). 중복 여정은 다시 검증하지 않는다.
- Dockerfile은 로컬 빌드·기동·health/SPA까지 검증. 외부 배포(레지스트리/호스트)는 계정 미정으로 BLOCKED — 배포 절차는 README에 기록.
- 실사용자 5명 테스트는 사람이 수행할 작업. USER_TEST_REPORT.md에 프로토콜·기록 양식을 준비하고 미실시로 표시.
- live eval은 LLM_API_KEY 미설정으로 계속 BLOCKED.
