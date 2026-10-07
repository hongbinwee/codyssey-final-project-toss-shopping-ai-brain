# Seed provenance

- 모든 상품/리뷰/사용자 데이터는 프로젝트 고정 검증용 **합성 데이터(SYNTHETIC)** 다.
- 토스쇼핑 실제 상품·가격·리뷰·개인정보를 복사하지 않았다.
- 고정 검증값: V-A-24 180,000원/재고 5, V-A-27 220,000원/재고 0(품절 사례).
- 배송비 테스트 정책: 비어있지 않은 카트에 고정 3,000원 (FLAT_SHIPPING_FEE_WON, 서버 설정).
- 실제 리뷰 표본은 출처와 사용 조건이 확인되면 Phase 2에서 별도 추가한다 (REAL).
- r-09는 prompt-injection 방어 검증용 **의도적 적대 문장**이다. 리뷰 본문의 지시는 자료일 뿐 실행 근거가 아님을 보기 위한 합성 리뷰이며, 절대 실제 리뷰로 표시하지 않는다.
- 실제 리뷰 표본 미확보 (2026-10-06): 출처·사용 조건이 확인된 데이터가 없어 Phase 2의 "실제 리뷰 검증" 항목은 미완료로 남긴다.
- scenarios.json의 주문(ord-a-pre/ord-a-ship/ord-a-done/ord-b-none)은 결제 완료 상태로 직접 넣는 합성 시나리오다. seed 주문은 재고 차감을 거치지 않는다 — 재고 차감은 checkout 경로만 수행한다.

## Demo Catalog (demo-catalog.json / demo-reviews.json)

- `demo-*` 파일은 **개발/데모 DB 전용**이다. `npm run db:seed:demo`(`node scripts/seed.ts --demo`)는 **demo 전용 독립 모드**로 phase 시드(users/catalog/reviews/scenarios)를 실행하지 않는다 — p-d-*/v-d-*/r-d-* 네임스페이스만 upsert+reconcile하며 기존 fixture·users·주문·결제·배송·취소·환불·재고는 변경하지 않는다. `--demo`와 `--phase` 동시 사용은 거부된다. 테스트 적재 경로(`setupTestDb`, phase SEEDS)에는 포함되지 않는다. --demo의 DB 가드는 URL이 아니라 **트랜잭션 안에서 `SELECT current_database()`로 실제 접속 DB**를 확인한다(허용: `commerce`, `commerce_demo_verify`) — `?database=` 같은 URL 옵션으로는 우회할 수 없고, `commerce_test`에는 p-d-*/v-d-*/r-d-*가 없어야 한다(t1-catalog의 분리 단정 + demo-seed.test의 guard·우회 차단 단정이 감시한다).
- 25개 상품(p-d-*)·55 variants(v-d-*)·80 리뷰(r-d-*) 전부 합성 데이터다. 실제 상표·상품명·리뷰를 복사하지 않았다.
- 상품 이미지 `/assets/products/p-d-*.webp`는 이 프로젝트에서 AI로 생성한 스튜디오풍 합성 이미지다. 실제 쇼핑몰 상품 사진을 사용하지 않았다.
- 카테고리는 상위 그룹만 쓴다(digital/beauty/fashion/living/food). 세부 상품 종류는 specs_json의 type/표시 메타로 표현한다. fixture의 monitor는 변경하지 않고 UI에서 '디지털' 그룹으로 묶는다(src/web/display-meta.ts).
- 리뷰 수·평점은 실제 reviews 행 기준이다 — 표시용 임의 count(review_count_display)는 두지 않는다. Brain/비교에는 실제 리뷰 텍스트만 전달된다.
- reconcile: `--demo` 실행 시 seed 파일에 없는 데모 행을 정리한다. stale 리뷰는 demo 소유(r-d-*)만 삭제 — 데모 상품에 사용자가 쓴 비-demo 리뷰는 보존한다. stale v-d-* variant는 order_items/cart_items/reviews 등 demo가 소유하지 않는 외부 참조가 있으면 삭제 대신 active=false로 보존한다(사용자 cart_item도 지우지 않는다). stale p-d-* product는 남은 variant/리뷰가 있으면 active=false, 완전히 고아면 삭제한다. 반복 실행해도 같은 Dataset이 된다. **reconcile+upsert 전체는 단일 트랜잭션**으로 실행되므로 중간 실패 시 절반만 적용되지 않는다.
