// 상품·리뷰 조회 서비스. 화면 API와 Agent Tool이 같은 함수를 사용한다.
import { sql } from "./db.ts";
import {
  ok, fail, err,
  type Availability, type MatchedVariant, type ProductDetail,
  type ProductSummary, type ReviewsResult, type SearchResult,
  type ReviewSort,
  type ToolResult,
} from "./contracts.ts";
import type { RequestContext } from "./session.ts";

export const FLAT_SHIPPING_FEE_WON = 3000;

export function variantAvailability(
  productActive: boolean,
  variantActive: boolean,
  stock: number,
): Availability {
  if (!productActive || !variantActive) return "UNAVAILABLE";
  return stock > 0 ? "AVAILABLE" : "SOLD_OUT";
}

function productAvailability(vs: { availability: Availability }[]): Availability {
  if (vs.length === 0) return "UNAVAILABLE";
  if (vs.some((v) => v.availability === "AVAILABLE")) return "AVAILABLE";
  if (vs.every((v) => v.availability === "SOLD_OUT")) return "SOLD_OUT";
  return "UNAVAILABLE";
}

// 옵션 유효 스펙 = 상품 스펙 + 옵션 override 병합
export const effectiveSpecs = (
  specs: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> => ({ ...specs, ...overrides });

export function specsMatch(
  required: Record<string, string>,
  eff: Record<string, string>,
): boolean {
  for (const [k, v] of Object.entries(required)) {
    if (eff[k] !== v) return false;
  }
  return true;
}

// 불투명 커서 = offset. ponytail: 내부 구조를 숨기기만 하면 되므로 base64 숫자.
const encCursor = (o: number) => Buffer.from(String(o)).toString("base64url");
const decCursor = (c?: string) => {
  if (!c) return 0;
  if (!/^[A-Za-z0-9_-]+$/.test(c)) return -1;
  const s = Buffer.from(c, "base64url").toString();
  return /^\d+$/.test(s) ? Number(s) : -1;
};

const page = (input: { cursor?: string; limit?: number }) => {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const offset = decCursor(input.cursor);
  return { limit, offset };
};

type VariantRow = {
  id: string; product_id: string; option_values_json: Record<string, string>;
  spec_overrides_json: Record<string, string>; unit_price_won: number;
  stock_qty: number; active: boolean; version: number;
};
type ProductRow = {
  id: string; name: string; brand: string; category: string;
  description: string; image_urls: string[]; specs_json: Record<string, string>;
  active: boolean; version: number;
};
type ReviewRow = {
  id: string; product_id: string; variant_id: string | null; rating: number;
  body: string; source_kind: "REAL" | "SYNTHETIC"; source_ref: string;
  written_at: string;
};

const toVariant = (p: { active: boolean; specs_json: Record<string, string> }, v: VariantRow): MatchedVariant => ({
  variant_id: v.id,
  option_values: v.option_values_json,
  effective_specs: effectiveSpecs(p.specs_json, v.spec_overrides_json),
  unit_price_won: v.unit_price_won,
  stock_qty: v.stock_qty,
  availability: variantAvailability(p.active, v.active, v.stock_qty),
  version: v.version,
});

export type SearchProductsInput = {
  query?: string;
  category?: string;
  max_unit_price_won?: number;
  required_specs?: Record<string, string>;
  sort?: "RELEVANCE" | "PRICE_ASC";
  cursor?: string;
  limit?: number;
};

export async function searchProducts(
  input: SearchProductsInput,
): Promise<ToolResult<SearchResult>> {
  const trace_id = crypto.randomUUID();
  const { limit, offset } = page(input);
  if (offset < 0) return fail(err("VALIDATION", "invalid cursor"), trace_id);
  if (input.sort && !["RELEVANCE", "PRICE_ASC"].includes(input.sort))
    return fail(err("VALIDATION", "invalid sort"), trace_id);
  if (
    input.required_specs &&
    Object.entries(input.required_specs).some(
      ([k, v]) => typeof k !== "string" || typeof v !== "string",
    )
  )
    return fail(err("VALIDATION", "required_specs는 문자열 키/값만 허용"), trace_id);
  if (
    input.max_unit_price_won !== undefined &&
    (!Number.isInteger(input.max_unit_price_won) || input.max_unit_price_won < 0)
  )
    return fail(err("VALIDATION", "invalid max_unit_price_won"), trace_id);

  const q = (input.query ?? "").trim();
  const products = await sql.unsafe<ProductRow[]>(
    `SELECT * FROM products WHERE active = true
      AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR brand ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR category = $2)
      ORDER BY id`,
    [q, input.category ?? null],
  );
  const variants = await sql.unsafe<VariantRow[]>("SELECT * FROM product_variants WHERE active = true ORDER BY id");
  const ratings = await sql.unsafe<{ product_id: string; avg: number; count: number }[]>("SELECT product_id, avg(rating)::float AS avg, count(*)::int AS count FROM reviews GROUP BY product_id");
  const ratingByPid = new Map(ratings.map((r) => [r.product_id, r]));

  let items: ProductSummary[] = [];
  for (const p of products) {
    const vs = variants
      .filter((v) => v.product_id === p.id)
      .map((v) => toVariant(p, v))
      .filter((mv) => {
        if (
          input.max_unit_price_won !== undefined &&
          mv.unit_price_won > input.max_unit_price_won
        )
          return false;
        if (input.required_specs && !specsMatch(input.required_specs, mv.effective_specs))
          return false;
        return true;
      });
    // 필수 스펙/가격 조건이 있는데 맞는 옵션이 없으면 상품을 결과에서 제외
    const constrained =
      input.max_unit_price_won !== undefined ||
      (input.required_specs && Object.keys(input.required_specs).length > 0);
    if (constrained && vs.length === 0) continue;
    const rating = ratingByPid.get(p.id);
    items.push({
      product_id: p.id,
      name: p.name,
      brand: p.brand,
      category: p.category,
      image: p.image_urls?.[0] ?? null,
      matched_variants: vs,
      rating_summary: rating
        ? { avg: Math.round(rating.avg * 10) / 10, count: rating.count }
        : { avg: null, count: 0 },
      availability: productAvailability(vs),
    });
  }
  if ((input.sort ?? "RELEVANCE") === "PRICE_ASC") {
    items.sort(
      (a, b) =>
        Math.min(...a.matched_variants.map((v) => v.unit_price_won)) -
        Math.min(...b.matched_variants.map((v) => v.unit_price_won)),
    );
  } else {
    items.sort(
      (a, b) =>
        (b.rating_summary.avg ?? 0) - (a.rating_summary.avg ?? 0) ||
        a.product_id.localeCompare(b.product_id),
    );
  }
  const sliced = items.slice(offset, offset + limit);
  const has_more = offset + limit < items.length;
  return ok(
    {
      items: sliced,
      shipping_fee_won: FLAT_SHIPPING_FEE_WON,
      next_cursor: has_more ? encCursor(offset + limit) : null,
      has_more,
    },
    trace_id,
  );
}

export async function getProduct(input: {
  product_id: string;
}): Promise<ToolResult<ProductDetail>> {
  const trace_id = crypto.randomUUID();
  const [p] = await sql.unsafe<ProductRow[]>("SELECT * FROM products WHERE id = $1", [
    input.product_id,
  ]);
  if (!p) return fail(err("NOT_FOUND", "상품을 찾을 수 없습니다"), trace_id);
  const vs = (await sql.unsafe<VariantRow[]>("SELECT * FROM product_variants WHERE product_id = $1 AND active = true ORDER BY id", [p.id])).map((v) => toVariant(p, v));
  return ok(
    {
      product: {
        id: p.id,
        name: p.name,
        brand: p.brand,
        category: p.category,
        description: p.description,
        images: p.image_urls ?? [],
        specs: p.specs_json,
        active: p.active,
        version: p.version,
        availability: productAvailability(vs),
      },
      variants: vs,
      shipping_fee_won: FLAT_SHIPPING_FEE_WON,
    },
    trace_id,
  );
}

// 리뷰 정렬 — ORDER BY는 이 상수 매핑에서만 가져오고 입력 원문은 절대
// 삽입하지 않는다. Ref127의 3종만 지원하고 '추천순'은 순위 알고리즘
// 계약이 없어 제공하지 않는다(sort 생략은 LATEST, 지원하지 않는 값은 VALIDATION) [PMQA-068].
const REVIEW_ORDER: Record<ReviewSort, string> = {
  LATEST: "written_at DESC, id",
  RATING_DESC: "rating DESC, written_at DESC, id",
  RATING_ASC: "rating ASC, written_at DESC, id",
};

export async function getReviews(
  input: {
    product_id: string;
    variant_id?: string;
    query?: string;
    sort?: string;
    cursor?: string;
    limit?: number;
  },
  db: Pick<typeof sql, "unsafe"> = sql,
): Promise<ToolResult<ReviewsResult>> {
  const trace_id = crypto.randomUUID();
  const { limit, offset } = page(input);
  if (offset < 0) return fail(err("VALIDATION", "invalid cursor"), trace_id);
  // own-property 검사 — 'toString'/'constructor'/'__proto__' 같은 상속키가
  // truthy로 통과해 ORDER BY에 들어가는 결함을 차단한다 [PMQA-068].
  const sortKey = input.sort ?? "LATEST";
  if (!Object.hasOwn(REVIEW_ORDER, sortKey))
    return fail(
      err("VALIDATION", "지원하지 않는 리뷰 정렬입니다"),
      trace_id,
    );
  const orderBy = REVIEW_ORDER[sortKey as ReviewSort];
  const [p] = await db.unsafe("SELECT id FROM products WHERE id = $1", [
    input.product_id,
  ]);
  if (!p) return fail(err("NOT_FOUND", "상품을 찾을 수 없습니다"), trace_id);
  if (input.variant_id) {
    const [v] = await db.unsafe(
      "SELECT id FROM product_variants WHERE id = $1 AND product_id = $2",
      [input.variant_id, input.product_id],
    );
    if (!v)
      return fail(
        err("VALIDATION", "variant_id가 해당 상품의 옵션이 아닙니다"),
        trace_id,
      );
  }
  const q = (input.query ?? "").trim();
  const rows = await db.unsafe<ReviewRow[]>(
    `SELECT * FROM reviews WHERE product_id = $1
      AND ($2::text IS NULL OR variant_id = $2)
      AND ($3 = '' OR body ILIKE '%' || $3 || '%')
      ORDER BY ${orderBy}`,
    [input.product_id, input.variant_id ?? null, q],
  );
  const sliced = rows.slice(offset, offset + limit);
  const has_more = offset + limit < rows.length;
  return ok(
    {
      reviews: sliced.map((r) => ({
        id: r.id,
        product_id: r.product_id,
        variant_id: r.variant_id,
        rating: r.rating,
        body: r.body,
        source_kind: r.source_kind,
        source_ref: r.source_ref,
        written_at: new Date(r.written_at).toISOString(),
      })),
      total_matching: rows.length,
      returned_count: sliced.length,
      next_cursor: has_more ? encCursor(offset + limit) : null,
      has_more,
      sort: sortKey as ReviewSort,
    },
    trace_id,
  );
}
