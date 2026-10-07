# 화면 / Commerce Action ↔ 향후 Agent Tool — 누적 분석

갱신일 2026-10-04. [인벤토리](SCREEN_INVENTORY.md)의 ID와 [Flow](SHOPPING_FLOW.md)의 실제 경로를 따른다. 녹화 1 원문은 [보존 묶음](history/recording-1-docs.zip)에 있다.

**모든 Tool 이름·입력·결과 확인·평가 방식은 향후 환경의 설계 후보(`Inferred`)다. 토스 실제 API/권한 계약을 확인하거나 구현한 것이 아니다.** 아래 ‘Observed’는 사용자의 UI Action 근거만 뜻한다. 화면 존재·요청 접수·최종 완료를 같은 성공으로 처리하지 않는다.

## Shopping Brain — 관찰한 Action

| 화면 / User Action | UI 관찰 | Potential AI Tool — Inferred | 필요 관계 / 성공 확인 | 미확인 |
| --- | --- | --- | --- | --- |
| 홈/카테고리/특가 탐색 | Observed H01/C01~04/L02/D01, V2-50 | list_categories(), list_products(), get_collection_products() | 선택 분류/컬렉션·상품 식별·옵션/가격/평점 목록 | 페이지네이션·전체 하위 분류 계약 미확인 |
| 최근 검색어/자동완성 조회 | Observed V3-01/02 | get_recent_searches(), suggest_queries() | 검색어 prefix·추천 후보·기록 목록 | 기록 삭제/인기 검색 P1-01 |
| 검색 실행/필터 적용/정렬 | Observed V3-03~12 | search_products(), get_search_facets() | query·적용 조건·정렬·결과 ID/가격·필터 개수 | 초기화 결과 적용/Empty·개수 변동 P0-01 |
| 추천 상품 읽기 | Observed — 표시 H02, V3-19 | get_recommendations() | 기준 상품/사용자 요청·후보·추천 근거 | 개인화/Context 입력·이미지 검색 P2-01 |
| 상품 상세·이미지 조회 | Observed PD01~10/V2-06/21/22 | get_product(), get_product_images() | 이미지 배열·판매자·구성·현재 가격·배송 약속 | 큰 보기 확대/내부 ID·설명 구조 P1-02 |
| 변형 옵션 선택/가격 갱신 | Observed V2-18/45/46, V3-16~18 | get_product_variants(), select_product_variant() | 옵션 축·선택 ID와 상품명/가격/판매자/리뷰/예정일 함께 갱신 | 종속 선택·품절 옵션·시점 변화 P0-02 |
| 품절/구매 한도 확인 | Observed V2-19/47 | get_availability(), get_purchase_limits() | 상품/옵션의 현재 구매 가능·한도·제한 사유 | 재고 변경/품절 옵션·한도 초기화 P0-02 |
| 배송 예상 확인 | Observed V2-43 | get_product_delivery_estimate() | 상품·배송지에 대한 예상일/택배사 안내 | 실제 주문 배송 추적과 분리 P0-07 |
| 판매자 상품 읽기 | Observed V2-44 | get_seller(), get_seller_products() | 선택 상품의 판매자 식별·스토어 상품 | 전체상품/정책/운영센터 P1-09/P2-04 |
| 가격 비교 목적지 | Observed — 화면만 V3-20 | get_comparison_candidates() | 동일 구성·배송비·혜택 포함 비교 결과 필요 | 비교 데이터는 Not Observed P1-09 |
| 실제 리뷰 읽기·정렬 | Observed RV01~03, V3-27~29 | get_reviews() → 리뷰 분석 | 정렬·옵션/판매자·평점·본문·사진·작성일·범위 | 단일 상세/조건 필터·페이지네이션 P1-02 |
| 사진 리뷰 모아보기 | Observed V3-30 | get_review_images() | 사진과 원래 리뷰/상품/옵션의 연결 | 한 장 확대·연결 상세 P1-02 |
| 찜 등록/목록 조회 | Observed W01/PD03/V3-24 | add_to_wishlist(), get_wishlist() | 등록 후 하트·목록의 상품/옵션 식별 | remove_from_wishlist() 실행 근거는 없음 P1-06 |
| 최근 본 읽기/삭제 | Observed RC01/02 | get_recently_viewed(), remove_recently_viewed() | 이력 항목과 제거 후 목록 | 삭제 모드 진입·복구·재시작 P1-06 |
| 선택 옵션 장바구니 담기 | Observed PD04, V3-17/21/22 | add_to_cart() | 상품·변형 구성·주문 수량·결과 cart item | 동일 선택 재담기가 수량 증가하는 사례; 전체 병합 정책 P0-03 |
| 카트 조회/비용 펼침 | Observed CT01~08/V2-48/V3-26 | get_cart(), get_cart_quote() | 구성/수량/체크·배송 묶음·상품/할인/배송비·합계 | 조건별 쿠폰 배분/다중 그룹 P0-03 |
| 개별/전체/묶음 선택 | Observed CT04~06/V2-23 | set_cart_selection() | 선택 cart item 집합·건수·할인/합계 재조회 | 미선택 가격도 바뀌는 사례, 배분 정책 미확인 |
| 카트 수량 감소 | Observed V3-22→23 | update_cart_quantity() | item ID·요청 수량·최종 금액/재고 | + 직접 증가/최대치/실패 P0-03 |
| 개별/선택 삭제·빈 카트 | Observed CT03/06/07/V2-49 | remove_cart_item(), remove_cart_items() | 대상 집합·실제 삭제 후 목록/Empty | 부분 실패·다중 동시 요청 P0-03 |
| 삭제한 항목 다시 담기 | Observed V3-25 | restore_cart_item() | 삭제 전 구성/수량·복원 결과·총액 | Undo 기한·재고 변경·복원 실패 P0-03 |

## Checkout 연결 — 실행 권한은 미정

결제·취소 등 실제 변경 Tool의 실행 권한/사용자 확인 정책은 프로젝트에서 **미정**이다. UI에서 결제를 수행했다고 향후 AI의 자동 결제 권한이 결정되는 것은 아니다. 아래는 연결 분석만이다.

| User Action | UI 관찰 | Potential AI Tool — Inferred | 필요 관계 / 성공 확인 | 미확인 |
| --- | --- | --- | --- | --- |
| 선택 상품 주문서 | Observed V2-23→24 | prepare_checkout() | 선택 item/variant/수량·배송지·가격/혜택/총액 | 복수 상품·가격 변화/품절 재검증 P0-03/04 |
| 주소 목록/기존 주소 확인 | Observed V2-02 | get_addresses(), get_checkout_address() | 현재 선택 주소·후보·기존 주소 확인 결과 | set_checkout_address(), 주소 CRUD 실행은 Not Observed P0-04/P1-05 |
| 배송 요청 편집 페이지 | Observed V2-03 — 기존 값 저장 | get_delivery_request_options(), get_delivery_request() | 프리셋·현재 값·글자 수 안내 | 새 값 저장/Validation은 Not Observed P0-04 |
| 결제수단 목록 열기 | Observed V3-31 — 변경 없음 | get_payment_methods(), get_checkout_payment_method() | 후보/현재 선택·잔액/할부 요약 | select_payment_method() 변경 성공 근거 없음 P0-04 |
| 쿠폰 적용된 금액 확인 | Observed V2-01/23 | get_eligible_coupons(), get_checkout_quote() | 자동 반영 쿠폰/할인·현재 선택 조건·총액 | 쿠폰함/사용자 적용·해제 Tool은 Not Observed P1-03 |
| 포인트 최대 체크/0 입력 | Observed V2-25/26 | get_point_balance(), set_checkout_points() | 최대 사용 선호·실제 사용 금액을 구분; 잔액·총액 | 양수 부분 사용/초과 오류/내역 P1-04 |
| 전체 주문서 결제 CTA/완료 | Observed V2-26→27/29 | submit_order(), get_payment_status() | 동일 주문 요청 식별·결제 상태·생성 주문·결제 금액 | 인증/실패/취소/재시도/중복 방지 P0-05; 간편 슬라이더 성공 없음 |
| 구매자 카드 전표 조회 | Observed V2-32/33 | get_order_receipt() | 주문과 연결된 결제/취소·금액/세금 증빙 | 다운로드·취소 후 갱신 P1-09; 실제 정산 아님 |

## CS Agent — 확인된 시작점과 요청 범위

| User Action | UI 관찰 | Potential AI Tool — Inferred | 필요 관계 / 성공 확인 | 미확인 |
| --- | --- | --- | --- | --- |
| 내 쇼핑/주문 목록 조회 | Observed V2-28/29/41 | list_orders() | 주문/item 식별·현재 상태·금액·가능 Action | 기간/검색/Empty·다중 상품 P0-06 |
| 현재 주문 상세 조회 | Observed V2-30/31/34/40 | get_order() | 결제완료→상품준비중→취소요청·항목/수량/가격 | 배송 상태 상세·변경 정책 P0-06 |
| 취소 사유/예상액 조회 | Observed V2-35~38 | get_cancel_options(), get_cancel_quote() | 대상 item·사유·예상액·주문 상태·판매자 승인 안내 | 취소 불가/부분 대상·쿠폰/포인트 반환 P0-10/12 |
| 취소 요청 접수 | Observed V2-39~41 | request_cancel_order() | 사유 주문 실수·요청 접수·동일 현재 주문 취소요청 확인 | 최종 취소와 구별; 승인/거절/환불 완료 P0-10/12 |
| 문의 분류/하위 질문 | Observed V2-07~10 | get_support_topics() | 상품/주문 Context·문의 종류·하위 주제 | 질문에 따른 실제 정책/신청 연계 P0-11 |
| 문의 조건별 주문 조회 | Observed V2-13~17 — Empty | list_support_eligible_orders() | 조회 질문/범위·빈 결과 안내·다음 행동 | 조회 조건의 정확한 정의/대상 있는 결과 P0-11 |
| 상담 채널 선택/진입 | Observed V2-11/12 — Skeleton까지 | get_support_channels(), open_support_channel() | 선택 채널/연결 상태 | 메시지/접수 성공 없음; create_support_ticket() 실행은 Not Observed P0-11 |

## 근거가 아직 부족한 Tool 후보

| 시작점 | 현재 근거 | Potential AI Tool — Inferred | 추가 촬영 |
| --- | --- | --- | --- |
| 배송 조회 CTA | 표시만, Timeline Not Observed | get_shipping_status(), get_shipping_events() | P0-07: 운송장·단계·지연/완료 |
| 반품/교환 희망 문의 항목 | 표시만, 신청 Not Observed | get_return_eligibility(), request_return(), get_return_status(), request_exchange(), get_exchange_status() | P0-08/09: 사유·회수·비용·교환 옵션/재고·접수/완료 |
| 환불 예정액 | 표시액 Observed, 진행 Not Observed | get_refund_status() | P0-10: 승인 후 환불 상태·수단·금액·혜택 반환 |
| 최종/부분 취소 | 이번 요청 이후 결과 Not Observed | get_cancel_status(), request_partial_cancel() | P0-12: 가능/불가·부분 금액·최종 완료 |
| CS 문의 작성/내역/답변 | Not Observed | create_support_ticket(), list_support_tickets(), get_support_ticket(), send_support_message() | P0-11: 문의 제출·접수 ID·답변/종료 |
| 쿠폰 수동 선택/발급/해제 | Not Observed | claim_coupon(), list_coupons(), apply_coupon(), remove_coupon() | P1-03 |
| 찜 해제/리뷰 쓰기 | Not Observed | remove_from_wishlist(), submit_review() | P1-06/08 |
| 주소/수단 편집 | Not Observed | create_address(), update_address(), select_payment_method() | P0-04/P1-05 |
| 이미지 검색/Context 관리 | Not Observed | search_by_image(), get_user_context(), update_user_preferences() | P2-01 |
| 판매자센터/정산 | Not Observed | 판매자 운영 Tool 범위 미정 | P2-04; 소비자 스토어/카드 전표와 분리 |

## Tool 성공의 확인 관계 — Inferred

1. **상품/변형/판매자/리뷰**: 옵션 선택은 단순 숫자 변경이 아니다. 선택 구성과 현재 판매자·가격·배송 약속·리뷰 범위를 같이 반환하는지 확인해야 한다. 화면만으로 실제 ID 관계는 확정할 수 없다.
2. **Cart item / variant / quantity / selection / quote**: 2팩 구성·주문 수량2는 팩4 구성과 다르다. 재담기 성공은 합쳐진 수량·총액까지 확인하며, 선택과 쿠폰 가격이 달라질 때 견적을 다시 읽는다. 삭제는 대상 사라짐, 복원은 동일 구성/수량 돌아옴으로 확인한다.
3. **Checkout / payment / order**: 포인트 체크 상태와 사용 금액·총액을 분리한다. 제출 뒤 완료 안내와 신규 주문을 대조한다. 실패/응답 불명 상황에서 재시도·중복 요청 처리 방식은 미정이며 P0-05 근거가 필요하다.
4. **Order / cancel request / refund**: 요청 접수, 판매자 승인, 최종 취소, 환불 진행/완료는 따로 확인해야 한다. request_cancel_order()의 이번 UI 성공은 ‘취소요청’까지다. 과거 다른 주문 취소완료를 현재 요청 결과로 쓰지 않는다.
5. **Delivery / support**: 구매 전 ETA는 실제 배송 단계가 아니다. CS 조건 조회 Empty는 시스템 오류가 아니며, Chat Skeleton/채널 진입은 문의 접수가 아니다. 미래 Tool 결과에도 이런 구분이 필요하다.
6. **내부 정책/권한**: 관찰된 계정 화면이 로그인 필요 조건·데이터 권한·결제/취소 허용 정책의 증거는 아니다. 향후 테스트 환경 권한·확인 정책은 미정이다.

## 향후 평가 시나리오 후보 — 구현·실행하지 않음

- 조건 검색 후 적용된 필터와 낮은 가격순 결과를 읽는다. 편집 초기화 후 닫은 조건을 적용됐다고 설명하지 않는다.
- 베개 2팩을 수량1 담고 같은 구성 재담기로 수량2가 되었는지 확인한 뒤, 수량1로 감소시켜 견적을 비교한다.
- 마지막 상품 삭제로 Empty를 확인한 뒤 복구해 상품 2,800+배송3,000=5,800 사례처럼 구성 금액을 검증한다.
- 포인트 최대 체크만 해제한 상태와 사용 금액0을 구별하고, 주문서·완료·주문 상세의 금액을 비교한다.
- 상품준비중 주문의 취소 사유/환불 예정액을 확인하고 요청 접수 후 ‘취소요청’만 보고한다. 최종 환불 완료는 별도 조회 근거가 생긴 뒤 판단한다.
- 배송/반품/교환/실제 CS 메시지는 추가 촬영 전 관찰 기반 성공 시나리오를 확정하지 않는다.
