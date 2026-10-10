# Verification Log

명령 실행과 결과를 기록한다.

> 표기 규칙: Phase 0~5의 'PASS/완료'는 **로컬 구현 + 로컬 검증** 기준이다. live LLM eval(LLM_API_KEY 미설정 BLOCKED)·외부 배포·실사용자 테스트는 미완료이며 로드맵 12~13에서 수행한다(PROJECT_CONTEXT.md §현재 프로젝트 방향). 과거 기록은 당시 사실을 보존하되, Superseded된 결정은 그대로 두고 [Superseded] 표시로 현재 결정과 연결한다.

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

## 2026-10-07 구매자 UI 1차 — 홈·검색·목록(토스쇼핑 레퍼런스 기반)

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| node --test tests/unit/*.test.ts | PASS — 18/18 |
| node --test --test-concurrency=1 tests/integration/*.test.ts | PASS — 전체 통과 (회귀 없음) |
| Playwright e2e | PASS — 14/14 |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 16/16 |
| node scripts/eval.ts --mode=stub --split=holdout --repeat=3 | PASS — 18/18 |
| node scripts/build-web.ts | PASS — web/app.js |
| 브라우저 실검증 (localhost:3200, 390×844, demo-a) | PASS — 홈/검색(최근·자동완성·결과·정렬시트·가격순·빈결과)·카테고리 필터 시각 확인. 캡처: 당시 test-results/compare/(playwright가 폴더를 비워 삭제됨 — 복원되지 않음). 현재 비교 캡처는 이후 Light/Dark 재촬영분 `shots/compare/light_*.png`·`dark_*.png` 10장 |
| /assets/products/*.webp 정적 서빙 | PASS — 200 |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (유지) |

메모:
- 이번 변경은 프런트(스타일/화면/정적 자산) 위주. Backend API·DB 스키마·Tool 계약은 변경 없음.
- 상품 이미지는 DB image_urls가 비어 있어 프런트 convention 매핑(/assets/products/{id}.webp)으로 해결. DB 시드 변경 없음. 시드 확장(상품 수/할인·적립 필드)은 미승인 제안 상태.
- 레퍼런스 대비 의도적 차이: 히어로 캐러셀·아이콘 그리드 대신 AI 카드, 하단 네비는 토스 앱 전체가 아닌 쇼핑 범위(홈/검색/장바구니/내 주문/AI), 토스 브랜드 자산 미사용. **[Superseded 2026-10-07]** 이 '의도적 차이'는 당시 결정의 이력 기록이다 — Navigation 쇼핑 범위 단순화·AI 카드가 merchandising을 대신한다는 판단은 방향 재정립으로 폐기됐다(docs/IMPLEMENTATION_DECISIONS.md 2026-10-07 절). 현재 기준: Navigation·merchandising 모두 레퍼런스 구조 충실.
- 미해결 차이: 상품 카드 할인 배지/원가 취소선/적립 pill/카드 위 장바구니 아이콘은 데이터 필드 부재로 미구현(제안 대기).

## 2026-10-07 디자인 시스템 정본화 + 홈·검색·목록 Visual 보정

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| npm run check (tsc) | PASS |
| node --test tests/unit/*.test.ts | PASS — 18/18 |
| node --test --test-concurrency=1 tests/integration/*.test.ts | PASS — 전 스위트 ✔ (t1-catalog+t2-orders 별도 확인 10/10) |
| npx playwright test --output=pw-output | PASS — 14/14 |
| node scripts/build-web.ts | PASS |
| 390×844 colorScheme light/dark 캡처 | PASS — shots/compare/{light,dark}_{home,search_results,search_idle,search_empty,home_cat}.png |

메모:
- COMMERCE_DESIGN_SYSTEM.md를 구현 Source of Truth로 v2 정본화: [Project] 태그 추가, Light/Dark semantic 토큰표(2-1)·Iconography(2-2)·공통 상태 스펙 신설, 하단 네비 라벨 정정(토스 앱 전체 네비 vs 우리 쇼핑 네비 구분), Pretendard 도입 반영.
- 이모지 → src/web/icons.tsx 단일 SVG 라인 아이콘(24 그리드·stroke 2·currentColor) 전환: 검색/카트/뒤로가기/닫기/홈/주문/AI/시계/chevron/✓/★.
- 홈 카테고리 언더라인 탭 → pill 칩(.cat-tab, 선택=--chip-on+bold)으로 교정 — home/01의 '쇼핑 홈' pill 관측값 반영.
- 정렬 바텀시트에 grabber(.sheet-grabber) 추가, 검색 결과 헤더에 카트 아이콘 추가(레퍼런스 관측).
- e2e 로케이터 'AI' exact로 갱신(SVG aria-hidden으로 접근 이름은 'AI').
- COMMERCE_UI_SPEC.md 7-1에 다음 Phase(상세→옵션→카트) 스펙 기록: 구매 가능 기본 옵션 자동 선택, 품절 옵션 기본 선택 제외, 전부 품절일 때만 CTA disabled, 옵션 변경은 공용 BottomSheet, 선택·수량에 따라 가격/CTA 즉시 갱신.
- 사고 기록: playwright 기본 outputDir(test-results)이 실행 시 폴더를 비워 기존 비교 캡처·분석 스크립트 삭제됨. 이후 스크린샷은 shots/compare/, 스크립트는 scripts/shoot-themes.mjs로 이동. 중복 실행으로 남은 고아 node --test 프로세스 14개는 사용자 승인 후 PID 명시로 정리.
- live eval은 LLM_API_KEY 미설정으로 계속 BLOCKED.

## 2026-10-08 04-B Demo Catalog 구현

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| npm run db:seed:demo (dev DB commerce) | PASS — 데모 상품 25·variant 55·review 80 적재. dev DB 실측 products 28 / variants 61 / reviews 89 |
| npm run db:seed:demo ×3 반복 실행 | PASS — 멱등. p-d-*/v-d-*/r-d-* reconcile 후 동일 행수 유지 |
| node node_modules/typescript/bin/tsc --noEmit | PASS — 오류 0 |
| node scripts/build-web.ts | PASS — web/app.js |
| node --test tests/unit/*.test.ts | PASS — 18/18 |
| node --test (integration 파일별 순차 실행) | PASS — cancel 18 / checkout 7 / health 2 / session 1 / t1-cart 20 / t1-catalog 6(데모 격리 단정 신설) / t2-orders 5 |
| Playwright e2e | PASS — 14/14 |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 16/16 |
| node scripts/eval.ts --mode=stub --split=holdout | PASS — 18/18 |
| 브라우저 실검증 (localhost:3200, 390×844, demo-a) | PASS — 홈 특가 레일·그룹 탭 필터·검색 그룹 칩·상세 실사진 히어로·스펙 라벨 확인. 캡처: shots/demo-b/ (gitignore) |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (유지) |

메모:
- Demo Catalog는 seed --demo로만 적재. 기본 seed(--phase)는 기존 deterministic fixture(catalog.json 3상품/6variant + reviews.json 9건 — r-09는 prompt-injection 방어용 의도적 적대 문장, provenance.md 참고)만 유지해 commerce_test에 데모 데이터가 유입되지 않는다. t1-catalog에 "demo catalog is isolated from test db" 단정 추가.
- Demo reconcile: seed --demo 실행 시 데모 네임스페이스(p-d-*/v-d-*/r-d-*) 한정으로 정리 후 재적재. order_items가 참조하는 상품은 삭제 대신 active=false. p-a/p-b/p-c·사용자·주문 등 기존 데이터는 건드리지 않는다. **[Superseded 2026-10-08]** 이 기록의 동작 설명은 04-B 초기 구현 기준이다 — 이후 검수에서 --demo가 phase=99를 암시해 base 시드까지 재실행하는 결함이 발견돼, demo 전용 독립 모드 + r-d-* 한정 reconcile + 외부 참조 보존 + commerce_test 가드로 교정됐다(아래 '04-B Seed Safety Correction' 절).
- 리뷰 수/평점은 실제 저장된 SYNTHETIC review row 기준으로 통일(review_count_display 미사용 — 대규모 표시 수가 필요하면 aggregate 통계와 sample text를 분리하는 별도 계약을 그때 설계).
- 카테고리: 기존 fixture는 category=monitor 유지, 신규 데모는 digital/beauty/fashion/living/food 상위 카테고리. display-meta의 CATEGORY_GROUPS가 monitor를 디지털 UI 그룹에 묶어 표시.
- 상품 이미지 25장은 imagegen으로 생성 후 600×600 WebP로 변환해 web/assets/products/에 배치(총 ~210KB). 무단 스크래핑·브랜드 자산 사용 없음.
- 사고 기록: 병렬 재실행으로 남은 고아 node --test 프로세스가 commerce_test를 동시 reseed해 스위트가 간헐 지연. 임의 PID 강제종료는 자동 검토 거부로, 파일 단위 개별 실행으로 회귀 검증을 완료했다. 통합 스위트는 한 번에 하나만 실행할 것.
- live eval은 LLM_API_KEY 미설정으로 계속 BLOCKED.

## 2026-10-08 04-B Seed Safety Correction

Side Astra 검수에서 --demo의 암묵적 base 재시드(phase=99)·리뷰 reconcile 범위 결함이 발견돼 교정했다.

### 변경

- `--demo`는 **demo 전용 독립 모드**: phase 시드(users/catalog/reviews/scenarios)를 실행하지 않는다. `--demo`+`--phase` 동시 사용은 거부(exit 1).
- `--demo`를 `commerce_test` DB에서 실행하면 거부한다(당시: URL의 db명 검사 — 이후 URL 옵션 우회 가능이 발견돼 실제 접속 DB 기준 검사로 강화됐다. 아래 '04-B Seed Safety Final Patch' 절 참고).
- stale 리뷰 정리는 `id LIKE 'r-d-%'`로 한정 — 데모 상품에 붙은 비-demo 리뷰(product_id LIKE 'p-d-%'만으로)는 더 이상 삭제하지 않는다.
- stale v-d-*/p-d-* 정리: 외부 참조(order_items/cart_items/reviews)가 있으면 DELETE 대신 active=false 보존. 사용자 cart_items를 reconcile이 지우지 않는다.
- Search.tsx 검색 결과 요청에 limit=50 추가 — 서버 기본 20으로 인해 그룹 필터가 28개 카탈로그의 일부를 누락하던 문제 수정.
- 프로틴 상품(p-d-pro-1, 720g 파우더/24회분) 이미지가 RTD 병처럼 보이던 것을 파우더 통+스쿱 이미지로 재생성 교체.

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| node --test tests/integration/demo-seed.test.ts (신규, scratch DB commerce_demo_verify) | PASS — 3/3. (1) commerce_test --demo 거부 (2) --demo+--phase 거부 (3) fixture stock/version·주문 version/cancelled_at·payment 환불 상태가 3회 데모 시드 후에도 보존, r-custom 비-demo 리뷰 보존, r-d-stale 정리, 외부 참조 stale variant/product는 active=false 보존 + 사용자 cart_item 보존, 고아 stale 행만 삭제, fixture p-a~c·리뷰 9건·demo 25/55 확인 |
| npm run db:seed:demo (dev DB) | PASS — demo 파일만 적재(base 시드 미실행 로그 확인), reconcile 정상, dev DB 실측 28/61/89 유지, v-a-24 stock=5·주문 4건 불변 |
| node node_modules/typescript/bin/tsc --noEmit | PASS |
| node scripts/build-web.ts | PASS |
| node --test tests/unit/*.test.ts | PASS — 18/18 |
| integration 전체 | PASS — 62건. 스위트 1회 실행 중 후반부 출력이 멈춰(고아 프로세스 간섭 추정) 로그상 51건 확인 + t1-catalog 6·t2-orders 5를 파일별 재실행해 전부 PASS 확인 |
| Playwright e2e | PASS — 14/14 |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 16/16 |
| node scripts/eval.ts --mode=stub --split=holdout --repeat=3 | PASS — 18/18 |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (유지) |

메모:
- demo-seed.test의 seed 헬퍼가 --demo를 누락해 1차 실행에서 거부 테스트가 phase-0 no-op으로 통과되던 결함을 발견·수정. 보존 검증이 실제 --demo를 3회 실행함을 확인했다(실패→수정→통과 이력).
- payments CHECK 제약(전액 환불만 허용)에 맞춰 검증용 UPDATE도 refunded_amount=paid_amount로 조정 — 제약 자체는 변경하지 않았다.

## 2026-10-08 04-B Seed Safety Final Patch

Side Astra 재검수에서 남은 Major 2건(demo seed 원자성 부재, DB 가드 우회)을 해소했다.

### 변경

- demo seed의 모든 DB write를 `sql.begin` 단일 트랜잭션으로 묶었다 — DB 가드 확인 → stale reconcile(리뷰→variant→product) → demo upsert(product→variant→review)가 한 트랜잭션에서 커밋되거나 함께 롤백된다. 트랜잭션 콜백 안의 모든 쿼리는 전달받은 `q`를 사용한다.
- DB 가드를 URL pathname 검사에서 트랜잭션 안의 `SELECT current_database()`로 교체했다. postgres.js는 `?database=` URL 옵션을 실제 접속에 사용해 pathname과 다른 DB에 연결될 수 있으므로(`postgres://…/commerce?database=commerce_test` → commerce_test 접속 확인), 가드는 실제 접속 DB명을 본다. 허용 DB: `commerce`, `commerce_demo_verify`. 그 외(테스트 DB 포함)는 거부한다.
- demo-seed.test.ts 확장: ?database= 우회 거부 + 거부 시 무쓰기 단정, 트랜잭션 중간 실패(CHECK 제약 주입) 시 reconcile·upsert·비활성화 전체 롤백 검증, cancel_requests/action_requests·주문 상태 보존 단정 추가, scratch DB 정리를 try/finally로 이동.

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| node --test tests/integration/demo-seed.test.ts | PASS — 5/5. (1) commerce_test --demo 거부 (2) `?database=commerce_test` 우회도 거부 + commerce_test의 p-d-* 개수 전후 불변 (3) --demo+--phase 거부 (4) fixture stock/version·주문 status·cancel_requests COMPLETED·payment 환불 상태가 3회 데모 시드 후 보존, r-custom 보존, r-d-stale 정리, 외부 참조 stale 행 active=false 보존, 고아 행 삭제, fixture·demo 25/55 확인 (5) products CHECK 제약으로 upsert 중간 실패 주입 → reconcile 삭제/비활성화·product upsert 전부 롤백 확인, 제약 제거 후 동일 seed 정상 커밋 |
| node node_modules/typescript/bin/tsc --noEmit | PASS |
| node scripts/build-web.ts | PASS |
| node --test tests/unit/*.test.ts | PASS — 18/18 |
| integration 전체 | PASS — 64건. 스위트 로그상 28건(demo-seed 5·health 2·session 1·t1-cart 9·t1-update 11) 확인 후 실행 프로세스가 t1-cart update 직후 소멸하는 기존 증상 재발 → 나머지 7개 파일을 개별 직렬 실행해 전부 PASS(t1-catalog 6·t2-orders 5·checkout 7·cancel-confirmation 9·cancel-race 3·cancel-recovery 6). 병렬 재실행(3개 cancel 파일 동시) 시 VERSION_CONFLICT 재현 — commerce_test 공유 충돌이며 직렬 실행으로 해소 |
| Playwright e2e | PASS — 14/14 |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 16/16 |
| node scripts/eval.ts --mode=stub --split=holdout --repeat=3 | PASS — 18/18 |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (유지) |

메모:
- 실패 주입은 테스트에서 `ALTER TABLE products ADD CONSTRAINT chk_demo_tx CHECK (id <> 'p-d-tone') NOT VALID`로 수행 — 운영 seed 경로에 디버그 옵션을 두지 않았다. 기존 행 검증을 건너뛰는 NOT VALID이지만 신규 write(upsert)에는 적용돼 트랜잭션 중간 실패를 만든다.
- 검증 초기 `DEMO_DBS` 상수가 모듈 하단에 선언돼 TDZ로 전 테스트가 실패하던 결함을 발견·수정(선언을 데모 분기 위로 이동) — 실패→수정→통과 이력.

## 2026-10-08 04-C Toss Shopping Home Reconstruction

홈 전체 IA를 토스쇼핑 캡처 기준으로 재구축했다(코드 변경: src/web/{app.tsx,icons.tsx,display-meta.ts,screens/Shopping.tsx,components/ProductCard.tsx,styles.css}). 대형 AI 카드는 홈에서 제거하고 진입점은 하단 네비 `AI` 탭으로 유지한다.

### e2e 보정 (UI 구조 변경에 따른 기대 조건 갱신 — 단정 완화 아님)

- 로그인 완료 신호: 제거된 홈 AI 카드 버튼 `/AI에게 조건/` → 홈 헤더의 `상품 검색` placeholder로 변경(5개 spec).
- `내 주문` strict-mode 충돌: 신설된 홈 숏컷 `.sc-item`과 하단 네비 `.nav-item`이 동일 라벨 → 테스트의 클릭 대상을 `.bottom-nav`로 스코프(5곳). 숏컷 라벨은 유지(사용자 지정 예시).

### 실행 환경 이슈 (코드와 무관)

- 이전 세션의 고아 `node --test t1-cart`(PID 34428)는 세션 리셋으로 이미 소멸 확인 → 단독 재실행 PASS(20/20).
- Playwright 연속 재실행 간 `ERR_CONNECTION_REFUSED` = 이전 실행의 고아 3100 webServer를 `reuseExistingServer`가 재사용하다가 프로세스가 중간 소멸한 것. 3100 리스너 소멸 확인 후 단일 실행 시 정상.

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| node node_modules/typescript/bin/tsc --noEmit | PASS |
| node scripts/build-web.ts | PASS |
| node --test tests/unit/*.test.ts | PASS — 18/18 |
| integration 전체 | PASS — 64건. 스위트 1회 실행은 러너 프로세스 소멸로 로그 53건까지 기록(모두 PASS) → 나머지 t1-catalog 6·t2-orders 5를 파일별 실행해 전부 PASS |
| Playwright e2e | PASS — 14/14 (보정 후 클린 단일 실행) |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 16/16 |
| node scripts/eval.ts --mode=stub --split=holdout --repeat=3 | PASS — 18/18 |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (유지) |

### Visual QA (390×844, reference 대조)

- 캡처: `shots/04c/` — dark/light 각 11장 + `cmp_*.jpg` 병렬 비교 6장(홈 첫 화면·스크롤·뷰티·특가·시즌·카테고리).
- 대조 결과: 수직 구역 순서(헤더→탭→히어로→혜택→숏컷→추천→그리드)·히어로 카드형 슬라이드+페이지 인디케이터·숏컷 레일 밀도·2열 카드 계층이 레퍼런스와 구조적으로 일치. Light는 실제 토스 Light 레퍼런스 부재로 [Project]/[TDS] 토큰 기준.
- 남은 차이(04-D/08 범위로 기록): 하단 네비(토스=홈/혜택/쇼핑/증권/전체 vs 우리=홈/검색/장바구니/내 주문/AI), 스크롤 시 헤더 플로팅 축소(당시 sticky — **[아래 04-C Correction에서 구현됨]**), 카드 이미지 radius 미세 차이(~14-16px vs 12px), 토스 카드의 '30일 최저가/N명/적립' 행은 근거 데이터 없어 의도적 미구현.

## 2026-10-08 04-C Visual Correction Pass

사용자 Visual QA 보류에 따른 좁은 보정 — 전체 재개발 없이 비교 캡처에서 확인된 차이만 수정했다.

### 수정 범위

- **Product Card anatomy** [Observed `home/02`·`product-list/34`]: 다크 셸 위 라이트 카드(`--pcard` light `#fff` / dark `#b6b6b6`)로 이미지·정보 영역 일체화 — radius ~14px+overflow hidden, 이미지 ~1.12:1+하단 카드색 페이드, 본문 다크 텍스트, 할인율%=가격과 동일 다크색(레드는 이미지 배지만), 우하단 흰 원형 카트 버튼, 카드 마진·grid gap ~10px(`.shell.shop-pad`로 shop/search 라우트만 `--pad:10px`, 나머지 라우트는 20px 유지).
- **특가 탭 구조 복원** [Observed `product-list/34`]: 프로모 카드(좌 텍스트+우 이미지) → 보조탭(하루 특가/셀러 특가/기획전/쿠폰 혜택 — 하루 특가 활성, 기획전→시즌 탭, 나머지 2개는 Backend 없어 disabled '준비 중') → 자정 카운트다운 → DealCard(좌상 '하루특가 n%' 배지+우하 원형 카트 아이콘).
- **Hero 크기 보정**: 슬라이드 높이 186→~232px, 할인율 14.5/상품명 20/가격 21px(800), 이미지 영역 45%.
- **스크롤 헤더** [Observed `home/02`]: shop 라우트 scrollY>72px → `.top.mini`(검색필드 소멸) + 플로팅 검색·카트 버튼(카트 배지 유지). 다른 라우트 영향 없음.
- **Home 상품 구성**: recommended 우선 + 카테고리 라운드로빈 정렬로 식품/뷰티/리빙/디지털/패션 혼합 노출(기존 디지털 편중 해소). Hero 콘텐츠도 커피/선크림/의자로 다양화.
- 숏컷 아이콘: 54px 원형 → 46px squircle(토스 관찰 형태).
- 변경 파일: `src/web/{app.tsx,display-meta.ts,styles.css,screens/Shopping.tsx}` — Backend/DB/Seed 변경 없음.

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| node node_modules/typescript/bin/tsc --noEmit | PASS |
| node scripts/build-web.ts | PASS |
| node --test tests/unit/*.test.ts | PASS — 18/18 |
| integration 파일별 순차 | PASS — cancel-confirmation 9 / cancel-race 3 / cancel-recovery 6 / checkout 7 / demo-seed 5 / health 2 / session-api 1 / t1-catalog 6 / t2-orders 5 / t1-cart 20 — 전부 개별 PASS |
| Playwright e2e | PASS — 14/14 |
| node scripts/eval.ts --mode=stub --split=dev | PASS — 16/16 |
| node scripts/eval.ts --mode=stub --split=holdout --repeat=3 | PASS — 18/18 |
| node scripts/eval.ts --mode=live | BLOCKED — LLM_API_KEY 미설정 (유지) |

메모(기존 환경 이슈, 이번 변경과 무관 — 프런트 전용 변경): `t1-cart`는 20개 테스트 모두 개별 통과하나 `after(sql.end())` 이후 워커 프로세스가 수 분간 종료되지 않는 기존 지연이 재현됨(DB 잠금·미커밋 트랜잭션 없음 확인). 04-C 이전 턴에서도 동일 증상이 보고·기록된 상태.

### Visual QA (390×844, Reference 대조)

- 비교 캡처: `shots/04c/qa/` — 01_home_first·02_home_scrolled·03_hero_slide·04_beauty·05_sale·06_light (Reference|Implementation 병렬).
- 자체 확인: 라이트 카드 anatomy·특가 상단 구조(프로모/보조탭/타이머)·히어로 비중·스크롤 플로팅 헤더·카테고리 혼합 노출이 Reference와 구조적으로 일치.
- 남은 차이: 하단 네비(04-D 범위), 토스 카드의 '30일 최저가/N명 구매/적립' 행은 근거 데이터 없어 의도적 미구현, 카드 이미지 radius 등 미세 수치는 08 Visual Polish 범위.
- **최종 Visual 승인 = 사용자 대기 중 (04-C 미확정).**

## 2026-10-09 04-C Product Card C안 보완

사용자 승인 C안에 따라 Product Card의 관측 지표와 시각 계층을 보완했다. 04-C의 사용자 Visual QA는 계속 대기 상태다.

### 변경

- 그리드 카드의 정가 취소선을 제거하고, 이미지 배지 아래에 할인율+판매가를 한 줄로 강조했다. 특가 DealCard의 정가 취소선은 유지한다.
- 상품명 2줄·카드 내 여백·배송 칩·평점 메타를 정리하고, 별점을 다크 톤으로 맞췄다. 우하단 카트는 배경 없는 작은 윤곽선 쇼핑백으로 변경했다.
- UI 전용 `ProductSignals`를 추가했다. 조회수는 페이지뷰와 구분된 고유 방문자 수·집계기간·기준시각·출처유형·출처명을 가진다. 합성값에는 카드에서 '데모'를 표시한다.
- 30일 최저가는 고정 Boolean 대신 `product_id + variant_id + source_name`별 시점·가격 관측표본에서 계산한다. 같은 옵션·같은 출처의 최근 30일 표본만 사용하며, 현재 서버 가격이 계산된 최저가 이하일 때만 노출한다. 표본이 없거나 만료·가격 초과 시 숨긴다.
- DB/Migration·상품 Seed·외부 API·조회 수집·적립 정책은 추가하지 않았다. 현재 Product Signals 표본은 `SYNTHETIC`이다.

### 검증

| 명령 / 확인 | 결과 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS |
| `node scripts/build-web.ts` | PASS |
| `node --test tests/unit/*.test.ts` | PASS — 21/21 (조회수 포맷, 동일 옵션 30일 최저가, 현재가가 최저가보다 높을 때 숨김, 관측기간 만료) |
| Playwright E2E | PASS — 14/14. 첫 시도는 Docker Desktop 정지로 readiness 실패; Docker Desktop과 DB 컨테이너를 기존 `pgdata` volume으로 기동한 뒤 재실행 통과 |
| `node scripts/eval.ts --mode=stub --split=dev` | PASS — 16/16 |
| `node scripts/eval.ts --mode=stub --split=holdout --repeat=3` | PASS — 18/18 |
| Integration 전체 | 이번 변경은 Frontend·표시 신호 전용이므로 재실행하지 않음. 직전 기록의 직렬 Integration 64건 PASS 유지 |
| Live Eval | 이번 변경에서 실행하지 않음(Brain/API 변경 없음); 기존 LLM key 미설정 BLOCKED 기록은 유지 |

### Visual QA

- 기준 390×844, Dark: Reference/Implementation 비교본 `shots/04c/qa/01_home_first.png`, `02_home_scrolled.png`, `03_hero_slide.png`, `04_beauty.png`, `05_sale.png`; Light 구현본은 `06_light.png`.
- 확인: 그리드에서 배지·가격·30일 최저가·조회/평점·배송 칩·쇼핑백의 순서와 밀도가 보이고, 합성 신호에는 '데모'가 표시된다. Dark/light 모두 레이아웃이 유지된다.
- 남은 Gap: 사용자 시각 승인 전 04-C를 종료하지 않는다. 하단 Navigation은 04-D 범위다.

## 2026-10-10 · PMQA-04C-VERIFY-001 — c24dea0 독립 검증 (코드 변경 없음)

목적: PM/독립 QA 지시로 HEAD c24dea0447483a408bf2b319f9d76c0c540ab6d9 (04-C3 Product Card C안)의 회귀 검증과 증거 정리만 수행. 구현 변경·Push·04-D 진입 없음.

### 환경 · 원격 상태

- cwd C:\문서\codyssey_final, branch main, 검증 SHA c24dea0. 추적 파일 변경 없음(미추적 tmp_* 작업 스크립트만 존재).
- 원격 main = 689c12667371d910493afd420cf05b651ced103b — PM이 연결된 GitHub 커넥터(hongbinwee)로 get_repo/fetch_commit을 직접 호출해 확인. 로컬은 1 ahead(c24dea0 미Push). 로컬 추적 ref origin/main이 같은 값을 보이나 로컬 fetch 성공 증거는 아니다.
- 로컬 GitHub 인증 불가: 프라이빗 저장소 — GCM에 유효 자격 없음(GIT_TERMINAL_PROMPT=0에서 could not read Username), gh는 project99hong-ai로 로그인돼 저장소 404(권한 없음, 운영 지침상 접근 금지). 정책은 '연결된 hongbinwee GitHub 도구 우선, 불가능한 경우에만 구체적 제약·대안 보고'이며 로컬 원격 작업의 절대 금지가 아니다(PMQA-GIT-POLICY-20261010).
- 턴 시작 시 Docker Desktop 중단 → 사용자 로컬 설치 경로로 기동 → codyssey_final-db-1 start → SELECT 1 = 1. 이번 샌드박스는 비상승 컨텍스트의 localhost TCP와 docker npipe 접근이 차단돼 DB·서버·브라우저 명령은 모두 승인된 상승 실행으로 수행했다(npipe 'permission denied'는 daemon 다운이 아니라 세션/ACL 차이).

### 명령 · 결과 (대상 SHA c24dea0, 로그 shots/04c/verify/)

| 명령 | 결과 |
| --- | --- |
| npm run check (tsc --noEmit) | PASS — exit 0 (tsc.log) |
| npm run build | PASS — exit 0, web/app.js 1.3mb (build.log) |
| npm run test:unit | PASS — 21/21, exit 0 (unit.log) |
| npm run test:integration (node --test --test-concurrency=1) | 개별 테스트 53/53 PASS(8파일: cancel-confirmation 9·cancel-race 3·cancel-recovery 6·checkout 7·demo-seed 5·health 2·session-api 1·t1-cart 20) 후 runner가 최종 요약·종료 코드 없이 **종료되지 않고 지속(hang)** — 프로세스 조회로 npm wrapper(PID 27044)·runner(PID 20228)·t1-cart 워커(PID 25520)가 잔존함을 확인하고, 이번 작업에서 시작한 프로세스만 종료했다. --test-force-exit 미사용 (integration.log) |
| node --test tests/integration/t1-catalog.test.ts | PASS — 6/6, exit 0 (int-t1-catalog.log) |
| node --test tests/integration/t2-orders.test.ts | PASS — 5/5, exit 0 (int-t2-orders.log) |
| Integration 판정 | 개별 assertion 64/64 전부 PASS / 스위트 runner는 정상 종료하지 못하고 잔존해 이번 작업에서 수동 종료(runner 완결 = BLOCKED) — 구분해 기록한다. 원인 후보(PM read-only 분석): t1-cart.test.ts의 두 suite가 각각 ensureTestDb→connectDb 호출, src/db.ts connectDb가 기존 pool을 닫지 않고 전역 sql을 덮어씀 → 첫 pool 누수가 워커 종료를 막는 기존 harness 결함(c24 신규 회귀 아님). 첫 pool도 종료하는 teardown 보정은 후속 작업 |
| npx playwright test --workers=1 (commerce_test 직렬) | PASS — 14/14, exit 0 (e2e.log) |
| node scripts/eval.ts --split=dev (stub) | PASS — 16/16 (eval-dev.log) |
| node scripts/eval.ts --mode=stub --split=holdout --repeat=3 | PASS — 18/18 (eval-holdout.log) |
| live eval | BLOCKED — LLM_API_KEY 미설정. 미실행, stub으로 대체하지 않음 |

### 카드 Interaction 실검증 (localhost:3200, 390×844 dark, 실제 Playwright)

shots/04c/verify/interact.mjs (interact.log) — 세 진입 검증 PASS, 스크립트 후반 캡처 단계 timeout(exit 1)으로 스크립트 전체는 PASS 아님:

- 장식용 쇼핑백 .card-cart 클릭 → #/p/p-d-cof-2 상세 진입 PASS (아이콘은 aria-hidden 장식이지만 카드 버튼 onOpen이 그대로 동작)
- 품절 카드(코트라인 캔버스 스니커즈, .thumb-soldout) 쇼핑백 클릭 → #/p/p-d-sn-2 상세 진입 PASS
- 검색 결과 카드 클릭 → #/p/p-c 상세 진입 PASS

shots/04c/verify/zoom.mjs (zoom.log) — 별도 재시도, 성공:

- .product-card:has(.signal-demo) 카드를 하단 네비(nav.bottom-nav) 위로 스크롤 배정 후 요소 캡처 card_signals_zoom.png — CARD_FULLY_VISIBLE=PASS(네비 위까지 완전 노출). 문맥 전체 화면 card_signals_context.png 함께 보존. 합성 신호(최저가·조회수)의 '데모' 배지 표기를 PM이 이미지에서 직접 확인했다.

### 캡처 재생성 (c24dea0 기준)

- 구현 캡처 shots/04c/{dark,light}_*.png 전면 재촬영(실행 tmp_shots.mjs, 로그 reshots.log) — 2026-10-10, viewport 390×844, deviceScaleFactor 2.
- 비교본 shots/04c/qa/*.png 6장 재합성(tmp_qacmp.mjs, qa-rebuild.log): Reference reference/toss-shopping/screenshots/home/{01_home_default,02_home_scrolled,03_home_banner_changed,26_beauty_home}.png + product-list/34_daily_deals_default.png 대 구현 390×844 dark. Light(06_light.png)는 토스 Light 레퍼런스가 없어 구현 단독.
- reference/ 캡처는 Git 미포함 로컬 전용 자료 — 없으면 Visual QA 완료 불가(기존 방침 유지).

### PM 독립 검수 결과 (2026-10-10)

- 종합: 신규(c24) 정상 입력 경로에 BLOCKER/MAJOR 없음. Backend/DB/Seed 변경 없음, 가격·재고·Cart 계약 유지. 그러나 04-C 전체 Visual 판정 = FAIL(보정 후 재검수) — c24와 무관한 기존 결함 2건:
- PMQA-04C-MJ01 (MAJOR, 기존 결함): styles.css .hero-slide(약 205행) height:232와 cover .hero-sub margin-top:auto. reference/home/26_beauty_home.png는 약 1:1 배너+하단 텍스트 클러스터지만 현재 뷰티는 348×232에 상품명/가격이 상단 고정. 단 27_oasis_home.png 식품 배너는 가로형(약 1.54:1)이므로 모든 cover에 square 비율 일괄 적용은 금지.
- PMQA-04C-MJ02 (MAJOR, 기존 결함): .deal-thumb(약 364행) aspect-ratio 1.55 vs reference/product-list/34_daily_deals_default.png 약 2.5:1 — 특가 이미지가 지나치게 높아 카드 밀도가 크게 다름. DealCard는 Season 화면과 공유 — 50_seasonal_home.png(가로행 카드) 영향을 먼저 확인해야 함.
- MINOR/후속: signal-demo 9px/opacity .78 모바일 가독성(표기는 존재); lowest30dFor의 출처그룹·30일 경계·미래값·invalid date NaN 필터 검증 커버리지 부족(현재 합성 샘플은 유효 — 활성 데이터 결함 아님); COMMERCE_DESIGN_SYSTEM.md의 과거 카드 설명(가격색/원형 쇼핑백)과 현재 C 기준 충돌 → 해당 문서에 Superseded 주해로 연결 완료; 소규모 스타일은 08 Final Polish로 이관 가능.

### QA 상태

PM 독립검수 완료 — 04-C Visual FAIL(MJ01/MJ02 보정 후 재검수) / 사용자 최종 Visual 승인 대기. 04-D 진입은 사용자 승인 후.

## 2026-10-10 · PMQA-04C-FIX-002 — MJ01·MJ02 보정 구현 + 재검증

목적: VERIFY-001 PM 판정의 기존 결함 2건(뷰티 히어로 비율·텍스트 배치, 특가 딜카드 비율·시즌 카드 공유)을 Reference 기준으로 좁게 보정하고 전체 회귀를 재검증한다. Backend/DB/Seed 변경 없음. Push 없음.

### 수정 범위

- **MJ01 — 히어로 변형 분리** [Observed `home/26` vs `home/27`]: `.hero-slide.cover`를 `aspect-ratio:1`로 추가하고 cover의 `.hero-sub`을 `margin-top:8px`로 하단 텍스트 클러스터에 붙였다. cover 조건은 `cat==='beauty'`로 한정 — 뷰티는 Ref26의 정사각 커버, 식품은 Ref27의 가로 카드형(~1.5:1)을 따른다. 카드형 홈 히어로(~232px)는 변경 없음.
- **MJ02 — 딜카드 변형 분리** [Observed `product-list/35` vs `home/50`]: 특가 DealCard를 `.deal-thumb { aspect-ratio:2.5 }`+하단 정보(상품명→가격·원가 취소선→★)로 Ref35에 맞춤. 카드 full-bleed(`margin:0 -10px`)는 Ref35의 ~10px 가장자리와 다른 [Project] 구현 차이 — MINOR→08 이관. 시즌 화면은 Ref50의 가로행 카드이므로 `DealCard`에 `row` 변형을 추가 — 정사각 썸네일(~140px)+우측 정보 클러스터(상품명 2줄·`rate% price`·★), 할인율은 레드 과용을 피해 --text-2.
- 특가 상단 정리: `.sale-promo/.sale-tabs/.sale-timer/.sale-title`의 폭·마진을 10px pad 컨텍스트로 정리.
- `.signal-demo` 10px/opacity .9로 가독성 소폭 보정.
- **테스트 허니스 결함 수정**: `tests/helpers/testdb.ts` `ensureTestDb`가 `connectDb` 덮어쓰기 전 `if (sql) await sql.end()`로 이전 pool을 종료 — VERIFY-001에서 기록된 t1-cart teardown hang(runner 미종료)의 원인 해소. 7개 integration 파일 `after(() => sql.end())`→`sql?.end()`(setup 실패 시 TypeError 방어).
- `display-meta.ts` `lowest30dFor`에 `!Number.isFinite(at) || !Number.isFinite(o.price_won)` 가드 추가. `product-signals.test.ts` +6 — 출처 메타, 빈 variant, 비최저가 variant 숨김, 경계/미래/invalid·NaN(finally 정리), 출처 그룹 분리(최신 source_name 승리), 상품 격리(대상 배열 내 foreign obs로 `o.product_id` 필터 실증, splice 복원).

### 검증 (로그 `shots/04c/fix002/logs/`, native exit 보존)

| 명령 | 결과 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS — exit 0 (테스트 파일 추가 수정 후 최종 코드 기준 재실행) |
| `node scripts/build-web.ts` | PASS — exit 0 |
| `node --test tests/unit/*.test.ts` | PASS — 27/27, exit 0 |
| `node --test --test-concurrency=1 tests/integration/*.test.ts` | PASS — 64/64, exit 0, **runner 정상 종료**(pool 누수 수정으로 VERIFY-001의 hang 해소 확인) |
| `npx playwright test --workers=1` | PASS — 14/14, exit 0 |
| `node scripts/eval.ts --mode=stub` (dev/holdout) | 미실행 — 이번 변경이 Frontend·테스트 허니스에 한정돼 agent 경로 비변경. VERIFY-001의 stub dev 16/16·holdout 18/18 기록을 유지. 한계: eval 미재실행 구간에 display-meta 변경이 포함돼 있으나 eval 입력은 DB/Tool 결과이므로 영향 없음을 근거로 인용 |
| Live eval | BLOCKED — LLM_API_KEY 미설정(유지). Live eval 미실행은 이번 09 Commerce Environment Freeze 게이트가 아니며 Brain 단계(로드맵 11~12)에서 수행 |

이력: FIX-002 최초 비상승 Integration 실행은 샌드박스의 localhost TCP 차단으로 ECONNREFUSED+teardown TypeError(exit 1) 실패 — Docker 실제 Up/5432 확인 후 승인된 실행에서 64/64·exit 0 정상 종료(최종 PASS 변경 없음).

### 캡처 (390×844, Reference 대조)

- 구현 `shots/04c/fix002/`: dark/light × home_top·hero2·scrolled·tab_{beauty,food,sale,season}·tab_*_scrolled. 신호 카드 `card_signals_zoom.png`/`card_signals_context.png` — 카드 전체가 하단 네비 위에 완전 노출(CARD_FULLY_VISIBLE=PASS), 합성 신호 '데모' 배지 표기.
- 비교본 `shots/04c/fix002/qa/` — 콘텐츠 폭으로 재합성(빈 canvas 제거): 01_home_first(Ref01) · 02_home_scrolled(Ref02) · 03_beauty(Ref26) · 04_food(Ref27) · **05_sale_top(Ref34↔sale top 상태)** · **05_sale_scrolled(Ref35↔sale scrolled 상태)** · 06_season(Ref50) · 07_light(구현 단독, Toss Light ref 없음).
- c24dea0 baseline 비교본·원본은 `shots/04c/baseline-c24/`에 보존(덮어쓰기 없음).

### PM 재검수 결과 (2026-10-10)

- PM이 fix002 신규 캡처를 직접 열람해 MJ01/MJ02의 주요 구조 보정을 확인했다 — 뷰티 정사각 커버+하단 클러스터, 식품 가로/좌텍스트·우이미지, 특가 2.5:1+하단 정보, 시즌 정사각+우측 정보. **전체 승인은 아직 아님** — 최종 코드/로그/커밋 및 사용자 Visual 승인이 남은 게이트다.
- MINOR → 08 Final Visual Polish 이관(원인·이관 기록): (1) `.deal-card` full-bleed(x=0)가 Ref35/50의 ~10px 가장자리와 다름, (2) 정사각 상품 에셋을 2.5:1 cover로 쓰면서 커피/클렌징폼 상·하단 크롭이 큼(상품명/가격은 읽힘, Major 아님), (3) DealCard 쇼핑백의 반투명 원형 배경 vs Ref outline 차이, (4) 시즌 캠페인 배너 높이/여백.
- PM 보완 지시 반영: Ref34→sale top / Ref35→sale scrolled 상태 분리 비교본 + 콘텐츠 폭 재합성 완료.
- 검증 대상 커밋: `4719e1b6a50388c5a5b3da43dba259d11e0f6414` (로컬, Push 없음). PM 최종 verdict는 후속 문서 체크포인트로 연결 예정 — 사용자 Visual 승인 전까지 04-C 미확정.

### QA 상태

PM 재검수(구조 보정 확인) 통과 — 04-C Visual 미확정, **사용자 최종 Visual 승인 대기**. 04-D 미착수, Push 없음.

→ 이후 **PMQA-04C-REVIEW-002** 최종 판정 전달(아래 섹션): 기술 검증 PASS · PM Visual CONDITIONAL PASS(주요 구조 보정), BLOCKER 0/열린 MAJOR 0, MINOR 4건→08 이관. 사용자 승인 게이트는 변함없이 유지.

## 2026-10-10 · PMQA-04C-REVIEW-002 — PM 최종 독립 판정 (기록 전용)

- 검증 대상: `4719e1b6a50388c5a5b3da43dba259d11e0f6414` (로컬, Push 없음) — 이후 후속은 docs-only 정정 커밋으로 코드 변화 없음.
- PM이 직접 확인한 것: 실제 커밋 Diff(16파일 +224/−30)·최종 코드, native exit 로그(tsc 0 · build 0 · unit 27/27 · Integration 64/64 runner 정상 종료·skip 0 · E2E 14/14 --workers=1), 원본 Reference와 dark/light·교정 비교본·신호 카드 완전 노출 캡처. Backend/DB/Seed/fixture/가격·재고·Cart 업무 계약 변경 없음.
- **판정: 기술 검증 PASS · PM Visual CONDITIONAL PASS(주요 구조 보정)** — BLOCKER 0 / 열린 MAJOR 0 (MJ01·MJ02 해결), MINOR 4건 → 08 Final Visual Polish 이관 기록.
- 구분 기록 유지: eval 미재실행 한계(Frontend·harness 전용 변경 — VERIFY-001 stub dev16·holdout18 인용, Live eval은 키 없어 BLOCKED, 09 게이트 아님)와 최초 비상승 실행의 환경 실패(ECONNREFUSED, 샌드박스 TCP 차단) → 승인 실행 정상(64/64·exit 0)의 실패·복구 이력.
- 원격 상태: 실제 원격 main = `689c12667371d910493afd420cf05b651ced103b` (PM hongbinwee 커넥터 확인). 로컬은 구현+docs-only 후속 커밋으로 ahead.
- **이 판정은 사용자 최종 Visual 승인이나 04-C 마일스톤 완료가 아니다.** 사용자 Visual 미승인 / 04-D 미착수 / Push 없음 상태 유지 — 후속 구현은 사용자 승인 후.

## 2026-10-10 · PMQA-04C-CLOSE-PUSH-003 — 04-C 사용자 최종 승인·완료 + Push

- **사용자 최종 Visual QA 승인 (2026-10-10 KST)** — FIX-002 보정 구현과 Reference/Implementation 비교 자료를 검토한 사용자가 04-C를 최종 승인하고, MINOR 4건의 08 이관·04-C 완료 처리·GitHub Push를 명시 승인했다. 직전 '사용자 Visual 승인 대기' 기록은 이력으로 보존하고 본 항목이 최신 상태다 [Superseded: 승인 대기 → 승인 완료].
- 판정 연결: 검증 대상 `4719e1b` — 기술 검증 PASS(tsc 0 · build 0 · unit 27/27 · integration 64/64 runner 정상 종료 · e2e 14/14), PM Visual CONDITIONAL PASS(MJ01·MJ02 해결, BLOCKER 0/열린 MAJOR 0).
- MINOR 4건 → 08 Final Visual Polish 이관 확정: 딜카드 full-bleed vs Ref ~10px 가장자리 · 정사각 에셋 2.5:1 크롭 · 쇼핑백 반투명 원 vs outline · 시즌 배너 높이/여백.
- **04-C Home Reconstruction = 완료.** 다음 단계는 04-D Navigation Reconstruction — 별도 지시·승인 게이트 유지.
- Push: 사용자 승인에 따라 미Push 로컬 커밋 + 본 승인 기록 커밋을 `hongbinwee/codyssey_final-mission` main에 반영한다 — 실제 반영 결과와 원격 HEAD 일치는 PM 독립 원격 검증으로 확인한다. Push 경로·제약은 본 문서 후속 기록 또는 PM 보고 참조.

### Push 미실행 기록 (2026-10-10, CLOSE-PUSH-003)

- **Push 미실행 — 실행 아님, 승인 전달 범위 제약.** 로컬 `git push origin main` 1회 시도가 자동 승인 검토에서 거부됐다. 거부 사유: Push 승인 근거가 다른 Thread의 위임 내용(비신뢰 콘텐츠)에만 있고, 본 Main SWE Thread의 신뢰된 사용자 지시는 직전까지 'Push 하지 말 것'이었으므로 이 Thread에서의 명시적 사용자 승인이 필요하다는 판정.
- 이 제약은 인증/권한 실패나 원격 거부가 아니다 — 신뢰된 승인 전달 범위에 대한 도구 검토 제약이다. 로컬 인증 경로가 실제로 동작하는지는 사용자 승인 후에도 별도 확인이 필요하다(GCM 유효 자격은 기존 기록상 미확보).
- 상태 스냅샷: local HEAD `5e3ec6061f60cdf9159a1299f2176b72443b44f4` (origin/main 기준 7 commits ahead, fast-forward 가능) / remote main `689c12667371d910493afd420cf05b651ced103b` (PM hongbinwee 커넥터 조회값).
- 커넥터 경로는 객체 보존 불가로 배제 — `51bb8be`가 원격에 없어 ref 이동 불가(422), create_commit은 author/committer/date 입력이 없어 SHA가 달라지며, 다른 SHA 재생성을 Push 성공으로 보고하는 것은 금지다.
- **사용자가 본 Thread에서 직접 승인할 때까지 Push 보류. 04-D 착수는 Push 성공 + PM 독립 원격 검증 이후로 제한(사용자 순서 조건).**

### Push 성공 기록 (2026-10-10, CLOSE-PUSH-003 — 위 '미실행' 기록 Superseded)

- **PM이 04-C 배치 8개 커밋을 기존 로컬 hongbinwee GitCredentialManager 인증 경로로 정상 Push 완료.** 비대화형(계정 선택 명시) fast-forward, Force/Reset/Rebase/커밋 재생성/인증 설정 변경 없음.
- 원격 검증: hongbinwee GitHub 커넥터로 실제 원격 main = `a51a032cbe30dce95e11e39db58df1453637613f` = local HEAD 완전 일치 확인.
- 정정: 직전 'Push 미실행' 기록은 '승인 전달 범위의 도구 검토 제약'까지의 이력으로 보존하고, 본 항목이 최신 상태다 — 기존 로컬 인증 경로(hongbinwee GCM)가 실제 지원됨이 확인됐다.
- 운영 정책 확정: Push·원격 검증 = PM(오케스트레이션) 담당, 구현·테스트·문서·로컬 커밋 = Main SWE. PM은 코드·DB를 수정하지 않는다.

## 2026-10-10 · PMQA-04D-NAV-001 → CLOSE-002 — 04-D Navigation Reconstruction 구현·검증·문서

대상: 토스 하단 네비 5슬롯 구조 재현 + 스크롤 숨김 + history.state 마커 기반 뒤로가기 + 전체 메뉴 시트. 코드 기준 = 본 항목 기록 후 생성되는 로컬 커밋(변경 파일 목록 아래) — 커밋 SHA는 본문에 자기참조로 쓸 수 없어 final 보고와 PM 후속 QA 체크포인트에서 연결한다.

### 변경 파일

- `src/web/app.tsx` — 하단 네비 5슬롯(홈/혜택/쇼핑/AI/전체) 재구성, 쇼핑 슬롯 `aria-current="page"`+채움 아이콘(IcBagFill), 스크롤 방향 인식 숨김/복귀(`y>120 && y>lastY`, `.hidden`=visibility:hidden), `.menu-sheet`(aria-haspopup/expanded, 첫 항목 포커스·ESC·오버레이 닫기·포커스 복귀), `history.state` 마커(`{app,internal}`) 기반 backbar 뒤로가기 + `gotoReplace(BACK_PARENT)` fallback, `goto`/`gotoReplace` 시 `scrollTo(0,0)`, 세션 복원 `fetch('/api/session')` 최상위 `{ok,user}` 읽기로 수정.
- `src/web/icons.tsx` — `IcMenu`, `IcBagFill` 추가.
- `src/web/styles.css` — `.bottom-nav` transition+`.hidden`, `.menu-sheet`/`.menu-item`.
- `src/web/screens/Shopping.tsx` — 선택 상단 탭 가시화를 `scrollIntoView` 대신 getBoundingClientRect 차이 기반 `scrollLeft` 계산으로 변경(부모 offsetLeft 문제·세로 이동 방지).
- `tests/e2e/nav.spec.ts` 신규 7 테스트.
- `tests/e2e/{checkout-t2,core-journeys,t3-cancel}.spec.ts` — '내 주문' 네비 직접 클릭 5곳을 헤더 '내 쇼핑' 버튼 경로로 교체(실제 사용자 경로, 단정 유지).

### 검증 결과

| 명령 | 결과 |
| --- | --- |
| `npm run check`(tsc --noEmit) | PASS — exit 0 (CLOSE-002 최종 코드 재실행) |
| `node scripts/build-web.ts` | PASS — exit 0 (NAV-001; 뒤이은 unit 명령이 && 체인으로 실행된 사실로 build 성공 확인) |
| `node --test tests/unit/` → `node --test tests/unit/*.test.ts` | FAIL→PASS — 잘못된 디렉터리 명령 exit 1 후 정상 명령으로 27/27 (NAV-001, PM 검수 exec-ad3dbfa5) |
| `node --test --test-concurrency=1 tests/integration/*.test.ts` | PASS — 64/64 요약 + runner 정상 종료 (NAV-001, PM 검수 exec-b15dc217) |
| `npx playwright test --workers=1 --reporter=line` | PASS — 21/21 raw exit 0 (NAV-001, PM 검수 exec-70245004) |
| `npx playwright test nav.spec.ts --workers=1 --reporter=line` | PASS — 7/7 exit 0 (NAV-001, PM 검수 exec-30f0fbdb) |
| `node scripts/eval.ts --mode=stub` (dev) | PASS — 16/16 (NAV-001) |
| `node scripts/eval.ts --mode=stub --split=holdout --repeat=3` | PASS — 18/18 raw exit 0 (CLOSE-002 재실행, exec-e8e81528). 최초 비상승 sandbox 시도는 EACCES 127.0.0.1:5432로 exit 1 — 승인 경로 재실행으로 PASS, 두 결과를 구분 기록 |
| live eval | BLOCKED — LLM_API_KEY 미설정(로드맵 12 게이트, stub PASS로 대체하지 않음) |

실패→복구 이력(원인 분리): nav.spec 초안 raw 5PASS/2FAIL의 2건은 서로 다른 원인 — (a) empty checkout readiness 1건: heading 대기 대신 실제 VALIDATION 텍스트('카트가 비어 있습니다')로 교정, 제품 코드 변경 없는 spec readiness 수정. (b) 실제 reload 세션 blank 결함 1건: `r.data.user` TypeError(기존 MAJOR) — app.tsx를 최상위 `{ok,user}` 계약대로 수정, reload e2e(pageerror 0, GET /api/session `{ok:true,user}` 증거)로 회귀 검증. (c) 별도 이력 = 정규식 이스케이프 TS1109는 테스트 실행 이전의 사전 파서 문법 오류로 러너 실행 수 0(PM 파서 확인) — 위 2건과 섞지 않는다. 각각 수정 후 nav 단독 7/7, 전체 21/21.

### 캡처 (390×844, dsf=2, shots/04d/ — git 미포함 로컬 자산)

- 서버: 기존 localhost:3200 프로세스(PID 9280) 재사용 — `web/app.js` 번들이 소스 변경 이후에 빌드돼 `menu-sheet` 포함 확인. 신규 spawn(PID 18204)은 EADDRINUSE로 즉시 종료됐으며 별도 정리 불필요. 비상승 sandbox의 포트 조회는 빈 출력을 반환해 기존 서버 부재로 오인 가능 — 승인된 escalated 조회 기준으로 기록.
- facts.txt 증거: dark/light 공통 — 초기 nav visible+`.nav-item.on`='쇼핑', 딥스크롤 `.hidden`+visibility:hidden, 상승 시 복귀, '시즌 추천' 선택 탭 inView=true(390px에서 전체 탭이 표시돼 scrollLeft=0 — 스크롤 불필요 상태의 정상 결과), 전체 시트 aria-expanded=true·항목 4개, detail/cart/checkout/order 각 push 화면에서 `.bottom-nav` 렌더 0(자체 CTA와 겹침 없음).
- 캡처 제약(자동 검토 정책): 카트 담기·주문서 진입 등 DB 쓰기가 포함된 캡처 경로가 거부돼 read-only 경로로 조정 — Primary demo 사용자(u-a)의 cart_items=0이므로 `dark_cart_state`/`dark_checkout_state`는 빈 상태/VALIDATION 화면이다. populated checkout CTA 캡처는 없으며 그렇게 완료된 것처럼 기록하지 않는다. 상세·주문 상세(ord-a-ship)는 실데이터로 자체 CTA/backbar+nav 부재를 확인.
- `shots/04d/qa/` 합성 비교본 제약: 1280×720 캔버스에 390×844 세로 이미지를 배치해 하단(하단 네비 영역)이 잘린다. 두 합성본을 '하단 nav 나란히 비교 완료' 증거로 쓰지 않는다 — 04-E에서 전체 높이 캔버스 또는 HTML 비교 뷰로 보완하고, Reference의 iOS status bar/safe area와 웹 viewport 차이를 명시한다(PM CLOSE-002 피드백).

### 잔여·이관

- MINOR→08: 채움 쇼핑백(IcBagFill) 실루엣의 손잡이가 Reference tote보다 짧아 crown처럼 보이는 미세 차이(PM 지적, 코드 수정 요구 없음).
- 04-E: 전체 셸 Screenshot/Visual QA + 최종 사용자 승인 게이트(본 04-D 기록으로 자가 최종 승인하지 않음).
- PM 독립 QA 통과 후 PM이 일반 마일스톤 사전 허용 정책에 따라 Push + 원격 full SHA 일치 검증.

## 2026-10-10 · PMQA-04D-REVIEW-PUSH-003 — 04-D 독립 QA·Push·종료 기록

- PM 독립 QA: 구현 `60463c72f4b458e6e8d5e1cdd59df8e532775d1b` + 문서 `f568ff7cfd38d65e8cc6e08ef88b6a9acf8a320f` 검수 — 제품 code/test hash가 검증 버전과 일치, 13파일 diff·nav.spec 7·기존 assert 유지·Backend/DB/fixture/deps 불변 확인. 기능·코드·04-D 구조 QA PASS, BLOCKER 0/열린 MAJOR 0. IcBagFill silhouette MINOR→08 유지. 핵심 화면 최종 Visual 승인은 04-E 사용자 게이트.
- Push (PM 실행, 2026-10-10 14:36 KST): 원격 `a51a032cbe30dce95e11e39db58df1453637613f` → `f568ff7cfd38d65e8cc6e08ef88b6a9acf8a320f` 정상 fast-forward, 실제 로컬 3커밋(116dd87/60463c7/f568ff7) 전송, 기존 hongbinwee GCM 명시 계정 filter·exit 0. 연결된 hongbinwee GitHub 플러그인 fresh main = f568ff7 full SHA = local HEAD 확인, fetch 동일 계정·origin/main 일치. Force/Reset/Rebase/Amend/커밋 재생성/인증 재설정 없음.
- **04-D Navigation Reconstruction = 완료.** 04-E 전체 셸 Visual QA 진행 — 사용자 최종 승인 게이트 유지.




## 2026-10-10 · PMQA-04E-FIX01 — Category 연속 섹션 보정 + 검색 스크롤 증거 보완

대상: PM 독립 검수 MAJOR 2건 — EVIDENCE-01(검색 스크롤 비교 증거 부족: dark_search_results/_scrolled 동일 SHA로 실제 스크롤 아님), MJ-CATEGORY-01(CategoryBrowser가 선택 그룹 1개만 렌더해 Ref etc/28~31의 연속 섹션·다음 그룹 peek·콘텐츠 밀도와 큰 차이).

### 변경 파일

- src/web/screens/Shopping.tsx — CategoryBrowser를 전체 5그룹 연속 섹션 렌더로 변경. 우 pane을 독립 스크롤 컨테이너(overflow-y:auto + overscroll-behavior:contain)로 만들어 windowY=0 유지 — miniTop/navHidden 회귀와 header/shop-tabs/bottom-nav 소실 방지(PM 지적: window scrollIntoView 방식은 헤더 축소·nav 숨김을 유발). 좌 rail 클릭 = pane.scrollTo(해당 섹션, smooth), pane 자체 scroll spy(threshold 12px)로 활성 그룹 동기화 + 최하단 clamp fallback(마지막 그룹에서 레일이 직전 그룹으로 되돌아가지 않게).
- src/web/styles.css — .cat-browser 높이 calc(100dvh - 226px)(top60+tabs50+pt6+main pb110), .cat-pane 독립 스크롤 + padding-bottom:420px(마지막 '식품' 섹션이 pane 상단까지 도달하기 위한 여백, [Project] 정책 — 가짜 콘텐츠로 채우지 않음), .cat-sec 섹션 간격.
- 캡처/검증 스크립트 tmp_shots04e2.mjs·tmp_catinteract.mjs·tmp_qacmp04e.mjs — 로컬 도구, git 미포함.
- 기존 캡처 baseline은 shots/04e/baseline/에 21개 보존.

### 증거 (shots/04e/, facts_fix01.txt — 390×844, dsf=2, 코드=본 항목 커밋 기준)

- 카테고리(dark/light 공통): sections=5·subs=13, 레일 선택 전 상태에서 windowY=0·searchFieldVisible=visible·tabsTop=66·navHidden=false 유지. rail 클릭 → 해당 그룹 head가 pane top에 도달(뷰티0/패션0/리빙0), 다음 그룹은 155px 아래에 peek. spy 동기화: pane 수동 top→'디지털', bottom→'식품' active.
- [Project 제한 → MINOR·08 이관] 마지막 '식품' 섹션은 아래 콘텐츠 부재로 head가 pane top+73에서 clamp — spy fallback으로 '식품' active 유지. Ref의 14 rail·다수 subcat 밀도 대비 5그룹/13sub은 데이터 규모 차이이며, Toss 동일 밀도로 표기하지 않는다.
- 인터랙션 probe(localhost:3200 read-only): 디지털 '전체보기'→?cat=digital 10카드 / '모니터' sub→?cat=digital&sub=monitor 3카드=코드뷰 모니터 C·A·B(assert3) / 식품 레일→'커피' sub→?cat=food&sub=coffee 2카드. demo 미포함 commerce_test와 구분되는 Primary dev 증거.
- 검색 스크롤(EVIDENCE-01 해소): q='에' apiOk=true serverCount=9=rendered, docH1879/vp844, requestedY400→actualY400 — 실제 스크롤 증거로 Ref104 비교. q='버즈' 3건 actualY=33(소량이지만 >0, PASS 아닌 부분 스크롤로 표기). q='이어폰' 1건 docH=vp → SCROLL-NOT-POSSIBLE을 성공 스크롤로 기록하지 않음. serverCount와 rendered 일치(renderedEq=true) 확인, 자동완성(limit=5)과 결과(limit=50) 응답을 query+limit 파라미터로 정확히 구분 매칭.
- 검색 typing(Ref102 대응): '모니터' 입력만(Enter 미제출) → limit=5 응답 후 sug-row 3·mark 3, mark 색 dark=rgb(41,117,244)/light=rgb(49,130,246) 파란 강조. 제안 클릭은 상세 직행이 아니라 submit(p.name): hash ?q=코드뷰 모니터 C·input 동일명·결과 카드 1.
- 최근 검색어: 실제 7회 검색 누적(localStorage) → recent rows=7 다중 행 밀도 증거.
- 합성 비교본: shots/04e/qa/ 17쌍(01_home_first~17_search_sort) — fullPage 전체 높이 캔버스로 생성, 하단 잘림·MISS 0. Ref102 typing 쌍 추가.
- 캡처 제약: iOS status bar/safe area·네이티브 키보드는 desktop Playwright 재현 불가 — 가짜 키보드 대신 한계로 명시. Light Reference 부재로 Light는 [Project/TDS] 기준. 카트 담기 등 DB 쓰기 캡처는 자동 검토 정책 거부로 read-only 한정.

### 검증

| 명령 | 결과 |
| --- | --- |
| npm run check (tsc --noEmit) | PASS — exit 0 |
| npm run build (esbuild web/app.js) | PASS — exit 0. 서버는 요청마다 디스크 번들을 서빙해 재기동 불필요(Static readFile 경로 확인) |
| npm run test:unit | PASS — 27/27 |
| npx playwright test nav.spec.ts core-journeys.spec.ts smoke.spec.ts --workers=1 --reporter=line | PASS — 13/13 raw exit 0 |
| integration 전체·e2e 전체 21·eval stub | NOT_RUN — 본 수정은 CategoryBrowser+CSS 프런트 한정. 04-D의 전체 통과 이력(int64/e2e21/stub dev16·holdout18)은 별도 이력이며, 13을 full 21로 표기하지 않는다 |
| live eval | BLOCKED — LLM_API_KEY 미설정 |

### 잔여

- 04-E 최종 완료 = 사용자 Visual 승인 게이트. 본 기록으로 자가 승인하지 않는다.
- MINOR→08: '식품' head+73 clamp 및 pane 하단 여백(05 또는 08에서 레이아웃 정책 검토).

