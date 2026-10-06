-- Phase 4: 취소 요청. DATA_TOOL_DESIGN 2절 — 주문당 전체 취소 1건,
-- 승인/실행 레코드(action_requests)와 1:1 연결. 환불 예정액은 접수 시 서버 확정값.
CREATE TABLE cancel_requests (
  id text primary key,
  order_id text not null unique references orders(id),
  action_request_id text not null unique references action_requests(id),
  reason_code text not null check (reason_code in ('ORDER_MISTAKE','CHANGE_OF_MIND','OTHER')),
  status text not null check (status in ('REQUESTED','COMPLETED')),
  refund_amount_won int not null check (refund_amount_won >= 0),
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

CREATE INDEX cancel_requests_action_idx ON cancel_requests(action_request_id);
