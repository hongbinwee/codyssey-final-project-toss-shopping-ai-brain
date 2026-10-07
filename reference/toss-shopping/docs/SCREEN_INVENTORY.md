# 화면 인벤토리 — 녹화 1·2·3 누적 분석

갱신일: 2026-10-04 (Asia/Seoul). Reference / UX / Workflow 관찰 자료이며 앱·API·Agent 코드는 구현하지 않았다. 브랜드·로고·이미지·문구를 구현 자산으로 복제하도록 지정하지 않는다.

## 분석 범위와 근거

| 원본 | 길이 | 전체 디코딩 프레임 | 대표 캡처 | SHA-256 |
| --- | --- | ---: | ---: | --- |
| [녹화 1](../../../toss쇼핑_화면/토스쇼핑화면녹화1.mp4) | 02:00.60 | 3,618 | 기존 50 | `ef27461b0d0c4dc235b6203be561b0bdc6d52097d50b0f1d2023e771ccafcb46` |
| [녹화 2](../../../toss쇼핑_화면/토스쇼핑화면녹화2.mp4) | 05:16.46 | 9,494 | 신규 49 | `b7da3b621959aa15675bcda017e041ab1af50727712d41a0312d702e6a562b7c` |
| [녹화 3](../../../toss쇼핑_화면/토스쇼핑화면녹화3.mp4) | 04:15.26 | 7,658 | 신규 31 | `e673d0d13a2eea996ae336aba43ad961dc08ec635febc37bfa9cc34b3124a5eb` |

세 원본은 모두 880×1920, HEVC, 30 fps이며 전체 디코딩 오류가 보고되지 않았다. 녹화 2·3은 처음부터 마지막 프레임 구간까지 0.5초 검토 프레임을 추출하고 1초 연속 타임라인을 모두 확인했다. 전환·선택·취소·수량·필터 초기화·결제수단 구간은 0.1~0.25초 간격으로 재검토했다. 모든 30 fps 프레임을 육안 확인했다는 뜻은 아니다. 대표 PNG는 상태 변화 기준으로 수동 선정해 FFmpeg로 원본에서 직접 추출했다.

- **누적 49개 화면/시트/독립 구역 유형, 대표 화면·상태 130개, Screenshot 130장.** 추가 자료로 유형 30개·대표 상태 80개가 늘었다. 49개는 라우트 수가 아니며, 기존 집계 방식대로 시트와 독립 구역을 포함한다.
- 기존 50개 PNG와 ID는 그대로 보존했다. 다섯 문서의 녹화 1 분석 원문은 [원본 문서 묶음](history/recording-1-docs.zip)에 보존했다. ZIP 안 상대 링크는 원래 docs 위치 기준이다.
- `Observed`: 화면 또는 전후 변화 확인. `Observed — 표시만`: 컨트롤/안내는 보이나 실행 결과 없음. `Not Observed`: 세 영상에서 확인 못함. `Inferred`: 해석·설계 제안.
- 시각은 **각 영상 시작 기준 경과 시간**. `V2-xx`/`V3-xx`는 새 상태 ID이며 기존 ID는 녹화 1. 파일명 순서로 촬영 순서나 세 영상의 연속 세션을 추정하지 않는다. 추출 시각은 약 1프레임 오차가 가능하다.
- 터치 표시는 없으므로 버튼/제스처 구분이 불명확한 경우 결과까지만 기록한다. 기기 시계·보상·알림은 주문 성공 증거가 아니다. 개인정보는 문서에 재전사하지 않았다.
- `returns`는 계속 빈 폴더다. `shipping`에는 **구매 전 배송 안내**만 있으며 배송 추적 캡처는 없다. 미관찰 화면의 대체 이미지를 만들지 않았다.

관련 문서: [이동·Interaction](SHOPPING_FLOW.md), [UI 패턴](UI_PATTERNS.md), [Agent Action](AGENT_ACTION_MAP.md), [남은 추가 촬영](MISSING_CAPTURE_CHECKLIST.md).

## 누적 유형별 집계

| 유형 | 대표 상태 수 |
| --- | --- |
| Shopping Home | 4 |
| Product Detail | 18 |
| Wishlist Feedback | 2 |
| Cart | 16 |
| Zero Price Promotion | 1 |
| Reviews Page | 4 |
| Embedded Reviews | 2 |
| Beauty Home | 1 |
| Oasis Home | 1 |
| Category | 4 |
| Beauty Product List | 2 |
| Daily Deals | 2 |
| Prime Offer | 3 |
| Quick Checkout | 4 |
| Recent Views | 2 |
| Seller Deals | 1 |
| Campaign Collection | 1 |
| Coupon Benefits | 1 |
| Seasonal Home | 1 |
| Full Checkout | 5 |
| Address Selection | 1 |
| Delivery Request | 1 |
| CS Topics | 1 |
| CS Subtopics | 3 |
| CS Channel Sheet | 1 |
| CS Chat | 1 |
| CS Order Query Empty | 5 |
| Product Gallery Viewer | 2 |
| Order Complete | 1 |
| My Shopping | 1 |
| Order List | 2 |
| Order Detail | 4 |
| Card Receipt | 2 |
| Cancel Reason | 3 |
| Cancel Confirmation | 1 |
| Cancel Requested | 1 |
| Product Shipping Info | 1 |
| Seller Store | 1 |
| Option Overview Sheet | 1 |
| Purchase Limit Modal | 1 |
| Category Product List | 1 |
| Search Input | 2 |
| Search Results | 8 |
| Search Filter | 5 |
| Search Sort Sheet | 1 |
| Price Comparison | 1 |
| Wishlist Page | 1 |
| Photo Review Grid | 1 |
| Payment Method Selection | 1 |

## 기존 화면의 관찰 범위 갱신

| 영역 | 이번 변경 | 확인 범위 |
| --- | --- | --- |
| 검색/조건 | Not Observed → Observed | V3-01~15: 입력·결과·필터 적용·가격순. 초기화 후 결과 해제는 아직 없음 |
| 옵션/품절 | 표시만 → 선택 결과 Observed | V2-18/19/45~47, V3-16~18: 옵션·가격/판매자/리뷰 변경·품절·한도 초과 |
| 카트 | 부분 관찰 → 수량·복원·Empty·주문서 Observed | V2-23/24/48/49, V3-21~26. + 버튼 직접 증가·품절 항목은 없음 |
| 리뷰 | 정렬/사진 모아보기 Observed | V3-27~30. 단일 리뷰/사진 확대·작성은 없음 |
| 주문/결제 | 결과 없음 → 전체 주문서 결제·완료 Observed | V2-24~31. 녹화 1 간편 시트 결과는 여전히 미관찰 |
| 주소/결제수단 | 요약만 → 선택 화면 존재 Observed | V2-02/03, V3-31. 다른 값으로 바꾸고 적용한 결과는 없음 |
| 취소/CS | Not Observed → 요청/분류/빈 조회 Observed | V2-07~17/34~41. 최종 취소·환불·상담 메시지는 없음 |
| 찜/판매자 | 진입점만 → 목록/스토어 Observed | V3-24, V2-44. 찜 해제·판매자센터·정산은 없음 |

## 녹화 1의 기존 화면 기록

다음 19개 유형의 기존 캡처·설명은 **녹화 1만의 관찰 범위**로 보존한다. 이 부분의 “Not Observed/표시만”이 누적 판정을 의미하지는 않는다. 위 갱신표와 뒤의 추가 관찰 및 최종 확인표가 현재 판정이다.

## Shopping Home — 쇼핑 홈


> **추가 관찰 반영:** 검색 진입 결과는 V3-01~03, 사용자 아이콘의 내 쇼핑 이동은 V2-28로 Observed.


### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| H01 | 00:00.15 | Default | [screenshots/home/01_home_default.png](../screenshots/home/01_home_default.png) |

| H02 | 00:03.50 | Scrolled / Compact Header | [screenshots/home/02_home_scrolled.png](../screenshots/home/02_home_scrolled.png) |

| H03 | 00:09.00 | Banner Changed | [screenshots/home/03_home_banner_changed.png](../screenshots/home/03_home_banner_changed.png) |

| H04 | 01:01.20 | Reward Shortcuts Scrolled | [screenshots/home/25_home_reward_shortcuts_scrolled.png](../screenshots/home/25_home_reward_shortcuts_scrolled.png) |



### 목적



배너, 추천 상품과 쇼핑 내 탐색 탭을 통해 상품 탐색을 시작한다.



### 주요 UI



- 검색 입력처럼 보이는 진입 영역

- 사용자 아이콘·장바구니 배지

- 쇼핑 홈·뷰티·오아시스·카테고리·특가·환절기 탭

- 배너와 페이지 번호

- 포인트·쿠폰 받기 바로가기 행

- 2열 추천 상품 카드

- 앱 하단 내비게이션

- 스크롤 보상 안내/타이머



### 사용자 Action



- Observed: 세로 스크롤, 배너 변화, 보상 바로가기 행 가로 이동, 배너 상품 진입, 쇼핑 내 탭 전환.

- 표시만: 검색, 사용자 아이콘, 추천 카드의 장바구니 아이콘, 보상 미니 기능. 개별 진입 결과는 Not Observed.



### 연결 화면



- Home → Product Detail (약 00:09)

- Home → Beauty Home → Oasis Home → Category → Daily Deals → Seasonal Home → Home.

- 앱 하단 탭의 홈·혜택·증권·전체 목적 화면은 Not Observed.



### 관찰 한계와 상태 해석



초기 배너는 3/3, 닭다리 배너는 2/3. 약 00:07~09에 배너가 바뀌지만 자동 회전인지 손가락 이동인지 확정할 수 없다. 아래로 탐색하는 동안 검색/장바구니 아이콘만 남는 압축 헤더가 보이고 하단 탭바가 숨는 구간이 있다. 상단 쪽으로 돌아오면 전체 헤더와 탭바가 다시 보인다. 추천 제목에 이용자 이름과 AI/광고 배지가 보이지만 개인화 알고리즘은 Not Observed.



## Product Detail — 상품 상세


> **추가 관찰 반영:** 옵션 변경·갤러리·품절·옵션 시트·가격 비교 목적지·배송 안내·판매자 스토어는 아래 추가 관찰에서 Observed로 갱신.


### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| PD01 | 00:10.30 | Default | [screenshots/product-detail/04_product_detail_default.png](../screenshots/product-detail/04_product_detail_default.png) |

| PD02 | 00:11.70 | Scrolled / Opaque Header | [screenshots/product-detail/05_product_detail_scrolled.png](../screenshots/product-detail/05_product_detail_scrolled.png) |

| PD03 | 00:17.00 | Wishlist Selected | [screenshots/product-detail/08_product_detail_wish_selected.png](../screenshots/product-detail/08_product_detail_wish_selected.png) |

| PD04 | 00:18.50 | Cart Added / Snackbar | [screenshots/product-detail/09_product_detail_cart_added.png](../screenshots/product-detail/09_product_detail_cart_added.png) |

| PD05 | 00:41.20 | Inline Pack Options / 1 Pack Selected | [screenshots/product-detail/18_product_pack_options_inline.png](../screenshots/product-detail/18_product_pack_options_inline.png) |

| PD06 | 00:49.00 | Information Collapsed | [screenshots/product-detail/22_product_information_collapsed.png](../screenshots/product-detail/22_product_information_collapsed.png) |

| PD07 | 00:51.10 | Information Expanded | [screenshots/product-detail/23_product_information_expanded.png](../screenshots/product-detail/23_product_information_expanded.png) |

| PD08 | 00:54.60 | Daily Purchase Limit Displayed | [screenshots/product-detail/24_product_daily_purchase_limit.png](../screenshots/product-detail/24_product_daily_purchase_limit.png) |

| PD09 | 01:15.93 | Skeleton | [screenshots/product-detail/36_product_detail_skeleton.png](../screenshots/product-detail/36_product_detail_skeleton.png) |

| PD10 | 01:16.10 | Bundle Product / Default | [screenshots/product-detail/37_product_bundle_detail.png](../screenshots/product-detail/37_product_bundle_detail.png) |



### 목적



상품 정보·가격·후기·배송 예상·판매자를 확인하고 찜, 담기, 구매 행동을 시작한다.



### 주요 UI



- 상단 뒤로·공유·검색·장바구니 배지

- 대표 이미지와 1/4·1/3·1/6 표시

- 비슷한 상품 진입점

- 상품명·원산지 안내·카테고리 순위

- 할인/기존가/판매가/단위가격

- 가격 비교하기

- 프라임 적립 안내

- 리뷰 요약·배송 예정·판매자 행

- 중량/팩 옵션 목록

- 리뷰/상품 정보 탭

- 접힌 상세 이미지·자세히 보기

- 배송·교환반품·상품·판매자 정보 링크

- 찜·장바구니·0원 뽑기·구매하기 하단 CTA



### 사용자 Action



- Observed: 상세 진입·스크롤, 찜 등록, 장바구니 담기, 리뷰 페이지 진입/뒤로, 자세히 보기로 이미지 확장, 0원 프로모션 열기/닫기, 구매 CTA로 프라임 안내 진입.

- 표시만: 이미지 넘기기, 공유, 가격 비교, 판매자/배송/교환반품 정보 클릭, 팩 옵션 변경, 품절 표시 및 여러 속성의 선택 순서는 Not Observed.



### 연결 화면



- Home / Daily Deals / Recent Views → Product Detail.

- Product Detail → Wishlist Feedback / Cart / Reviews Page / Zero Price Promotion / Prime Offer → Quick Checkout.



### 관찰 한계와 상태 해석



초기엔 이미지 위 투명한 헤더, 스크롤 후엔 불투명 헤더. 구매 CTA는 상세·리뷰·확장 이미지의 스크롤에도 하단에 남는다. PD05의 1팩 20,800원·2팩 40,500원·3팩 73,000원은 본문 선택 후보와 1팩 초기 선택의 표시 근거다. 다른 팩 선택으로 실제 상품명/총액이 바뀌는 장면은 Not Observed. PD08은 하루 최대 1개 구매 안내이며 품절과 다르다. PD09는 짧은 진입 애니메이션 중 Skeleton이어서 이전 화면의 좁은 가장자리가 남아 있다. 원본을 자르지 않았다.



## Wishlist Feedback — 찜 등록 피드백 시트


> **추가 관찰 반영:** V3-24에서 찜 목록도 확인. 상세 하트 해제 및 목록 X 삭제 결과는 계속 Not Observed.


### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| W01 | 00:13.20 | Added / Recommendation Sheet | [screenshots/etc/06_wishlist_added_sheet.png](../screenshots/etc/06_wishlist_added_sheet.png) |

| W02 | 00:15.55 | Recommendation Row Scrolled | [screenshots/etc/07_wishlist_recommendations_scrolled.png](../screenshots/etc/07_wishlist_recommendations_scrolled.png) |



### 목적



찜 등록 성공을 알리고 유사 상품으로 후속 탐색을 제안한다.



### 주요 UI



- 어두워진 상세 배경

- 등록 상품 썸네일·추가 완료 문구

- 찜 바로가기

- 유사 상품 가로 카드

- 닫기 CTA

- 상단 손잡이



### 사용자 Action



- Observed: 빈 하트 → 채워진 하트, 등록 안내 시트, 추천 행 가로 스크롤, 시트 닫힌 뒤 상세 복귀.

- 표시만: 찜 목록 바로가기 결과, 찜 해제 결과는 Not Observed.



### 연결 화면



- Product Detail → Wishlist Feedback → Product Detail.



### 관찰 한계와 상태 해석



시트가 00:12경 열린다. 01:20경 다른 상품에서도 반복된다. 이후 시트 위치가 내려가는 모습이 있으나 닫기 버튼과 손잡이 제스처 중 정확한 입력은 확정하지 않는다. 별도 찜 목록 페이지는 촬영되지 않았다.



## Cart — 장바구니


> **추가 관찰 반영:** 수량 감소·재담기 증가·개별 선택·복원·Empty·전체 주문서 이동을 아래 추가 관찰에서 Observed로 갱신.


### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| CT01 | 00:21.80 | 8 Items / All Selected | [screenshots/cart/10_cart_all_selected_8_items.png](../screenshots/cart/10_cart_all_selected_8_items.png) |

| CT02 | 00:25.30 | Scrolled / Shipping Groups | [screenshots/cart/11_cart_scrolled_shipping_groups.png](../screenshots/cart/11_cart_scrolled_shipping_groups.png) |

| CT03 | 00:27.40 | 7 Items / Single Deleted | [screenshots/cart/12_cart_single_deleted_7_items.png](../screenshots/cart/12_cart_single_deleted_7_items.png) |

| CT04 | 00:30.65 | None Selected / Recalculating | [screenshots/cart/13_cart_all_deselected.png](../screenshots/cart/13_cart_all_deselected.png) |

| CT05 | 00:31.60 | Group Selected / Recalculating | [screenshots/cart/14_cart_group_selected_2_items.png](../screenshots/cart/14_cart_group_selected_2_items.png) |

| CT06 | 00:32.25 | Selected Delete Confirmation | [screenshots/cart/15_cart_selected_delete_confirmation.png](../screenshots/cart/15_cart_selected_delete_confirmation.png) |

| CT07 | 00:33.50 | 5 Items / None Selected / Deleted Feedback | [screenshots/cart/16_cart_batch_deleted_5_items.png](../screenshots/cart/16_cart_batch_deleted_5_items.png) |

| CT08 | 01:42.00 | 5 Items / All Selected | [screenshots/cart/44_cart_all_selected_5_items.png](../screenshots/cart/44_cart_all_selected_5_items.png) |



### 목적



상품과 배송 묶음, 선택 항목 및 결제 금액을 관리한다.



### 주요 UI



- 장바구니 개수·최근 본·찜 탭

- 전체 선택·선택 삭제

- 배송 묶음 체크박스

- 무료배송 임계액 안내·추가 추천

- 상품별 체크박스/이미지/가격/도착 예정/X

- −·수량·+

- 배송비 포함 묶음 금액

- 할인/프라임 안내

- 고정 주문 CTA

- 삭제 Snackbar와 다시 담기

- 삭제 확인 Modal



### 사용자 Action



- Observed: 담기 후 8건 진입, 스크롤, X로 단일 삭제, 7건/92,540원으로 갱신, 전체 선택 해제, 오아시스 그룹 선택, 2개 선택 삭제 확인, 삭제 후 5건, 재진입 시 전체 5건 선택 표시, 최근 본 탭 전환.

- 표시만: 수량 변경, 개별 체크박스만의 토글, 다시 담기, 금액 상세보기, 선택 상품 주문서 진입, 품절 처리는 Not Observed.



### 연결 화면



- Product Detail → Cart → Product Detail.

- Cart → Recent Views → Product Detail.

- Cart → Checkout은 CTA만 보이고 실제 전환은 Not Observed.



### 관찰 한계와 상태 해석



처음부터 기존 7개 상품이 있었고 담기 후 8개가 된다. 영상은 빈 장바구니에서 시작하지 않는다. 8건 95,740원 → 1개 삭제 후 7건 92,540원 → 선택 2개 삭제 후 5건. 2개 선택 시 10,600원 표시, 나중에 5건 전체 선택 시 81,940원. 배송비·프로모션의 상세 산식은 Not Observed. 상품 삭제 Toast가 보여도 주문 취소의 근거는 아니다. 전체 해제 후의 빈 선택은 장바구니 Empty State가 아니다. CTA의 흐려짐은 관찰되지만 탭 불능까지 시험한 것은 아니다.



## Zero Price Promotion — 0원 프로모션 시트



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| Z01 | 00:36.20 | Open | [screenshots/etc/17_zero_price_promotion_sheet.png](../screenshots/etc/17_zero_price_promotion_sheet.png) |



### 목적



상품을 받을 수 있다는 프로모션 안내로 진입한다.



### 주요 UI



- 상세 배경 Dim

- 손잡이

- 가격 비교 애니메이션

- 받는 방법 알아보기

- 닫기



### 사용자 Action



- Observed: 상세의 0원 뽑기에서 안내 시트가 열리고 뒤에 닫힘.

- 표시만: 받는 방법 알아보기 후속 화면은 Not Observed.



### 연결 화면



- Product Detail → Zero Price Promotion → Product Detail.



### 관찰 한계와 상태 해석



당첨·주문·무료 상품 수령 완료를 의미하지 않는다. 다른 사람의 당첨 Snackbar도 현재 이용자 주문 성공의 근거가 아니다.



## Reviews Page — 전체 리뷰 화면


> **추가 관찰 반영:** 정렬 변경·사진 모아보기를 V3-27~30에서 Observed로 갱신. 단일 리뷰 상세/사진 확대는 계속 Not Observed.


### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| RV01 | 00:43.90 | Full List | [screenshots/reviews/19_reviews_full_list.png](../screenshots/reviews/19_reviews_full_list.png) |



### 목적



상품 리뷰를 별도 화면에서 읽고 정렬·사진 탐색 진입점을 확인한다.



### 주요 UI



- 뒤로

- 상품의 모든 상점 리뷰 제목

- 평점과 개수

- 사진 리뷰 썸네일·더보기

- 전체 리뷰·추천순 드롭다운

- 사진/본문/옵션/판매자·작성일·도움돼요

- 하단 구매 CTA



### 사용자 Action



- Observed: 00:43경 상세 평점 행에서 전체 리뷰 화면으로 가로 전환, 00:44경 뒤로 상세 복귀.

- 표시만: 추천순 열기/정렬 변경, 사진 탭/리뷰 상세, 리뷰 작성은 Not Observed.



### 연결 화면



- Product Detail → Reviews Page → Product Detail.



### 관찰 한계와 상태 해석



RV01은 안정된 리뷰 목록 상태. 단일 리뷰 상세 화면이나 사진 전체보기와 혼동하지 않는다. 하단 0원 뽑기/구매하기 CTA가 남아 있다.



## Embedded Reviews — 상세 안의 리뷰 구역



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| RV02 | 00:45.80 | Inline Summary | [screenshots/reviews/20_reviews_inline_summary.png](../screenshots/reviews/20_reviews_inline_summary.png) |

| RV03 | 00:46.90 | Scrolled / Sticky Tab | [screenshots/reviews/21_reviews_sticky_tab_scrolled.png](../screenshots/reviews/21_reviews_sticky_tab_scrolled.png) |



### 목적



상세 페이지를 떠나지 않고 평점, 사진과 대표 후기를 확인한다.



### 주요 UI



- 리뷰 개수/평점

- 사진 썸네일 행

- 본문/작성자 마스킹/날짜/옵션/판매자

- 도움돼요 수와 아이콘

- 모든 리뷰 보기

- 리뷰·상품 정보 탭



### 사용자 Action



- Observed: 상세 스크롤로 리뷰 노출, 추가 스크롤에서도 상단 탭과 하단 구매 CTA 유지.

- 표시만: 사진 확대·도움돼요·모든 리뷰 보기 클릭 결과는 이 구간에서 Not Observed.



### 연결 화면



- Product Detail 안에서 Embedded Reviews ↔ Product Information.

- 상단 평점 행을 통한 Reviews Page 진입은 별도 RV01 근거.



### 관찰 한계와 상태 해석



상품마다 평점/후기/구매 옵션이 달라지는 것을 확인했다. 영상에 보이는 일부 리뷰가 전체 리뷰 데이터나 검증된 구매 리뷰 전부라는 뜻은 아니다.



## Beauty Home — 뷰티 홈



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| BH01 | 01:03.65 | Default | [screenshots/home/26_beauty_home.png](../screenshots/home/26_beauty_home.png) |



### 목적



뷰티 기획·브랜드·추천 상품으로 탐색 범위를 좁힌다.



### 주요 UI



- 뷰티 선택 탭

- 뷰티 배너와 페이지 번호

- 브랜드/하위 카테고리 원형 바로가기

- 추천 카드

- 공통 헤더·하단 탭바



### 사용자 Action



- Observed: 상단 뷰티 탭 진입, 다음 오아시스 탭으로 이동.

- 표시만: 브랜드 아이콘 클릭 결과는 Not Observed.



### 연결 화면



- Shopping Home → Beauty Home → Oasis Home.



### 관찰 한계와 상태 해석



배너가 1/26을 표시한다. 모든 배너를 넘기는 장면은 Not Observed.



## Oasis Home — 오아시스 홈



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| OH01 | 01:04.75 | Default | [screenshots/home/27_oasis_home.png](../screenshots/home/27_oasis_home.png) |



### 목적



별도 판매 영역의 카테고리와 인기 상품을 탐색한다.



### 주요 UI



- 선택된 오아시스 탭

- 배너

- 과일·유기농 등 하위 바로가기

- 인기 상품 가로 행

- 공통 헤더·하단 탭바



### 사용자 Action



- Observed: 탭 진입 후 카테고리로 이동.

- 표시만: 과일 등 하위 이동, 개별 인기 상품 선택은 Not Observed.



### 연결 화면



- Beauty Home → Oasis Home → Category.



### 관찰 한계와 상태 해석



장바구니에도 오아시스 상품이 별도 배송 묶음으로 나타난다. 판매 영역과 묶음 조건이 동일한 도메인 객체인지는 Inferred.



## Category — 카테고리


> **추가 관찰 반영:** 문구·학용품 및 신선식품 하위 분류 진입을 V2 05:00~08에서 확인. 대표 V2-50.


### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| C01 | 01:06.00 | Food Selected | [screenshots/etc/28_category_food.png](../screenshots/etc/28_category_food.png) |

| C02 | 01:07.85 | Living Selected | [screenshots/etc/29_category_living.png](../screenshots/etc/29_category_living.png) |

| C03 | 01:08.95 | Fashion Selected | [screenshots/etc/30_category_fashion.png](../screenshots/etc/30_category_fashion.png) |

| C04 | 01:10.10 | Beauty Selected | [screenshots/etc/31_category_beauty.png](../screenshots/etc/31_category_beauty.png) |



### 목적



대분류에서 하위 분류 또는 전체 상품 목록으로 이동한다.



### 주요 UI



- 왼쪽 대분류 목록

- 선택된 분류 강조

- 오른쪽 하위 카테고리 원형 이미지

- 각 분류의 전체보기

- 검색·장바구니

- 하단 탭바



### 사용자 Action



- Observed: 식품 → 생활용품 → 패션 → 뷰티 선택, 우측 콘텐츠 이동, 뷰티 전체보기 진입.

- 표시만: 개별 원형 하위 분류 클릭 결과는 Not Observed.



### 연결 화면



- Oasis Home → Category

- Category (Beauty) → Beauty Product List → 뒤로 Category.



### 관찰 한계와 상태 해석



대분류 선택에 맞춰 해당 영역이 우측 위에 나타난다. 하나의 긴 콘텐츠 안에서 이동하는 모습과 다음 분류의 일부가 보인다. 우측 자체 스크롤 영역의 정확한 경계는 영상만으로 확정하지 않는다.



## Beauty Product List — 뷰티 상품 목록



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| L01 | 01:10.70 | Skeleton | [screenshots/product-list/32_beauty_list_skeleton.png](../screenshots/product-list/32_beauty_list_skeleton.png) |

| L02 | 01:11.25 | Loaded | [screenshots/product-list/33_beauty_list_loaded.png](../screenshots/product-list/33_beauty_list_loaded.png) |



### 목적



선택한 분류의 상품 카드에서 상세 탐색을 시작한다.



### 주요 UI



- 제목 뷰티·아래 화살표

- 뒤로·검색·장바구니

- 하위 카테고리 아이콘

- 2열 카드

- 가격/리뷰/혜택

- Skeleton



### 사용자 Action



- Observed: 카테고리 전체보기 → Skeleton → 카드 목록, 뒤로 카테고리 복귀.

- 표시만: 제목 드롭다운, 하위 분류 클릭, 상품 카드 선택은 Not Observed.



### 연결 화면



- Category → Beauty Product List → Category.



### 관찰 한계와 상태 해석



로딩에서 회색 원과 사각형이 실제 아이콘·상품 카드로 교체된다. 최종 목록에는 앱 공통 하단 탭바가 보이지 않는다. 검색 결과 목록으로 분류하지 않는다.



## Daily Deals — 하루 특가 목록



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| D01 | 01:13.75 | Default | [screenshots/product-list/34_daily_deals_default.png](../screenshots/product-list/34_daily_deals_default.png) |

| D02 | 01:15.20 | Scrolled | [screenshots/product-list/35_daily_deals_scrolled.png](../screenshots/product-list/35_daily_deals_scrolled.png) |



### 목적



시간 제한 특가 목록에서 상품을 고른다.



### 주요 UI



- 특가 탭

- 하루 특가·셀러 특가·기획전·쿠폰 혜택 하위 탭

- 기획 배너

- 카운트다운

- 상품 이미지·가격·할인·리뷰

- 하단 탭바/압축 헤더



### 사용자 Action



- Observed: 특가 탭 진입, 목록 스크롤, 첫 닭강정 상품 상세 진입, 뒤로 복귀, 하위 탭 전환.

- 표시만: 카드 안의 장바구니 아이콘을 누른 결과는 Not Observed.



### 연결 화면



- Category → Daily Deals → Product Detail (Bundle)

- Daily Deals → Seller Deals → Campaign Collection → Coupon Benefits.



### 관찰 한계와 상태 해석



스크롤 시 기획 배너/검색 영역이 시야 밖으로 나가고 하위 탭과 검색·장바구니 축약 아이콘이 상단에 남는 모습이 보인다. 하단 탭바도 스크롤 중 숨는 구간이 있다.



## Prime Offer — 프라임 가입 권유 오버레이



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| P01 | 01:25.00 | Open | [screenshots/checkout/38_prime_offer_open.png](../screenshots/checkout/38_prime_offer_open.png) |

| P02 | 01:28.00 | 7 Day Suppression Selected | [screenshots/checkout/39_prime_offer_suppressed_7_days.png](../screenshots/checkout/39_prime_offer_suppressed_7_days.png) |



### 목적



구매 전 추가 적립 가입 경로와 바로 주문 경로를 제시한다.



### 주요 UI



- 상세 배경 Dim

- 애니메이션 심볼

- 최대 적립 안내

- 가입하고 주문하기

- 바로 주문하기

- 7일 동안 보지 않기 체크



### 사용자 Action



- Observed: 구매하기 → 오버레이, 7일 동안 보지 않기 체크 표시, 바로 주문하기 쪽에서 주문 시트 진입.

- 표시만: 실제 프라임 가입 완료, 재방문 시 7일 억제 유지 효과는 Not Observed.



### 연결 화면



- Product Detail → Prime Offer → Quick Checkout.



### 관찰 한계와 상태 해석



P01은 체크 미선택, P02는 선택. 가입하지 않고 진입한 것으로 해석되는 경로지만 가입 상태의 서버 값은 Not Observed.



## Quick Checkout — 간편 주문·결제 시트


> **추가 관찰 반영:** 녹화 2의 결제 성공은 전체 주문서 경로. 이 간편 시트 슬라이더 결과의 Not Observed 판정은 유지.


### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| Q01 | 01:30.80 | Loading | [screenshots/checkout/40_quick_checkout_loading.png](../screenshots/checkout/40_quick_checkout_loading.png) |

| Q02 | 01:31.35 | Ready / Points Applied | [screenshots/checkout/41_quick_checkout_ready.png](../screenshots/checkout/41_quick_checkout_ready.png) |

| Q03 | 01:32.30 | Slider Dragged Right | [screenshots/payment/42_payment_slider_dragged.png](../screenshots/payment/42_payment_slider_dragged.png) |

| Q04 | 01:35.90 | Slider Returned To Start | [screenshots/payment/43_payment_slider_reset.png](../screenshots/payment/43_payment_slider_reset.png) |



### 목적



상품 수량과 최종 금액, 이미 설정된 배송지·카드·포인트를 확인하고 결제 제스처를 시작한다.



### 주요 UI



- 상단 손잡이

- 17,842원·무료배송

- 수량 −/1/+

- 상품명

- 포인트 차감 −148원

- 도착 예정과 배송지 요약

- 선택된 카드·일시불

- 포인트 사용 행

- 프라임 적립 안내

- 로딩 점 → 밀어서 결제하기

- 주문 확인·정보 제공 동의 문구



### 사용자 Action



- Observed: 주문 시트 로딩 → 결제 준비, 포인트 148원 사용 표시, 슬라이더 오른쪽 이동 → 왼쪽 초기 위치 복귀, 이후 시트가 닫히고 상세로 복귀.

- 표시만: 배송지 변경/선택, 카드 변경/선택, 포인트 변경, 수량 변경, 동의 상세, 결제 승인/실패, 주문 완료는 Not Observed.



### 연결 화면



- Product Detail → Prime Offer → Quick Checkout → 슬라이더 상태 변화 → Product Detail.

- Quick Checkout → Order Complete는 Not Observed.



### 관찰 한계와 상태 해석



별도 전체 화면 주문서가 아닌 Bottom Sheet이다. 17,990원 상품에 148원 사용 표시와 17,842원 금액이 보인다. 금액 차이가 148원임은 확인되나 포인트 적용 정책/자동 사용 동작 전체는 Not Observed. 01:31.8경 핸들이 오른쪽으로 움직이고 01:35.5경부터 돌아와 01:35.9에 초기 위치다. 오류 문구 없이 복귀했으므로 결제 실패·취소로 단정하지 않는다. 결제 승인 화면, 외부 인증, 주문 번호가 없다.



## Recent Views — 최근 본 상품



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| RC01 | 01:46.50 | Default | [screenshots/etc/45_recent_views_default.png](../screenshots/etc/45_recent_views_default.png) |

| RC02 | 01:47.20 | Item Removed / Delete Controls | [screenshots/etc/46_recent_views_item_removed.png](../screenshots/etc/46_recent_views_item_removed.png) |



### 목적



최근 탐색 상품을 다시 열거나 이력에서 제거한다.



### 주요 UI



- 최근 본 선택 탭

- 2열 상품 카드

- 가격·리뷰·혜택

- 상품 이미지 안 장바구니 아이콘

- 삭제 모드의 X



### 사용자 Action



- Observed: 장바구니 → 최근 본 탭, LA갈비 카드가 사라지고 나머지 카드가 재배치됨, 다른 카드의 X 표시, 이후 상품 상세 복귀.

- Inferred: 삭제 모드에 들어간 정확한 입력(길게 누르기 등)은 확정 불가.



### 연결 화면



- Cart → Recent Views → Product Detail.



### 관찰 한계와 상태 해석



삭제 전 RC01과 삭제 후 RC02를 비교한다. 장바구니 5건은 그대로 표시된다. 최근 본 이력 제거와 장바구니 삭제는 별개 Action으로 취급한다.



## Seller Deals — 셀러 특가 목록



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| SD01 | 01:55.30 | Default | [screenshots/product-list/47_seller_deals_tab.png](../screenshots/product-list/47_seller_deals_tab.png) |



### 목적



추천 셀러의 특가 상품을 탐색한다.



### 주요 UI



- 선택된 셀러 특가 탭

- 추천 셀러 제목

- 상품 이미지·판매자/브랜드 표기·가격

- 공통 헤더·하단 탭바



### 사용자 Action



- Observed: 셀러 특가 탭 선택 후 기획전 탭 전환.

- 표시만: 상품 선택 및 판매자 상세 이동은 Not Observed.



### 연결 화면



- Daily Deals → Seller Deals → Campaign Collection.



### 관찰 한계와 상태 해석



소비자용 특가 컬렉션이다. 판매자 페이지·판매자센터·정산 화면과 구분한다.



## Campaign Collection — 기획전 목록



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| CP01 | 01:56.25 | Default | [screenshots/product-list/48_campaign_collection_tab.png](../screenshots/product-list/48_campaign_collection_tab.png) |



### 목적



기획 묶음에서 관련 상품과 더보기 진입점을 확인한다.



### 주요 UI



- 선택된 기획전 탭

- 묶음 제목

- 상품 가로 행

- 더보기

- 공통 헤더·하단 탭바



### 사용자 Action



- Observed: 기획전 탭 진입 후 쿠폰 혜택 전환.

- 표시만: 더보기 및 상품 클릭 결과는 Not Observed.



### 연결 화면



- Seller Deals → Campaign Collection → Coupon Benefits.



### 관찰 한계와 상태 해석



약 01:56에 침구류 기획 묶음이 보인다. 하위 기획전 상세 화면은 Not Observed.



## Coupon Benefits — 쿠폰 혜택 상품 랭킹



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| CB01 | 01:57.20 | Loaded / Food Ranking | [screenshots/product-list/49_coupon_benefits_ranking.png](../screenshots/product-list/49_coupon_benefits_ranking.png) |



### 목적



혜택이 표시된 상품을 분류별로 탐색한다.



### 주요 UI



- 선택된 쿠폰 혜택 탭

- 식품·패션 등 Chip

- 순번 상품 행

- 할인 후 가격/기존 가격

- 할인혜택 큰 순 표시



### 사용자 Action



- Observed: 탭 진입 후 식품 랭킹 콘텐츠가 로드됨, 다음 환절기 탭 이동.

- 표시만: Chip 전환, 정렬 조작, 쿠폰 받기/선택/적용은 Not Observed.



### 연결 화면



- Campaign Collection → Coupon Benefits → Seasonal Home.



### 관찰 한계와 상태 해석



탭 진입 직후 잠깐 본문이 비어 있다가 상품이 표시된다. 빈 쿠폰함이라는 Empty State로 분류하지 않는다. 보유 쿠폰 목록이나 주문서의 쿠폰 적용 화면은 Not Observed.



## Seasonal Home — 환절기 기획 홈



### Screenshot / 상태



| ID | 경과 시각 | 대표 상태 | Screenshot |

| --- | --- | --- | --- |

| SH01 | 01:58.20 | Default | [screenshots/home/50_seasonal_home.png](../screenshots/home/50_seasonal_home.png) |



### 목적



시즌 기획 배너와 추천 상품을 탐색한다.



### 주요 UI



- 환절기 선택 탭

- 기획 배너

- 이용자 이름이 들어간 추천 영역

- 인기 특가

- 하단 탭바



### 사용자 Action



- Observed: 탭 진입 후 쇼핑 홈으로 복귀.

- 표시만: 추천 상품 선택 결과는 Not Observed.



### 연결 화면



- Daily Deals 계열 → Seasonal Home → Shopping Home.



### 관찰 한계와 상태 해석



01:58경 진입. 추천 영역에 표시되는 이름의 변경만으로 계정 전환이나 개인화 근거를 확정하지 않는다.




## 추가 촬영에서 확인한 화면·상태

아래 표의 경과 시각은 각 영상 기준이며 Screenshot 링크는 `reference/toss-shopping/` 기준 표기를 쓴다. 각 표의 상태는 모두 Observed; 실행되지 않은 컨트롤은 본문에서 표시만으로 구분한다.

## Full Checkout — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-01 | 녹화 2 00:00.80 | 주문서 초기 / 쿠폰·포인트 적용 | [screenshots/checkout/051_v2_full_checkout_default.png](../screenshots/checkout/051_v2_full_checkout_default.png) |
| V2-04 | 녹화 2 00:10.00 | 주문서 하단 / 비용·동의 요약 | [screenshots/checkout/054_v2_full_checkout_summary.png](../screenshots/checkout/054_v2_full_checkout_summary.png) |
| V2-24 | 녹화 2 02:10.00 | 선택 1개 주문서 / 적용할 쿠폰 없음 | [screenshots/checkout/074_v2_checkout_from_cart_no_coupon.png](../screenshots/checkout/074_v2_checkout_from_cart_no_coupon.png) |
| V2-25 | 녹화 2 02:15.30 | 최대 사용 체크 해제 / 158원 유지 | [screenshots/checkout/075_v2_checkout_max_points_unchecked.png](../screenshots/checkout/075_v2_checkout_max_points_unchecked.png) |
| V2-26 | 녹화 2 02:19.60 | 포인트 0 / 결제금액 6,990원 | [screenshots/checkout/076_v2_checkout_points_zero.png](../screenshots/checkout/076_v2_checkout_points_zero.png) |

### 목적

주문 상품·배송지·할인·결제 조건을 최종 확인하는 전체 화면 주문서.

### 주요 UI

배송지/요청사항, 상품 요약·주문 금액, 쿠폰 변경, 카드 변경, 포인트 입력·최대 사용 체크, 총액/할인/배송비, 동의 문구, 하단 결제 CTA.

### 사용자 Action

Observed: 주소/요청사항 페이지 열기와 복귀, 세로 스크롤, 최대 포인트 체크 해제, 포인트 158 → 0 입력·확인, 결제 실행과 완료 화면 확인.

### 연결 화면

Cart → Full Checkout → 주소/요청사항/결제수단 선택; Full Checkout → Order Complete.

### 관찰 한계와 상태 해석

V2 시작의 주문서 진입 과정은 없음. 실제 Cart → 주문서는 V2 02:07경 별도로 확인. 소시지 21,500−쿠폰 3,200−포인트 158=18,142원. 갈비 9,990−할인 3,000−158=6,832원; 포인트 0 입력 후 6,990원으로 결제. 새 주소/요청사항/결제수단 변경 성공, 쿠폰 선택 페이지, 복수 상품 주문서는 Not Observed.

## Address Selection — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-02 | 녹화 2 00:02.95 | 저장 배송지 목록 / 현재 주소 선택 | [screenshots/checkout/052_v2_address_selection.png](../screenshots/checkout/052_v2_address_selection.png) |

### 목적

받을 곳을 확인하고 배송지를 선택한다.

### 주요 UI

집·회사·임시 저장 주소 행, 현재 체크, 수정하기, 새로운 주소, 확인 CTA.

### 사용자 Action

Observed: 주문서의 변경 → 목록 열기 → 현재 선택 그대로 확인 → 주문서 복귀.

### 연결 화면

Full Checkout ↔ Address Selection.

### 관찰 한계와 상태 해석

현재 선택 주소를 다른 주소로 바꾸거나 주소 추가·수정·삭제한 결과는 Not Observed. 회사 행은 등록 안내가 보인다. 개인정보 값은 문서에 전사하지 않는다.

## Delivery Request — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-03 | 녹화 2 00:04.55 | 직접 입력 요청사항 / 키보드 | [screenshots/checkout/053_v2_delivery_request_editor.png](../screenshots/checkout/053_v2_delivery_request_editor.png) |

### 목적

배송 요청사항의 선택·직접 입력을 다룬다.

### 주요 UI

경비실/배송 전 연락/문 앞/택배함/직접 입력 후보, 기존 입력값, 글자 수 6/50, 키보드, 저장 CTA.

### 사용자 Action

Observed: 주문서의 요청사항 → 편집 페이지 → 기존 직접 입력값 그대로 저장 → 복귀.

### 연결 화면

Full Checkout ↔ Delivery Request.

### 관찰 한계와 상태 해석

입력값 실제 변경, 다른 프리셋 선택, 길이 초과/검증 결과는 Not Observed. 열린 키보드를 텍스트 수정 성공으로 세지 않는다.

## Prime Offer — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-05 | 녹화 2 00:13.25 | 프라임 가입·결제 제안 시트 | [screenshots/checkout/055_v2_prime_signup_offer.png](../screenshots/checkout/055_v2_prime_signup_offer.png) |

### 목적

주문서에서 프라임 가입·혜택을 제안한다.

### 주요 UI

배경 Dim, 월 5,900원 결제/기존 카드 요약, 결제하고 혜택받기 CTA.

### 사용자 Action

Observed: 추가 적립 안내에서 가입 제안 시트를 열고 원래 흐름으로 복귀.

### 연결 화면

Full Checkout ↔ Prime Offer.

### 관찰 한계와 상태 해석

녹화 1 P01/P02와 다른 가입 결제 제안 상태. 월 금액은 촬영 시 표시값. 실제 가입·회비 결제·해지 결과는 Not Observed.

## Product Detail — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-06 | 녹화 2 00:19.65 | 상품 이미지 4/5 | [screenshots/product-detail/056_v2_product_gallery_changed.png](../screenshots/product-detail/056_v2_product_gallery_changed.png) |
| V2-18 | 녹화 2 01:03.40 | 1.32kg 선택 / 가격·리뷰 변경 | [screenshots/product-detail/068_v2_product_weight_variant_selected.png](../screenshots/product-detail/068_v2_product_weight_variant_selected.png) |
| V2-19 | 녹화 2 01:16.70 | 품절 이미지·안내 / 품절 CTA | [screenshots/product-detail/069_v2_product_sold_out.png](../screenshots/product-detail/069_v2_product_sold_out.png) |
| V2-42 | 녹화 2 03:48.60 | 상품 할인 내역 펼침 | [screenshots/product-detail/092_v2_product_discount_expanded.png](../screenshots/product-detail/092_v2_product_discount_expanded.png) |
| V2-46 | 녹화 2 04:07.20 | 시트의 다른 옵션 선택 후 상세 갱신 | [screenshots/product-detail/096_v2_product_option_sheet_selection_applied.png](../screenshots/product-detail/096_v2_product_option_sheet_selection_applied.png) |
| V3-16 | 녹화 3 01:19.40 | 베개 크기·1팩 기본 선택 | [screenshots/product-detail/116_v3_product_pillow_pack_default.png](../screenshots/product-detail/116_v3_product_pillow_pack_default.png) |
| V3-17 | 녹화 3 01:21.60 | 2팩 선택 / 가격·판매자·리뷰 변화 | [screenshots/product-detail/117_v3_product_pillow_two_pack.png](../screenshots/product-detail/117_v3_product_pillow_two_pack.png) |
| V3-18 | 녹화 3 01:23.50 | 4팩 선택 / 가격·리뷰 변화 | [screenshots/product-detail/118_v3_product_pillow_four_pack.png](../screenshots/product-detail/118_v3_product_pillow_four_pack.png) |

### 목적

상품 이미지·변형 옵션·가격·리뷰·구매 가능 상태를 확인한다.

### 주요 UI

이미지 번호, 중량/크기 Chip, 팩 후보, 선택 체크, 가격·판매자·리뷰·배송 예정, 할인 Accordion, 옵션 전체보기, 품절 오버레이·CTA.

### 사용자 Action

Observed: 갤러리 1/5 → 2/5 → 4/5, 중량 1.5kg ↔ 1.32kg, 베개 1 → 2 → 4팩, 옵션 전체보기에서 다른 구성 선택, 할인 펼침, 품절 상태 확인.

### 연결 화면

Search Results / Category Product List / Cart → Product Detail; 상세 → 리뷰/갤러리/옵션 시트/배송 안내/판매자/가격 비교/CS/Cart.

### 관찰 한계와 상태 해석

소시지 중량 변경: 18,300원·리뷰 695 → 24,810원·리뷰 16이며 판매자와 배송 예정도 변한다. 베개 1/2/4팩: 9,490/14,860/30,451원, 평점·리뷰·판매자도 갱신. 팩 구성과 Cart 주문 수량은 다르다. 다른 크기 FREE/60×40cm 선택도 V3 01:53~54에 보이지만 중복 PNG는 추가하지 않음. 품절 상품의 구매 CTA는 흐리게 보이고 밤 12시 이후 구매 안내가 있다. 품절 옵션 선택, 품절 CTA 탭 결과, 찜 해제는 Not Observed.

## CS Topics — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-07 | 녹화 2 00:23.50 | 배송·취소·교환반품·기타 문의 | [screenshots/cs/057_v2_cs_topics.png](../screenshots/cs/057_v2_cs_topics.png) |

### 목적

상품 또는 주문에서 문의 종류를 정한다.

### 주요 UI

배송/주문 취소/교환·반품/다른 문의, 상담 지연 안내, 뒤로.

### 사용자 Action

Observed: 상세의 물음표 → 문의 분류; 주문 상세의 문의하기 → 같은 분류.

### 연결 화면

Product Detail / Order Detail → CS Topics → CS Subtopics / CS Channel Sheet.

### 관찰 한계와 상태 해석

교환·반품 메뉴 존재만 확인했다. 실제 반품·교환 접수 화면의 근거가 아니다.

## CS Subtopics — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-08 | 녹화 2 00:28.60 | 배송 하위 질문 | [screenshots/cs/058_v2_cs_delivery_subtopics.png](../screenshots/cs/058_v2_cs_delivery_subtopics.png) |
| V2-09 | 녹화 2 00:30.00 | 취소 하위 질문 | [screenshots/cs/059_v2_cs_cancel_subtopics.png](../screenshots/cs/059_v2_cs_cancel_subtopics.png) |
| V2-10 | 녹화 2 00:31.80 | 교환·반품 하위 질문 | [screenshots/cs/060_v2_cs_return_exchange_subtopics.png](../screenshots/cs/060_v2_cs_return_exchange_subtopics.png) |

### 목적

큰 문의 분류를 구체적인 질문으로 좁힌다.

### 주요 UI

배송: 지연/진행/완료 미수령/늦어서 취소/기타; 취소: 취소 희망/취소됨/기타; 반품·교환 희망/기타.

### 사용자 Action

Observed: 큰 분류를 열고 하위 항목 선택; 배송/취소 질문에서 대상 주문 조회 결과로 이동.

### 연결 화면

CS Topics → CS Subtopics → CS Order Query Empty / CS Channel Sheet.

### 관찰 한계와 상태 해석

반품·교환 희망 항목은 노출만 확인. 신청 사유·회수·교환 옵션·수수료 화면은 Not Observed.

## CS Channel Sheet — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-11 | 녹화 2 00:34.30 | 전화·채팅 연결 시트 | [screenshots/cs/061_v2_cs_channel_sheet.png](../screenshots/cs/061_v2_cs_channel_sheet.png) |

### 목적

문의 상담 채널을 선택한다.

### 주요 UI

핸들, Dim, 전화 상담/토스 앱 채팅 상담, 지연 안내.

### 사용자 Action

Observed: 기타 문의 → 시트 열림; 채팅 상담 → 채팅 목적 화면; 뒤로 원래 분류 복귀.

### 연결 화면

CS Topics / CS Subtopics → CS Channel Sheet → CS Chat.

### 관찰 한계와 상태 해석

전화 연결 결과, 업무시간별 상태, Sheet 드래그로 닫기 규칙은 Not Observed.

## CS Chat — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-12 | 녹화 2 00:38.00 | 채팅 진입 / Skeleton 유지 | [screenshots/cs/062_v2_cs_chat_skeleton.png](../screenshots/cs/062_v2_cs_chat_skeleton.png) |

### 목적

채팅 상담 목적 화면으로 진입한다.

### 주요 UI

뒤로, 본문 회색 줄/원 Skeleton, 하단 자리 표시 영역.

### 사용자 Action

Observed: 채팅 상담을 선택하면 Skeleton 화면이 몇 초 유지된 뒤 뒤로 복귀.

### 연결 화면

CS Channel Sheet → CS Chat → 이전 문의 분류.

### 관찰 한계와 상태 해석

실제 대화 본문·입력·메시지 전송·상담원 답변·문의 내역은 Not Observed. 오래 보인 Skeleton을 오류 또는 상담 접수 성공으로 해석하지 않는다.

## CS Order Query Empty — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-13 | 녹화 2 00:43.40 | 배송 지연 대상 주문 없음 | [screenshots/cs/063_v2_cs_delayed_orders_empty.png](../screenshots/cs/063_v2_cs_delayed_orders_empty.png) |
| V2-14 | 녹화 2 00:45.05 | 배송 내역 없음 | [screenshots/cs/064_v2_cs_shipping_history_empty.png](../screenshots/cs/064_v2_cs_shipping_history_empty.png) |
| V2-15 | 녹화 2 00:47.25 | 배송 완료 대상 주문 없음 | [screenshots/cs/065_v2_cs_delivered_orders_empty.png](../screenshots/cs/065_v2_cs_delivered_orders_empty.png) |
| V2-16 | 녹화 2 00:54.00 | 취소 도움 경로 / 주문한 상품 없음 | [screenshots/cs/066_v2_cs_cancelable_orders_empty.png](../screenshots/cs/066_v2_cs_cancelable_orders_empty.png) |
| V2-17 | 녹화 2 00:55.38 | 판매자 취소 대상 주문 없음 | [screenshots/cs/067_v2_cs_seller_canceled_orders_empty.png](../screenshots/cs/067_v2_cs_seller_canceled_orders_empty.png) |

### 목적

질문 조건에 맞는 주문이 조회되지 않았음을 안내한다.

### 주요 UI

경고 아이콘, 상황별 안내, 주문 목록 보기, 문의하기.

### 사용자 Action

Observed: 지연/배송 진행/배송 완료 미수령/취소 희망/판매자 취소 질문 → 각각 빈 결과.

### 연결 화면

CS Subtopics → CS Order Query Empty; 다음 주문 목록/문의 CTA는 표시만.

### 관찰 한계와 상태 해석

배송 내역 안내는 일반 배송만 확인 가능하며 오아시스·다른 상태 주문은 목록에서 확인하라는 문구. 판매자 취소 없음은 사용자가 취소한 과거 주문이 없다는 뜻이 아니다. V2 00:49에는 지연 주문 없음 설명이 추가로 보이나 같은 빈 결과 패턴으로 추가 캡처하지 않음. 실제 조회 기준·네트워크 에러는 Not Observed.

## Product Gallery Viewer — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-21 | 녹화 2 01:19.00 | 전체 화면 이미지 / 두 번째 사진·썸네일 | [screenshots/product-detail/071_v2_gallery_viewer_default.png](../screenshots/product-detail/071_v2_gallery_viewer_default.png) |
| V2-22 | 녹화 2 01:20.10 | 전체 화면 다음 이미지 | [screenshots/product-detail/072_v2_gallery_viewer_changed.png](../screenshots/product-detail/072_v2_gallery_viewer_changed.png) |

### 목적

상품 사진을 큰 화면으로 확인한다.

### 주요 UI

뒤로, 큰 이미지, 하단 썸네일·선택 테두리.

### 사용자 Action

Observed: 품절 상세 이미지 → 전체 화면 보기 → 다른 사진/표 이미지 → 뒤로.

### 연결 화면

Product Detail ↔ Product Gallery Viewer.

### 관찰 한계와 상태 해석

두 번째 사진과 정보표 사진 전환은 Observed. 썸네일 탭인지 가로 제스처인지 정확한 입력은 Inferred; 확대/핀치 제스처는 Not Observed.

## Cart — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-23 | 녹화 2 02:06.50 | 개별 선택 / 미선택 상품 쿠폰 가격 변화 | [screenshots/cart/073_v2_cart_single_selected_coupon_repriced.png](../screenshots/cart/073_v2_cart_single_selected_coupon_repriced.png) |
| V2-48 | 녹화 2 04:33.50 | 장바구니 상품 할인 내역 펼침 | [screenshots/cart/098_v2_cart_item_discount_expanded.png](../screenshots/cart/098_v2_cart_item_discount_expanded.png) |
| V2-49 | 녹화 2 04:36.60 | 마지막 항목 삭제 / 장바구니 비었어요 | [screenshots/cart/099_v2_cart_empty.png](../screenshots/cart/099_v2_cart_empty.png) |
| V3-21 | 녹화 3 02:11.80 | 2팩 옵션 / 주문 수량 1 | [screenshots/cart/121_v3_cart_pack_variant_quantity_one.png](../screenshots/cart/121_v3_cart_pack_variant_quantity_one.png) |
| V3-22 | 녹화 3 02:23.40 | 같은 옵션 재담기 / 주문 수량 2 | [screenshots/cart/122_v3_cart_duplicate_add_quantity_two.png](../screenshots/cart/122_v3_cart_duplicate_add_quantity_two.png) |
| V3-23 | 녹화 3 02:25.10 | 마이너스 / 수량 1·금액 재계산 | [screenshots/cart/123_v3_cart_quantity_decreased.png](../screenshots/cart/123_v3_cart_quantity_decreased.png) |
| V3-25 | 녹화 3 03:03.50 | 다시 담기 / 삭제한 항목 복원 | [screenshots/cart/125_v3_cart_deleted_item_restored.png](../screenshots/cart/125_v3_cart_deleted_item_restored.png) |
| V3-26 | 녹화 3 03:05.10 | 합계 펼침 / 상품 2,800·배송 3,000 | [screenshots/cart/126_v3_cart_order_quote_expanded.png](../screenshots/cart/126_v3_cart_order_quote_expanded.png) |

### 목적

선택한 옵션·주문 수량·가격·삭제/복구를 검토한다.

### 주요 UI

개별/전체 체크, 수량 Stepper, 상품 할인 펼침, 결제 예상 펼침, 배송비·합계, Fixed 주문 CTA, 삭제 Snackbar/다시 담기, Empty 안내.

### 사용자 Action

Observed: 개별 선택, 동일 옵션 재담기로 수량 1 → 2, 카트 −로 2 → 1, 할인/합계 펼침, 마지막 항목 삭제, Snackbar 다시 담기로 복원, 선택 상품 주문서 진입.

### 연결 화면

Product Detail → Cart → Full Checkout; Cart ↔ 최근 본/찜; Cart 삭제 → Empty → 다시 담기 → Cart.

### 관찰 한계와 상태 해석

베개는 2팩 옵션·주문 수량 1에서 14,860원, 재담기 후 주문 수량 2·29,720원. 전체 합계 96,800 → 111,660 → 96,800원, 항목 수 6 유지. + 버튼 직접 증가와 최대치/품절 항목 처리는 Not Observed. 소시지 선택에 따라 쿠폰 반영 가격 18,300/21,500원이 달라지는 사례를 확인했으나 배분 정책은 Inferred. 복원된 돼지고기 1개는 상품 2,800+배송 3,000=5,800원. V3-23의 Snackbar는 다른 항목 삭제 피드백과 겹치므로 감소 성공의 근거는 수량/금액이다.

## Order Complete — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-27 | 녹화 2 02:25.70 | 결제했어요 / 주문 결과 | [screenshots/payment/077_v2_payment_order_complete.png](../screenshots/payment/077_v2_payment_order_complete.png) |

### 목적

결제 완료 결과와 주문 다음 행동을 안내한다.

### 주요 UI

확인 아이콘·결제했어요, 상품·도착 예정·배송지, 488원 적립 진입점, 홈으로 가기/주문 상세 내역 보기.

### 사용자 Action

Observed: V2 전체 주문서 6,990원 결제 CTA → 로딩 → 결제했어요 → 홈으로 가기.

### 연결 화면

Full Checkout → Order Complete → Home → My Shopping.

### 관찰 한계와 상태 해석

결제 인증 과정, 적립 버튼 결과, 완료 화면의 주문 상세 버튼 결과는 Not Observed. 완료 화면과 뒤의 신규 주문 결제완료 상태가 결제 성공의 UI 근거. 영상만으로 결제 사업자 서버 기록을 확인한 것은 아니다. 녹화 1 Q03/Q04의 슬라이더 경로 성공을 입증하지 않는다.

## My Shopping — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-28 | 녹화 2 02:37.40 | 내 쇼핑 / 주문·혜택·바로가기 | [screenshots/orders/078_v2_my_shopping_dashboard.png](../screenshots/orders/078_v2_my_shopping_dashboard.png) |

### 목적

쇼핑 계정의 주문·혜택·리뷰·이력을 모아 보여준다.

### 주요 UI

포인트 잔액 158원, 적립 안내 488원, 쿠폰/리뷰/찜/문의 바로가기, 최근 본, 주문 Carousel/전체보기, 리뷰 쓰기 CTA.

### 사용자 Action

Observed: 홈 사용자 아이콘 → 내 쇼핑 → 주문 전체보기; 취소 요청 후 같은 현재 주문의 상태 재노출.

### 연결 화면

Home → My Shopping → Order List; 기타 바로가기는 표시만.

### 관찰 한계와 상태 해석

내 정보 편집, 로그인/로그아웃, 쿠폰함·포인트 내역·문의 내역 진입은 Not Observed. 자동 적립/확정 정책은 안내 표시 범위만 관찰.

## Order List — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-29 | 녹화 2 02:41.70 | 결제완료·취소완료·구매확정 주문 목록 | [screenshots/orders/079_v2_order_list_mixed_statuses.png](../screenshots/orders/079_v2_order_list_mixed_statuses.png) |
| V2-41 | 녹화 2 03:15.50 | 목록에서 현재 주문 취소요청 확인 | [screenshots/orders/091_v2_order_list_cancel_requested.png](../screenshots/orders/091_v2_order_list_cancel_requested.png) |

### 목적

과거 및 현재 주문을 상태별 카드로 조회한다.

### 주요 UI

상품·결제일·예정일·금액·상태, 취소/문의/배송 조회/리뷰 쓰기 CTA.

### 사용자 Action

Observed: 목록 진입·현재 주문 선택; 요청 후 돌아오면 현재 주문 취소요청 반영.

### 연결 화면

My Shopping → Order List → Order Detail.

### 관찰 한계와 상태 해석

과거 취소완료·구매확정 카드는 원래 존재하는 별도 주문. 이번 취소 요청 완료와 연결하지 않는다. 배송 조회 CTA는 표시만이며 목적 Timeline은 Not Observed.

## Order Detail — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-30 | 녹화 2 02:43.70 | 현재 주문 결제완료 | [screenshots/orders/080_v2_order_detail_paid.png](../screenshots/orders/080_v2_order_detail_paid.png) |
| V2-31 | 녹화 2 02:45.30 | 주문 상세 결제·포인트 요약 | [screenshots/orders/081_v2_order_detail_payment_summary.png](../screenshots/orders/081_v2_order_detail_payment_summary.png) |
| V2-34 | 녹화 2 03:01.70 | 현재 주문 상품준비중 | [screenshots/orders/084_v2_order_detail_preparing.png](../screenshots/orders/084_v2_order_detail_preparing.png) |
| V2-40 | 녹화 2 03:11.70 | 주문 상세 취소요청 / 취소 CTA 제거 | [screenshots/orders/090_v2_order_detail_cancel_requested.png](../screenshots/orders/090_v2_order_detail_cancel_requested.png) |

### 목적

주문 단위 상품·배송지·결제 정보와 가능한 후속 행동을 확인한다.

### 주요 UI

현재 상태, 상품·수량 1, 예정일, 취소하기/문의하기, 영수증 보기, 배송지/요청사항, 총액·할인·포인트 적립.

### 사용자 Action

Observed: 결제완료 → 스크롤/영수증/문의; 재노출 시 상품준비중; 취소 요청 후 취소요청·문의만 표시.

### 연결 화면

Order List → Order Detail → Card Receipt / CS Topics / Cancel Reason; Cancel Requested → Order Detail.

### 관찰 한계와 상태 해석

실제 관찰 상태: 결제완료 → 상품준비중 → 취소요청. 상품준비중 전환 원인은 Not Observed. 주문 헤더 결제일과 상품 현재 상태는 별개. 최종 취소완료·배송중·배송완료 상세·부분 취소·배송지 변경 결과는 Not Observed.

## Card Receipt — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-32 | 녹화 2 02:49.10 | 카드 매출전표 / 승인·공급자 정보 | [screenshots/orders/082_v2_card_receipt.png](../screenshots/orders/082_v2_card_receipt.png) |
| V2-33 | 녹화 2 02:51.00 | 전표 하단 / 과세·세금·합계 | [screenshots/orders/083_v2_card_receipt_tax_summary.png](../screenshots/orders/083_v2_card_receipt_tax_summary.png) |

### 목적

구매자의 카드 매출전표를 확인한다.

### 주요 UI

승인/카드/거래 요약, 공급자·결제대행사 정보, 주문 금액/할인/포인트/과세/세금/결제/취소 금액, 다운로드 버튼.

### 사용자 Action

Observed: 주문 상세 영수증 보기 → 전표 → 하단 스크롤 → 뒤로.

### 연결 화면

Order Detail ↔ Card Receipt.

### 관찰 한계와 상태 해석

결제 금액 6,990원, 과세 6,354원+세금 636원, 취소 금액 0원. 개인/카드/주문 식별값은 전사하지 않음. 다운로드 수행, 취소 후 전표 갱신은 Not Observed. 소비자 전표는 판매자 실제 정산 화면이 아니다.

## Cancel Reason — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-35 | 녹화 2 03:03.60 | 취소 사유 미선택 / 다음 흐림 | [screenshots/orders/085_v2_cancel_reason_default.png](../screenshots/orders/085_v2_cancel_reason_default.png) |
| V2-36 | 녹화 2 03:04.40 | 단순 변심 선택 | [screenshots/orders/086_v2_cancel_reason_change_of_mind.png](../screenshots/orders/086_v2_cancel_reason_change_of_mind.png) |
| V2-37 | 녹화 2 03:05.80 | 주문 실수 선택 | [screenshots/orders/087_v2_cancel_reason_order_mistake.png](../screenshots/orders/087_v2_cancel_reason_order_mistake.png) |

### 목적

취소할 상품과 사유를 정한다.

### 주요 UI

선택 상품, 단순 변심/주문 실수/배송 지연, 상세 사유 입력칸, 다음 CTA.

### 사용자 Action

Observed: 미선택 → 단순 변심 → 주문 실수로 변경 → 다음.

### 연결 화면

Order Detail 상품준비중 → Cancel Reason → Cancel Confirmation.

### 관찰 한계와 상태 해석

미선택 CTA는 흐림, 선택 후 밝아짐. 비활성 버튼 탭 테스트, 상세 사유 입력, 복수 상품/부분 취소 대상 선택은 Not Observed.

## Cancel Confirmation — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-38 | 녹화 2 03:08.70 | 환불 예정 6,990원 / 판매자 승인 안내 | [screenshots/orders/088_v2_cancel_expected_refund.png](../screenshots/orders/088_v2_cancel_expected_refund.png) |

### 목적

예상 환불액과 주문 상태별 취소 안내를 확인한다.

### 주요 UI

상품 9,990원, 할인 −3,000원, 배송비 0원, 환불 예정 6,990원, 판매자 승인 안내, 취소 요청 CTA.

### 사용자 Action

Observed: 사유 선택 후 예상액 확인 → 취소 요청.

### 연결 화면

Cancel Reason → Cancel Confirmation → Cancel Requested.

### 관찰 한계와 상태 해석

결제완료 상태는 즉시 취소/환불, 상품준비중은 판매자 승인 후 취소한다는 안내가 표시됨. 실제 실행은 상품준비중 요청 한 건이며 즉시 취소 규칙의 실행 결과는 Not Observed. 예상액을 환불 완료로 기록하지 않는다.

## Cancel Requested — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-39 | 녹화 2 03:10.25 | 취소 요청했어요 / 요청 상태 | [screenshots/orders/089_v2_cancel_request_complete.png](../screenshots/orders/089_v2_cancel_request_complete.png) |

### 목적

취소 요청 접수 결과를 확인한다.

### 주요 UI

취소요청했어요, 판매자 그룹, 대상 상품·취소요청 상태, 사유 주문 실수, 확인 CTA.

### 사용자 Action

Observed: 요청 CTA → 접수 결과 → 확인 → 주문 상세·목록에 취소요청.

### 연결 화면

Cancel Confirmation → Cancel Requested → Order Detail / Order List.

### 관찰 한계와 상태 해석

최종 판매자 승인/거절·취소완료·환불 진행/완료는 Not Observed. 성공 범위는 요청 접수와 UI 상태 동기화까지.

## Product Shipping Info — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-43 | 녹화 2 03:56.60 | 구매 전 배송 예상·택배사 안내 | [screenshots/shipping/093_v2_product_shipping_info_sheet.png](../screenshots/shipping/093_v2_product_shipping_info_sheet.png) |

### 목적

구매 전 상품의 배송 약속과 배송사를 안내한다.

### 주요 UI

배송정보 시트, 도착 예정일, 정시 도착 비율 91%, 택배사, 현재 주소, 확인 CTA.

### 사용자 Action

Observed: 상품 상세 배송일 행 → 시트 → 확인/복귀.

### 연결 화면

Product Detail ↔ Product Shipping Info.

### 관찰 한계와 상태 해석

구매 전 정보이다. 실제 주문의 운송장·집화/이동/배달 Timeline·배송 지연 조회가 아니므로 배송 추적은 Not Observed.

## Seller Store — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-44 | 녹화 2 04:00.30 | 소비자용 판매자 스토어 | [screenshots/product-list/094_v2_seller_store.png](../screenshots/product-list/094_v2_seller_store.png) |

### 목적

소비자가 판매자의 상품을 탐색한다.

### 주요 UI

판매자 Banner·브랜드/배지, 홈/전체상품, 혜택 알림 받기, 베스트 상품·일간/주간/월간, 상품 카드.

### 사용자 Action

Observed: 상세 판매자 행 → 판매자 스토어 → 스크롤/복귀.

### 연결 화면

Product Detail ↔ Seller Store.

### 관찰 한계와 상태 해석

월간 선택 표시와 카드 노출 확인. 전체상품·알림 수신 변경·사업자 상세 정책 화면은 Not Observed. 판매자센터와 구별.

## Option Overview Sheet — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-45 | 녹화 2 04:05.50 | 옵션 전체보기 / 현재 옵션 선택 표시 | [screenshots/product-detail/095_v2_product_option_overview_sheet.png](../screenshots/product-detail/095_v2_product_option_overview_sheet.png) |

### 목적

현재 상품의 다른 구성을 한눈에 비교·선택한다.

### 주요 UI

하단 Sheet, 배경 Dim, 구성 이름·썸네일·가격, 현재 선택 파란 강조.

### 사용자 Action

Observed: 옵션 전체보기 → 5,950원 구성에서 8,900원 구성 선택 → 시트 닫힘·상세 제목/가격/리뷰 갱신.

### 연결 화면

Product Detail → Option Overview Sheet → Product Detail variant changed.

### 관찰 한계와 상태 해석

담기/구매 시 색상→사이즈를 순서대로 고르는 전용 Sheet의 근거는 아님. Sheet 안 주문 수량·품절 옵션·다중 선택은 Not Observed.

## Purchase Limit Modal — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-47 | 녹화 2 04:16.70 | 중복 담기 시 최대 구매 수량 초과 | [screenshots/cart/097_v2_max_purchase_limit_modal.png](../screenshots/cart/097_v2_max_purchase_limit_modal.png) |

### 목적

허용 수량을 넘는 담기 시도를 막고 이유를 알린다.

### 주요 UI

배경 Dim, 최대 구매 수량 초과 안내, 1개까지 주문 가능, 확인.

### 사용자 Action

Observed: 한도 1개 상품을 다시 담기 → Modal → 확인, 추가 항목 증가 없음.

### 연결 화면

Product Detail add attempt → Purchase Limit Modal → Product Detail.

### 관찰 한계와 상태 해석

재고 품절과 다른 구매 제한이다. 카트 + 입력으로 동일 차단을 실행한 결과, 한도 초기화 시점은 Not Observed.

## Category Product List — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V2-50 | 녹화 2 05:00.50 | 문구·학용품 하위 분류 목록 | [screenshots/product-list/100_v2_category_subcategory_list.png](../screenshots/product-list/100_v2_category_subcategory_list.png) |

### 목적

하위 카테고리의 상품을 탐색한다.

### 주요 UI

분류 제목·뒤로/검색/장바구니, 추천·세부 분류 Chip, 2열 카드.

### 사용자 Action

Observed: 카테고리에서 문구·학용품 하위 분류 → 목록; 이후 신선식품 목록 → 상세.

### 연결 화면

Category → Category Product List → Product Detail.

### 관찰 한계와 상태 해석

V2 04:54 이후 대분류의 반려/취미 등도 노출. 비슷한 분류별 결과는 대표 하나만 캡처. Chip 클릭 후 결과·대분류 전체 목록은 Not Observed.

## Search Input — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-01 | 녹화 3 00:02.60 | 검색 진입 / 최근 검색어·키보드 | [screenshots/search/101_v3_search_recent_terms.png](../screenshots/search/101_v3_search_recent_terms.png) |
| V3-02 | 녹화 3 00:04.60 | 치킨 자동완성 | [screenshots/search/102_v3_search_autocomplete.png](../screenshots/search/102_v3_search_autocomplete.png) |

### 목적

검색어를 입력하고 자동완성·최근 검색어를 확인한다.

### 주요 UI

검색 입력/지우기, 최근 검색어·각 X, 입력 중 제안 목록, 한글 키보드/검색 키.

### 사용자 Action

Observed: 검색 진입 → 치킨 입력 → 자동완성 → 검색; 이후 치킨 최근 기록 추가, 베개 입력으로 새 결과.

### 연결 화면

Home / Oasis Home → Search Input → Search Results; Results ↔ Search Input.

### 관찰 한계와 상태 해석

자동완성 항목 탭 결과, 최근 검색어 X 삭제/전체 삭제, 인기 검색어, 로그인 간 이력은 Not Observed.

## Search Results — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-03 | 녹화 3 00:06.90 | 치킨 결과 / 필터·정렬·상품 목록 | [screenshots/search/103_v3_search_results_default.png](../screenshots/search/103_v3_search_results_default.png) |
| V3-04 | 녹화 3 00:10.50 | 검색 결과 스크롤 / 상단 조건 유지 | [screenshots/search/104_v3_search_results_scrolled.png](../screenshots/search/104_v3_search_results_scrolled.png) |
| V3-08 | 녹화 3 00:27.50 | 필터 2개 적용 결과 | [screenshots/search/108_v3_search_results_filters_applied.png](../screenshots/search/108_v3_search_results_filters_applied.png) |
| V3-11 | 녹화 3 00:51.30 | 낮은 가격순 변경 중 Skeleton | [screenshots/search/111_v3_search_results_sort_skeleton.png](../screenshots/search/111_v3_search_results_sort_skeleton.png) |
| V3-12 | 녹화 3 00:52.60 | 낮은 가격순 적용 결과 | [screenshots/search/112_v3_search_results_price_ascending.png](../screenshots/search/112_v3_search_results_price_ascending.png) |
| V3-14 | 녹화 3 01:01.50 | 닫기 후 필터 2개·가격순 유지 | [screenshots/search/114_v3_search_results_reset_not_applied.png](../screenshots/search/114_v3_search_results_reset_not_applied.png) |
| V3-15 | 녹화 3 01:16.60 | 베개 결과 / 상품군별 조건 변화 | [screenshots/search/115_v3_search_results_pillow_facets.png](../screenshots/search/115_v3_search_results_pillow_facets.png) |
| V3-19 | 녹화 3 01:38.80 | 방금 본 상품과 비슷한 추천 | [screenshots/search/119_v3_search_context_recommendations.png](../screenshots/search/119_v3_search_context_recommendations.png) |

### 목적

검색어·조건에 맞는 상품과 관련 추천을 탐색한다.

### 주요 UI

검색어 입력, 상품군별 중량/국내산 또는 소재/형태 조건, 필터 개수·정렬 Chip, 혜택 Chip, 2열 카드, 추천 행.

### 사용자 Action

Observed: 검색 실행·스크롤, 필터 2개 적용, 가격 낮은순 적용 → 이미지 Skeleton → 상품, 상세 진입/복귀, 방금 본 상품과 비슷한 추천.

### 연결 화면

Search Input → Search Results ↔ Search Filter / Search Sort Sheet / Product Detail.

### 관찰 한계와 상태 해석

낮은 가격순 상단 4,850/5,800/5,810/6,000원. 필터 초기화 후 적용 없이 닫으면 결과의 필터 2개/가격순 유지. V3 02:39에는 치킨 조건이 다시 유지되지만 앱 재실행 영속성은 Not Observed. 추천 산출 알고리즘·무한 스크롤 계약·검색 Empty는 Not Observed.

## Search Filter — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-05 | 녹화 3 00:21.30 | 필터 페이지 / 조건 미선택 | [screenshots/search/105_v3_search_filter_default.png](../screenshots/search/105_v3_search_filter_default.png) |
| V3-06 | 녹화 3 00:23.60 | 2만원 이하 가격 조건 선택 | [screenshots/search/106_v3_search_filter_price_selected.png](../screenshots/search/106_v3_search_filter_price_selected.png) |
| V3-07 | 녹화 3 00:25.80 | 닭·오리고기 추가 선택 | [screenshots/search/107_v3_search_filter_category_selected.png](../screenshots/search/107_v3_search_filter_category_selected.png) |
| V3-09 | 녹화 3 00:31.40 | 특징 탭 / 중량·종류·부위·보관 | [screenshots/search/109_v3_search_filter_features.png](../screenshots/search/109_v3_search_filter_features.png) |
| V3-13 | 녹화 3 00:59.60 | 필터 안 초기화 / 강조 제거 | [screenshots/search/113_v3_search_filter_draft_reset.png](../screenshots/search/113_v3_search_filter_draft_reset.png) |

### 목적

검색 조건을 골라 결과에 적용한다.

### 주요 UI

가격대/카테고리/브랜드/특징 Tab, 조건 Chip, 초기화, 하단 N개 상품 보기 CTA.

### 사용자 Action

Observed: 2만원 이하 → 닭/오리고기 선택 → 상품 보기 → 필터 2개 결과; 특징 Tab 열기; 재진입 후 초기화 → 적용 없이 닫기.

### 연결 화면

Search Results ↔ Search Filter.

### 관찰 한계와 상태 해석

CTA 개수는 402 → 440 → 443으로 증가한 표시값; 데이터 고정/단조 감소를 추정하지 않는다. 초기화 후 강조 해제·402 표시까지 확인, 결과 해제 적용은 Not Observed. 편집 조건과 적용 조건을 나누는 모델은 Inferred.

## Search Sort Sheet — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-10 | 녹화 3 00:37.90 | 정렬 시트 / 추천순 초기 | [screenshots/search/110_v3_search_sort_sheet.png](../screenshots/search/110_v3_search_sort_sheet.png) |

### 목적

결과 정렬 기준을 바꾼다.

### 주요 UI

하단 Sheet·Dim·핸들, 추천순 체크, 가격 낮은순.

### 사용자 Action

Observed: 열기 → 변경 없이 닫기; 다시 열어 낮은 가격순 선택 → Sheet 닫힘/목록 로딩·갱신.

### 연결 화면

Search Results → Search Sort Sheet → Search Results sorted.

### 관찰 한계와 상태 해석

영상에 보인 두 기준만 기록. 다른 정렬 종류와 가격에 배송비 포함 여부는 Not Observed.

## Price Comparison — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-20 | 녹화 3 01:48.50 | 가격 비교 진입 / 외부몰 탭·빈 본문 | [screenshots/product-detail/120_v3_price_comparison_empty_body.png](../screenshots/product-detail/120_v3_price_comparison_empty_body.png) |

### 목적

상세의 가격 비교 목적 화면으로 진입한다.

### 주요 UI

선택 상품·가격, 외부몰 이름 Tab, 큰 빈 본문, 뒤로.

### 사용자 Action

Observed: 가격 비교하기 → 외부몰 Tab 화면 → 즉시 뒤로.

### 연결 화면

Product Detail ↔ Price Comparison.

### 관찰 한계와 상태 해석

비교 가격/매칭 상품/비교 결과는 Not Observed. 빈 본문에 오류·Empty 안내가 없으므로 실패/정상 Empty로 확정하지 않는다.

## Wishlist Page — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-24 | 녹화 3 02:32.10 | 찜 목록 / X·담기 컨트롤 | [screenshots/etc/124_v3_wishlist_grid.png](../screenshots/etc/124_v3_wishlist_grid.png) |

### 목적

찜한 상품을 그리드로 모아 보여준다.

### 주요 UI

장바구니/최근 본/찜 Tab, 2열 카드, X·담기 아이콘.

### 사용자 Action

Observed: 찜 Tab → 목록 → 상품 선택 → 상세.

### 연결 화면

Cart tab region → Wishlist Page → Product Detail.

### 관찰 한계와 상태 해석

X로 해제, 상세 하트 해제, 전체 비우기·Empty, 재시작 유지 여부는 Not Observed. V2 품절 상세의 하트는 로딩 후 채워져 보일 뿐 등록/해제 입력은 확인하지 못했다.

## Reviews Page — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-27 | 녹화 3 03:40.30 | 리뷰 추천·최신·별점 정렬 메뉴 | [screenshots/reviews/127_v3_reviews_sort_popup.png](../screenshots/reviews/127_v3_reviews_sort_popup.png) |
| V3-28 | 녹화 3 03:41.05 | 최신순 적용 | [screenshots/reviews/128_v3_reviews_latest_sorted.png](../screenshots/reviews/128_v3_reviews_latest_sorted.png) |
| V3-29 | 녹화 3 03:44.80 | 별점 낮은순 적용 | [screenshots/reviews/129_v3_reviews_low_rating_sorted.png](../screenshots/reviews/129_v3_reviews_low_rating_sorted.png) |

### 목적

전체 후기의 정렬 기준을 바꾸어 읽는다.

### 주요 UI

평점/리뷰 수, 사진 썸네일·더보기, 정렬 Popup, 후기 본문·옵션/판매자·도움됐어요, 하단 CTA.

### 사용자 Action

Observed: 추천/최신/별점 높은/낮은 메뉴, 최신순 → 높은순 → 낮은순 변경 후 본문 변화; 사진 더보기 진입.

### 연결 화면

Product Detail → Reviews Page → Photo Review Grid → 이전 화면.

### 관찰 한계와 상태 해석

대표 PNG는 메뉴·최신·낮은순만 저장, 높은순은 V3 03:43에서 확인. 도움됐어요 선택 결과, 단일 리뷰 상세, 리뷰 조건 필터·작성/평점 입력은 Not Observed.

## Photo Review Grid — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-30 | 녹화 3 03:46.60 | 사진 리뷰 모아보기 | [screenshots/reviews/130_v3_photo_review_grid.png](../screenshots/reviews/130_v3_photo_review_grid.png) |

### 목적

사진이 포함된 리뷰 이미지를 모아 탐색한다.

### 주요 UI

이미지 여러 열·서로 다른 높이, 뒤로.

### 사용자 Action

Observed: 리뷰 사진 더보기 → 모아보기 → 세로 스크롤 → 뒤로.

### 연결 화면

Reviews Page ↔ Photo Review Grid.

### 관찰 한계와 상태 해석

사진 한 장 확대·연결된 단일 리뷰 상세·사진 리뷰 조건 적용은 Not Observed.

## Payment Method Selection — 추가 관찰

### Screenshot / 상태

| ID | 경과 시각 | 대표 상태 | Screenshot |
| --- | --- | --- | --- |
| V3-31 | 녹화 3 04:14.45 | 계좌·카드 목록 / 현재 선택 유지 | [screenshots/payment/131_v3_payment_method_selection.png](../screenshots/payment/131_v3_payment_method_selection.png) |

### 목적

주문에 사용할 계좌·카드 후보와 현재 선택을 보여준다.

### 주요 UI

토스페이머니 잔액 0, 계좌 목록·추가·모두 보기, 카드 목록·추가·현재 체크, 확인 CTA.

### 사용자 Action

Observed: V3 끝의 주문서 결제수단 변경 → 선택 목록이 잠깐 완전히 로드 → 기존 선택 그대로 뒤로.

### 연결 화면

Full Checkout ↔ Payment Method Selection.

### 관찰 한계와 상태 해석

다른 수단 선택·확인·주문서 반영·추가/삭제·할부 변경은 Not Observed. 화면 존재를 결제수단 변경 성공으로 기록하지 않는다.

## 요청한 필수 화면 확인표 — 현재 누적 판정

체크는 표에 적힌 범위의 화면/결과가 확인됐다는 의미이며 전체 기능 완료가 아니다.

| 체크 | 요청 항목 | 확인 범위 / 남은 한계 |
| --- | --- | --- |
| [x] | 쇼핑 홈 | H01~H04 |
| [x] | 카테고리 | C01~C04, V2-50 하위 분류 연결 |
| [x] | 상품 목록 | L02/D01/SD01/CP01/CB01, V2-44/50 |
| [x] | 검색 | V3-01/02 |
| [x] | 검색 결과 | V3-03/08/12/15 |
| [x] | 검색 필터 | V3-05~09/13; 적용 Observed, 초기화 최종 적용 Not Observed |
| [x] | 검색 정렬 | V3-10~12 가격 낮은순 적용 |
| [x] | 상품 상세 | PD01~10, V2-06/18~20/42/46, V3-16~18 |
| [x] | 상품 옵션 | V2-18/45/46, V3-16~18 본문/전체보기 선택; 종속 구매 옵션 시트는 미관찰 |
| [x] | 품절 상품 | V2-19, 품절 옵션은 Not Observed |
| [x] | 리뷰 | RV01~03, V3-27~29 정렬 |
| [ ] | 리뷰 상세 | Not Observed — V3-30은 사진 모아보기, 단일 리뷰 상세/한 장 확대가 아님 |
| [x] | 장바구니 | CT01~08, V2-23/48/49, V3-21~26 |
| [x] | 주문서 | Q01~02 간편 시트 + V2-01/04/24~26 전체 주문서 |
| [x] | 배송지 선택 | V2-02 목록/현재 주소 확인만. 다른 주소 적용 Not Observed |
| [x] | 결제수단 선택 | V3-31 목록/현재 선택만. 수단 변경 적용 Not Observed |
| [x] | 결제 | V2-26 → V2-27 성공 결과; 인증/실패 Not Observed |
| [x] | 주문 완료 | V2-27 결제했어요 및 신규 주문 V2-29/30 |
| [x] | 주문 내역 | V2-28/29/41 |
| [x] | 주문 상세 | V2-30/31/34/40 |
| [x] | 찜 | W01/PD03 + V3-24 목록; 해제 Not Observed |
| [ ] | 쿠폰 | Not Observed — 쿠폰함/발급 화면 없음; CB01은 상품 컬렉션 |
| [x] | 쿠폰 적용 | 자동 적용된 가격/3,200원 주문 할인 Observed V2-01/23; 사용자 쿠폰 선택·적용/해제 Not Observed |
| [x] | 포인트 | Q02/V2-01/04/28 잔액·사용 요약; 내역 Not Observed |
| [x] | 포인트 사용 | V2-25/26 최대 체크 해제·158 → 0·금액 변경 |
| [ ] | 배송 추적 | Not Observed — V2-43은 구매 전 예상/택배사 안내, V2-29 배송 조회 CTA는 표시만 |
| [x] | 주문 취소 | V2-35~41 요청 접수·상태 반영; 최종 취소완료 Not Observed |
| [ ] | 반품 | Not Observed — V2-10은 문의 메뉴만 |
| [ ] | 반품 사유 선택 | Not Observed |
| [ ] | 반품 접수 | Not Observed |
| [ ] | 반품 상태 | Not Observed |
| [ ] | 교환 | Not Observed — V2-10은 문의 메뉴만 |
| [ ] | 교환 옵션 선택 | Not Observed |
| [ ] | 교환 접수 | Not Observed |
| [ ] | 교환 상태 | Not Observed |
| [ ] | 환불 상태 | Not Observed — V2-38 환불 예정액만 Observed |
| [x] | CS 진입 | V2-07~17 |
| [ ] | CS 문의 | 채널 선택·Chat Skeleton만 Observed; 실제 문의 작성/전송/접수는 Not Observed |
| [ ] | 문의 내역 | Not Observed |
| [x] | 판매자 정보 / 판매자 페이지 | V2-44 소비자 스토어, V2-32/33 전표 공급자 정보 |
| [ ] | 판매자센터 | Not Observed |
| [ ] | 실제 정산 관련 화면 | Not Observed — 매출전표는 구매자 증빙 |

## 추가 발견과 공통 상태

- Observed: 전체 주문서/배송 요청사항, 구매 전 배송 Sheet, 소비자 스토어, 구매자 카드 매출전표, 조건별 CS Empty, Cart Empty/복원, 최대 구매 수량 Modal, 필터 편집 초기화 후 결과 유지, 포인트 0 사용, 주문 상품준비중/취소요청, 리뷰 정렬/사진 모아보기.
- Observed — 표시만: 주문 목록 배송 조회·리뷰 쓰기, 주소/계좌/카드 추가, 찜 X, 쿠폰 변경, 문의 바로가기, 프라임 가입 결제 CTA, 흐린 품절/사유 미선택 CTA.
- Not Observed: 로그인/계정 전환, 주문자 정보 편집, 네트워크 오류/재시도, 결제 실패·취소·재결제·주문 실패, 검색 결과 없음, 품절 옵션, 주문 상세의 배송중/배송완료/지연, 실제 배송 Timeline, 반품·교환 접수/상태, 환불 진행/완료, 실제 CS 메시지/답변/내역, 단일 리뷰 상세/사진 확대/리뷰 작성, 이미지 검색/Context 설정.
- Inferred: 옵션 변경 시 상품·판매자·가격·리뷰를 함께 조회해야 하는 데이터 모델, 조건 편집/적용 분리, 취소 요청 접수와 최종 취소를 분리하는 상태 모델. 화면 관찰이 실제 API/정책을 확정하지 않는다.

최종 검토에서 로딩 중 하트 표시를 등록 Action으로 판정할 수 없어 중복 후보 V2-20을 제외했다. 기존 50장은 그대로이며 새 ID/파일 번호에는 이 공백을 남겼다. 추가 캡처에서는 반복된 홈/추천 카드·기존 간편 주문 시트·동일 Skeleton·삭제 Modal·동일 빈 카트 재방문을 재추출하지 않았다. 추가 촬영 지침은 [MISSING_CAPTURE_CHECKLIST.md](MISSING_CAPTURE_CHECKLIST.md)를 따른다.
