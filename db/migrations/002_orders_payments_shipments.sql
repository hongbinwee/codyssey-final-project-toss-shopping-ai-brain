-- Phase 3: 주문/결제/배송. DATA_TOOL_DESIGN 2~3절 계약.
-- 금액은 KRW 정수 원. 주문 항목은 구매 시점 스냅샷을 저장한다.
CREATE TABLE orders (
  id text primary key,
  user_id text not null references users(id),
  status text not null check (status in ('CONFIRMED','CANCELLED')),
  items_total_won int not null check (items_total_won >= 0),
  shipping_fee_won int not null check (shipping_fee_won >= 0),
  total_won int not null check (total_won >= 0),
  address_snapshot_json jsonb not null,
  version int not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (total_won = items_total_won + shipping_fee_won)
);

CREATE TABLE order_items (
  id text primary key,
  order_id text not null references orders(id),
  variant_id text not null references product_variants(id),
  product_name_snapshot text not null,
  option_snapshot_json jsonb not null,
  unit_price_won int not null check (unit_price_won >= 0),
  quantity int not null check (quantity >= 1),
  line_total_won int not null check (line_total_won >= 0),
  check (line_total_won = unit_price_won * quantity)
);

-- 모의 결제: 주문당 1건, 성공(PAID)만 레코드. 전액 환불 최대 1회.
CREATE TABLE payments (
  id text primary key,
  order_id text not null unique references orders(id),
  method text not null check (method = 'SIMULATED'),
  status text not null check (status = 'PAID'),
  paid_amount_won int not null check (paid_amount_won >= 0),
  paid_at timestamptz not null default now(),
  refund_status text not null default 'NONE' check (refund_status in ('NONE','PENDING','REFUNDED')),
  refunded_amount_won int not null default 0 check (refunded_amount_won >= 0),
  refunded_at timestamptz,
  check (
    (refund_status <> 'REFUNDED' and refunded_amount_won = 0)
    or (refund_status = 'REFUNDED' and refunded_amount_won = paid_amount_won)
  )
);

-- 배송: 주문당 최대 1건. events_json 마지막 상태와 status는 같은 트랜잭션에서 갱신.
CREATE TABLE shipments (
  id text primary key,
  order_id text not null unique references orders(id),
  status text not null check (status in ('PREPARING','IN_TRANSIT','DELIVERED','CANCELLED')),
  events_json jsonb not null default '[]'::jsonb check (jsonb_typeof(events_json) = 'array'),
  estimated_arrival_at timestamptz,
  updated_at timestamptz not null default now()
);
