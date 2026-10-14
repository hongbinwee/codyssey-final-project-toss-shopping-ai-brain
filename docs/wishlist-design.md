# 찜(Wishlist) 설계 문서 — PMQA-070

> 근거 태그: `[Observed]` = Toss Shopping 캡처 실측 · `[Project]` = 프로젝트 결정 ·
> `[Inferred]` = 추정. 캡처에서 확인되지 않은 동작을 Toss 실제 동작이라고 주장하지 않는다.

## 1. 범위와 노출 계약

- 찜은 **화면 API 전용**이다 — Agent Tool registry에 등록하지 않는다 [Project].
  Shopping/CS Brain이 찜을 Tool로 조작하는 기능은 향후 Brain 단계의 별도 설계다.
- 세션 actor의 찜만 읽고 쓴다 — body의 user_id 같은 actor 주장 필드는 읽지 않는다
  (기존 cart/checkout과 동일 계약).
- 데이터: `db/migrations/004_wishlist_items.sql` — `(user_id, product_id)` PK,
  `created_at` 저장 시각. 두 FK 모두 `NO ACTION`이라 상품·사용자의 물리 삭제가
  찜 행이 있으면 거절된다 — 목록의 JOIN이 항상 성립해 비활성(판매 중단) 상품도
  "판매 중단" 표시로 보존·해제할 수 있다.

## 2. Migration 적용 — phase 6 opt-in

- `004_wishlist_items.sql`은 `scripts/migrations-manifest.ts`의 phase 6에만 등록된다.
- 기존 `--phase<=4` setup 경로는 이 파일을 **skip**한다 — 신규 파일이 있다고 기존
  명령이 새 DDL을 자동 적용하지 않는다(fail closed 대신 등록 skip).
- 적용 방법: `npm run db:migrate -- --phase=6` — 명시적 opt-in에서만 실행된다.
- `tests/helpers/testdb.ts`는 같은 매니페스트의 `requiredMigrations`를 재사용한다 —
  복제본 맵이 phase6을 누락해 setupTestDb(6)가 004 미적용 DB를 schemaSatisfied로
  오인하던 결함을 정본 재사용으로 해소했다 [PMQA-070 독립 검수].
- `scripts/migrate.ts`는 `--phase` 인자를 ensureDevDb/connect/advisory lock **이전**에
  검증한다 — invalid phase는 어떤 DB 연결도 열기 전에 실패한다.
- 디스크에 `NNN_*.sql`이 있는데 어느 phase에도 미등록이면 `unknown`으로 fail closed.

## 3. 멱등 — runAction 계약 재사용

- `SET_WISHLIST`는 신규 저장소/프로토콜을 만들지 않고 기존 `runAction`
  (src/actions.ts)을 재사용한다:
  - 같은 키 + 같은 payload 재전송 → 저장 결과 replay
  - 같은 키 + 다른 payload → IDEMPOTENCY_CONFLICT
  - 같은 키 READY(커밋 불명) → OUTCOME_UNKNOWN + getActionResult 복구
- **입력 검증은 runAction 이전**에 끝낸다 — invalid payload가 action_requests에
  기록되면 이후 정상 요청의 pending 조회가 과거 비정형 saved를 해석하다 영구 실패
  할 수 있다. `setWishlistInputError`가 product_id/saved만 검증해 no-write로 거절.

## 4. 동시성·잠금 근거

- **actor 직렬화: users 행 `FOR NO KEY UPDATE`** — 트랜잭션은 이미 action_requests
  INSERT로 users에 `FOR KEY SHARE`를 쥐고 있다(FK 참조). 같은 actor의 두 요청이
  KEY SHARE를 든 채 FOR UPDATE로 승격하면 상호 대기 데드락이다. NO KEY UPDATE는
  KEY SHARE와 충돌하지 않으면서 같은 actor의 write를 직렬화하고 users 일반 UPDATE와도
  직렬화된다 — PK를 바꾸지 않는 가장 약한 충분한 잠금.
- **상품 active 후판정: products 행 `FOR SHARE`** — 일반 UPDATE가 잡는 NO KEY UPDATE와
  실제로 충돌해 active 동시 변경이 있으면 그 커밋을 기다린 뒤 최신 값으로 판정한다.
  FOR KEY SHARE는 NO KEY UPDATE와 충돌하지 않으므로 갱신 차단 증거가 되지 못해 미사용.
- 같은 상품의 `status=READY` SET_WISHLIST만 FOR UPDATE로 잠근다 — 소유 트랜잭션 종료를
  기다리고, 락 획득 후에도 반대 saved의 READY가 남아 있으면 OPERATION_IN_FLIGHT로 거절
  (결과 불명 중 반대 상태 기록 방지). saved 비교는 텍스트(payload_json->>'saved')로 해
  과거 비정형 payload에도 SQL이 실패하지 않는다.
- 판매 중단(active=false) 상품의 새 저장(saved=true)은 UNAVAILABLE. 기존 저장은 보존하고
  해제(saved=false)는 항상 허용한다. 품절은 찜 가능(재고와 무관한 표시 의사).

## 5. 표시 정보 정책

- PUT 응답은 `{product_id, saved, wishlist_count}`뿐 — 이름·이미지·가격 같은 표시 정보를
  포함하지 않는다. 클라이언트는 저장 확정 시 display가 없으면 `force` 목록 재조회로 보강한다
  (합성 금지).
- GET 목록은 서버 join으로 name/image/active/min_price_won을 실시간 제공한다 — 찜 탭은
  서버 목록이 정본이며 카탈로그 재조회로 조립하면 비활성 보존 항목이 조용히 숨겨진다.
  `min_price_won`은 **활성 variant만** 집계한다 — catalog 목록·상세의 `active = true`
  정본과 같은 계약이다(비활성 옵션이 더 저렴해도 찜 가격에 섞지 않는다
  [MAJOR070-PRICE]). 활성 옵션이 0개면 null을 반환하고 카드는 가격을 표시하지 않는다
  (가격 미확인 — 허위 가격 표시 없음).

## 6. 클라이언트 안전 계약 (src/web/wishlist.ts)

- 스토어는 명시 userId 키 버킷 — 전역 scope 없이 계정 전환/복원 타이밍에 다른 계정의
  찜을 읽을 경로가 없다. userId=null이면 읽기·쓰기 모두 no-op.
- 계정에 민감한 intent·확정 상태를 적용하기 전에 `io.scope()===userId`를
  확인한다 — 불일치 시 intent·스토어 변경 없이 ABORTED(원 계정 버킷에 intent
  보존). 실패·READY 조기 반환은 계정 상태를 적용하지 않아 추가 재검사가 없다.
- GET 적용은 fetchSeq(마지막 fetch만)+gen(확정 PUT·적용 GET마다 증가) 이중 가드 —
  GET 시작 후 확정된 PUT이 있으면 늦게 도착한 GET 응답은 폐기. `force`는 구 inflight를
  기다리지 않고 실제 새 GET을 시작하며 fetchSeq로 구 fetch를 무효화한다.
- 같은 상품의 미해결 SET_WISHLIST intent가 있으면 새 키 토글을 PENDING_EXISTS로 차단 —
  commit 불명 동안 반대 intent를 만들지 않는다.
- 하트는 confirmed만 표시 — 낙관적 토글 없이 서버 ok 확정 뒤에만 저장 상태를 바꾼다.
- 복구·재시도는 저장 intent의 kind/method/path·product_id·saved·idempotency_key·현재 계정
  소속을 `wishPendingError`로 검증한다 — 변조 payload를 임의 값으로 강제 변환해 실행하지 않는다.
- React 효과 순서: 자식의 ensure effect는 부모의 bindPendingUser보다 먼저 실행될 수 있다 —
  scope 미확정 시 ensure는 no-op이므로, useWishlist는 bind가 쏘는 `pending-writes`를 구독해
  scope 확정 뒤 재적재한다.

## 7. UI 표면

| 표면 | 근거 | 구현 |
| --- | --- | --- |
| 카드 하트 | Ref124 등 이미지 우상단 하트 [Observed] | `WishButton`(.wish-heart) — 목록 ready 전에는 토글 대신 명시 재조회만, LOST/REJECTED/BUSY는 `.wish-fb` 인라인 안내 + "찜에서 확인" 복구 진입 |
| 상세 하트 | Ref08 하단 CTA 좌측 하트 [Observed] | `.detail-heart` — 구매하기/담기 바 좌측 |
| 저장 완료 시트 | Ref06 core [Observed 부분] | `WishSavedSheet` — `[썸네일][찜 목록에 추가했어요][우측 파란 바로가기]` 한 행 + 하단 단일 primary 닫기 CTA |
| 찜 탭 | Ref124 [Observed] | Recent `?tab=wish` — 서버 목록 기준 2열 그리드, 이미지 위 X=찜 해제, 항목별 bag=상품 상세 진입(옵션 선택이 필요해 즉시 담기 미지원) [Project 매핑] |
| 내 쇼핑 찜 수 | Ref078 | MyShop의 찜 행이 실제 서버 count를 표시 |

### X/bag 기준 박스 (PM070 Ref124 재검수 보정)

- `.wish-x`/`.wish-bag`는 `.wish-cell` 전체가 아니라 `.wish-visual`(이미지 aspect-ratio 1
  영역)을 기준으로 절대 배치한다 — 셀 기준 bottom이면 bag이 상품명·가격을 가린다.
- `.wish-visual`은 `pointer-events:none`이고 두 버튼만 `auto` — 빈 영역 클릭은 카드 본문
  버튼으로 통과한다. 형제 버튼 구조라 nested button 없음.

## 8. 남은 시각 Gap (PM070 — PM이 Ref06/Ref124 원본을 view_image로 재확인)

본 절은 **Visual Fidelity Gap**이다 — 기능 Backend 실구현·DB-free QA 완료와는
별개 축으로 관리한다. 추천 rail·보조 메타·Undo는 후속 AB 기능군 계획의 남은
P0/P1 Gap 후보로 기록하며, 무조건 08 Final Visual Polish의 MINOR로 이관하지
않는다(이번 070 범위에서 구현하지 않음) [PM070 최종 QA].

- **Ref06 시트 헤더**: 원본에는 generic '찜' 제목이 없다 [Observed — PM 재확인].
  구현은 공용 BottomSheet의 generic 헤더를 사용하므로 원본과 차이가 있다.
- **Ref06 추천 rail**: 원본 시트 하단에 추천 상품 rail이 실제로 존재한다
  [Observed] — Recommendation 데이터·계약 부재로 이번 범위에서는 미구현. 단,
  현 wishlist DTO·응답에 없다는 사실을 구현 불가로 단정하지 않는다 — 기존
  카탈로그 메타·합성 표시 계약으로 보완 가능성을 별도 관리한다(허위 상품
  노출 금지 원칙은 유지).
- **Ref124 카드 보조 정보**: 원본 찜 카드의 평점·할인·가격추이 보조 표기가
  실제 관측된다 [Observed] — 현재 서버 목록 응답은 name·active·min_price_won
  (활성 variant 기준)만 정본이라 미표시. DTO 미포함을 구현 불가로 단정하지
  않는다 — 카탈로그 메타·가격 이력 계약 등 보완 가능성을 별도 관리한다.
- **Ref124 '다시 담기' Undo**: 항목 삭제 후 '다시 담기' Undo가 실제 관측된다
  [Observed — PM 재확인] — 미구현 Gap.
- 찜 탭 bag 아이콘의 원본 대비 정확한 크기·색·배치는 픽셀 대조 미실행 [Inferred→Gap].

## 9. NOT_RUN — 실제 검증 이관

- 실DB migration 적용·실API GET/PUT 왕복·브라우저 렌더·계정 전환 실동작·픽셀 비교는
   전부 브라우저/통합 승인 단계로 이관한다 — 본 문서의 동작 서술은 코드 계약 기준이며
   실측 증거 주장이 아니다.
- mock 단위 테스트(wishlist-service·wishlist-web)가 증명하는 것은 SQL 잠금 문구·
  호출 절차·파라미터 바인딩·컨트롤러 상태 전이뿐이다 — 실제 동시성 직렬화·
  트랜잭션 rollback·장기 durability·인덱스/실행계획은 mock으로 재현할 수 없어
  실DB 통합 검증(NOT_RUN)의 범위로 분리한다 [PM070 테스트 정적 QA].
