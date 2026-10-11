# Commerce UI 구현 기준 — 토스쇼핑 레퍼런스 매핑 (2026-10-07)

목적: `COMMERCE_DESIGN_SYSTEM.md`의 토큰과 토스쇼핑 캡처를 컴포넌트 단위 구현 기준으로 번역한다. 각 항목은 **참고 캡처 → 관찰한 디자인·동작 → 구현할 UI State → 연결 Backend/API** 순서다. 토스 브랜드 자산(로고·아이콘·문구)은 복제하지 않고 구조와 상호작용만 따른다.

우선순위: 이 문서는 **화면 배치·Navigation·옵션 UX·Bottom Sheet·CTA 상태·Interaction·Visual 구조의 UI 구현 정본**이다. `WIREFRAME_PLAN.md`·`HANDOFF_*.md`·`IMPLEMENTATION_PLAN.md`의 화면 표는 업무 규칙·Backend 정책·사용자 Journey 요구의 근거로 유효하나, UI 상세가 충돌하면 이 문서와 `reference/toss-shopping/` 캡처를 우선한다.

범위 표기: **[1차]** = 이번 프런트엔드 단계(홈·검색·목록·탐색)에 구현, **[후속]** = 상품 상세·카트·주문 단계, **[제외]** = P0 외.

## 1. 모바일 우선 셸

- 참고 캡처: `home/01`, `cart/44`, `orders/079` — 전 화면 모바일 세로 레이아웃.
- 관찰: 화면 폭 = 기기 폭, 좌우 패딩 ~16–20pt, 콘텐츠 아래 하단 네비 높이만큼 여백.
- 구현: `.shell` max-width 480px 중앙 정렬(데스크톱도 모바일 폭 유지 — 앱 에뮬레이션 환경). 본문 `padding-bottom`으로 하단 네비+고정 CTA와 겹침 방지. 모든 버튼 `white-space: nowrap` + 최소 폭으로 한글 라벨 줄바꿈 방지.
- Backend: 없음(프레젠테이션).

## 2. 상단 Header [1차]

- 참고 캡처: `home/01`, `search/101`.
- 관찰: 홈 헤더 = 둥근 검색 필드(돋보기+placeholder) + 우측 마이·장바구니 아이콘(카트는 빨간 숫자 배지). 상세는 이미지 위 오버레이 아이콘(백/공유/검색/카트). **[05 구현됨 — 2026-10-10, 후속 표기 해소]** 지원 아이콘은 뒤로·검색·장바구니 3개다(공유는 미지원이라 만들지 않음 [Project]). `.detail-nav`가 히어로 위 투명 overlay로 시작해 스크롤 시 solid 바로 전환하고, product 라우트는 별도 `.backbar`를 렌더하지 않는다. 스크롤 시(`home/02` [Observed]) 검색 필드가 소멸하고 우측 상단에 검색·장바구니 플로팅 원형 아이콘만 남는다.
- 구현 State(스크롤): `shop` 라우트에서 scrollY>72px이면 `.top.mini`(transparent+자식 숨김+pointer-events 해제)로 전환하고 `.float-nav` 플로팅 버튼(검색→search 라우트, 카트→cart 라우트+배지)을 표시한다 [04-C Correction]. 다른 라우트는 기존 sticky 헤더 유지 — 전역 리팩터링 없이 shop 한정.
- 구현 State: 기본(홈) = 검색 input + 프로필 아이콘 + 카트 아이콘(배지); 검색 화면 = `‹` 뒤로가기 + input + X 지우기; 서브 화면 = 상세는 자체 overlay `.detail-nav`(05, '다음 단계 뒤로가기 헤더' 후속 표기 해소), 카트·주문은 `.backbar` 뒤로가기 헤더. [04-C] 프로필 아이콘 추가 — 토스의 '마이' 목적지는 우리 서비스에 없어 **내 주문으로 대체 [Project]**.
- Backend: 카트 배지 = `GET /api/cart`의 `items.length`(기존 `refreshCart` 재사용).

## 3. 하단 Bottom Navigation [04-D]

- 참고 캡처: `home/01` 하단 5탭(홈/혜택/쇼핑/증권/전체).
- 관찰: 높이 ~56pt, 상단 구분선, 선택 탭 밝은 아이콘+라벨, 미선택은 muted.
- **[Superseded 2026-10-07]** 이전에는 '토스 앱 전체 네비이므로 우리 플로우용으로 단순화'로 판단했으나 폐기 — 새 방향은 브랜드 자산을 제외하고 탭 수·배치·선택 상태·높이·아이콘/라벨 관계·가로 스크롤·화면 내 위치까지 레퍼런스를 최대한 따른다(IMPLEMENTATION_DECISIONS 2026-10-07). **04-D에서 재구성한다.**
- 구현(04-D): 슬롯 5개 = **홈**→shop 루트 리셋 / **혜택**→shop?cat=sale / **쇼핑**→shop + active 슬롯(route=shop이면 항상 on, `aria-current="page"`, 선택 시 채움 쇼핑백 `IcBagFill`; 특가 등 내부 탭 진입도 전역 active는 쇼핑 슬롯에 유지) / **AI**→AgentPanel(기존 shopping brain 진입 보존) / **전체**→메뉴 시트(`aria-haspopup="menu"`+`aria-expanded`, `.on` 미사용). 원본의 '증권' 목적지는 우리 서비스에 없어 AI 진입으로 대체 [Observed 구조 / Project 매핑].
- 렌더 범위: `NAV_ROUTES={shop}` — 상세·카트·주문서·주문목록·주문상세는 자체 `.bottom-bar` CTA가 있어 글로벌 네비를 렌더하지 않는다(겹침 없음). **[05 정정]** 상세는 자체 overlay `.detail-nav`를 두어 `.backbar`를 렌더하지 않고, 카트·주문서·주문목록·주문상세는 `.backbar`만 둔다.
- 스크롤 숨김: `y>120 && y>lastY`에서 `.hidden`(translate+`visibility:hidden` — 포커스·a11y 트리에서도 제외), 올리면 복귀, transition 적용 [Project].
- 전체 시트: `.menu-sheet`(sheet-overlay 재사용) = 내 쇼핑(orders)·장바구니(cart)·검색(search)·AI 쇼핑 도우미. 열 때 첫 항목 포커스, ESC·오버레이 클릭 닫기, 닫을 때 전체 버튼으로 포커스 복귀.
- 뒤로가기(push 화면): `history.state` 마커 기반 — `goto` pushState 엔트리는 `{app:1,internal:1}`, 최초/직접 진입 엔트리는 mount·hashchange 시 `{app:1}`만 마킹. backbar 클릭 시 `internal` 있으면 `history.back()`, 없으면 `gotoReplace(BACK_PARENT)`(push가 아닌 **replace**로 상승해 parent→back 루프 방지). `BACK_PARENT`: product/cart/orders→shop, checkout→cart, order→orders [Project]. `goto`·`gotoReplace`는 `scrollTo(0,0)`으로 새 화면 스크롤을 초기화(pop은 브라우저 스크롤 복원에 위임).
- e2e 계약(04-D): nav 라벨 = 홈/혜택/쇼핑/AI/전체 exact, `.nav-item.on`='쇼핑'+`aria-current="page"`, 전체=`aria-expanded`. '내 주문'은 네비 슬롯이 아니라 헤더 '내 쇼핑' 아이콘/메뉴 시트 경로로 진입 — 기존 e2e의 네비 직접 클릭 단정은 헤더 버튼 경로로 교체(사용자 실제 경로 유지, 단정 완화 아님).
- Backend: 없음.

## 4. 쇼핑 홈 [1차]

- 참고 캡처: `home/01`.
- 관찰 구조: 검색 필드 → 카테고리 pill 칩 행(가로 스크롤, 선택 칩은 중성 밝기 상승 — 언더라인 아님) → 히어로 프로모 카드(밝은 배경+페이지 n|m) → 아이콘 단축키 행 → 개인화 상품 섹션('~님을 위한' + 칩) → 상품 그리드.
- 구현(04-C — Toss IA 재구성 완료): 상단 콘텐츠 탭(쇼핑 홈/뷰티/식품/카테고리/특가/시즌 추천 — 텍스트 탭 + 선택 pill, 가로 스크롤) → 카드형 히어로 캐러셀(scroll-snap, 슬라이드 ~88%+peek, 좌 텍스트·우 상품 이미지, 우하단 `n|N` 인디케이터, 크림 카드 고정색 [Observed], 높이 ~232px+할인율 14.5/상품명 20/가격 21px [04-C Correction]) → 혜택 스트립('특가·배송 혜택 모아보기' + 실제 최대 할인율 계산 → 특가 탭) → 숏컷 아이콘 레일 9개(46px squircle 아이콘+11px 라벨, 실 목적지만: 카테고리/오늘의 특가/뷰티/식품/디지털/패션/리빙/내 주문/장바구니) → 개인화 추천 섹션(`{userName}님을 위한 추천 상품` + recommended 우선·카테고리 라운드로빈 정렬로 식품/뷰티/리빙/디지털/패션 혼합 노출 [04-C Correction]) → 2열 상품 그리드. 탭별 콘텐츠: 뷰티=정사각(1:1) 커버형 히어로(풀블리드 이미지+하단 그라데이션+하단 텍스트 클러스터: 상품명/가격/보조)[Observed `home/26`, FIX-002 — '뷰티·식품 동일 커버' 기술 Superseded], 식품=가로 카드형 히어로(카드 내부 좌 텍스트·우 이미지)[Observed `home/27`, FIX-002] — 뷰티·식품 공통 +서브카테고리 아이콘 레일+그룹 그리드; 카테고리=좌측 세로 레일+우측 원형 서브카테고리 그리드+전체보기; 특가=프로모 카드(좌 텍스트+우 상품 이미지)+보조탭(하루 특가 활성/'기획전'→시즌 탭/'셀러 특가'·'쿠폰 혜택'=Backend 없어 disabled [Project])+자정 카운트다운+'오늘만 이 가격에 살 수 있어요'+DealCard(약 2.5:1 와이드 이미지 위+하단 상품명·가격·원가 취소선·★, 좌상 '하루특가 n%' 레드 배지, 우하 카트 아이콘)[Observed `product-list/35`, FIX-002 — 카드 full-bleed(x=0)는 Ref35의 ~10px 가장자리와 다른 [Project] 구현 차이로 MINOR→08 이관 — 기존 '16:10 [Observed product-list/34]' 기술은 잘못된 관측으로 Superseded]; 시즌 추천=풀블리드 기획전 배너+DealCard 가로행(row) 변형(정사각 썸네일+우측 정보 클러스터: 상품명 2줄·할인율+가격·★ — 할인율은 --text-2)[Observed `home/50`, FIX-002 — '특가와 같은 DealCard 공유' 기술 Superseded]. 상품 데이터는 `/api/products?limit=50` 1회 조회 후 클라이언트 그룹 필터링(서버 `category` 파라미터는 단일 값). shop/search 라우트는 `.shell.shop-pad`로 페이지 패딩을 10px로 축소(카드 마진 ~10px [Observed]) — 다른 라우트는 기존 20px 유지 [04-C Correction].
- **[Superseded 2026-10-07]** 'AI 진입 카드가 프로모/merchandising 영역을 대신한다'는 판단 폐기 — merchandising block(프로모/특가/추천/배너)은 04-B Demo Catalog + demo/static UI로 별도 재현한다. **AI 진입점:** AI/Brain 진입점 자체는 향후 필요하지만, 홈 중심 대형 AI 카드는 폐기됐다 — [04-C 구현] 홈에서 대형 AI 카드 제거 완료, 진입점은 하단 네비 `AI` 탭으로 유지. 이후 더 자연스러운 진입점은 Brain 통합 단계에서 결정. 단축키 행·페이징 히어로는 레퍼런스 대조 후 실제 구현에 포함됐다(숏컷은 실 목적지만 연결).
- UI State: 로딩 스켈레톤(카드형 회색 블록), Error(재시도), Empty.
- Backend: `GET /api/products?query=&category=` — 카테고리 필터는 서버 `category` 파라미터 사용.

### 4-1. Toss Home 영역별 Scope 매핑

Toss Shopping Home의 각 영역을 다음 네 상태로 분류한다. 구현자가 임의로 Toss 부가 기능을 만들어 Scope를 확장하지 않는다.

| 상태 | 의미 | 해당 영역 |
| --- | --- | --- |
| **A. 실제 기능 구현** | Backend 연결로 실제 동작 | 검색, 상품 탐색·카테고리, 장바구니, 상품 상세·리뷰·옵션, 주문/모의 결제, 주문 내역, 배송, 취소 |
| **B. 구조 재현 + 구매 목적지 대체** | Toss와 같은 화면 구조를 유지하되 목적지를 우리 구매 기능으로 연결 | Brain과 직접 무관한 shortcut/navigation 목적지 → 카테고리·특가·인기 상품·주문·추천 등 구매 관련 목적지로 대체 가능 |
| **C. 정적/Demo UI** | 실제 Backend 없이 Seed/static으로 시각 구조만 재현 | 특가 프로모션·배너·기획전·추천 섹션·merchandising block, Brain 구현 전의 static personalization |
| **D. 제외** | 기능·데모 UI 모두 구현하지 않음 | 오늘의 뽑기·포인트 피드·미니맵·고양이/게임성 요소·토스 생태계 전용 비쇼핑 기능 |

단, D 영역의 시각적 slot이 Home 구조 재현에 중요하면 C/B로 대체할 수 있다(기능 자체는 만들지 않는다). 정확한 목적지 매핑과 섹션 구성은 04-C 구현 전에 구체안 제시 후 승인받는다.

## 5. 상품 카드 / 목록 [1차]

- **갱신 메모 (2026-10-09):** 아래의 과거 04-C 구현/Correction 설명 중 가격 취소선, 별점 색, 카트 버튼 배경, 지표 미구현 여부는 C안 Product Card 보완으로 대체되었다. 현재 기준은 다음 항목을 적용한다.
- 참고 캡처: `home/01`, `search/105`, `product-list` 계열.
- 관찰: 2열, 정사각(1:1) 실사진, 좌상단 `n% 특가` 레드 pill, 이미지 우하단 장바구니 아이콘 버튼, 본문 = 상품명 2줄 → `n%`+가격(bold) → 단가 → `★평점(개수)` → `최대 N원 적립`.
- 구현(04-C 기준): 2열 그리드 + 1:1 이미지 + 상품명 2줄 클램프 + 가격 bold + `★평점(리뷰 n)` + 좌상단 `n% 특가` 레드 pill(실제 할인율 — sections=flash-sale) + 할인율%(discount 컬러) + 원가 취소선 + 배송 라벨 + 카드 우하단 카트 아이콘(장식 — 카드 전체가 상세 진입이며 바로 담기는 지원하지 않는다 [Project]) — 전부 `display-meta.ts`의 표시 메타 기반. 할인율은 `original_price_won` 대비 최저가 옵션가로 계산한다. **단가·'30일 최저가'·적립·'N만 명 구매'·광고 배지는 근거 데이터가 없어 구현하지 않는다**(근거 없는 수치 표시 금지 원칙). 품절은 이미지 딤드+`품절` 배지 유지.
- **[04-C Correction — 카드 해부 [Observed `home/02`·`product-list/34`]]** 다크 셸 위에서 카드 정보 영역은 **라이트 카드(--pcard: light `#fff` / dark `#b6b6b6`)**로 구현된다(이미지·텍스트가 하나의 카드 배경에 연결). 카드 radius ~14px+overflow hidden, 이미지 비율 ~1.12:1이며 하단이 카드 배경색으로 페이드(`mask-image` 그라데이션). 본문 텍스트는 카드 위 다크 컬러(--ptext/#1d1f24), **할인율 %도 가격과 같은 다크색**(빨간 강조는 이미지 위 `n% 특가` 배지만 해당). 카트 아이콘은 카드 우하단 **흰 원형 버튼**. 카드 좌우 마진 ~10px, 그리드 gap ~10px.
- **현재 구현 [04-C Product Card C]:** 2열 그리드 + 약 1:1 이미지 + 좌상단 레드 특가 배지 + 상품명 최대 2줄 + 할인율과 판매가 같은 줄(다크 계열, 19px) + 조건부 30일 최저가 + 조회/평점 메타 + 배송 칩 + 배경 없는 작은 쇼핑백 윤곽선. 그리드 카드의 정가 취소선은 숨기며 특가 DealCard에서는 유지한다. 카드 전체는 상세 진입이고 쇼핑백은 장식 [Project].
- 현재가·옵션·재고·리뷰 수는 API `ProductSummary`가 정본이다. 할인율은 `original_price_won` 대비 서버 최저 옵션가로 계산하고, 리뷰 수는 실제 `rating_summary.count`만 표시한다. 배송 칩은 `PRODUCT_META.delivery` Demo 라벨이다. 적립 정책·판매량·광고 데이터는 없어 관련 수치를 표시하지 않는다.
- **Product Signals [Project, UI 표시용]:** `display-meta.ts`의 조회 신호는 `metric=UNIQUE_VISITORS`, 고유 방문자 수, 집계 기간, 기준 시각, 출처 유형(`INTERNAL | EXTERNAL | SYNTHETIC`) 및 출처명을 가진다. 페이지뷰와 고유 방문자는 별도 의미다. 합성 표본은 카드에 `데모`로 보이며 값이 없으면 숨긴다.
- **30일 최저가 규칙:** Boolean 최저가 플래그를 저장하지 않는다. 가격 관측점은 `product_id`, `variant_id`, 관측 시각, 관측가, 출처 유형, 출처명을 가진다. 카드가 표시하는 현재 최저 옵션과 같은 variant 및 같은 출처의 최근 30일 관측만 집계한다. 현재 서버 가격이 그 관측 최저가 이하일 때만 문구를 표시하고, 데이터가 없거나 기간이 지났거나 현재가가 더 높으면 숨긴다. 현재 표본은 `SYNTHETIC`이며 실제 수집 API/DB/Migration은 없다.
- 상품 이미지: `ProductSummary.image`(=`image_urls[0]`)이 있으면 사용하고 없으면 로컬 생성 이미지 `/assets/products/{product_id}.webp`로 fallback(`onError` 시 글자 플레이스홀더). [04-B] demo-catalog는 image_urls에 실제 `/assets/products/p-d-*.webp`를 기록하고 파일도 함께 커밋한다 — fixture(p-a~c)는 image_urls가 비어 있어 convention fallback이 계속 동작한다.
- Backend: `GET /api/products` 응답 그대로.

## 6. 검색 화면 [1차]

- 참고 캡처: `search/101`(최근 검색어), `102`(자동완성), `103·105·110`(결과+칩행), 필터 페이지·정렬 시트.
- 관찰: (a) 진입 시 최근 검색어 행(시계 아이콘+단어+X 삭제). (b) 입력 중 자동완성 리스트 — **입력한 부분만 파란 강조**. (c) 결과 상단에 패싯/필터 칩 행 + '추천순 ⌄'. (d) 필터는 전체 페이지(탭+칩+'더 보기'+카운트 CTA). (e) 정렬은 바텀시트(선택 ✓+설명).
- 구현 State: `idle`(최근 검색어 — localStorage, 삭제 가능, 최대 10개) → `typing`(자동완성 — `/api/products?query=` 상위 5개 이름, 입력 부분 accent 마크) → `submitted`(결과 그리드+카테고리 칩 행+정렬 트리거). Empty='조건에 맞는 상품이 없어요'(e2e 계약 유지), Error=재시도.
- 정렬: 바텀시트 '추천순'/'가격 낮은 순' — 서버 `sort=RELEVANCE|PRICE_ASC` 그대로.
- 필터: 카테고리 칩 = 결과에 존재하는 상위 그룹 칩(전체+그룹). 결과가 클라이언트 필터이므로 칩 선택 후에도 칩 목록이 유지된다. 토스식 전체 필터 페이지(가격대·브랜드·특징 탭)는 **[후속 제안]** 유지.
- 키보드: 진입 시 autofocus, X 버튼으로 지우기(typing으로 복귀), Enter submit 시 recents 저장 + `?q=` 반영(뒤로가기로 이전 검색 복귀).
- Backend: `GET /api/products`(query/category/sort 파라미터). 신규 엔드포인트 없음.

## 7. Bottom Sheet (공용) [1차 — 정렬에 첫 적용]

- 참고 캡처: 정렬 시트(`search` 계열), 옵션 시트(`product-detail/095`), CS 패널(`cs/057`).
- 관찰: 딤 55~70% + 상단 라운드 ~20pt + 타이틀 + 항목 리스트(선택 ✓ accent+설명 문구).
- 구현: 공용 `BottomSheet` 컴포넌트(overlay 클릭/ESC로 닫기, 기존 `.sheet-overlay`/`.sheet` 토큰 재사용·상단 radius만 확대). 정렬 선택에 첫 적용했고 **옵션 선택도 05에서 같은 컴포넌트로 구현됨**(§7-1, 이전 [후속] 표기 해소). 취소 시트(`CancelSheet`)는 기존 마크업 유지(다음 주문 단계에서 공용화 여부 결정).
- Backend: 없음.

## 7-1. 상품 상세 → 옵션 → 장바구니 [05 구현 완료 · 사용자 최종 Visual 승인 보류(PMQA-05-GIT-POLICY-032) · 마일스톤 종료는 사용자 승인 + PM 커밋·Push 검증 후]

아래 스펙은 Phase 05에서 실제 구현됐다. 사용자 최종 Visual 승인은 최신 지시로 보류다(이전 승인 완료 기록은 Superseded — PMQA-05-GIT-POLICY-032). 05 마일스톤 최종 종료는 사용자 승인 + PM의 최종 커밋·Push HEAD 일치 검증 후 확정된다. 구현 계약:

- 상품 상세 진입 시 **구매 가능한 기본 옵션을 자동 선택**한다. 사용자가 옵션을 고르지 않아도 현재 선택 조합의 가격·CTA가 유효해야 한다.
- **품절 옵션은 기본 선택에서 제외**한다(표시는 하되 선택 불가 — `badge-soldout` + disabled).
- CTA 잠금은 두 조건을 구분한다. **구매 가능성**: 전 옵션 품절(`soldOutAll`)이면 구매 불가로 '품절' 표기하고 옵션 CTA·담기 CTA 모두 disabled — 옵션이 여러 개면 재고 있는 조합이 기본 선택된다. **쓰기 잠금**: pending(미확정 cart write) 또는 담기 진행 중에도 버튼은 잠긴다 — 실제 조건은 옵션 CTA `soldOutAll || anyPending`, 담기 CTA `!selected || adding || anyPending || soldOutAll`. 잠금 중에도 장바구니 이동·pending 복구 접근은 막지 않는다.
- 옵션 변경은 **공용 `BottomSheet`**로 연다(정렬 시트와 같은 컴포넌트 — 관찰된 '옵션 한번에 보기' 시트 패턴).
- 선택 옵션·수량 변경 시 **가격과 CTA 라벨을 즉시 갱신**한다(관찰된 'n원 결제하기' 금액 포함 CTA 패턴).
- **[05 추가 계약]** 담기·수량·삭제 등 cart write는 서버 재검증(expected version + idempotency)과 실패 복구를 따른다: 응답 유실/타임아웃 등 **불확정 결과는 localStorage pending intent로 보존**하고 전역 잠금(새 write·옵션·수량·주문 차단) 후 카트 배너의 '결과 확인'으로 `/api/actions?kind=&idempotency_key=ui-<key>` 조회 → SUCCEEDED면 카트 재동기화, 확정 거절(VERSION_CONFLICT·OUT_OF_STOCK)이면 intent 해제 + 최신 상태 재조회 + 사용자 재확인 요청. 자동 재실행은 하지 않는다 [Project — Toss 캡처에 대응 상태 없음].
- **[05 추가 계약]** 카트 읽기 레이스 방지: 부모 `cartReadSeq`가 쓰기 확정 적용 시점의 in-flight read를 무효화해 늦은 GET이 새 커밋 상태를 덮지 않는다.
- **[05 추가 계약]** 리뷰는 실제 DB 행 수·실제 cursor/has_more 페이지네이션·출처 칩(시연 리뷰=SYNTHETIC/실사용 리뷰=REAL)을 표시한다. 존재하지 않는 리뷰를 만들지 않는다.
- **[05-030 추가 계약]** 카트 결제 예상 금액 패널은 Ref126 대응 접힘/펼침 구조다 — 헤더(총 N건 결제 예상 금액+총액+chevron 토글) → 구분선 → 상품 금액·배송비 행(#cart-quote-rows) → 전체폭 주문 CTA. 토글은 표시 전용이다(button+aria-expanded/aria-controls·Enter/Space) — 카트 쓰기·선택·version을 바꾸지 않고, 표시 금액은 items_total_won/shipping_fee_won/total_won 서버값 그대로다(클라이언트 재견적·부분 주문 없음). 선택 subtotal은 전체 견적과 섞이지 않는 보조 행(.cart-summary-count)으로 토글 위에 둔다.
- **[05-030 추가 계약]** 고정 패널 높이가 변해도 콘텐츠가 가려지지 않아야 한다 — .cart-screen의 padding-bottom을 고정값 대신 ResizeObserver로 실측한 .bottom-bar 높이(--bb-h)로 유지한다.
- **[05-030]** 상세 정보 위계: 상품명 20px·할인율 15px 보조·판매가 26px 주강조·배송비는 서버값 .price-sub 보조 행으로 분리·info-rows 상단 8px 섹션 밴드([Project] 채택값)·label-value inline 밀도.

## 8. 로딩·오류·Empty [1차]

- 관찰: 토스는 스켈레톤 블록 사용(채팅·리스트). 우리 구현: 상품 그리드는 스켈레톤 카드, 그 외 기존 `Loading/Empty/ErrorState` 유지.
- Backend: `ApiResult.ok=false` 시 `error.code` 표시 + 재시도(기존 패턴).

## 9. 명시적 제외

- 할인율·원가 취소선·단가·적립·쿠폰·포인트·찜·판매자 배지·결제수단 선택·부분 주문 — 현재 DB 필드 부재. **[2026-10-07 조정]** 할인율·원가·배지·적립 등 표시용 필드는 04-B Demo Catalog 확장 시 시드 데이터로 재현 대상이 됐다(실제 쿠폰/포인트 기능이 아니라 카드 표현용 데이터). 찜·결제수단 선택·부분 주문·판매자 기능은 여전히 제외. **[2026-10-11 정정]** '부분 주문' 제외는 Backend 계약 기준이다 — UI상 항목 부분선택(checkbox·선택 합계·전체 장바구니 견적 동시 표시)은 05에서 구현됐고, 선택이 전체가 아니면 주문 CTA가 disabled + 안내 문구로 처리된다.
- 상세 갤러리 다중 이미지 n|m(단일 이미지는 1|1 정직 표기, 다중 이미지 실데이터 부재로 미검증)·'비슷한 상품' pill·결제 완료 화면·주문 그룹 헤더·취소 단계 페이지·CS 주제 패널 — 06 또는 후속 단계. 옵션 Bottom Sheet는 05에서 구현됨(§7-1). **[Superseded 2026-10-11]** '하단 CTA 4분할' 후속 표기는 폐기 — 05 실구현은 상세 overlay `.detail-nav`(뒤로·검색·카트 3아이콘) + 하단 고정바 지원 3 CTA(장바구니·옵션 선택·n원 담기)다. 찜 하트·공유 등 미지원 요소는 만들지 않았고, 평점은 저장된 전체 리뷰 집계와 일치할 때만 표기하며, 리뷰는 사진/작성자 없이 flat list + 출처 칩으로 렌더한다.
- DB 시드 확장(상품 수·카테고리·이미지 URL)·판매자센터·정산 — 별도 승인 필요, 이번에 제안만 기록.

---
근거: `docs/COMMERCE_DESIGN_SYSTEM.md`(토큰·실측), `reference/toss-shopping/screenshots/` 22장 열람, `src/catalog.ts` API 계약. 미관측 동작을 Toss Shopping의 실제 동작이라고 주장하지 않는다. 단, Backend 정책상 필요한 상태·오류·프로젝트 UX 결정은 [Project]/[Inferred]로 명시해 구현할 수 있다 — 관찰 사실과 프로젝트 결정의 구분을 유지하는 것이 원칙이다.
