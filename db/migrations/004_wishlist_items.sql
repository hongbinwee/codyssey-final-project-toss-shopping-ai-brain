-- Commerce environment 확장 [PMQA-070]: 찜 목록 + SET_WISHLIST action kind.
-- 이 파일은 migrations-manifest의 phase 6(post-Phase-5 확장)에 등록된다 —
-- 기존 `--phase=4` setup 경로는 이 파일을 '등록된 상위 phase'로 skip하고,
-- 실제 적용은 명시 `--phase=6` opt-in 실행에서만 일어난다. 이번 세션은 파일
-- 작성·등록만 하고 어떤 DB에도 적용하지 않는다.

-- 찜 목록 — (user_id, product_id) 복합 PK로 같은 상품의 중복 저장을
-- 구조적으로 막는다. FK는 NO ACTION(기본) — 상품/사용자 삭제 정책을
-- 찜이 암묵적으로 연쇄시키지 않는다.
CREATE TABLE wishlist_items (
  user_id text not null references users(id),
  product_id text not null references products(id),
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
CREATE INDEX wishlist_items_user_idx ON wishlist_items(user_id, created_at DESC, product_id);

-- SET_WISHLIST 실행 요청 kind 확장 — 기존 5종은 그대로 보존한다.
-- saved+PK만으로는 재전송 간 다른 의도(저장↔해제)를 구분할 수 없어
-- action_requests의 kind+idempotency_key+payload_hash 계약을 재사용한다.
ALTER TABLE action_requests DROP CONSTRAINT action_requests_kind_check;
ALTER TABLE action_requests ADD CONSTRAINT action_requests_kind_check
  CHECK (kind in ('ADD_CART','UPDATE_CART','REMOVE_CART','CHECKOUT','CANCEL_ORDER','SET_WISHLIST'));
