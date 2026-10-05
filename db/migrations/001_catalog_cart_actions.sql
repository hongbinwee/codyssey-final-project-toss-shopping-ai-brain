-- Phase 1: catalog + cart + action_requests (DATA_TOOL_DESIGN 2절)

CREATE TABLE users (
  id text primary key,
  auth_subject text not null unique,
  display_name text not null,
  test_address_json jsonb not null,
  created_at timestamptz not null default now()
);

CREATE TABLE products (
  id text primary key,
  name text not null,
  brand text not null,
  category text not null,
  description text not null default '',
  image_urls jsonb not null default '[]'::jsonb,
  specs_json jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  version int not null default 1 check (version >= 1)
);

CREATE TABLE product_variants (
  id text primary key,
  product_id text not null references products(id),
  option_values_json jsonb not null default '{}'::jsonb,
  spec_overrides_json jsonb not null default '{}'::jsonb,
  unit_price_won int not null check (unit_price_won >= 0),
  stock_qty int not null check (stock_qty >= 0),
  active boolean not null default true,
  version int not null default 1 check (version >= 1)
);
CREATE INDEX product_variants_product_idx ON product_variants(product_id);
-- 리뷰가 같은 상품의 옵션만 참조하도록 복합 FK에 필요
CREATE UNIQUE INDEX product_variants_pid_id ON product_variants(product_id, id);

CREATE TABLE reviews (
  id text primary key,
  product_id text not null references products(id),
  variant_id text,
  rating int not null check (rating between 1 and 5),
  body text not null,
  source_kind text not null check (source_kind in ('REAL','SYNTHETIC')),
  source_ref text not null default '',
  written_at timestamptz not null,
  foreign key (product_id, variant_id) references product_variants(product_id, id)
);
CREATE INDEX reviews_product_idx ON reviews(product_id);

CREATE TABLE carts (
  id text primary key,
  user_id text not null unique references users(id),
  version int not null default 1 check (version >= 1),
  updated_at timestamptz not null default now()
);

CREATE TABLE cart_items (
  id text primary key,
  cart_id text not null references carts(id),
  variant_id text not null references product_variants(id),
  quantity int not null check (quantity >= 1),
  unique (cart_id, variant_id)
);

CREATE TABLE action_requests (
  id text primary key,
  actor_user_id text not null references users(id),
  kind text not null check (kind in ('ADD_CART','UPDATE_CART','REMOVE_CART','CHECKOUT','CANCEL_ORDER')),
  idempotency_key text not null,
  payload_json jsonb not null,
  payload_hash text not null,
  status text not null check (status in ('READY','SUCCEEDED','REJECTED')),
  confirmed_at timestamptz,
  expires_at timestamptz,
  result_json jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (actor_user_id, kind, idempotency_key)
);

