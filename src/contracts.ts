// DATA_TOOL_DESIGN 5~7절 공통 계약. 구현된 Tool만 registry에 노출한다.
export type RecoveryAction =
  | "RETRY_READ"
  | "REFRESH_AND_RECONFIRM"
  | "CHECK_OPERATION"
  | "STOP";

export type ToolError = {
  code: string;
  message: string;
  recovery_action: RecoveryAction;
};

export type ToolResult<T> =
  | {
      ok: true;
      data: T;
      observed_at: string;
      trace_id: string;
      operation_id?: string;
      action_status?: string;
      replayed?: boolean;
    }
  | {
      ok: false;
      error: ToolError;
      trace_id: string;
      operation_id?: string;
      action_status?: string;
      replayed?: boolean;
    };

export const ok = <T>(data: T, trace_id: string): ToolResult<T> => ({
  ok: true,
  data,
  observed_at: new Date().toISOString(),
  trace_id,
});

export const fail = <T>(
  error: ToolError,
  trace_id: string,
  operation_id?: string,
): ToolResult<T> => ({ ok: false, error, trace_id, operation_id });

export const err = (
  code: string,
  message: string,
  recovery_action: RecoveryAction = "STOP",
): ToolError => ({ code, message, recovery_action });

export type Availability = "AVAILABLE" | "SOLD_OUT" | "UNAVAILABLE";

export interface MatchedVariant {
  variant_id: string;
  option_values: Record<string, string>;
  effective_specs: Record<string, string>;
  unit_price_won: number;
  stock_qty: number;
  availability: Availability;
  version: number;
}

export interface ProductSummary {
  product_id: string;
  name: string;
  brand: string;
  category: string;
  image: string | null;
  matched_variants: MatchedVariant[];
  rating_summary: { avg: number | null; count: number };
  availability: Availability;
}

export interface SearchResult {
  items: ProductSummary[];
  shipping_fee_won: number;
  next_cursor: string | null;
  has_more: boolean;
}

export interface ProductDetail {
  product: {
    id: string;
    name: string;
    brand: string;
    category: string;
    description: string;
    images: string[];
    specs: Record<string, string>;
    active: boolean;
    version: number;
    availability: Availability;
  };
  variants: MatchedVariant[];
  shipping_fee_won: number;
}

export interface ReviewItem {
  id: string;
  product_id: string;
  variant_id: string | null;
  rating: number;
  body: string;
  source_kind: "REAL" | "SYNTHETIC";
  source_ref: string;
  written_at: string;
}

export interface ReviewsResult {
  reviews: ReviewItem[];
  total_matching: number;
  returned_count: number;
  next_cursor: string | null;
  has_more: boolean;
}

export interface CartItemView {
  cart_item_id: string;
  product_id: string;
  variant_id: string;
  product_name: string;
  image: string | null;
  option_values: Record<string, string>;
  quantity: number;
  unit_price_won: number;
  variant_version: number;
  availability: Availability;
  purchasable: boolean;
  block_reason: string | null;
}

export interface CartView {
  cart_id: string;
  version: number;
  items: CartItemView[];
  items_total_won: number;
  shipping_fee_won: number;
  total_won: number;
  can_checkout: boolean;
}
