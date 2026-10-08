// 04-B Demo Catalog — 화면 표시/merchandising 전용 메타.
// 실제 가격·재고·리뷰 수는 항상 API 응답이 정본이다.
// 이 파일에는 카드/홈 표시를 위한 UI 메타(정가 취소선, 배송 라벨, 섹션 태그)만 둔다.
// Brain이나 추천 로직은 없으며, static 태그 기반으로 04-C Home 재구성 시 교체 가능한 형태다.

// 상위 카테고리 그룹. DB products.category는 상품군 단위(digital/beauty/...)이고
// fixture의 monitor는 변경하지 않고 "디지털" 그룹에 함께 묶는다.
export interface CategoryGroup {
  id: string;
  label: string;
  categories: string[];
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { id: "digital", label: "디지털", categories: ["digital", "monitor"] },
  { id: "beauty", label: "뷰티", categories: ["beauty"] },
  { id: "fashion", label: "패션", categories: ["fashion"] },
  { id: "living", label: "리빙", categories: ["living"] },
  { id: "food", label: "식품", categories: ["food"] },
];

const GROUP_OF = new Map<string, string>(
  CATEGORY_GROUPS.flatMap((g) => g.categories.map((c) => [c, g.id] as const)),
);
// 알 수 없는 category는 원문을 돌려준다(그룹 밖 카테고리도 탭/칩으로 표시 가능).
export const groupOf = (category: string): string =>
  GROUP_OF.get(category) ?? category;
export const groupLabel = (id: string): string =>
  CATEGORY_GROUPS.find((g) => g.id === id)?.label ?? id;

export interface ProductMeta {
  // 최저가 옵션 기준 정가. 카드의 할인율/취소선 표시에만 쓰인다 (주문 가격과 무관).
  original_price_won?: number;
  // "오늘출발"/"내일도착" 같은 도착 라벨. 배송비는 서버 shipping_fee_won이 정본.
  delivery?: string;
  // 홈 섹션 태그. 정적 merchandising용 — 추후 Brain 추천 결과로 교체 가능.
  sections?: ("flash-sale" | "popular" | "new" | "recommended" | "value")[];
}

// 카드/히어로 공통 표시 계산. 실제 주문 가격은 항상 서버 값이 정본이다.
import type { ProductSummary } from "../contracts.ts";
export const minPriceOf = (p: ProductSummary) =>
  Math.min(...p.matched_variants.map((v) => v.unit_price_won));
export const rateOf = (p: ProductSummary) => {
  const o = PRODUCT_META[p.product_id]?.original_price_won;
  const m = minPriceOf(p);
  return o && o > m ? Math.round(((o - m) / o) * 100) : 0;
};

// 로컬 생성 webp 컨벤션 — 시드 image_urls가 비어 있을 때의 표시 경로.
export const productImg = (p: { product_id: string; image: string | null }) =>
  p.image ?? `/assets/products/${p.product_id}.webp`;

// ── 04-C 홈 재구성용 merchandising 데이터 ─────────────────────────────
// 캡처 [Observed] 구조: 히어로(텍스트+이미지) → 혜택 행 → 숏컷 → 추천 그리드.

// 상단 쇼핑 탭. Toss의 OASIS는 우리 식품 콘텐츠로 대체한 [Project] 매핑.
// 디지털·패션·리빙은 탭에 없고 카테고리/숏컷으로 진입한다.
export const TOP_TABS = [
  { id: "", label: "쇼핑 홈" },
  { id: "beauty", label: "뷰티" },
  { id: "food", label: "식품" },
  { id: "category", label: "카테고리" },
  { id: "sale", label: "특가" },
  { id: "season", label: "시즌 추천" },
] as const;

// 콘텐츠 홈으로 렌더하는 탭(히어로+서브카테고리+그리드). 나머지 그룹 id는 리스팅.
export const CONTENT_TABS = new Set(["beauty", "food"]);

// 히어로 슬라이드 — 홈은 카드형(좌텍스트+우이미지), 뷰티/식품은 풀블리드 이미지형.
// 원본 홈 히어로는 식품·생활 계열 중심이어서 카테고리를 섞는다 [Observed 01].
export const HOME_HERO = ["p-d-cof-1", "p-d-sun-mineral", "p-d-chair-1"];
export const GROUP_HERO: Record<string, string[]> = {
  beauty: ["p-d-sun-mineral", "p-d-lip", "p-d-tone"],
  food: ["p-d-cof-1", "p-d-pro-1", "p-d-cof-2"],
};

// 시즌 추천 탭 상품 — 쌀쌀한 계절 홈카페/무드 컨셉의 데모 큐레이션 [Project].
export const SEASONAL = [
  "p-d-lamp-2", "p-d-cof-1", "p-d-cof-2", "p-d-pro-1", "p-d-tee-2", "p-d-chair-2",
];

// 카테고리 브라우저의 서브카테고리 원형 아이콘 그리드 [Project].
// productIds는 대표 이미지와 ?sub= 필터링에 쓰인다.
export interface Subcat { id: string; label: string; productIds: string[] }
export const SUBCATS: Record<string, Subcat[]> = {
  digital: [
    { id: "earbuds", label: "이어폰", productIds: ["p-d-ear-lite", "p-d-ear-pro", "p-d-ear-ultra"] },
    { id: "keyboard", label: "키보드", productIds: ["p-d-key-87", "p-d-key-61"] },
    { id: "battery", label: "보조배터리", productIds: ["p-d-bat-10", "p-d-bat-20"] },
    { id: "monitor", label: "모니터", productIds: ["p-a", "p-b", "p-c"] },
  ],
  beauty: [
    { id: "sun", label: "선케어", productIds: ["p-d-sun-mineral", "p-d-sun-aqua", "p-d-sun-stick"] },
    { id: "cleansing", label: "클렌징", productIds: ["p-d-foam-1", "p-d-foam-2"] },
    { id: "makeup", label: "메이크업", productIds: ["p-d-lip", "p-d-tone"] },
  ],
  fashion: [
    { id: "tee", label: "티셔츠", productIds: ["p-d-tee-1", "p-d-tee-2"] },
    { id: "shoes", label: "스니커즈", productIds: ["p-d-sn-1", "p-d-sn-2"] },
  ],
  living: [
    { id: "chair", label: "의자", productIds: ["p-d-chair-1", "p-d-chair-2"] },
    { id: "light", label: "조명", productIds: ["p-d-lamp-1", "p-d-lamp-2"] },
  ],
  food: [
    { id: "coffee", label: "커피", productIds: ["p-d-cof-1", "p-d-cof-2"] },
    { id: "protein", label: "프로틴", productIds: ["p-d-pro-1"] },
  ],
};
export const subcatOf = (group: string, sub: string) =>
  SUBCATS[group]?.find((s) => s.id === sub);

export const SECTION_LABEL: Record<string, string> = {
  "flash-sale": "지금 특가",
  popular: "인기 상품",
  new: "새로 들어온 상품",
  recommended: "추천 상품",
  value: "가성비 상품",
};

// 상세 스펙 칩의 표시 라벨. DB specs_json 키는 영문 ID로 유지하고,
// 화면에는 이 표의 한글 라벨을 쓴다. 없는 키는 원문 그대로 노출.
export const SPEC_LABEL: Record<string, string> = {
  panel: "패널", size: "크기", resolution: "해상도", refresh_rate: "주사율",
  ports: "포트", anc: "노이즈캔슬링", battery_hours: "배터리", driver: "드라이버",
  waterproof: "방수", weight_g: "무게", codec: "코덱", layout: "배열",
  switch: "스위치", keycap: "키캡", connection: "연결", capacity: "용량",
  output: "출력", spf: "SPF", pa: "PA", uv_type: "자외선 차단", skin: "피부 타입",
  tone: "톤", finish: "마감", material: "소재", fit: "핏", weight_g_m2: "원단 무게",
  sole: "밑창", armrest: "팔걸이", lumbar: "요추 지지", recline: "틸트",
  max_load: "하중", dimming: "밝기 조절", color_temp: "색온도", light: "광원",
  volume: "용량", roast: "로스팅", origin: "원산지", note: "노트",
  protein_per_serving: "단백질", servings: "회분", type: "유형", closure: "마개",
  weight: "무게",
};

// 상품별 표시 메타. 원가는 최저가 옵션의 정가이며 없으면 할인 표시를 하지 않는다.
export const PRODUCT_META: Record<string, ProductMeta> = {
  // fixture 모니터 — category는 그대로 두고 디지털 그룹으로 묶인다.
  "p-a": { original_price_won: 219000, delivery: "내일도착", sections: ["recommended"] },
  "p-b": { original_price_won: 189000, delivery: "오늘출발", sections: ["recommended", "popular"] },
  "p-c": { delivery: "내일도착", sections: ["recommended"] },

  // digital
  "p-d-ear-lite": { original_price_won: 119000, delivery: "오늘출발", sections: ["flash-sale", "recommended"] },
  "p-d-ear-pro": { original_price_won: 189000, delivery: "오늘출발", sections: ["flash-sale", "popular"] },
  "p-d-ear-ultra": { delivery: "내일도착", sections: ["new"] },
  "p-d-key-87": { original_price_won: 99000, delivery: "오늘출발", sections: ["flash-sale", "recommended"] },
  "p-d-key-61": { delivery: "내일도착", sections: ["value"] },
  "p-d-bat-10": { original_price_won: 39000, delivery: "오늘출발", sections: ["flash-sale", "value"] },
  "p-d-bat-20": { delivery: "내일도착", sections: ["value"] },

  // beauty
  "p-d-sun-mineral": { original_price_won: 24000, delivery: "오늘출발", sections: ["flash-sale", "popular"] },
  "p-d-sun-aqua": { delivery: "오늘출발", sections: ["popular"] },
  "p-d-sun-stick": { delivery: "내일도착", sections: ["new", "value"] },
  "p-d-tone": { delivery: "내일도착", sections: ["new"] },
  "p-d-lip": { original_price_won: 19000, delivery: "오늘출발", sections: ["flash-sale", "new"] },
  "p-d-foam-1": { original_price_won: 12900, delivery: "오늘출발", sections: ["flash-sale", "value"] },
  "p-d-foam-2": { delivery: "내일도착", sections: ["value"] },

  // fashion
  "p-d-tee-1": { original_price_won: 29000, delivery: "오늘출발", sections: ["flash-sale", "popular"] },
  "p-d-tee-2": { delivery: "내일도착", sections: ["new"] },
  "p-d-sn-1": { original_price_won: 79000, delivery: "내일도착", sections: ["flash-sale", "popular"] },
  // sn-2는 전 옵션 품절 상품 — 특가/추천 섹션에서 제외한다.
  "p-d-sn-2": { delivery: "내일도착" },

  // living
  "p-d-chair-1": { original_price_won: 189000, delivery: "내일도착", sections: ["flash-sale", "popular"] },
  "p-d-chair-2": { delivery: "내일도착", sections: ["recommended"] },
  "p-d-lamp-1": { original_price_won: 45000, delivery: "오늘출발", sections: ["flash-sale", "value"] },
  "p-d-lamp-2": { delivery: "내일도착", sections: ["new"] },

  // food
  "p-d-cof-1": { original_price_won: 14900, delivery: "오늘출발", sections: ["flash-sale", "value", "popular"] },
  "p-d-cof-2": { delivery: "오늘출발", sections: ["new"] },
  "p-d-pro-1": { original_price_won: 42000, delivery: "오늘출발", sections: ["flash-sale"] },
};
