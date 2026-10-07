# AI Commerce P0 Implementation Plan

> **[2026-10-07]** Phase 0~5(Backend·Tool·Eval·배포 아티팩트)는 이 계획대로 완료됐다. 이후 로드맵(04 Toss Shopping Shell → 05~08 Commerce UI → 11~12 Brain)은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) §현재 프로젝트 방향으로 이관 — Brain 우선순위는 Commerce Environment 완성 이후로 조정됐다. Phase 구조·Global Constraints·검증 기준은 여전히 유효.

> **For agentic workers:** 다른 모델이 이 계획을 Phase별로 실행한다. 해당 스킬이 제공되는 환경에서는 `superpowers:executing-plans`를 사용한다. 스킬이 없는 환경에서도 아래 체크박스·검증 기준을 그대로 따른다. 이 문서 작성은 코드 구현 착수를 의미하지 않으며, 구현 완료 표시는 실제 검증 결과가 있을 때만 한다.

**Goal:** 실제 상품·리뷰·카트·주문 데이터에서 Shopping Brain과 CS Brain의 P0 세 과제를 끝까지 실행하고 평가한다.

**Architecture:** 단일 Backend의 Commerce 서비스가 화면 API와 Agent Tool에 같은 데이터·규칙을 제공한다. 관계형 DB에 업무 상태와 실행 요청을 저장하고, LLM은 조건 해석·조회·설명을 수행한다. 결제는 사용자 직접 모의 결제, 배송/최종 취소/환불은 내부 시뮬레이터로 처리한다.

**Tech Stack — 실행용 권장 기준안:** TypeScript, React + Vite, Fastify, PostgreSQL + `pg`, SQL migration, Vitest, Playwright, npm. 기존 설계에서 확정된 스택은 아니며, 구체적인 파일/명령을 제시하기 위해 이 계획에서 선택한 기준안이다. Phase 0에서 실행 환경과 기존 코드 유무를 확인하고 버전을 고정한다. LLM 제공자·모델·배포처는 가용 계정/환경을 확인한 뒤 결정한다. 모델별 구현은 Provider Adapter 1개로 격리한다.

**Spec / 읽기 순서:** [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)는 배경, [CORE_TASK_SCOPE.md](CORE_TASK_SCOPE.md)는 현재 P0, [SHOPPING_BRAIN_VISION.md](SHOPPING_BRAIN_VISION.md)는 장기 방향, [WIREFRAME_PLAN.md](WIREFRAME_PLAN.md)는 6개 화면·2개 패널, [DATA_TOOL_DESIGN.md](DATA_TOOL_DESIGN.md)는 12개 테이블·13개 Tool·상태/정책 계약이다. 실행 명세가 충돌하면 임의로 합치지 말고 해당 부분을 기록한다. 이전 배경 문서의 ‘범위 미정’이나 Vision을 근거로 P0를 확대하지 않는다.

2026-10-05 작성. 현재 확인한 작업 폴더에는 설계 문서·영상·레퍼런스가 있고 애플리케이션 패키지/구현 파일은 없다. 아래 코드 경로·명령은 **앞으로 만들 결과물**이며 지금 실행 가능한 것으로 보고하지 않는다.

## Global Constraints

- P0: T1 상품 비교·옵션·장바구니 / T2 소유 주문·배송 조회 / T3 사용자 확인 후 전체 주문 취소.
- 화면은 W01~W06, 패널은 A01/A02를 유지한다. 모의 결제는 W04 안에서 완료 상태로 바뀐다.
- 같은 옵션 재담기는 수량 합산, 수정은 최종 양수 수량, 삭제는 별도 명령. 담기로 재고를 예약/차감하지 않는다.
- 주문 CONFIRMED/CANCELLED, 결제 PAID, 환불 NONE/PENDING/REFUNDED, 배송 PREPARING/IN_TRANSIT/DELIVERED/CANCELLED, 취소 REQUESTED/COMPLETED를 분리한다.
- 취소는 모의 결제 완료·출고 전·취소 요청 없는 소유 주문 전체만 가능. 환불 예정액은 저장된 실결제액 전액이며 배송비를 포함한다. LLM 계산값을 받지 않는다.
- 견적 유효기간 **5분**, 정책 버전 **p0-v1**, 비교 후보 **최대 3개**, 목록 기본 **20개/최대 50개**, 금액 **KRW 정수**. 세부 필드와 오류 코드는 DATA_TOOL_DESIGN을 따른다.
- 미확인 취소 실행 0회, 추천만 요청한 경우 카트 변경 0회. 사용자 UI 최종 확인과 서버 검증을 거쳐야 취소 요청이 저장된다.
- 화면과 Tool은 같은 서비스 함수·정책·트랜잭션을 사용한다. API와 Tool에 비즈니스 규칙을 복제하지 않는다.
- READ 9개 / LOW-RISK WRITE 3개 / HIGH-RISK WRITE 1개. 결제·승인 생성·시뮬레이터는 Agent Tool 목록 밖이다.
- Toss 자료는 **UI 배치·스타일을 구현할 때 필요한 부분만** 확인한다. 130개 상태 재구현·전체 재촬영을 선행 조건으로 삼지 않는다.
- 다크 톤·큰 이미지/가격·2열 카드·둥근 컴포넌트·파란 CTA·하단 고정 영역의 디자인 조건을 유지한다. 레퍼런스의 개인 정보·브랜드 자산을 테스트 데이터로 복사하지 않는다.
- P1/장기 기능은 끝의 TODO만 남긴다. Mock LLM·합성 리뷰의 결과를 실제 모델 실행·실제 사용자 리뷰 분석 성과로 보고하지 않는다.

## Review Focus

| 놓치기 쉬운 입력/조건 | 기대 동작 | 담당 검증 |
| --- | --- | --- |
| 첫 응답과 operation_id까지 유실 | 최초 idempotency key로 결과 복원, 새 요청으로 중복 변경 금지 | Phase 1 `lost_first_response_recovers` / Phase 3·4 재사용 |
| 같은 이름의 서로 다른 옵션·다른 상품의 리뷰 | 정확한 variant 선택, 다른 옵션 경험을 혼합하지 않음 | Phase 1 `variant_and_evidence_match` |
| 새로고침·다중 탭에서 같은 변경 반복 | UI/Agent가 같은 버전·실행 요청 규칙 사용 | Phase 2 `stale_cart_and_replay` |
| 취소 확인 직후 출고 또는 상태 변경 | 동일 주문 잠금으로 한쪽만 성공, 승인 재사용 차단 | Phase 4 `cancel_ship_race` |
| 리뷰 속 실행 지시·타인 주문 ID·위조 승인 | 자료를 명령으로 실행하지 않고 소유권/승인을 서버에서 차단 | Phase 2 `review_instruction_is_data`, Phase 3·4 권한 테스트 |

## 1. Phase 구성과 독립 실행 원칙

| Phase | 결과물 / 목표 | 누적 Tool | DB migration | 다음 단계 전 Gate |
| --- | --- | ---: | --- | --- |
| 0 | 실행 환경·검증 명령·최초 데이터 계약 준비 | 0 | migration runner만 | 앱/DB 연결·단위 테스트·브라우저 smoke 실행 가능 |
| 1 | **첫 Vertical Slice:** 실제 AI 비교 → 명시된 옵션 담기 → DB/화면 확인 | 5 | 001 | 실제 LLM 실행과 정확한 카트 변경 증거 |
| 2 | T1 완성: 최대 3개 비교·근거·수량 수정/삭제·실패 복구 | 7 | 없음 | T1 정상/오류·권한·재시도 통과 |
| 3 | 사용자 모의 결제 + T2 주문 식별·배송 설명 | 10 | 002 | 생성 주문과 배송 조회 연결·결제/재고 원자성 |
| 4 | T3 확인·취소 접수·최종 취소/모의 환불 | 13 | 003 | 승인 우회·출고 경합·중복 취소/환불 차단 |
| 5 | 통합 평가·배포·실사용자 피드백 반영 | 13 | 원칙적으로 없음 | 세 과제 회귀 통과·외부 배포·실사용 5명 이상 |

각 Phase는 이전 Phase의 **검증된 결과**를 사용한다. ‘독립 실행’은 의존성이 없다는 뜻이 아니라, 해당 Phase까지 migration/seed를 적용하면 후속 Phase 없이 실행·테스트할 수 있다는 뜻이다. 존재하지 않는 Tool·버튼은 등록/노출하지 않는다. 남은 Phase의 Backend를 가짜 성공 응답으로 대체하지 않는다.

각 Phase에서 실패 테스트 → 최소 구현 → 해당 테스트와 누적 회귀 → 검증 기록 순으로 진행한다. DB·정책·중복 방지·권한은 의미 있는 실패/경합 테스트를 먼저 작성한다. 낮은 위험의 문구·스타일 변경에 구현을 그대로 복제하는 테스트를 추가하지 않는다.

## 2. 예정 파일 구조와 공통 인터페이스

현재 파일을 옮기지 않고 다음 경로를 추가한다. 스택 변경이 필요하면 Phase 0에서 대응 경로/명령을 먼저 기록하고 이후 모든 Phase에서 일관되게 사용한다.

| 경로 | 책임 |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `.gitignore`, `.env.example`, `compose.yaml` | 실행/검증 스크립트, 고정 의존성, 로컬 PostgreSQL 설정. 비밀 값은 예제에 넣지 않음 |
| `index.html`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts` | 웹 진입·개발 API proxy·단위/통합 테스트 분리·E2E 서버 기동 설정 |
| `src/shared/contracts.ts`, `src/shared/tool-contracts.ts` | DTO·오류·상태·13개 Tool 입력 스키마. 구현된 Tool만 registry에 노출 |
| `src/server/app.ts`, `src/server/main.ts`, `src/server/config.ts` | API 등록·시작·검증된 환경 설정. 배포 시 빌드된 웹 정적 자산도 같은 서버에서 제공 |
| `src/server/auth/session.ts`, `src/server/auth/ui-action.ts` | 인증 주체, UI 전용 승인/결제 호출 검증. Agent 입력으로 실행 주체 변경 금지 |
| `src/server/db/pool.ts`, `src/server/db/transaction.ts`, `db/migrations/*.sql` | PostgreSQL 연결·원자 처리·migration |
| `src/server/commerce/catalog.ts`, `cart.ts`, `actions.ts`, `checkout.ts`, `orders.ts`, `cancellation.ts`, `simulator.ts` | 상품/리뷰 조회, 카트, 실행 요청, 모의 결제, 주문/배송 조회, 취소 정책/처리, 내부 상태 진행. 도메인별 SQL과 규칙을 이곳에 모음 |
| `src/server/commerce/quotes.ts` | UI 확인용 견적 서명·검증·5분 만료. Phase 3부터 사용 |
| `src/server/http/catalog.ts`, `cart.ts`, `orders.ts`, `checkout.ts`, `cancellation.ts`, `actions.ts`, `agent.ts`, `session.ts` | 얇은 HTTP 입력/출력 변환. 업무 로직은 commerce 호출만 사용 |
| `src/server/agent/provider.ts`, `runtime.ts`, `registry.ts`, `shopping.ts`, `cs.ts`, `session-context.ts`, `trace.ts` | 모델 Adapter, 제한된 Tool 실행 루프, Tool 등록, Brain 지침·응답 생성, 사용자별 대화 Context, 추적 |
| `src/web/main.tsx`, `App.tsx`, `api.ts`, `styles/tokens.css`, `styles/app.css` | 웹 진입·화면 이동·서버 조회·공통 디자인 토큰 |
| `src/web/screens/Shopping.tsx`, `Product.tsx`, `Cart.tsx`, `Checkout.tsx`, `Orders.tsx`, `OrderDetail.tsx` | W01~W06. 필요한 Phase에서만 생성 |
| `src/web/components/AgentPanel.tsx`, `CancelSheet.tsx`, `CommerceState.tsx`, `ProductCard.tsx` | A01/A02·공통 Loading/Empty/Error·상품 카드 |
| `db/seeds/catalog.json`, `reviews.json`, `users.json`, `scenarios.json`, `provenance.md` | 고정 테스트 데이터와 실제/합성 출처. 운영 계정 비밀은 포함하지 않음 |
| `scripts/migrate.ts`, `seed.ts`, `verify-phase.ts`, `eval.ts`, `simulate.ts` | 순차 migration·격리된 seed/reset·Phase 검증·평가·내부 상태 진행 |
| `tests/unit/*.test.ts`, `tests/integration/*.test.ts`, `tests/e2e/*.spec.ts`, `tests/helpers/fixtures.ts` | 정책/금액, 실제 DB 계약/동시성, 브라우저 흐름, 결정적 seed와 장애 주입 |
| `eval/cases/dev/*.json`, `eval/cases/holdout/*.json`, `eval/rubric.md` | 입력·기대 Tool 제약·최종 DB/화면·근거 판정. 개발용/최종 평가용 분리 |
| `docs/IMPLEMENTATION_DECISIONS.md`, `docs/IMPLEMENTATION_PROGRESS.md`, `docs/VERIFICATION_LOG.md`, `docs/USER_TEST_REPORT.md`, `README.md` | 실행 시 선택·진행 상태·명령/증거·사용자 피드백·실행법 |

**공통 함수 경계:** `executeTool(name, input, context): Promise<ToolResult>`는 registry 검증 후 `catalog/cart/orders/cancellation`의 같은 이름 함수에 위임한다. 각 서비스 함수는 `(input: 해당 ToolInput, context: RequestContext): Promise<ToolResult>` 형태를 따른다. 모든 DTO/ToolInput은 DATA_TOOL_DESIGN 5~7절을 기준으로 shared 파일에서 정의한다.

`RequestContext`의 `actor_user_id`, `origin=UI/AGENT/SYSTEM`은 서버가 검증한 세션·실행 경로에서 결정한다. UI와 Agent가 `origin`을 임의 제출할 수 없게 한다. 사용자 행동 ID/중복 방지 키는 첫 전송 전에 UI 또는 Tool Adapter가 보관하고, 서버가 인증 주체·명령 종류와 결합해 검증한다. LLM이 키를 생성·변경하지 못하게 하며, 같은 행동의 통신/모델 재시도에는 원래 키와 payload를 유지한다. 내부 함수는 `prepareCheckout`, `confirmCheckout`, `confirmCancellation`, `getActionResult`, `advanceShipment`, `completeCancellation`, `completeRefund`로 이름을 고정하고 5절의 내부 API/명령에만 연결한다.

`runAgentTurn({user_message, page_context, client_action_id}, context)`는 `AgentTurnResult={message, evidence_refs, proposed_action?, operation?, trace_id}`를 반환한다. `proposed_action`은 확인 화면 안내일 뿐 권한이 아니다. Tool 실행 결과와 설명을 구분하고, 현재 화면 상품/주문 ID도 소유권·유효성을 다시 검사한다. 세션 Context는 단일 서버의 사용자별 저장으로 시작하며 장기 기억 테이블을 추가하지 않는다.

## 3. DB migration 계획

| 파일 / 적용 단계 | 생성·제약 | 검증 |
| --- | --- | --- |
| `db/migrations/001_catalog_cart_actions.sql` / Phase 1 | `users`, `products`, `product_variants`, `reviews`, `carts`, `cart_items`, `action_requests`. FK, 사용자별 카트 고유, 카트+옵션 고유, 요청 키 고유, 재고/금액 ≥ 0, 수량 ≥ 1, 허용 source/status/kind 제약. 리뷰 옵션이 같은 상품인지 검증하는 관계 제약 포함 | 깨끗한 DB 적용·재실행 무변경, 중복 카트/요청 거절, 다른 상품 옵션 리뷰 거절, 음수·0수량 거절 |
| `db/migrations/002_orders_payments_shipments.sql` / Phase 3 | `orders`, `order_items`, `payments`, `shipments`. 결제/배송 `order_id` 고유, 주문 항목 스냅샷, 정수 금액·상태·버전, 결제 PAID/모의 수단, 환불 제약. 주문 합계/관련 상태 일치는 공통 트랜잭션에서도 검사 | 001 데이터 보존, 주문/재고 원자성, 결제·배송 중복 방지, 실패 시 부분 주문 없음 |
| `db/migrations/003_cancel_requests.sql` / Phase 4 | `cancel_requests`, `order_id`·`action_request_id` 고유, FK·사유·REQUESTED/COMPLETED·금액 제약 | 같은 주문 취소 1건, 기존 주문/결제 보존. 승인 payload와 대상 주문의 일치는 서비스 통합 테스트에서 검증 |

최종 업무 테이블은 12개다. migration 실행 이력용 메타데이터는 도구 내부 관리이며 새 커머스 기능이 아니다. migration은 순차·트랜잭션으로 적용하고 이미 적용한 SQL의 내용 변경을 감지한다. 개발 중 변경 필요 시 새 migration을 추가한다. 공개 환경에서 reset/테이블 삭제로 migration을 대신하지 않는다.

**Seed 결정:** 첫 상품군은 실행용 예시로 모니터 1종을 사용한다. 가상 상품 A/B/C, 각 2옵션, 합성 리뷰 8개, 테스트 사용자 2명으로 시작한다. `V-A-24` 단가 180,000원·재고 5, `V-A-27` 단가 220,000원·재고 0을 필수 고정 사례로 둔다. 나머지 옵션도 가격·재고·스펙 차이가 있도록 선언하고 ID/내용을 고정한다. `FLAT_SHIPPING_FEE_WON=3000`은 **테스트 기준값**으로 정한다. V-A-24 1개 카트 합계는 183,000원, 2개는 363,000원, 빈 카트는 0원이다. 실제 토스 가격/정책으로 표현하지 않는다.

Phase 2에서 사용 조건과 출처가 확인된 실제 리뷰 표본을 별도로 추가한다. 합성 데이터는 반복 검증용으로 계속 보존한다. 실제 데이터 확보가 막히면 그 검증 항목은 미완료로 기록하고, 합성 리뷰에 REAL 표시를 붙이지 않는다. Phase 3·4 seed는 주문/결제/재고 간 관계가 맞는 전용 시나리오를 만든다. 진행 중인 사용자 데이터에 샘플 주문을 무작정 덧붙이지 않는다.

## 4. 실행·테스트 명령 계약

아래 npm script는 Phase 0/해당 Phase에서 생성한다. Windows에서 실행 가능하게 작성하고, 경로 이동·환경 변수를 POSIX shell 문법에만 의존시키지 않는다.

| 명령 | 실행 의미 / 성공 증거 |
| --- | --- |
| `npm ci` | 고정 lockfile로 의존성 재현. 최초 scaffold 때는 lockfile을 생성한 뒤 확인 |
| `npm run db:migrate -- --phase=N` | N까지 필요한 migration만 적용. 재실행으로 데이터가 바뀌지 않음 |
| `npm run db:seed -- --phase=N --scenario=기본값` | 해당 단계의 명시된 seed. reset은 격리된 테스트 DB에서만 별도 플래그로 허용 |
| `npm run dev` | API·웹 함께 실행, DB 기반 health와 UI 진입 확인 |
| `npm run check` / `npm run build` | 타입·입력 schema 검사 / 웹·서버 production build |
| `npm run test:unit -- 경로` | 대상 정책·금액 테스트 PASS, 실패 재현과 수정 결과 기록 |
| `npm run test:integration -- 경로` | 실제 PostgreSQL에서 소유권·트랜잭션·경합 검증 PASS |
| `npm run test:e2e -- 경로` | Playwright가 서버와 브라우저를 실행해 사용자 경로 확인 |
| `npm run eval -- --phase=N --mode=stub` | 고정 모델 응답으로 runtime/Tool 경계 평가. 실제 LLM 검증과 구분 |
| `npm run eval -- --phase=N --mode=live --split=dev` | 지정 제공자/모델 실제 호출·Tool 실행·최종 DB 평가. 모델/프롬프트/데이터 버전 기록 |
| `npm run verify -- --phase=N` | N까지 check/build·정책/통합/E2E·stub 회귀를 묶어 실행. 필요한 선행 단계 없으면 실패하며 조용히 건너뛰지 않음 |
| `npm run simulate -- --order=ID --event=ship/deliver/cancel/refund` | 내부 테스트 권한과 공통 상태 전환 규칙 사용. 사용자/Agent에 API로 공개하지 않음 |

DB 테스트는 실제 PostgreSQL을 사용한다. 행 잠금·경합 검증을 SQLite/메모리 Mock 통과로 대체하지 않는다. CI 테스트 DB와 사용자 테스트 DB를 분리하며, reset은 DB명·환경을 확인한 후 테스트용 DB에서만 허용한다. 모델 키가 없으면 live 평가는 **BLOCKED**로 보고하고 stub PASS로 대신 표시하지 않는다. 독립적인 Backend/UI 작업은 계속할 수 있지만 관련 Phase 전체 완료는 선언하지 않는다.

## 5. API / Tool 매핑

HTTP 경로는 이 계획의 구현 기준안이다. Tool의 입력/출력/오류는 DATA_TOOL_DESIGN을 따른다. HTTP path/query/body의 값은 같은 입력 schema로 정규화한다. Agent가 HTTP를 임의 호출하는 범용 네트워크 Tool은 만들지 않는다.

| Phase | 화면 API | Agent Tool / 위험도 | 공통 서비스 |
| --- | --- | --- | --- |
| 1 | `GET /api/products` | `search_products()` / READ | `catalog.ts` |
| 1 | `GET /api/products/:id` | `get_product()` / READ | `catalog.ts` |
| 1 | `GET /api/products/:id/reviews` | `get_reviews()` / READ | `catalog.ts` |
| 1 | `GET /api/cart` | `get_cart()` / READ | `cart.ts` |
| 1 | `POST /api/cart/items` | `add_to_cart()` / LOW-RISK WRITE | `cart.ts` + `actions.ts` |
| 2 | `PATCH /api/cart/items/:id` | `update_cart_quantity()` / LOW-RISK WRITE | `cart.ts` + `actions.ts` |
| 2 | `DELETE /api/cart/items/:id` | `remove_cart_item()` / LOW-RISK WRITE | `cart.ts` + `actions.ts` |
| 3 | `GET /api/orders` | `list_orders()` / READ | `orders.ts` |
| 3 | `GET /api/orders/:id` | `get_order()` / READ | `orders.ts` |
| 3 | `GET /api/orders/:id/shipping` | `get_shipping_status()` / READ | `orders.ts` |
| 4 | `GET /api/orders/:id/cancel-eligibility` | `check_cancel_eligibility()` / READ | `cancellation.ts` |
| 4 | `GET /api/orders/:id/cancel-quote` (reason_code 지정) | `get_cancel_quote()` / READ | `cancellation.ts` + `quotes.ts` |
| 4 | `POST /api/orders/:id/cancel-requests` (승인 ID 필수) | `request_cancel_order()` / HIGH-RISK WRITE | `cancellation.ts` + `actions.ts` |

| Phase | 사용자 전용 / 내부 연결 | 계약 |
| --- | --- | --- |
| 0~1 | `POST /api/session`, `DELETE /api/session`, `GET /api/session` | 사전 발급한 테스트 사용자 접근 코드 → 서명된 HttpOnly 세션. 코드는 서버 비밀 설정으로만 관리하고 사용자 ID를 임의 선택해 로그인하지 못하게 함. 제품의 회원가입/계정 관리 화면은 만들지 않음 |
| 1 | `POST /api/agent/turn` | 사용자 메시지·페이지 맥락·행동 ID → 구조화된 답변/근거/작업 결과. actor는 서버 세션에서 결정 |
| 1 | `GET /api/actions/:id`, `GET /api/actions?kind=...&idempotency_key=...` | 소유 실행 요청 결과. 첫 응답 유실 시 원래 키로 복원. Agent Tool 아님 |
| 3 | `GET /api/checkout/quote`, `POST /api/checkout/confirm` | 현재 카트 견적 → 사용자 최종 확인·원자 주문 생성. Agent가 실행할 수 없음 |
| 4 | `POST /api/orders/:id/cancel-confirmations` | A02 최종 버튼·견적 토큰·행동 키 → confirmation_id. UI 전용 호출 검증, 일반 Tool 등록 금지 |
| 3~4 | `scripts/simulate.ts` | 배송/최종 취소/환불 진행. 공통 상태 검증을 호출하는 내부 CLI만 제공 |

세션·승인 경계는 이름만 다른 API로 구현하지 않는다. 브라우저 요청은 세션과 Origin/위조 요청 방지를 검증하고, Agent runtime에는 브라우저 세션 쿠키·승인 생성 기능을 주지 않는다. 취소 실행은 UI 확인 이벤트로 생성된 승인 ID에 묶는다. 대화에 삽입된 승인 ID나 모델의 `confirmed=true`는 승인 이벤트가 아니다.

## 6. Phase별 실행 계획

### Phase 0 — 실행 기반과 최초 검증 계약

**목표:** 아직 상품 기능이 없어도 앱·DB·테스트 환경의 상태를 확인할 수 있다. 이 준비를 별도의 장기 플랫폼 작업으로 확대하지 않는다.

**생성:** package/TypeScript/Vite/Vitest/Playwright 설정, `compose.yaml`, `.env.example`, `src/server/{app,main,config}.ts`, `src/server/db/{pool,transaction}.ts`, `src/server/auth/session.ts`, `src/shared/{contracts,tool-contracts}.ts`, 웹 App/기본 CSS, `scripts/{migrate,seed,verify-phase}.ts`, `tests/integration/health.test.ts`, `tests/e2e/smoke.spec.ts`, `docs/{IMPLEMENTATION_DECISIONS,IMPLEMENTATION_PROGRESS,VERIFICATION_LOG}.md`, `README.md`.

**입출력 경계:** `GET /health` → 서버/DB 연결 상태. 사용자 API는 검증된 `RequestContext`만 사용. 아직 registry에는 업무 Tool을 등록하지 않는다. **Migration:** 없음. 환경 도구의 실행 이력만 준비한다.

Phase 0의 세션 검증은 주입한 테스트 인증 주체로 단위 테스트한다. 아직 없는 `users` 테이블이나 업무 API에 의존하지 않는다. 실제 사용자 세션 API와 `auth_subject` → DB 사용자 연결은 Phase 1의 001 migration 적용 후 완성한다.

- [ ] 실행 폴더에 다른 모델의 코드가 생겼는지 재확인한다. 있으면 덮어쓰지 않고 구조를 매핑한다. Git 저장소 여부를 확인하고 없으면 구현 기록용 로컬 저장소를 준비한다. 원본 영상·불필요한 대용량 캡처는 자동으로 커밋하지 않는다.
- [ ] Node/DB 실행 경로, 위 스택의 호환 버전, 사용할 LLM 제공자/모델·키 접근 위치, 로컬/배포 DB를 `IMPLEMENTATION_DECISIONS`에 기록한다. 필요한 비밀이 없으면 값을 만들거나 파일에 노출하지 않는다.
- [ ] `health_requires_database` 통합 테스트와 `tests/unit/session.test.ts`의 `session_cannot_choose_actor`를 먼저 작성한다. DB 미연결은 정상 health로 보고하지 않고, 가짜 actor 입력은 거절해야 한다.
- [ ] 설정·서버·세션·DB 연결·검증 명령을 최소 구현한다. `.env.example`에는 변수 이름과 설명만 둔다. DB reset은 테스트 환경 확인 없이는 실행되지 않게 한다.
- [ ] `npm run verify -- --phase=0`으로 타입/build·health·브라우저 smoke를 통과시킨다. 명령/결과를 로그에 기록하고 Phase 0 상태를 완료로 바꾼다.

**DoD / Gate:** 새 작업 환경에서 의존성 설치→DB 연결→서버·웹 실행이 재현되고, 세션 주체 위조/비밀 노출 검사가 통과한다. LLM 환경이 준비됐거나 live 호출 차단 원인이 명시돼 있다. 아직 Agent/Commerce 완료를 주장하지 않는다.

### Phase 1 — 첫 Vertical Slice: 근거 조회에서 실제 카트 반영까지

**목표:** 한 상품군에서 사용자의 예산·용도를 받아 상품/리뷰를 조사하고, 명시적으로 선택한 옵션을 실제 DB 카트에 담는다.

**생성:** migration 001; `db/seeds/{catalog,reviews,users}.json`, `provenance.md`; `commerce/{catalog,cart,actions}.ts`; `http/{catalog,cart,actions,agent,session}.ts`; `agent/{provider,runtime,registry,shopping,session-context,trace}.ts`; `screens/{Shopping,Product,Cart}.tsx`; `components/{AgentPanel,CommerceState,ProductCard}.tsx`; `src/web/api.ts`; `scripts/eval.ts`, `eval/cases/dev/t1-first-slice.json`, `eval/rubric.md`; `tests/integration/t1-first-slice.test.ts`, `tests/e2e/t1-first-slice.spec.ts`, `tests/unit/agent-runtime.test.ts`.

**수정:** 서버/API 등록, shared 입력/출력, 웹 화면 이동, README/검증 기록. **Migration:** 001. **인터페이스:** 5절 Phase 1의 Tool 5개와 `CartView`, `runAgentTurn`, `getActionResult`. 테스트 Provider와 실제 Provider가 같은 runtime·Tool registry를 사용한다.

- [ ] `db:migrate --phase=1` 적용과 seed 재현 테스트를 작성한다. `V-A-24`·`V-A-27` 가격/재고·리뷰 출처·사용자별 카트 격리를 확인한다.
- [ ] `variant_and_evidence_match`, `add_merges_once`, `recommendation_has_no_write`, `lost_first_response_recovers` 통합 테스트를 먼저 실패시킨다. 정확한 옵션 ID, 추가 후 수량, 재고 불변, 같은 키 재호출 시 무변경을 assert한다.
- [ ] 실제 사용자 세션을 `users.auth_subject`에 연결하고 상품/리뷰 검색, get_cart, 원자적 action request·담기·결과 조회를 구현한다. 같은 서비스에 HTTP와 Tool Adapter를 각각 연결하고 입력/결과가 같음을 테스트한다.
- [ ] W01·W02·W03 최소 UI와 A01을 연결한다. 옵션 선택/리뷰 원문/담기 피드백을 구현한다. 이때 필요한 Toss 대표 화면만 참고해 다크 톤·카드·CTA를 맞춘다. 주문 버튼은 Phase 3 전까지 노출하지 않는다.
- [ ] 실제 모델이 `search_products`·`get_product`·`get_reviews`를 선택하고 근거를 제시하도록 연결한다. 명확한 추가 요청 뒤에는 최신 카트/옵션 버전을 조회해 담는다. 브라우저 입력이 정확한 고정 문장일 때만 동작하는 분기문으로 대체하지 않는다.
- [ ] runtime에 허용 Tool·schema 검사, 사용자별 세션, 반복 호출 제한, 실패 출력 처리를 넣는다. 초기 실행 기준은 턴당 Tool 호출 최대 8회·60초 제한으로 두고 설정화한다. 한도 도달 시 제한 도달을 표시하며 업무 성공으로 응답하지 않는다.
- [ ] trace에 원래 요청 ID·Tool 입출력 요약·근거 ID·DB 결과·시간·실제 토큰 사용량을 남긴다. 비용은 제공자의 확인된 단가가 있을 때 계산하고 없으면 미측정으로 표시한다.
- [ ] `verify --phase=1`과 live 평가를 수행한다. 새로운 seed에서 정상 2턴 시나리오를 3회 실행해 결과와 근거를 기록한다. 비정상 사례는 검색 0건·근거 부족·품절·Tool 실패·추천만 요청·응답 유실을 각각 검사한다.

**DoD / Gate:** 마지막 10절의 첫 Slice 완료 조건을 전부 만족한다. 실제 LLM 호출 기록·DB 결과·브라우저 캡처가 있어야 한다. 결제·주문·취소가 없어도 이 단계는 독립적으로 실행 가능하다.

### Phase 2 — T1 완성: 비교·수정·삭제·복구

**목표:** 최대 3개 후보의 목적별 비교와 리뷰 근거를 제공하고 카트 변경 전체를 안전하게 수행한다.

**생성:** `tests/integration/t1-cart.test.ts`, `tests/unit/shopping-evidence.test.ts`, `tests/e2e/t1-complete.spec.ts`, `eval/cases/dev/t1-complete.json`.

**수정:** `cart.ts`, `http/cart.ts`, shared/registry, `shopping.ts`, `AgentPanel.tsx`, `Product.tsx`, `Cart.tsx`, seed/출처 문서. **Migration:** 없음. **추가 인터페이스:** `update_cart_quantity`, `remove_cart_item`; 누적 Shopping Tool 7개.

- [ ] `stale_cart_and_replay`, `delete_sold_out_item`, `review_instruction_is_data`, `citation_must_exist` 테스트를 작성한다. 다른 사용자 카트, 같은 이름의 다른 옵션, 0/음수 수량, 오래된 버전, 허위 리뷰 ID를 포함한다.
- [ ] 수량 수정·삭제를 actions 공통 처리에 연결한다. 품절 상품 삭제는 허용하고, 실패/결과 미확정 상태에서는 주문·추가 변경을 차단한다.
- [ ] A01 비교 카드에 사용자 조건·상품 차이·근거 리뷰 ID·한계를 표시하고 W02 원문으로 이동/복귀하게 한다. 리뷰 부족을 긍정 평가로 바꾸거나 검색 결과 일부를 전체로 표현하지 않게 한다.
- [ ] W03 Empty, 옵션 품절, 가격 변경 재확인, 읽기 실패/쓰기 결과 확인 UI를 완성한다. 같은 작업의 재시도는 이전 payload/키를 보존하고 새 버전으로 자동 재실행하지 않는다.
- [ ] 사용 조건이 확인된 실제 리뷰 표본을 출처와 함께 추가해 검색→원문→설명 경로를 별도 평가한다. 데이터가 확보되지 않으면 실제 리뷰 검증 항목만 미완료로 남긴다.
- [ ] `verify --phase=2`, dev T1 live 평가, 초기 프롬프트 대비 비교를 실행한다. 추천만 요청했을 때 쓰기 0회, 잘못된 근거 ID 0건을 확인한다.

**DoD / Gate:** T1 전체가 W01/W02/W03/A01에서 연결되고 초기 조건·옵션·근거·카트 결과가 일치한다. 7개 Shopping Tool만으로 동작한다. 실제 리뷰 검증과 합성 데이터 테스트 결과를 분리해 보고하고, 실패/미확정 상태를 숨기지 않는다.

### Phase 3 — 모의 결제와 T2 주문·배송 설명

**목표:** 사용자가 카트에서 주문을 만들고, CS Brain이 그 주문을 식별해 실제 상태를 설명한다.

**생성:** migration 002; `commerce/{checkout,orders,quotes,simulator}.ts`; `http/{checkout,orders}.ts`; `auth/ui-action.ts`; `agent/cs.ts`; `screens/{Checkout,Orders,OrderDetail}.tsx`; `scripts/simulate.ts`; `db/seeds/scenarios.json`; `tests/integration/{checkout,t2-shipping}.test.ts`, `tests/e2e/checkout-t2.spec.ts`, `eval/cases/dev/t2-orders.json`.

**수정:** App·AgentPanel·registry·shared·장바구니 주문 진입·seed/trace. **Migration:** 002. **추가 인터페이스:** `prepareCheckout`, `confirmCheckout`, 주문 Tool 3개, 내부 배송 전환. 누적 Tool 10개.

- [ ] 001→002 적용 시 기존 카트/리뷰가 보존되는 migration 테스트를 작성한다. 결제 성공/품절/가격 변경/응답 유실 fixture를 준비한다.
- [ ] `checkout_is_atomic`, `concurrent_last_stock`, `duplicate_checkout_one_order`, `agent_cannot_checkout` 테스트를 먼저 작성한다. 재고 1개 동시 주문은 1개만 성공하고 다른 요청은 주문/결제를 남기지 않아야 한다.
- [ ] UI 전용 5분 견적·확인·주문 생성과 getActionResult를 구현한다. 재고 차감·주문·결제·배송·카트 비우기·실행 결과가 한 트랜잭션이어야 한다.
- [ ] W04 확인→Processing→완료→W06을 구현한다. 합계/테스트 주소/모의 결제 표시를 넣고 새로고침·응답 유실·이전 버튼의 중복 결제를 차단한다.
- [ ] `orders_are_owner_scoped`, `missing_shipping_is_not_delay`, `ambiguous_order_requires_selection`을 작성하고 W05/W06과 CS READ Tool 3개를 연결한다. 준비/배송 중/완료/정보 없음 주문을 각각 재현한다.
- [ ] CS 지침을 ‘대상 주문 확인→도구 조회→상태/시각 설명’으로 시작한다. 취소 실행 Tool은 아직 등록하지 않는다. 내부 ship/deliver는 공통 주문 잠금과 이력 갱신을 사용한다. 아직 없는 `cancel_requests` 조회에 의존하지 않으며, Phase 4에서 취소 접수 중 출고 차단 규칙과 회귀 테스트를 함께 추가한다.
- [ ] `verify --phase=3`, T1 회귀와 T2 live 평가를 수행한다. 새 주문은 사용자 UI에서 만들고 같은 주문 ID로 Agent 설명까지 확인한다.

**DoD / Gate:** UI 결제가 만든 DB 주문과 CS가 조회한 주문이 동일하다. 타인 주문 접근 0건, 정보가 없는 도착일 생성 0건, 중복 주문/음수 재고 0건이다. Phase 4 없이 배송 조회까지 독립적으로 데모할 수 있다.

### Phase 4 — T3 사용자 확인·취소·모의 환불

**목표:** 취소 가능 여부와 금액을 서버가 결정하고, 확인된 요청만 접수해 결과를 단계별로 표시한다.

**생성:** migration 003; `commerce/cancellation.ts`, `http/cancellation.ts`, `components/CancelSheet.tsx`; `tests/unit/cancellation-policy.test.ts`, `tests/integration/{cancel-confirmation,cancel-race,cancel-recovery}.test.ts`, `tests/e2e/t3-cancel.spec.ts`, `eval/cases/dev/t3-cancel.json`.

**수정:** `quotes.ts`, `actions.ts`, `simulator.ts`, `auth/ui-action.ts`, `orders.ts`, CS/registry/contracts, W06/A01, seed/scenarios. **Migration:** 003. **추가 인터페이스:** CS Tool 3개, `confirmCancellation`, `completeCancellation`, `completeRefund`; 누적 13개.

- [ ] 가능한 주문·출고 주문·취소요청 있음·이미 취소·배송 정보 없음·결제/합계 모순에 대한 서버 정책 표 테스트를 작성한다. 예정액은 paid_amount 전액이며 현재 상품 가격 변경과 무관함을 assert한다.
- [ ] `confirmation_required`, `forged_actor_denied`, `expired_or_changed_quote`, `approval_api_not_agent_accessible`을 작성한다. 과거 승인 ID·위조 true 값·타인 승인·대상/사유/금액 변경을 차단한다.
- [ ] READ 자격/견적→A02 최종 버튼→서버 승인 READY→공통 취소 명령→REQUESTED를 구현한다. confirmation_id와 operation_id를 별도 요청으로 이중 생성하지 않는다.
- [ ] `cancel_ship_race`와 `cancel_retry_once`를 실제 DB 동시 연결로 실행한다. 취소 접수와 출고가 동시에 성공하지 않고 요청은 주문당 1건이어야 한다.
- [ ] 내부 취소 처리와 모의 환불을 분리한다. 취소 시 주문/배송 CANCELLED·취소 COMPLETED·재고 1회 복원·환불 PENDING, 이후 환불 REFUNDED로 전환한다. 중간 단계에서 중단/재시작해도 반복 처리로 금액·재고가 늘지 않게 한다.
- [ ] A02 닫기/미확인/진행 중/불가 상태와 W06의 요청·취소·환불 결과를 구현한다. AI는 조회한 실제 단계만 설명하고 ‘접수’를 ‘환불 완료’라고 표현하지 않는다.
- [ ] `verify --phase=4`, CS/T1 누적 회귀와 T3 live 평가를 수행한다. 최초 승인 응답 유실도 UI 행동 키로 복원한다.

**DoD / Gate:** 확인 전 취소 호출/변경 0회, 확인 후 요청 1건, 재고 복원/환불 각각 1회. 모든 불가·우회·경합 사례가 막히며 UI와 Agent 결과가 같다. 합성 운영 시스템인 점이 화면과 기록에서 분명하다.

### Phase 5 — 통합 검증·배포·실사용 개선

**목표:** 세 과제를 외부 사용자가 실행하고, 반복 평가와 피드백으로 품질 개선을 입증한다. 추가 기능 Phase가 아니다.

**생성:** `tests/e2e/core-journeys.spec.ts`, `eval/cases/holdout/{t1,t2,t3}.json`, 배포처에 맞는 최소 설정, `docs/USER_TEST_REPORT.md`.

**수정:** 앱의 드러난 P0 결함, README/진행/검증 기록, 필요시 배포 build/static serving/session 설정. **Migration:** 기본 없음. 실제 발견된 P0 결함 수정에 필요할 때만 새 migration과 기존 데이터 보존 검증을 추가한다.

- [ ] 모든 화면/패널·필수 7개 상태를 E2E로 확인한다. UI 레퍼런스는 이때 홈/상세/카트/주문 대표 배치 비교에만 사용하고 픽셀 복제 범위로 확장하지 않는다.
- [ ] dev 평가 케이스와 분리한 holdout 6개(과제당 2개)를 실행한다. 같은 질문에만 맞추지 않도록 표현·예산·옵션·주문 대상을 바꾸고, 각 케이스를 초기화된 상태에서 3회 실행한다. 답변, 근거, Tool, DB 최종 상태를 함께 판정한다.
- [ ] deterministic 정책/권한/회귀는 전부 PASS, live 평가의 금지된 변경·타인 접근·허위 근거 ID는 0건이어야 한다. Task Success/근거 적합성/latency/cost를 전후 비교하고 남은 실패를 숨기지 않는다. holdout을 튜닝에 사용했다면 새 holdout을 분리한다.
- [ ] 외부 배포와 사용자별 테스트 계정을 준비한다. 테스트 접근 코드는 비밀로 전달하며 Source/로그/클라이언트에 전체 계정 코드 목록을 노출하지 않는다. 공용 actor 선택·DB reset·시뮬레이터는 공개하지 않는다.
- [ ] 실제 사용자 **최소 5명**이 세 과제 중 지정된 과제를 수행하게 하고, 막힌 지점·추천 근거 이해·처리 결과 이해·피드백을 기록한다. Seed Persona/자동 브라우저를 실제 사용자 수로 세지 않는다.
- [ ] 피드백에서 P0 결함을 수정하고 관련 회귀·live 평가를 다시 수행한다. README에 실행법·역할·범위·모의 처리·평가/피드백·한계·배포 주소를 정리한다. GitHub 코드/문서 기록 및 발표에 필요한 증거를 남긴다.

**DoD / Gate:** 세 과제가 배포 환경에서도 작동하고, 실제 사용자 피드백을 최소 한 차례 반영한 증거가 있다. 기존 `MISSION_REQUIREMENTS.md`의 AI Agent + 상품/리뷰 Retrieval 기반 RAG, 배포, 5명 테스트, AI 표시 조건을 확인한다. 기준을 충족하지 못한 항목은 미완료로 남긴다.

## 7. UI / Shopping Brain / CS Brain의 구현 순서

| 영역 | 순서 |
| --- | --- |
| UI | Phase 1: 공통 다크 토큰·W01/W02/W03·A01 → Phase 2: 비교/근거·카트 수정·실패 복구 → Phase 3: W04/W05/W06 → Phase 4: A02·취소 결과 → Phase 5: 대표 화면 비교·사용성 보완 |
| Shopping Brain | Provider/runtime·READ Tool → 현재 대화 조건 확인·상품/리뷰 조회 → 근거 있는 후보 비교 → 명확한 추가 요청의 쓰기 실행 → 수량 수정/삭제·실패 복구·평가 개선 |
| CS Brain | 주문/배송 READ Tool·소유 주문 식별 → 정보 없음/모호한 주문 질문 → 서버 취소 자격/견적 설명 → UI 확인 이벤트 이후 요청 Tool → 실제 단계 재조회·설명 |

두 Brain은 역할과 허용 Tool을 나눈 같은 runtime으로 시작한다. 멀티 Agent 플랫폼·복잡한 라우터는 만들지 않는다. 사용자 화면의 쇼핑/주문 맥락에 맞춰 모드를 시작하고, Agent가 새 역할을 얻어 권한을 확대할 수 없게 한다.

## 8. Guardrail / Evaluation / 완료 증거

| 시작 시점 | 함께 구현할 내용 | 증거 |
| --- | --- | --- |
| Phase 0 | 신뢰된 사용자 세션·명령/검증 규약·테스트 DB 격리 | health/auth 실패 테스트·환경 결정 기록 |
| Phase 1 | 입력 schema·Tool allowlist·현재 사용자/버전·중복 키·호출 상한·첫 trace·DB 결과 평가 | 실제 모델 Tool trace + DB/브라우저 결과, 최초 정상/실패 fixture |
| Phase 2 | 근거 ID 검증·다른 옵션 리뷰 분리·자료 내 지시 무시·쓰기 복구 | citation/품절/권한/재시도 회귀와 실제 리뷰 출처 |
| Phase 3 | 사용자 전용 결제·소유 주문·동시 재고·정보 없음 | 결제 원자성·actor 격리·T2 live 결과 |
| Phase 4 | 위조 불가 승인·5분 만료·최신 정책·출고 경합·1회 재고/환불 | 우회/경합/중복 테스트·T3 단계별 화면/DB |
| Phase 5 | holdout 반복 평가·운영 세션 보호·실사용 피드백 | 전후 평가 보고·5명 이상 테스트 기록·회귀 |

평가 케이스에는 `case_id`, 사용자 요청/전제 상태, seed/scenario, 허용/금지 Tool, 기대 DB 변화, 필요한 근거 ID/조건, 기대 화면 상태를 저장한다. Tool 호출 순서 하나에만 정답을 고정하지 않고, 필요한 근거와 최종 상태를 판정한다. `eval/rubric.md`는 조건 충족·근거와 주장 일치·금지 변경 여부·사용자 이해를 구분한다.

LLM 평가는 동일 seed·모델/프롬프트 버전에서 비교하고 Task Success 분모/실행 횟수를 기록한다. latency는 실제 요청 시간, cost는 실제 토큰과 확인한 단가에 근거한다. 존재하지 않는 데이터로 개인화 정확도·사용자 만족도를 수치화하지 않는다. 첫 단계부터 자동 판정 가능한 DB/권한은 코드로, 설명의 적합성은 명시한 rubric과 사람 검토로 평가한다.

**공통 Phase 완료 기록:** 생성/수정 파일, migration 버전, 실행한 명령·exit/result, seed/모델/프롬프트 버전, 통과/실패 케이스, 대표 UI/trace/DB 증거, 미완료 항목을 `docs/VERIFICATION_LOG.md`에 기록한다. 토큰·비용 로그에는 비밀·주소 등 불필요한 개인 정보를 남기지 않는다. 각 검증된 작업 단위로 명확한 commit을 남기되 기존 사용자 파일을 함께 일괄 stage하지 않는다.

## 9. 후속 기능 TODO — 이번 구현에서 작업하지 않음

- [ ] TODO: 장기 선호/구매 이력 기반 개인화·Shopping Plan 저장·여러 상품 예산 배분.
- [ ] TODO: 상품군별 Aspect 저장/검색 고도화·대규모 리뷰 검색 최적화. 현재 원문 조회·근거 연결은 P0에서 수행.
- [ ] TODO: 이미지 기반 시각적/기능적 유사 상품 검색, 재구매 예측·능동 알림.
- [ ] TODO: 반품·교환·부분 취소·CS 티켓/상담원 연결.
- [ ] TODO: 찜·쿠폰·포인트·복잡한 필터·판매자센터·정산·실제 PG/배송사 연동.

위 목록은 후속 후보 기록이다. 실제 P1/P2 우선순위·일정이 확정됐다는 뜻이 아니며, 빈 화면·미사용 테이블·Tool stub을 미리 만들지 않는다.

### 구현 도구 참고

권장 기준안의 사용법은 구현 시 선택한 버전의 [Fastify 공식 문서](https://fastify.dev/docs/latest/), [Vite 공식 가이드](https://vite.dev/guide/)로 확인한다. 동시성 검증은 [PostgreSQL 행 잠금 문서](https://www.postgresql.org/docs/current/explicit-locking.html)를 참고하고, 브라우저 테스트 서버 기동은 [Playwright webServer 문서](https://playwright.dev/docs/test-webserver)를 따른다. 이 링크들은 도구 사용 참고이며 P0 제품 범위를 추가하지 않는다.

## 10. 첫 구현 Vertical Slice 추천과 구체적 완료 조건

**Phase 0의 최소 준비 직후 Phase 1을 시작한다. 첫 Slice는 ‘조건에 맞는 상품/리뷰 비교 → 사용자가 특정한 옵션 담기 → 실제 카트 확인’이다.** 주문/취소의 복잡도를 먼저 만들지 않아도 이 흐름에서 Retrieval, LLM Tool Calling, 서버 규칙, 상태 변경, 사용자 화면, 평가를 함께 검증할 수 있다.

예시: “배송비 포함 20만원 안에서 개발용 모니터를 비교해줘.” → 후보·원문 근거 표시 → “A의 24인치 옵션 1개를 담아줘.” → 실제 담기 → W03 결과. 이 사례는 고정 테스트 데이터의 예시이며 실제 제품 추천이 아니다.

**아래 10개가 모두 충족돼야 첫 Slice 완료다.**

1. 깨끗한 테스트 DB에 001 migration·고정 seed를 적용하고 앱을 재실행할 수 있다.
2. 실제 LLM이 등록된 5개 Tool을 필요한 시점에 호출하며 trace로 확인된다. 고정 문장 분기·Stub만으로 완료 처리하지 않는다.
3. 추천 응답은 예산/용도와 일치하는 후보 및 실제 조회한 상품/리뷰 ID를 제공한다. 추천만 했을 때 카트는 비어 있다.
4. 옵션이 모호하면 질문하고, 품절 V-A-27은 담지 않는다. 사용자 의사 없이 옵션을 대체하지 않는다.
5. 명시된 V-A-24 1개를 담으면 카트 항목 1개·수량 1·상품 금액 180,000원·배송비 3,000원·합계 183,000원이다. 재고는 5로 유지한다.
6. 같은 키로 담기를 재전송해도 수량은 1이다. 최초 응답과 요청 ID 유실 후에도 원래 키로 결과를 복원할 수 있다.
7. 다른 테스트 사용자의 카트 조회/변경은 불가능하고, UI 버튼과 Agent 호출이 같은 서비스의 동일한 결과를 낸다.
8. 검색 0건·리뷰 근거 부족·옵션 품절·Tool 실패가 구분돼 보인다. 근거/실행 결과를 만들어내지 않는다.
9. `verify --phase=1`이 통과하고 초기화된 상태의 정상 2턴 live 시나리오 3회에서 같은 업무 결과를 얻는다. 실패가 있으면 원인과 재검증 결과를 기록한다.
10. W01/W02/W03/A01에서 요청→근거→선택→카트 확인을 사용자가 따라갈 수 있다. 다크 톤·카드·가격·CTA가 기준 문서와 맞고, DB 결과·trace·브라우저 증거가 함께 저장돼 있다.
