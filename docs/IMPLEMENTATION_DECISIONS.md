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

Phase 2 추가 결정:

| 항목 | 결정 | 이유/메모 |
| --- | --- | --- |
| 비교 카드 데이터 | 서버가 tool result JSON에서 조립(`buildCompare`), 최대 3개 + limitations(리뷰 근거 부족/부분 결과/품절 포함) | LLM 텍스트가 아닌 조회 데이터 기준 — 허위 근거/과대 표현을 구조적으로 차단 |
| update/remove 멱등 | runAction 공통 처리. action kind는 001 예약값 UPDATE_CART/REMOVE_CART 사용 | Phase 2 migration 없음 |
| 재시도 규칙 | OUTCOME_UNKNOWN만 같은 키+payload 보존(결과 조회 복구). VERSION_CONFLICT는 새 키 + 최신 버전으로 사용자가 재시도 | REJECTED는 저장된 거절을 재생할 뿐이므로 같은 키로 재실행 불가 |
| 카트 가격 표시 | 담긴 시점 가격을 저장하지 않고 항상 현재가 표시 | ponytail: 가격 변경 감지 UI 대신 라이브 가격. 옵션 version 충돌로 변경 후 구매는 여전히 차단 |
| 수량 UI | +는 재고 힌트 없이 서버 OUT_OF_STOCK에 위임, −는 1에서 비활성, 품절은 삭제만 | CartView에 stock 미포함 상태 유지 |

Phase 3 추가 결정:

| 항목 | 결정 | 이유/메모 |
| --- | --- | --- |
| 주문서 견적 | HMAC 서명 불투명 토큰 + 5분 TTL, 카트/옵션 버전·가격·주소 스냅샷 포함 | UI 전용. 견적 후 카트 변경은 STALE_QUOTE로 차단하고 재확인 요구 |
| 결제 원자성 | runAction("CHECKOUT") 단일 트랜잭션: 카트 잠금→버전 검증→옵션 FOR UPDATE(정렬)→활성/가격/재고 재검증→재고 차감→주문+항목 스냅샷+결제 PAID+배송 PREPARING 생성→카트 비우기 | 실패 시 부분 주문 없음. 같은 키 재전송은 저장된 결과 복원(중복 주문 없음) |
| checkout 접근 | Tool registry에 등록하지 않음. GET /api/checkout/quote + POST /api/checkout/confirm은 UI 세션 전용 | agent_cannot_checkout 테스트로 brain 양쪽 노출 0 검증 |
| 주문 항목 | 구매 시점 스냅샷(상품명/옵션/단가) 저장 | 이후 상품·가격 변경과 무관하게 주문 내용 보존 |
| 배송 상태 | shipments 주문당 1건, PREPARING→IN_TRANSIT→DELIVERED 전환은 내부 simulate만(shipOrder/deliverOrder). cancel_requests가 생기면(Phase 4) 같은 주문 잠금으로 출고 차단 | Tool/API에 노출하지 않는 운영 전환 |
| CS Brain 분리 | ToolSpec.brains로 노출 범위 분리: shopping=카탈로그·카트, cs=주문 조회 3종. 히스토리는 user:brain별 | brain 외 Tool은 TOOL_NOT_ALLOWED. 취소 실행 Tool은 Phase 4 |
| 테스트 사용자 | u-c 추가(박주문) — e2e checkout 스펙 전용 | 병렬 실행 시 기존 u-a/u-b 카트와 경합 방지 |
| 재시드 재현성 | variant upsert에 version=1 리셋 포함 | checkout이 version을 올려 재실행 시 기대값(1)과 어긋나는 것 방지 |
| jsonb 파라미터 | postgres.js 파라미터에는 raw 객체/배열(JSON.stringify 금지 — 문자열로 저장돼 CHECK 위반) | seeds/checkout/orders에 동일 적용 |
| 통합 테스트 종료 | sql 풀이 서브프로세스 종료를 막아 --test 러너 hang → after(sql.end()) + --test-force-exit | spawn kill 직후 크래시는 300ms 지연으로 회피. verify.ts 반영 |
| 주문서 CTA | 장바구니 '주문하기' 버튼 라벨에 금액 미포함 | 기존 e2e의 금액 텍스트 단정과 strict-mode 충돌 방지 |

Phase 4 추가 결정:

| 항목 | 결정 | 이유/메모 |
| --- | --- | --- |
| 취소 승인 = 실행 요청 행 | UI 승인이 action_requests(kind=CANCEL_ORDER, status=READY, 5분 만료)를 만들고, CS Tool 실행이 같은 행을 READY→SUCCEEDED/REJECTED로 확정 | confirmation_id==operation_id. 승인과 실행이 한 멱등 단위 — '승인 없는 실행'과 '중복 실행'이 구조적으로 불가 |
| 승인 생성은 UI 전용 | POST /api/orders/:id/cancel/approve는 세션 본인만. Tool registry에 없음 | Agent가 스스로 승인을 만들 수 없어 확인 우회 차단(approval_api_not_agent_accessible 테스트) |
| 실행 입력 | request_cancel_order(order_id, reason_code?, confirmation_id?) — confirmation_id 없으면 actor+order의 최신 READY 승인을 소비 | 단순화: 시트는 confirmation_id를 명시하고, Agent는 방금 만든 승인을 조회해 소비. 없으면 CONFIRMATION_REQUIRED |
| 실행 전 재검증 | 만료→CONFIRMATION_EXPIRED, 주문 버전/대상/사유/금액 불일치→CONFIRMATION_STALE, 자격 상실→CANCEL_NOT_ELIGIBLE — 전부 REJECTED로 확정 저장 | 승인 시점 이후 상태 변화(출고 등)를 실행 시점에 다시 확인 |
| 접수≠완료 | REQUESTED에서 주문은 CONFIRMED 유지, 최종 취소·재고 복원·환불 PENDING은 simulate cancel(completeCancellation), 환불 REFUNDED는 simulate refund | P0: 처리 지연을 운영자 시뮬레이션으로 표현. LLM이 취소 완료/환불액을 판단하지 않음 |
| 자격 조건(p0-v1) | 소유 주문·CONFIRMED·결제 PAID+환불 NONE·취소 요청 없음·배송 PREPARING. 배송 레코드 없으면 SHIPPING_UNVERIFIED(불가) | 환불액=payments.paid_amount_won 전액, 주문 합계와 불일치 시 DATA_INCONSISTENT로 중단 |
| 취소-출고 경합 | cancel과 shipOrder가 같은 orders 행 FOR UPDATE로 직렬화 — 패자는 CONFIRMATION_STALE(버전 범프) 또는 INVALID_STATE | REQUESTED와 IN_TRANSIT 동시 성립 불가(설계 §8.1) |
| e2e 상품 격리 | t3-cancel은 모니터 C(v-c-27) 구매 — checkout-t2(v-b-24)와 다른 옵션 | 재고 차감이 옵션 버전을 올리는 것은 문서화된 정상 동작. 병렬 스펙끼리 같은 옵션을 사면 STALE_QUOTE가 의도대로 발생하므로 상품을 분리 |

Phase 5 추가 결정:

| 항목 | 결정 | 이유/메모 |
| --- | --- | --- |
| holdout 케이스 | dev와 표현·예산·옵션·주문 대상을 다르게 한 6개(T1×2: 152,000 cap 추천/v-b-27×2개, T2×2: PREPARING 설명/타인 주문 조회, T3×2: 배송 정보 없음 불가/2턴 확인 전 실행 차단) | 시드 주문 집합이 고정돼 있어 대상 조합은 한정적 — 변형은 표현·사유·상태 축으로 |
| 반복 실행 | `--repeat=N`을 eval에 추가하고 케이스당 cleanUserData+resetHistory+새 provider로 3회 | 각 반복이 초기화된 동일 조건에서 실행돼야 재현성 있는 분모가 된다 |
| eval arg 버그 | `--k=v`를 인식 못해 flag가 무시되던 파서를 `--k=v`/`k=v` 모두 허용으로 수정 | silent misconfiguration — 잘못된 split/mode로 PASS가 보고될 수 있던 실질적 위험. Phase 5에서 발견·수정 |
| 배포 아티팩트 | 단일 stage Dockerfile(node:24-alpine, npm ci 전체, node src/server.ts) | esbuild가 서버 시작 시 웹 번들을 만들므로 devDependencies 필요. 멀티 스테이지 슬리밍은 P0 과잉. 이미지에 .env/문서/테스트 결과를 넣지 않는 .dockerignore 포함 |
| 배포 실행 | 로컬 빌드·기동·health/SPA까지 검증하고 외부 배포는 BLOCKED | 배포처 계정/레지스트리가 미정 — 준비물과 절차만 확정해 README에 기록 |
| 접근 코드 운영 | TEST_USER_CODES env가 코드→사용자 매핑. 사용자 테스트용 계정도 seed가 아니라 env로 추가 | 코드 목록은 Source에 있지만 테스트용 코드는 전달용으로만 쓰고 클라이언트/로그 노출 금지 — 공용 actor 선택·DB reset·시뮬레이터는 API에 노출되지 않는 구조 유지 |
| core-journeys 범위 | 기존 스펙이 덮는 경로는 반복하지 않고 미커버 필수 상태 5건만 작성 | ponytail: 전체 여정 재실행보다 커버리지 갭을 채우는 게 목적. 읽기 위주라 전용 사용자·재고 격리 불필요 |

2026-10-07 · 프로젝트 방향 재정립 — Commerce Environment 선행

배경: Phase 0~5로 Backend·Tool·Guardrail·Eval의 로컬 구현·검증이 완료됐으나(live eval·배포·실사용자 미완료), 실제 화면을 사용해 본 결과 Commerce Environment가 토스쇼핑의 구매 환경과 너무 달랐다 — 상품 3개·단일 카테고리(모니터)로 콘텐츠 밀도 부재, merchandising·프로모션 구조 없음, Header/Search/Navigation의 IA가 실제 앱과 상이. 최종 목표(현실적 Commerce 환경에서 동작하는 Brain의 구현·검증)는 동일하고, 도달 경로를 '간소화 데모 우선'에서 '**토스쇼핑 수준의 Commerce Environment를 먼저 구축한 뒤 Brain 결합**'으로 수정했다.

Superseded 처리된 과거 결정 (삭제하지 않고 기록 — 미래의 독자가 과거 문장을 보고 되돌아가지 않도록):

| 과거 결정 (Superseded) | 현재 결정 | 변경 근거 |
| --- | --- | --- |
| Toss Navigation을 프로젝트용으로 단순화한다 | 토스 로고·상표·고유 자산을 제외하고 Navigation 구조·탭 수/배치·선택 상태·높이·아이콘/라벨 관계·가로 스크롤·화면 내 위치를 레퍼런스대로 최대한 따른다 | 독창적 네비게이션은 목표가 아니며, IA 차이가 '토스쇼핑 유사 환경' 판단을 깨뜨림 |
| 상품 3개(전부 모니터)로 Commerce UI 검증이 충분하다 | 기존 fixture 보존 + 25개 Demo Catalog 추가 완료(04-B, 2026-10-08) | 카테고리 레일·추천·특가 등 Home merchandising을 실제 데이터로 검증 불가 |
| 홈의 AI 진입 카드가 merchandising 영역을 대신한다 | merchandising block(프로모/특가/추천/기획전/배너)을 demo/static UI로 별도 재현. AI 진입점은 유지하되 홈 중심 대형 카드의 위치·형태는 미확정 — 04-C Home 재구성에서 Toss IA·merchandising을 깨지 않는 곳으로 결정 | merchandising 밀도가 토스쇼핑 홈의 핵심 시각 특성 |
| 개별 컴포넌트 유사도가 화면 구조보다 우선이다 | 화면 단위 IA·콘텐츠 밀도·수직 구조의 재구성이 우선 | 색상/컴포넌트가 유사해도 화면 전체 인상이 다르면 목표 미달 |
| Brain 개발이 현재 우선순위다 | Commerce Environment(로드맵 04~09) 완성 후 Brain(11~12) | Brain 검증 환경이 먼저 실제 서비스 수준이어야 함. 기존 Tool Registry·Stub·Backend는 보존하되 Brain 완성으로 간주하지 않음 |
| 04 홈·검색·목록 1차 구현이 최종 완료다 | 기능적 1차 구현만 완료. Visual QA 목표 미달이므로 04 Toss Shopping Shell은 진행 중 **[Superseded 2026-10-11: 04-A~04-E 전부 완료로 04 Shell 완료 확정]** | 390×844 실제 비교에서 구조적 유사성 부족 확인 |

연결 계획(계획만, 미실행) 및 04-B 구현 결정(2026-10-08):

- **Demo Catalog(04-B, 방향 승인됨 — 세부 구현은 제안 후 승인):** 디지털/가전·패션·뷰티·생활·식품 카테고리 약 20~30개. 단순 화면 채우기가 아니라 이후 Shopping Brain이 사용할 데이터다. 상품 필드: category·image·정가/판매가·할인율·배송 정보·구조화 스펙·variants·재고/품절·rating·표시용 리뷰 수·실제 샘플 리뷰 텍스트·merchandising section tag(recommended/flash-sale/popular/new 등). 정합성: 상세 가격↔Cart/Checkout 서버 가격 일치, 옵션/재고는 실제 Backend 계약 연결, rating·review count 산출 방식 명시, 표시용 리뷰 수와 실제 리뷰 행 수가 다르면 명시적 모델링, 없는 리뷰를 Brain이 존재한다고 인식하지 않게 한다.
- **Fixture 보호(04-B, 완료):** p-a/p-b/p-c·V-A-24/V-A-27·모든 기존 테스트 기댓값 불변(검색 '모니터'=3건, 가격 필터={p-a,p-b}, 리뷰 수 등). 분리 방식 = 파일 분리(db/seeds/demo-*.json) + seed.ts `--demo` 플래그로만 적재 — phase SEEDS에 넣지 않아 `setupTestDb`·eval 등 모든 테스트 경로와 구조적으로 분리. `commerce_test`에 데모가 없음을 단정하는 회귀 assertion을 t1-catalog에 추가. 네임스페이스 reconcile: seed에 없는 p-d-*/v-d-*/r-d-* 행을 FK 순서로 정리, order_items가 참조하는 variant는 삭제 대신 active=false로 보존(멱등).
- **Demo Catalog(04-B, 2026-10-08 구현 완료):** 25개 데모 상품(디지털7·뷰티7·패션4·리빙4·식품3) + 55 variants + 80 합성 리뷰를 `db/seeds/demo-catalog.json`/`demo-reviews.json`으로 추가. 카테고리는 상위 그룹만 사용하고 fixture `monitor`는 변경하지 않음 — `src/web/display-meta.ts`의 CATEGORY_GROUPS가 UI '디지털'에 묶는다. 정가·배송 라벨·섹션 태그·스펙 한글 라벨은 DB가 아니라 display-meta(PRODUCT_META·SECTION_LABEL·SPEC_LABEL)에서 관리(migration 없음). 실제 가격·재고·주문은 서버/DB가 정본. review_count_display는 쓰지 않음 — 표시 수·평점은 실제 reviews 행 기준. 상품 이미지는 생성 webp(`/assets/products/p-d-*.webp`, 25장) 커밋, 실제 상표·쇼핑몰 이미지 미사용.
- **Personalization:** 'OOO님을 위한 추천'은 초기 static/demo → Brain 구현 후 교체 가능한 구조.
- **Theme override(제안·미구현):** 개발/QA용 `?theme=light|dark|system`. 사용자용 수동 토글은 없음.
- **재구현하지 않는 것:** 토스 브랜드 자산(로고·전용 폰트·아이콘 원본·문구), 오늘의 뽑기/스크롤하기/포인트 피드/미니맵 등 Brain 무관 기능, 판매자센터·실제 정산.

2026-10-10 · PM/QA 운영 정책 (PMQA-04C-VERIFY-001 / PMQA-GIT-POLICY-20261010)

| 항목 | 결정 | 근거 |
| --- | --- | --- |
| 역할 분담 | Main SWE Thread(코드·테스트·문서·로컬 커밋 전담) / PM Thread(읽기 전용 독립검수·지시·회수) | 사용자 운영 결정 — PM 검수와 사용자 승인은 별개 게이트. 04-C 최종 Visual 승인자는 사용자 |
| 원격 저장소 접근 [Superseded: '로컬 git 인증/fetch 우선' 해석] | 원격 조회·Push는 연결된 hongbinwee GitHub 커넥터를 우선하고, 불가능하면 구체적 제약·대안을 보고한다. 로컬 인증 재설정(PAT/SSH/GCM) 시도와 project99hong-ai 계정 접근은 하지 않는다 | PM이 커넥터로 실제 원격 main=689c126을 직접 확인. 로컬 GCM은 유효 자격 없고 gh는 무권한 계정 — 단 '로컬 원격 작업 절대 금지'가 아니라 우선순위와 보고 경로의 문제로 기록한다 |
| Push 판정 | branch ref 이동만으로 Push 성공이라 하지 않는다 — 실제 commit/tree/blob 객체의 원격 도달과 로컬/원격 HEAD 일치를 확인한다 | PMQA-GIT-POLICY-20261010 |
| Integration 판정 구분 | 개별 assertion PASS 수와 runner 전체 정상 종료 PASS를 구분해 기록한다 | VERIFY-001(2026-10-10)에서 suite runner가 개별 64/64 PASS 후 최종 요약 없이 종료되지 않고 잔존(hang)해 수동 종료했던 증상. 원인 확정: t1-cart.test.ts의 두 suite가 각각 ensureTestDb→connectDb를 호출하고 tests/helpers/testdb.ts가 이전 pool을 종료하지 않아 첫 pool이 누수 — FIX-002(2026-10-10)에서 ensureTestDb가 connectDb 덮어쓰기 전 `sql?.end()`로 이전 pool을 종료하도록 수정, 이후 Integration 64/64 PASS+runner 정상 종료 확인. '개별 PASS 수'와 'runner 정상 종료'를 구분해 기록하는 원칙은 유지한다 |
| 카드 합성 신호 표기 | SYNTHETIC 조회수·최저가는 화면에 '데모' 배지로 출처를 표시한다 | 사용자 C안 승인(2026-10-09) — 근거 없는 통계를 실측처럼 보이게 하지 않는다 |

2026-10-10 · GitHub Push 승인 정책 갱신 (사용자 표준 GitHub 운영정책 — PMQA-04D-NAV-001 지침으로 전달)

| 항목 | 결정 | 근거 |
| --- | --- | --- |
| Push 승인 게이트 [Superseded: '모든 GitHub Push는 매회 별도 사용자 승인'] | 승인된 프로젝트 범위의 일반 개발 마일스톤 Push는 PM 독립 QA 통과 후 오케스트레이션이 기존 성공한 hongbinwee GCM 인증으로 정상 fast-forward Push한다(사전 허용). 매회 별도 승인 요구 정책은 이번 사전 허용으로 대체한다 | 2026-10-10 사용자 표준 GitHub 운영정책 확정. 단 force-push·이력 재작성·파괴적 변경·중요 scope 변경은 계속 별도 승인. Push 후 커넥터로 원격/로컬 full SHA 일치를 매회 검증하고 VERIFICATION_LOG에 기록. 도구 직접 승인요구로 승인 절차를 우회하지 않는다. 핵심 화면 Visual 승인·09 Freeze·DB·유료 API·scope 게이트는 그대로 유지 |

2026-10-10 · 04-D Navigation Reconstruction 결정 (PMQA-04D-NAV-001)

| 항목 | 결정 | 근거 |
| --- | --- | --- |
| 하단 네비 슬롯 매핑 | 토스 5슬롯 구조 유지: 홈→shop 루트 / 혜택→특가 탭 / 쇼핑→shop(active) / 증권→AI(AgentPanel) / 전체→메뉴 시트 | `home/01`의 5슬롯 구조 [Observed] + 우리 서비스에 없는 목적지(증권)는 프로젝트 핵심 진입(AI)으로, 메뉴는 구매 목적지 시트로 대체 [Project] |
| active 컨텍스트 | 쇼핑 내부 탭(특가 등) 진입 중에도 전역 active는 '쇼핑' 슬롯에 유지. 목적지 current는 `aria-current="page"`, 시트 토글은 `aria-expanded`로 구분하고 `.on`을 붙이지 않는다 | PM QA 피드백 — active 슬롯이 실제 컨텍스트를 반영해야 하며 시각 on과 aria 상태를 혼합하지 않는다 |
| 스크롤 숨김/복귀 | 딥스크롤 숨김 [Observed home/02] + 방향 인식 복귀(y>120 && 내리는 중→숨김, 올리는 중→복귀). 숨김은 `visibility:hidden`으로 포커스·a11y 트리에서도 제외 | 복귀 트리거 미관측 [Inferred→Project] |
| 뒤로가기 이력 판별 | history.state 마커(`{app,internal}`) — URL 문자열 비교나 history.length 추정 대신 엔트리 마커로 내부 이력을 확정. fallback은 `gotoReplace(BACK_PARENT)`로 단조 상승(parent→back 루프 방지). mount·hashchange 시 미마킹 엔트리를 `{app:1}`로 보정해 reload 후에도 복원 | PM 지침 — '실제 entry 근거' 필요, boolean·URL스택 초안 폐기 |
| 세션 복원 버그 수정 | GET /api/session은 `{ok,user}` 최상위 반환인데 기존 코드가 `r.data.user`를 참조해 reload 시 TypeError→blank. raw fetch+`j.user.display_name`으로 수정, catch 시 setChecked(true)로 복구 | PM 검수에서 확인된 기존 MAJOR — 04-D 범위 내에서 수정·e2e reload 회귀로 검증 |
| 신규 캡처 정책 | QA 비교본은 390×844 원본 두 화면이 잘리지 않는 높이의 캔버스/HTML 뷰 사용. 현재 1280×720 합성은 세로 이미지 하단(하단 네비)이 잘려 nav 나란히 비교 증거로 쓰지 않는다 — 04-E에서 보완 | PMQA-04D-CLOSE-002 검수 — iOS status/safe-area와 웹 viewport 차이도 명시 |

## 2026-10-11 · 05 구조 결정 연결 (PMQA-05-FIDELITY-FIX-029 검수 기반)

| 항목 | 결정 | 근거 |
| --- | --- | --- |
| 상세 하단 CTA 매핑 | Toss의 4분할 CTA를 그대로 만들지 않고 지원 3 CTA(장바구니 아이콘·옵션 선택·n원 담기)로 매핑한다. 찜 하트·공유 등 미지원 요소는 버튼으로 만들지 않는다 | [Project] 지원하지 않는 동작을 흉내 내지 않는 근거 없는 UI 금지 원칙 |
| 전체 cart 계약 보존 | can_checkout·checkout은 전체 장바구니 기준을 유지한다. UI 부분선택(항목 checkbox·선택 합계·전체 견적 동시 표시)은 허용하되 비전체 선택 시 주문 CTA를 disabled + 안내로 처리한다 — Backend 부분 주문은 여전히 제외 | 사용자 05 구조 요구 — UI 선택과 Backend 주문 범위를 구분해 혼동과 잘못된 결제를 막는다 |
| 리뷰 미지원 요소 정직 표시 | 사진 리뷰 그리드·작성자 표기는 지원하지 않는다. 리뷰는 flat list + 출처 칩(SYNTHETIC=시연/REAL=실사용)과 실제 저장 행 수만 표시하고, 평점은 전체 집계와 일치할 때만 노출한다. 내부 variant id는 사용자 옵션 라벨로 해소한다 | 존재하지 않는 리뷰 메타를 만들지 않는 정직 표시 원칙; PMQA-05 검수에서 내부 id 노출을 해소 요구 |
| MAJOR/MINOR 분리 | 구조적 결함(CTA 가림·리뷰 가시성·부분선택 구조·비교 캔버스 잘림)은 05 correction 안에서 해소한다. 배송 데모 표기의 줄바꿈·미세 서체/간격 등 표면 polish만 08 Final Visual Polish로 이관한다 | PMQA-05-FIDELITY-FIX-029 — 구조 이슈를 외형 수정으로 미루지 않는다 |


## 2026-10-11 · 05 카트 견적 패널·상세 위계 구조 결정 + 05 Visual 승인 기록[최신 지시로 보류 정정] (PMQA-05-FINAL-STRUCTURE-030)

| 항목 | 결정 | 근거 |
| --- | --- | --- |
| 카트 견적 패널 구조 | 고정 하단바를 Ref126 대응 접힘/펼침 견적 패널로 재구성 — 헤더(총 N건 결제 예상 금액+총액+chevron) → 구분선 → 상품 금액·배송비 행 → 전체폭 주문 CTA | 사용자 재개 MAJOR — 실제 Toss 카트 견적 화면 대응 |
| 견적 토글 계약 | 접힘/펼침은 표시 전용 — 카트 쓰기·선택·version 불변. button+aria-expanded/aria-controls(#cart-quote-rows)+키보드 토글. 표시 금액은 서버값(items_total_won/shipping_fee_won/total_won) 그대로, 클라이언트 재견적 없음 | 표시 상태와 Backend 상태 분리 원칙 — e2e가 토글 전후 GET 스냅샷 동일성·비-GET 0건을 검증 |
| 선택 subtotal 위치 | 선택 합계는 전체 견적과 섞이지 않는 보조 행(.cart-summary-count)으로 토글 위에 둔다 — 견적 행 내부에 넣지 않는다 | 부분 선택 시 주문 CTA disabled 정책과 일관 |
| 고정 패널 높이 패딩 | .cart-screen padding-bottom을 고정값 대신 ResizeObserver 실측 --bb-h로 유지 — 펼침·부분선택 안내·pending 안내로 패널이 커져도 마지막 카드/CTA 가림 방지 | 390×844·390×600 도달성 검증 |
| 상세 가격 위계 | 상품명 20px·할인율 15px 보조·판매가 26px 주강조·배송비를 서버값 .price-sub로 분리·info-rows 상단 8px 섹션 밴드·label-value inline 밀도 | Ref04 정보 위계를 반영한 [Project] 적응 — 8px 밴드는 Reference 실측이 아니라 프로젝트 채택값 |
| 미지원 문구 비추가 | Ref의 최대 보관 수량·보관 기간·멤버십 적립 등 미지원 문구는 추가하지 않는다 | 정직 UI 원칙 — 지원하지 않는 동작을 표시하지 않는다 |
| 데이터·범위 한계 분리 | 리뷰 사진·작성자·다중 이미지 갤러리는 실데이터 부재로 한계로 유지한다(08 MINOR 아님 — 허위 데이터로 만들지 않는다) | 데이터 계약 부재는 polish 이슈가 아니다 |
| nav 상태 차이 기록 | 스크롤 깊이에서 구현 nav floating vs Ref05 solid 차이는 관측 사실만 캡션에 기록(수치 단정 없음) — 전환 시점 미세 보정은 08 MINOR | PM 정정 — 미검증 수치 기록 금지 |
| 05 Visual 승인 [Superseded 이력 → 최신 승인 완료] | 032에서 '승인 보류'로 정정됐던 기록은, PM 채팅의 최신 사용자 명시 승인(05 최종 Visual QA 승인 + 6커밋 Push 범위 승인, 각각 별개 게이트)으로 Superseded — **05 최종 Visual 승인 완료(2026-10-11)** + PM 단건 Push(5414ee8, 원본 6커밋 FF, 원격 일치 확인)로 **05 완료 확정** | PMQA-05-CLOSE-PUSH-033 — 이전 보류·거부 기록은 사실 이력으로 보존 |

## 2026-10-11 · 06A 주문서·모의 결제·결제 완료 계약 (PMQA-06A-034/035 + CAPTURE-037)

06A에서 확정된 구현 계약. 기능 검증 완료 — 사용자 Visual 게이트는 미통과 상태로 별도 표기한다.

| 항목 | 결정 | 근거 |
|---|---|---|
| Checkout=현재 Cart 견적 / Complete=주문 스냅샷 | 주문서는 `/api/checkout/quote`의 현재 카트 실시간 견적(가격·재고 서버 검증)을 표시하고, 결제 완료·주문 상세는 confirm 시점 저장된 주문 스냅샷을 표시한다. image/product_id만 조회 시점 카탈로그 LEFT JOIN. | 스냅샷 정합 — 이후 카탈로그·가격 변경이 확정 주문 기록을 바꾸지 않는다 |
| 동의 checkbox 없음 | Ref의 개인정보 동의/포인트/쿠폰/멤버십 문구는 미지원 업무이므로 checkbox·수집 UI를 만들지 않고 '모의 결제 — 실제 결제는 발생하지 않아요' 안내 블록만 표시한다. | 미지원 동작을 표시하지 않는 정직 UI 원칙 |
| OrderComplete paidOk 4조건 | '결제했어요' 성공 구조는 status=CONFIRMED && payment.status=PAID && paid_amount_won=total_won && !cancel_request일 때만. 취소 요청 접수/완료 주문은 별도 상태 라벨로 전환한다. | 신규 결제 외 상태를 성공으로 오인시키지 않는다 |
| STALE_QUOTE 서버 가드 | 견적 만료·카트 버전 변경·구성/수량/가격·옵션 변경 시 서버가 STALE_QUOTE+REFRESH_AND_RECONFIRM으로 거절한다(src/checkout.ts:101-139). 클라이언트·LLM 판단이 아니라 서버 확정 규칙. | 비즈니스 규칙의 서버 단일 정본 |
| CHECKOUT pending kind 격리 | CHECKOUT intent는 listCartPending에 노출되지 않고 listPendingByKind("CHECKOUT")만 본다. AMBIGUOUS→intent 유지+복구 스트립, 확정 거절→intent 해제. action 조회 키는 'ui-'+uiKey. | 카드 소비자와 결제 복구 책임의 분리 |
| cart PATCH expected_variant_version 필수 | cart 수량 변경은 expected_variant_version 서버 필수 계약이다(src/cart.ts — 불일치 시 VERSION_CONFLICT/REFRESH_AND_RECONFIRM). 미포함은 호출자 결함이지 제품 결함이 아니다. | 037 S2 스크립트 결함의 근원 — 제품/스크립트 결함 구분 |
| 미완 상태 캡처 실행 원칙 | scratch DB(commerce_demo_verify) 전용 + cart/모의주문 누적 max3 + confirm 예약 카운트 + SAFETY 즉시 중단(예상 외 주문·confirm 성공 시 정리 없이 중단) + 실행별 facts 별도 파일. 검증 필드 해시로 사후 동일성 실증(전체 DB 동일 단정 금지). | 사용자 승인 범위·기존 데이터 보존·증거 분리 |

## 2026-10-11 · PMQA-040 — scratch DB 수명주기 정책 (040-A 확정)

commerce_demo_verify 소실 사고(VERIFICATION_LOG PMQA-040-SEED-SAFETY) 이후 확정된 테스트 DB 정책. 구현은 `tests/helpers/scratch-db.ts` + `tests/integration/demo-seed.test.ts` 전체 skip + `tests/unit/scratch-db.test.ts`.

| 항목 | 결정 | 근거 |
|---|---|---|
| scratch 수명주기 전담 계층 | DB 생성·삭제는 `createOwnedScratchDb` 경유만. 테스트 파일의 ad-hoc admin DROP/CREATE는 금지 | 고정명 FORCE DROP이 보존 DB를 지운 사고의 직접 원인 |
| 소유 증거 3중 검증 | DROP 조건 = pg_database OID+datdba 일치 AND current_database()==이름 AND _scratch_owner.run_id==이 실행 runId. marker 단독은 불충분 — 같은 이름으로 재생성된 다른 DB를 구분 못 한다 | PM 리뷰 — marker만으로 DB identity 불변 보장 불가 |
| opt-in 게이트 | `SCRATCH_DB_TESTS=1` 없으면 connect 자체를 하지 않는다(생성·cleanup 양쪽, connect 전 검사). 기본 npm test/verify 경로에서는 관련 테스트가 skip | 사고는 일반 integration 실행 중 발생 — 무의식 실행 차단 |
| 이름 정책 | 무작위 `scratch_<16hex>`만. 고정명·재사용·보호 DB명·기존 DB 충돌은 전부 거부 | 고정명이 곧 보존 대상과 충돌했다 |
| adminUrl query 금지 | `?database=` 등 query 포함 adminUrl은 connect 전 거부(조용한 무시도 금지). 대상 URL은 query를 버리고 접속 후 current_database() 재확인 | postgres.js ?database= 우회의 이중 방어 |
| DROP 형태 | `DROP DATABASE <name>` — IF EXISTS·FORCE 없음. 열린 연결이 남으면 실패하고 fail closed | IF EXISTS는 대상 부재를 숨기고 FORCE는 다른 사용자 연결을 끊는다 |
| runId 생성 | 함수 내부 randomUUID()만 — 호출자·env 입력 경로 없음 | 외부가 marker를 맞춰 소유권 검증을 우회할 수 없다 |
| seed --demo 허용 목록 | `DEMO_DBS = commerce, commerce_demo_verify` 유지 — `scratch_*` 확대 금지. 미래 격리 테스트는 '검증된 scratch_*만 허용'하는 좁은 조건을 seed.ts에 별도 추가 후 demo-seed.test.ts 재활성 — **미확정·미승인 제안**(확정 정책 아님) | 허용 목록 확대는 test DB 오염 경로를 다시 연다 |
| 실패 시 기본값 | 생성 후 단계 실패·identity 변경·증거 부족은 전부 fail closed — 지우지 못해 남는 쪽을 선택 | 잘못 지우는 비용이 잔여 scratch 비용보다 크다 |

## 2026-10-11 · PMQA-046-A — restricted reset·캡처 증거 안전 보완

| 항목 | 결정 | 근거 |
|---|---|---|
| reset mutation 진입점 | restricted reset의 공개 실행 entry는 `restrictedE2EReset(db)`다. 고정 승인 043 dump의 단일 Buffer를 SHA 검증한 뒤 그 바이트에서 보호/삭제 baseline을 파생하고, transaction helper는 private로 둔다. 호출자 제공 baseline·test-only 우회 옵션은 허용하지 않는다. | 승인 기준과 실제 비교 기준의 분리·우회 방지 |
| 삭제 전 행 검증 | 잠금 후 첫 DELETE/UPDATE 전에 전체 삭제 대상 70행(승인 주문 13 + 직접 종속 57)의 전체 JSON을 승인 baseline과 정확 비교한다. 보호 행도 같은 baseline의 전체 행과 비교한다. 하나라도 다르면 write 0건으로 abort한다. | 건수만 맞는 변경/추가 행이 삭제되는 것을 방지 |
| 캡처 산출물 | 캡처는 매 실행 UUID 하위 디렉터리를 배타 생성한다. 재사용/덮어쓰기를 허용하지 않으며, 경로 예약 성공 전에는 테스트의 앱/API 동작을 시작하지 않는다. import 및 `--list`는 출력 경로를 만들지 않는다. | 기존 evidence 보존 및 부수효과 순서 보장 |
| approved dump 테스트 의존성 | 정확 baseline DB-free unit은 로컬 gitignored `shots/06a/pmqa043/commerce_test_prdump.sql`을 필요로 한다. 다른 checkout에 존재한다고 가정하지 않으며, dump를 Git에 포함하거나 파일 부재를 이유로 해당 테스트를 skip하지 않는다. | 증거의 비공개·비변조 보존, 기준 부재 시 명시적 실패 |
| 06A 재개 경계 | `commerce_demo_verify` 재생성·모의 주문 재생성은 금지 상태로 유지한다. 새 DB-free 보완만 진행하며 전체 기술 검증 미완료·06B 차단을 유지한다. | 06A 임시 DB 삭제 사고 후 최신 오케스트레이션 제한 |

## 2026-10-11 · PMQA-041 — 06A Visual 게이트 결과 + 확정 반응형 정책

| 항목 | 결정 | 근거 |
|---|---|---|
| 06A 사용자 최종 Visual QA | 승인 — 화면 게이트만 통과이며 06A 전체 완료·기술 QA 승인이 아니다. 위 06A 섹션의 'Visual 미통과' 기록은 Superseded | PMQA-041 사용자 결정 — PM 040 비교본 검수 경유 |
| 전체 회귀 상태 | CONDITIONAL 유지 — 최신 전체 실행 36/1/32 FAIL. fixture 복원+표준69 재실행은 별도 사용자 승인 pending(PM 질문 제출·답변 대기) | 새 통합 PASS로 기록 금지 |
| Visual 비실패 계약 | 상품·가격·iOS 크롬·미지원 쿠폰/포인트/ETA/주소 변경 차이는 실패로 취급하지 않고 허위 데이터 생성 금지. 작은 스타일 차이는 08 이관. 주문서 p-a/183,000과 완료 ord-c0bdcc4d/152,000은 서로 다른 fixture — 연속성 증거 아님 | PMQA-041 |
| 반응형 정책 | 06~07 모바일 우선(390×844 기준, 다른 너비 깨짐 예방만). 08에서 핵심 전 화면을 360×640/390×844/768×1024/1440×900 검증 — 모바일 유동폭·태블릿 모바일구조+max-width·PC 중앙 모바일 컨테이너·필수 정보 숨김 금지. 09 Freeze 전 3폼팩터 사용성 확인. PC 다열·Brain 패널·비교 레이아웃은 09 이후 향후 검토만 | PMQA-041 확정 · 상세는 COMMERCE_UI_SPEC §10 |
| 06B 진입 조건 | 기술 회귀 통과 + DB 안전성 + 최종커밋 독립검수 + PM FF Push 확인 전까지 금지 | PMQA-041 |
