# 프로젝트 컨텍스트 — 목표·방향·로드맵

## 최신 결정 (2026-10-14 · Commerce checkpoint 기준) — 최상위 우선

> 이 블록이 아래의 2026-10-07 절을 포함한 모든 오래된 문서보다 우선한다.

### 현재 체크포인트 상태 (2026-10-14)

> 이 상태 블록은 아래 로드맵의 과거 `04-C/04-E 완료`·`06 진행` 표기와 예전 검증 이력보다 우선한다.

- 현재 작업은 `checkpoint/commerce-20261014` 브랜치의 WIP 통합 체크포인트다. Commerce 구매자 UI와 API는 구현 변경이 누적됐지만 전체 통합 검증과 사용자 Visual 승인은 끝나지 않았다.
- 최신 고정 Suite `shots/isolated-suite/run-4a9d070d-80ef-44c9-84d3-00fad1cd0a74/` 결과: E2E 73개 중 52 PASS, 5 FAIL, 16 미실행. Integration은 E2E 실패로 시작하지 않아 **NOT_RUN**이며 전체 Suite PASS가 아니다.
- Preview는 이전에 `READY` 응답을 냈으나 현재 서버는 꺼져 있다. Preview DB와 실패한 Suite DB는 보존 중이며 scratch 생성 상한 2/2를 사용했다. 새 scratch 생성·재시드·migration 재실행은 허용하지 않는다.
- 이전 PMQA-079 인증 판정은 새 파일 기반 자격의 양쪽 DB 연결 및 wrong/missing-password 거부를 확인한 범위다. **기존 암호 전용 거부 검증은 NOT_RUN**이다.
- 과거에 명시적으로 승인된 04-C/04-E/05/06-A/06-B 화면은 당시 승인 상태를 유지한다. 이후 Product Card·구매 화면 변경분은 영향을 받는 최신 화면만 재확인이 필요하며, 이는 기존 승인을 일괄 취소한다는 뜻이 아니다. 06-C 최종 확인은 보류 중이고 전체 구매 여정 Visual QA는 아직 승인되지 않았다.

- **1단계 — Toss Shopping 구매자 UX/UI·핵심 쇼핑 기능의 충실한 재현이 최우선.** `reference/toss-shopping/` 실제 캡처를 최우선 Reference로 IA·콘텐츠 밀도·컴포넌트·Interaction을 유사하게 재현한 Commerce Environment를 먼저 완성한다.
- **2단계 — 그 위에 Shopping Brain / CS Brain을 결합한다.** Brain 자체가 목적이 아니라, 실제 Commerce 환경 위에서 동작하는 Brain의 검증이 목적이다.
- **현재 위치**: 06 진행 중. 09 Commerce Environment Freeze는 유지 중인 로드맵 목표이며 아직 완료되지 않았다. 10~13(Brain Architecture → 배포·실사용자)은 이후 단계다.
- 일반 핵심 쇼핑 기능은 Reference 충실 재현을 위해 **구현이 기본**이다 — 단순화·생략은 명시 승인이 필요하다.
- 허위 혜택·배송 약속 금지 — 근거 없는 적립·최저가·도착 예정·판매량·조회수 등을 만들지 않는다.
- 실DB·실API·브라우저·e2e·Integration·commit·Push 등 실제 실행은 건별 별도 승인이 필요하다. **보존 문서의 일반적인 push 허용 문구는 이후 특정 승인('commit/Push 금지')을 해제하지 않는다.**

## 현재 프로젝트 방향 (2026-10-07 확정) — (일부 Superseded: 최상단 '최신 결정' 블록이 우선)

> 이 절이 다른 오래된 문서와 충돌하면 이 절을 따른다. (Superseded — 2026-10-13 '최신 결정' 블록이 이 절을 포함한 모든 문서보다 우선한다) 아래 '주제 선정 배경'은 2026-10-03의 역사 기록이다.

**최상위 목표:** 현실적인 Commerce 환경에서 동작하는 Shopping Brain / CS Brain을 구현·검증한다. 토스쇼핑 복제 자체가 목적은 아니다(단, 1단계에서 구매자 UX/UI의 충실한 재현은 최우선이다 — 최상단 '최신 결정'). Brain이 실제 서비스 수준의 쇼핑 환경 위에서 상품 탐색·조건별 추천·리뷰 비교·옵션 선택·장바구니 조작·주문 조회·배송 설명·취소 지원을 수행해야 하므로, **충실한 Commerce Environment를 먼저 구축하고 그 위에 Brain을 결합한다.**

### 방향 변경 배경

초기 전략은 "핵심 구매 기능 + 주문/배송/취소 Backend + AI Tool interface + 간소화된 쇼핑 UI"로 Brain 실행 환경을 먼저 검증하는 것이었다. Backend(카탈로그·카트·주문·결제·배송·취소, Tool Registry, Guardrail, 멱등성, 평가)는 이 방향으로 Phase 0~5까지 로컬 구현·검증이 완료됐다(live LLM eval·외부 배포·실사용자 검증은 미완료 — 로드맵 12~13).

그러나 실제 화면을 사용해 본 결과 Frontend가 토스쇼핑의 구매 환경과 너무 달랐다 — 상품 3개·단일 카테고리라 콘텐츠 밀도가 없고, merchandising/프로모션 구조가 없으며, Header·Search·Navigation의 Information Architecture가 실제 앱과 다르다. 앱을 처음 열었을 때 '토스쇼핑을 참고한 서비스'라는 인상이 나지 않았다. 너무 단순한 데모 쇼핑몰 위에서는 "실제 Commerce 환경에서 동작하는 AI Agent"를 증명하기 어렵다고 판단해 방향을 수정한다.

- **이전:** 토스 디자인 언어를 참고한 간소화된 AI Commerce 데모
- **현재:** `reference/toss-shopping/` 캡처를 최우선 Reference로, 화면 IA·콘텐츠 밀도·Navigation·상품 그리드·상세·리뷰·옵션·카트·주문·배송·취소의 구조와 Interaction을 유사하게 재현한 Commerce Environment 선행 구축

### 무엇을 구현하고 무엇을 생략하는가

- **실제 Flow로 동작해야 하는 핵심 Commerce 기능:** 검색, 카테고리/상품 탐색, 상품 상세, 리뷰, 옵션, 장바구니, 주문/모의 결제, 주문 내역, 배송, 취소.
- **구현하지 않는 Brain 무관 사업 기능(영역 D):** 오늘의 뽑기, 스크롤하기, 포인트 피드, 미니맵, 게임성 요소, 판매자센터, 실제 정산 — 기능과 데모 UI 모두 만들지 않는다. 단, 해당 영역의 시각적 slot이 Home 구조 재현에 필요하면 구매 관련 shortcut으로 대체할 수 있다(기능 자체는 구현하지 않음). 영역별 분류는 docs/COMMERCE_UI_SPEC.md §4-1의 A/B/C/D 매핑을 따른다.
- **구조 재현 + 구매 목적지 대체(영역 B):** Toss Home의 shortcut/navigation 중 프로젝트 목적과 직접 연결되지 않는 목적지는 같은 화면 구조를 유지하면서 카테고리·특가·인기 상품·주문·추천 등 구매 관련 목적지로 대체할 수 있다.
- **demo/static으로 재현하는 영역(영역 C):** Home의 시각 구성에 필요한 프로모션·특가·추천·기획전·배너 등 merchandising block — 실제 Backend 없이 시드 데이터로 표현한다.
- 원칙: *시각적 쇼핑 환경과 구매 경험은 최대한 충실히 재현하되, 프로젝트 목적과 무관한 사업 기능까지 구현하지 않는다.*

### Demo Catalog 방향 (계획 — 04-B에서 승인 후 실행)

현재 상품 3개(전부 모니터)는 레퍼런스급 홈·검색·카테고리·추천 UI를 검증하기에 부족하다. 디지털/가전·패션·뷰티·생활·식품 등 약 20~30개 상품을 추가하는 방향은 확정됐다. Demo Catalog는 단순 화면 채우기가 아니라 이후 Shopping Brain이 사용할 데이터다. 상품은 필요에 따라 다음을 지원한다: category·상품 image·정가/판매가·할인율·배송 정보·구조화된 specifications·variants·재고/품절 상태·rating·표시용 리뷰 수·실제 샘플 리뷰 텍스트·merchandising section tag(`recommended`/`flash-sale`/`popular`/`new` 등). 추천 엔진 없이 section tag 기반으로 Home merchandising을 구성한다.

**Fixture 보호(04-B 선결):** 기존 p-a/p-b/p-c·V-A-24/V-A-27과 기존 회귀 테스트는 반드시 보존한다. 단, 기존 ID만 유지한다고 테스트가 보호되지는 않는다 — 기존 테스트가 검색 결과 개수·가격 조건 결과·특정 상품 집합을 고정값으로 가정할 수 있으므로, **deterministic fixture와 Demo Catalog를 분리하는 구체안을 04-B 시작 전에 제시하고 승인받는다.** 이 문서에서 분리 방법을 확정하지 않는다.

**정합성 원칙:** 상세 화면 가격과 Cart/Checkout의 서버 가격이 모순되지 않아야 한다. 옵션·재고는 실제 Backend 계약과 연결된다. rating·review count가 어떻게 계산되는지 명시한다. 표시용 리뷰 수와 실제 Brain이 읽을 리뷰 행 수가 다르면 그 차이를 명시적으로 모델링하고, 실제 없는 리뷰를 Brain이 존재한다고 인식하게 만들지 않는다. 정확한 schema/migration은 04-B 구현 전 별도 제안 후 승인받아 변경한다.

### Personalization과 Brain의 관계

홈의 'OOO님을 위한 추천 상품' 같은 영역도 초기에는 static/demo recommendation으로 둔다. Shopping Brain 구현 후 static → Brain 추천으로 교체할 수 있도록 구조를 유지한다. 기존 Tool Registry·Stub·Backend scaffolding은 보존하되 Brain 완성으로 간주하지 않는다.

### Theme

시스템 `prefers-color-scheme`에 따른 Light/Dark 자동 반영을 유지하고 수동 토글은 노출하지 않는다. 개발/QA 편의를 위한 `?theme=light|dark|system` override는 제안으로만 기록(미구현).

### 현재 로드맵

```text
01 Core Backend / Phase 5            ✅ 로컬 구현·검증 완료
                                     (live LLM eval·외부 배포·실사용자는
                                      로드맵 12~13에서 수행)
02 Commerce Audit                    ✅ 완료 (docs/COMMERCE_AUDIT.md)
03 Design System Foundation          ✅ 완료 (docs/COMMERCE_DESIGN_SYSTEM.md)

04 Toss Shopping Shell               ✅ 완료 (04-A~04-E 전부 완료)
   04-A 기본 Home/Search/List UI     ✅ 1차 기능 구현 완료 (Visual 목표 미달 — 아래 참조)
   04-B Demo Catalog Expansion       ✅ 완료 (seed safety correction 포함)
   04-C Toss Shopping Home 재구성    ✅ 완료 — 사용자 최종 Visual 승인 (2026-10-10)
   04-D Navigation 재구성            ✅ 완료 — PM 독립 QA PASS·Push·원격 일치 확인 (2026-10-10)
   04-E Screenshot / Visual QA       ✅ 완료 — 사용자 최종 Visual 승인 (2026-10-10)

   완료 조건 (04-E Visual QA — 주관적 '유사한 느낌'이 아닌 아래 절차로 판정):
   - 기준 viewport 390x844에서 실제 Toss Shopping Reference와 구현
     Screenshot을 나란히 비교한다 (첫 화면 + 주요 스크롤 구간 모두).
   - Header/Search·상단 Navigation·promotion/merchandising·
     recommendation 섹션·product grid·하단 Navigation을 영역별로 대조한다.
   - Light/Dark는 Reference가 관측된 범위에서만 비교한다(현재 캡처는
     전부 Dark — Light는 라이트 캡처 확보 전까지 제한적 검증).
   - 자동 테스트 통과만으로 완료 처리하지 않는다. 최종 승인자는 사용자.
   - 미세 1~2px·animation 차이는 08에서 보정하되, IA·section order·
     content density·navigation 구조가 Reference와 크게 다르면 04 미완료.

05 Product Detail / Review / Option / Cart   ✅ 완료 (2026-10-11, PMQA-05-CLOSE-PUSH-033 —
                                       사용자 최종 Visual 승인 + PM 단건 Push·원격 일치 확인)
06 Checkout / Payment / Order / Shipment / Cancel
                                       🟡 진행 중 — 06-A ✅ 완료 (PMQA-047-D 커밋 ca35a43 → PM 단건 Push·원격 일치 확인 → PMQA-047-E PM 최종 확정)
(커밋 ca35a43, PMQA-06A-034/035 + CAPTURE-037 + 040 보정 + PMQA-047 B1/B2/B3/D/E) — **사용자 06A 최종 Visual QA 승인(PMQA-041) 유지**
                                       PM 독립 판정 06A 로컬 기술 QA PASS → PM Push 검증 후 06A 전체 완료 확정. 이전 "36/1/32 FAIL"은 PMQA-047로 Superseded된 이력
                                       · 06-B 주문목록/주문상세/배송 — 구현 완료·기술 scoped PASS(readonly 22/22)·커밋 5755f27+97aa7ce PM Push·원격 일치. **사용자 Visual 승인 유지(PM 확정)**
                                       · 06-C 취소 단계/환불 — 코드 구현 + Luna correction#2 반영 완료(PMQA-060): DB-free unit 회귀 454/454·tsc·build exit 0. 실DB write·브라우저·Visual·표준 e2e·Integration·commit/Push 미실행 — PM/Luna 한정 판정: 소스+DB-free 근거 한정 PASS·actual UI/DB/Visual 미완료(이전 '06-C 착수 금지'는 승인 전 상태 이력)
                                        → PMQA-062 Mock 브라우저 검증 run-f5233cb1 **12/12 PASS**(네트워크 위반 0 · PMQA-061 readonly와 별도 검증) · PM 최종 분리 Visual 판정(run-d4210889) **FAIL — MJ062-VIS1 MAJOR**(Ref087/088/089 전용 fullpage 위계↔가변 시트)·**MN062-VIS1 MINOR**(상품 가격·수량 미표기) · Luna 별도 Visual MINOR · userVisual **PENDING**·Environment NOT_READY — UI 보정은 최신 승인 범위 밖이라 사용자 판단 대기(PM next-scope.md) · actual 취소/환불·standard69·integration NOT_RUN 유지
                                        → PMQA-063 취소 3화면 Visual Correction(사용자 승인 범위): CancelSheet를 `.cancel-overlay`/`.cancel-sheet` 전용 fullpage flex column으로 재작성(`.cancel-top` 표시줄·`.cancel-body`·`.cancel-cta` 단일 CTA — Backend·핸들러·상태머신·서버 정책 0, styles `.cancel-*` scoped 블록) + itemRows '단가 · 수량' 복원 + done '취소요청' 배지 · Mock 재검증 run-d827de0d **12/12 PASS**(네트워크 실패 17 = CDN 차단 11 + 주입 6, 위반·실서버 forward·PG 0) · check run-7737564b·build exec-9def9·unit run-26cb36bc **460/460** · 증거 baseline 1177/1177 SHA 동일 · 비교본 shots/pmqa063-compare/run-9e10ec79… · **PM 최종 한정 QA PASS(코드·Mock·구조 Visual PM/Luna 모두 PASS — MJ062-VIS1·MN062-VIS1 해소·open BLOCKER/MAJOR 0, 062 판정은 Superseded 이력)** · **userVisual PENDING**(사용자 최종 Visual 판단 대기) · MINOR 2건(MN063-1 LOST 하단 안내·MN063-2 미세 보정)은 08 이관 · actual Backend 취소/환불·standard69·integration·최신 readonly selector 회귀 NOT_RUN 유지 · 미커밋(commit/Push 금지 — PM 지시 대기)
                                        → **PMQA-065 A0 — 감사 P1 카피 정정 2건(2026-10-13, 구현·문서·DB-free 검증 완료 · PM 한정 PASS 확정 — 증거 1311/Backend18 불변)**: F21 특가 탭 허위 긴급 표현 폐기 — 자정 카운트다운·'오늘만 이 가격'·'실제 할인 상품만 모았어요' 제거 → '데모 특가' 표기로 실제 판매/기간 할인 암시 차단(Shopping.tsx) · F26 취소 안내 오인 문구 정정 — '접수되면 …환불 처리가 진행돼요' → '요청 접수는 취소·환불 완료가 아니에요. 취소 처리가 완료되면 환불 상태를 확인할 수 있어요'(+견적 유효 시각, CancelSheet.tsx · 서버 transition 자동화 추가 없음) · check run-5d1a9668 · build run-685b4150 · unit run-83f68c01 **460/460** exit 0(직전 run-d28ae0b3는 알려진 sandbox IPC hang으로 NOT_COMPLETE 원본 보존) · COMMERCE_UI_SPEC L41·§7-4 실구현 정합 정정 · 기존 승인 상태 유지(06C userVisual PENDING 그대로) · 미커밋(commit/Push 금지)
                                        · PMQA-054~057 QA·테스트 안전 인프라 — 커밋 75f2eef + PM Push·원격 검증 완료 · post-75 readonly22 PASS(PMQA-059 run-b7b6fe59, 22/22·drift 0) · **060 변경 반영 후 재검증 완료 — PMQA-061(run-61d8a457) 기존 readonly22 22/22 PASS**(두 DB 13테이블 동일·보호77/독립36·기존 증거1044→1064 신규는 readonly 산출20만·고정 source16 SHA 불변·Luna 독립 PASS — 06C Mock12인 PMQA-062와 별도 검증. 이전 '재검증 NOT_RUN'·'33파일 staged·commit 지시 대기' 기록은 Superseded). 전체 mutation pipeline READY 아님
                                        → **PMQA-066 제품 화면군 구현 + 읽기 검토 회귀 2건 수정(2026-10-13, DB-free 검증·미커밋 · 현재 단계: 06C/Fidelity 보완 중 · 07 대기)**: F04 정보 계층·F05 nav solid 임계·F18/F19 '옵션 한번에 보기' 시트·F08 리뷰 클러스터·F07 전체 리뷰 화면('/p/:id/reviews')·F32 이미지 뷰어 + 복귀 보존 'detail-resume'(계정·상품 스코프·isStale 미소비·OPTION_UNAVAILABLE/QTY_REDUCED 안내 — 조용한 교체 금지)·더보기 'review-pager' 공용 실행기(동기 잠금·stale 무변경·실패 보존) · spec 제목/선택자만 신규 계약 정정(실행 NOT_RUN) · check run-1943bda3·build run-ff5de457·unit run-950807e0 **474/474**(신규 detail-resume 9·review-pager 5 포함) · 실브라우저·실DB·standard e2e·Integration·Visual NOT_RUN · 미커밋(commit/Push 금지 — PM 회수 대기)
                                        → **PMQA-067 주문서 견적 출처 3종 + INVALID 실패 라우트 + 늦은 응답 가드(2026-10-13, DB-free 검증·미커밋 · PM 최종 판정: 정적+DB-free 한정 PASS)**: 견적 source는 CART_FULL(legacy 전체)/CART_SELECTED(선택 부분집합 Ref073)/DIRECT(바로구매 Ref04) 3종 — INVALID는 source가 아니라 frontend 파싱 실패 라우트 · POST /api/checkout/quote·v2 토큰 source 정합·v/source 없는 구형 카트 견적은 필수값 검증 후 CART_FULL 해석·DIRECT는 carts/cart_items SQL 0 · 상세 하단 바 [카트][담기 ghost][구매하기 primary]로 재구조·옵션 진입은 .optline 행 · checkout-guard 신규(OpCtx seq+scope+target·boundFor unbound 미발급·늦은 응답=상태/intent/이동 불변·intent 보존) · checkPending/retryPending 선검증 · Luna 정적 MAJOR 해소(cartWrites regex U+0008 오염 → 토큰 검출 + 자체 회귀 테스트) · check run-2ba4c45d·build run-25ef1609·unit run-ed0040a3 **517/517**(run-c8624892 hang = NOT_COMPLETE 보존) · **PM 최종 판정(2026-10-13): 코드/테스트 SHA·run 결과 PM 직접 대조 → PM·Luna 정적 및 DB-free 회귀 범위 PASS·열린 BLOCKER/MAJOR 0 · 기존 보호 1311파일 변경/누락 0 재확인 · code067 15파일 freeze** · 실DB·API·브라우저·standard e2e·Integration·Visual 전부 NOT_RUN(실제 통합 검증·전체 READY 판정 아님) · 06C 최종 userVisual PENDING · 미커밋(commit/Push 금지) · 사고 기록: shots/pmqa067-review/run-71a3fc81-62eb-4918-a0c1-b597f884082f/incident-browser-scope.md(원본 동결 — 미승인 headless Chromium 실행·PNG4 생성·API/DB접속0·덮어쓰기0은 NOT_PROVEN) · 이전 'PM/Luna 재검수 대기·PASS 단정 아님'은 판정 통보 이전 시점 이력으로 Superseded
→ **PMQA-070 찜(Wishlist) 실구현(2026-10-13, 코드·migration 004 작성 완료 · DB-free unit 602/602 · 미커밋)**: GET/PUT /api/wishlist·찜 탭/하트/저장 시트·cart actor 소유화 — 실DB 적용·실API·브라우저 통합·Visual 미검증. 설계 docs/wishlist-design.md · 진행 IMPLEMENTATION_PROGRESS §C/070 · **PM 최종 판정: 정적+DB-free 한정 PASS**(shots/pmqa070-final/run-4d7b54ed-… — 열린 B/M 0·실DB/브라우저/Visual NOT_RUN 유지)
                                       · 미검증 유지: Integration NOT_RUN·실DB rollback 오류 주입·09용 non-portable infra — PM049 추가: Integration/verify/eval은 보존 commerce_test 실행 불가(seed upsert·비구분 clean·TEST_DB_URL 고정), 09 전 테스트 격리/보호 지문/rollback fault 검증 해소 필수
07 Full Buyer Journey QA
08 Frontend Final Visual Polish
   (전체 화면 연결 후 필요하면 더 강한 모델로 typography/spacing/
    visual hierarchy/interaction/responsive/screenshot fidelity 보정.
    **[041 확정 반응형]** 핵심 모든 화면(홈/검색/상세/리뷰/옵션/카트/주문서/완료/주문내역/배송/취소)을
    360×640·390×844·768×1024·1440×900에서 검증 — 고정CTA/시트/모달/스크롤/이미지/금액/가독성·접근성.
    모바일 유동폭 + 태블릿 모바일구조·max-width + PC 중앙 모바일 컨테이너. 필수 기능·정보 숨김 금지.
    PC 다열/Brain 패널/비교 레이아웃은 09 이후 향후 검토만 — 현 범위 아님·Toss PC 재현 아님)
09 Commerce Environment Freeze — **[041] 선행 조건: 모바일/태블릿/PC 사용성 확인**
10 Brain Architecture 팀 논의
11 Shopping Brain / CS Brain 구현
12 Brain Integration / Evaluation / Guardrail
13 Deployment / Real User Testing / Feedback
```

### 운영 · 협업 정책 (2026-10-10 사용자 확정)

- **역할:** Main SWE Thread(구현 담당, id 01a102aa-2504-7601-a65e-9bae83c98b64, host local, cwd C:\문서\codyssey_final)가 코드·테스트·문서·로컬 커밋을 전담한다. PM/QA Thread(오케스트레이션·독립 검수, id 01a11e9e-bb68-7cc3-9ed2-34a4c3fe94de)는 읽기 전용 검수와 지시·회수(wait_threads/read_thread)를 담당하며, 예외적으로 **승인된 일반 마일스톤의 GitHub Push와 원격 SHA 검증**도 수행한다(2026-10-10 사용자 표준 GitHub 운영정책 — PM은 코드·DB를 수정하지 않는다). 최상위 Goal(로드맵 09까지)은 오케스트레이션 Thread에만 설정돼 있으므로 이 Thread에 중복 Goal을 만들지 않는다.
- **승인 게이트:** 04-C는 사용자 최종 Visual 승인 후 04-D로 진입한다. 그 외 확정 범위의 구현·수정·검증·로컬 커밋은 PM 검수 후 순차 진행한다. 사용자 승인이 필요한 것은: 핵심 화면의 최종 Visual QA, 중요한 DB schema/파괴적 데이터 변경, 유료 API 사용, 큰 scope 변경, 09 Commerce Environment Freeze 최종 승인. **GitHub Push(일반 마일스톤)는 PM 독립 QA 통과 후 오케스트레이션이 기존 성공한 hongbinwee GCM 인증으로 정상 fast-forward Push하도록 사전 허용됐다(2026-10-10 사용자 표준 GitHub 운영정책) — 매회 별도 승인이던 이전 정책은 Superseded.** 단, force-push/이력 재작성/파괴적 변경/중요 scope 변경을 동반하는 Push는 계속 별도 승인이며, Push 후 원격·로컬 full SHA 일치를 커넥터로 매회 검증하고 VERIFICATION_LOG에 기록한다.
- **live eval 위치:** LLM_API_KEY 미설정으로 live eval이 BLOCKED 상태인 것은 로드맵 10~13 Brain 범위의 기존 제한이다. 04-C나 09 승인이 LLM 키를 요구하는 게이트가 아니다.
- **서브에이전트·다른 모델 활용(2026-10-11 확정):** 같은 원인으로 반복 차단되면 다른 모델(예: Luna)의 독립 분석을 우선 활용한다. 위임 시 맥락·기존 승인 범위·거부 로그·DB 보호 조건을 함께 전달한다. 역할은 분석·read-only 검토·safe-code·QA까지 가능하나, 파일과 DB의 writer 책임은 사전에 분리한다(이번 PMQA-046 선례: Main=유일 writer / Luna=read-only / PM=최종 QA·Push). 사용자 또는 auto-review가 명시적으로 거부한 동일 작업을 에이전트를 바꿔 우회하는 것은 금지한다. 서브에이전트 활용 자체가 새로운 승인 범위를 부여하지 않는다. 이 정책은 로드맵 09까지 전체에 적용한다.
- **GitHub 접근:** 저장소 hongbinwee/codyssey_final-mission의 원격 조회는 **연결된 hongbinwee 계정의 GitHub 플러그인/커넥터를 우선**한다. Push 실행은 PM(오케스트레이션)이 기존 로컬 hongbinwee GitCredentialManager 인증 경로로 수행한다(04-C 배치에서 정상 동작 확인, 2026-10-10). project99hong-ai 계정으로 저장소에 접근하지 않고, 인증 재설정(PAT/SSH/GCM)을 시도하지 않는다. 커넥터가 불가능하면 구체적 제약과 안전한 대안을 보고한다(로컬 git 원격 작업의 절대 금지가 아니다). Push 시 branch ref 이동만으로 성공이라 하지 않고, 실제 commit/tree/blob 객체의 원격 도달과 로컬/원격 HEAD 일치를 검증한다(PMQA-GIT-POLICY-20261010).

### 문서 역할과 읽기 순서

새로 합류한 사람/AI는 이 순서로 읽는다.

| 순서 | 문서 | 역할 |
| --- | --- | --- |
| 1 | PROJECT_CONTEXT.md (이 문서) | 최상위 목표·왜 Commerce Environment를 먼저 구축하는지·로드맵·읽기 순서 |
| 2 | CORE_TASK_SCOPE.md | 현재 P0/P1 범위 — Commerce 핵심 기능과 생략 기능 |
| 3 | docs/COMMERCE_DESIGN_SYSTEM.md | Commerce UI 디자인 Source of Truth ([Observed]>[TDS]>[Inferred]>[Project]) |
| 4 | docs/COMMERCE_UI_SPEC.md | 화면별 Interaction/State/Backend 연결 기준 |
| 5 | docs/COMMERCE_AUDIT.md | 현재 구현 상태와 레퍼런스 대비 Gap |
| 6 | docs/IMPLEMENTATION_PROGRESS.md · docs/VERIFICATION_LOG.md | 실제 진행 단계와 검증 기록 |
| 7 | docs/IMPLEMENTATION_DECISIONS.md | 기술·방향 결정 이력, Superseded 목록 |
| 8 | SHOPPING_BRAIN_VISION.md | 장기 Brain 제품 비전 — **현재 구현 범위 아님** |

규칙: 같은 목적의 새 문서를 만들지 않는다. 방향·기술 결정은 IMPLEMENTATION_DECISIONS.md에 누적한다. 새 결정이 오래된 문서와 충돌하면 삭제하지 말고 Superseded 표시 후 정본을 가리킨다.

### Reference 자료 (Git 외 별도 자산)

- `reference/toss-shopping/screenshots/` — Toss Shopping 실제 캡처 130장(폴더별 분류)과 `docs/`의 분석 문서 5종. **스크린샷은 Git에 포함되지 않는 별도 자료**다(`.gitignore`, 약 79MB). 분석 문서는 커밋돼 있다.
- 새로 합류한 팀원/AI는 사용자에게 이 자료를 별도로 전달받아야 한다. 공유 저장소 위치는 **미정(TBD)**.
- **Reference 없이는 Visual Fidelity 작업을 완료로 표시하지 않는다.** 04-E Visual QA는 이 자료와의 나란한 스크린샷 비교를 전제로 한다.

### Superseded 결정 요약

근거 포함 상세는 [docs/IMPLEMENTATION_DECISIONS.md](docs/IMPLEMENTATION_DECISIONS.md)의 '2026-10-07 방향 재정립' 절:

- ~~Toss Navigation을 프로젝트용으로 단순화한다~~ → Navigation 구조·밀도는 레퍼런스를 최대한 따른다
- ~~상품 3개로 Commerce UI 검증이 충분~~ → 20~30개 Demo Catalog 확장 (04-B)
- ~~AI 카드가 merchandising 영역을 대신한다~~ → merchandising block을 demo/static으로 별도 재현
- ~~개별 컴포넌트 유사도가 화면 구조보다 우선~~ → Home 포함 화면 단위 IA·밀도 재구성이 우선
- ~~Brain 개발이 현재 우선순위~~ → Commerce Environment(04~09) 선행, Brain은 11~12
- ~~홈·검색·목록이 최종 완료~~ → 기능적 1차 구현만 완료, 04 계속 진행

---

## 주제 선정 배경 (2026-10-03 기록)

> 기록일: 2026-10-03. 출처: 사용자가 전달한 팀 회의 공유문과 토스 AI Engineer 채용 공고. 회의의 실제 날짜는 확인되지 않았다. 현재 기록은 주제 확정이나 팀원 전체의 동의를 의미하지 않는다.

## 회의에서 정한 목표와 기준

- 목표: 파이널 프로젝트를 통해 좋은 포트폴리오를 만든다.
- 역량 기준: 토스 AI 채용 공고의 업무와 요구 역량을 프로젝트로 보여준다.
- 팀이 설정한 반영 목표: 공고에 명시된 업무·역량의 약 **60~70% 이상**을 프로젝트에 반영한다.
- 서비스 수준: 기본적으로 실제 작동하고 실사용 가능한 서비스를 만든다.

60~70%는 팀 내부의 프로젝트 목표다. 토스의 채용 평가 기준이나 합격 기준으로 제시된 수치는 아니다. 어떤 항목을 기준으로 계산하고 어떤 결과물을 반영 증거로 볼지는 아직 미정이다.

## ADS에서 방향 변경을 논의한 이유

1. 처음에는 ADS를 프로젝트 주제로 고려했다.
2. 구체적인 설계 과정에서 예상보다 많은 도메인 지식이 필요하다고 판단했다.
3. 도메인 지식이 적게 필요한 일부 영역만 구현하자는 의견이 나왔다.
4. 일부 기능만 구현하면 하나의 완성도 있는 서비스로 만들기 어렵고, 팀이 정한 채용 공고 역량 반영 목표를 충족하기 어려울 수 있다는 우려가 나왔다.
5. 이에 ADS 관련 공고에서 Brain 관련 공고로 역량 기준을 변경하는 방향을 논의했다.

이 판단은 전달받은 회의 내용에 근거한 팀의 논의 기록이다.

## 현재 제안된 방향과 결정 상태

| 항목 | 내용 | 상태 |
| --- | --- | --- |
| 포트폴리오 목표 | 실제 작동하고 실사용 가능한 AI 서비스로 역량 입증 | 회의에서 설정 |
| 기준 공고 변경 | ADS 관련 공고 → 토스 Brain 관련 AI Engineer 공고 | 방향 변경 제안; 팀원 전체 동의 여부 미확인 |
| 서비스 아이디어 | 토스 쇼핑 채널과 관련된 전담 Brain AI 서비스(Agent) | 논의 중 |
| 주제 선택 관점 | 팀이 접근하기 쉬운 문제에서 AI Agent/Brain의 역할을 충분히 보여주기 | 논의된 방향 |
| 추가 아이디에이션 | 찬욱님과 해결 문제·AI 역할·실제 워크플로우를 구체화한 뒤 공유 | 예정 |
| 대상 사용자와 해결 문제 | 누가 어떤 상황에서 겪는 어떤 문제를 해결할지 | 미정 |
| 서비스 범위 | 핵심 기능, 제공 데이터, 실행할 작업, 연동 대상 | 미정 |
| AI 구성과 기술 스택 | Agent 구성, 채택 기술, 평가·개선 방식 | 미정 |

현재의 쇼핑 관련 아이디어는 구체적인 문제 정의와 서비스 범위가 정해지기 전 단계다.

## 이후 진행 순서와 역할 분배안

팀원들이 방향에 동의한다면 **아이디에이션 → 서비스 구체화 → 워크플로우 설계 → 팀원 역할 분배** 순서로 진행할 예정이다.

| 역할 | 인원 | 상태 |
| --- | --- | --- |
| 기획 / 전체 워크플로우 / 와이어프레임 설계 | 1명 | 제안 |
| AI 엔지니어링 A팀 | 사수 1명 + 부사수 1명 | 제안 |
| AI 엔지니어링 B팀 | 사수 1명 + 부사수 1명 | 제안 |

위 안은 총 5명이다. 실제 참여 인원, 담당자, A·B팀의 구체적인 업무 경계는 미정이다.

## 제공된 채용 공고의 핵심 역량

아래는 공고를 읽기 쉽게 묶은 요약이며, 팀이 확정한 구현 목록이나 60~70%의 산정표가 아니다. 원문은 [TOSS_AI_ENGINEER.md](references/TOSS_AI_ENGINEER.md)에 보관한다.

| 역량 | 공고에서 강조하는 내용 |
| --- | --- |
| 문제 정의와 비즈니스 적용 | 고객의 문제를 정의하고 실제 업무를 수행하며 고객 경험·비즈니스 성과 개선 |
| Agent 설계와 작업 실행 | 프롬프트, 에이전트 구성, Tool Calling으로 목표 달성 |
| 정보와 맥락 활용 | RAG, Context Engineering으로 필요한 정보와 사용자 맥락 이해·활용 |
| 정량 평가와 반복 개선 | 데이터셋·지표·실험·검증을 바탕으로 품질을 높이는 파이프라인 |
| Guardrail | 확률적인 AI 컴포넌트를 목적에 맞게 안전하고 효과적으로 사용 |
| 다양한 데이터 활용 | 텍스트·이미지·음성·구조화 데이터의 이해와 활용 |
| 서비스 운영을 고려한 설계 | 적용 가능성·확장성·지속 가능성, 품질·지연 시간·비용의 균형 |
| 실사용 피드백과 협업 증거 | 고객 피드백과 지표에 따른 개선, 개인 역할과 기술 외적 기여 설명 |

공고는 음성 경험이 없어도 텍스트·이미지 기반을 포함한 프로덕션 수준의 AI Agent 개발 및 반복 개선 경험이 있다면 충분하다고 명시한다. 실시간 음성 구현은 현재 팀의 필수 구현 항목으로 정해지지 않았다.

공고가 권하는 경험 설명 흐름은 **제약 상황 → 문제 정의 → 실험 설계 → 평가 → 개선**이다.

## 미션 요구사항과 함께 적용할 기준

공고 기반 포트폴리오 목표와 함께 [MISSION_REQUIREMENTS.md](MISSION_REQUIREMENTS.md)의 필수 조건을 충족해야 한다.

- 생성형 AI 또는 AI Agent가 서비스의 핵심 기능이어야 한다.
- 지정된 기술 요소 5개 중 2개 이상을 포함해야 한다.
- 외부에서 접근 가능한 형태로 서비스를 배포해야 한다.
- 실제 사용자 최소 5명에게 서비스를 제공하고 피드백을 수집·반영해야 한다.
- 기획·설계·진행·테스트·개선 기록, GitHub 버전 관리, 발표 자료를 남겨야 한다.
- AI 생성 콘텐츠 명시 및 개인정보 수집 시 동의·안전한 관리 조건을 지켜야 한다.

## 다음 논의에서 구체화할 항목

- 팀원들의 방향 변경 동의와 우려 사항
- 대상 사용자, 구체적인 문제 상황, 현재 해결 방식과 불편
- AI가 맡을 판단·검색·작업 실행 및 사용자가 얻는 결과
- 서비스의 시작부터 결과 확인까지 이어지는 실제 워크플로우
- 사용할 데이터와 실행 도구·서비스에 대한 접근 가능 여부
- 핵심 구현 범위와 공고 역량의 연결, 60~70% 반영 목표의 판단 기준
- 실사용자 테스트와 정량 평가 방법
- 팀원별 담당 결과물과 A·B팀 간 연동 방식
