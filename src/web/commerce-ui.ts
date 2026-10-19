import type { Availability } from "../contracts.ts";

export type CatalogUiContext = {
  read_only: boolean;
  is_simulated: boolean;
};

// Commerce is enabled only after the catalog context has explicitly confirmed
// that the selected catalog is writable. Unknown/error states fail closed.
export const isCommerceEnabled = (
  context: CatalogUiContext | null | undefined,
): boolean => context != null && !context.read_only;

export function variantStockLabel(
  availability: Availability,
  stockQty: number,
  readOnly: boolean,
): string {
  if (availability === "SOLD_OUT") return "품절";
  if (availability === "UNAVAILABLE") return "판매 중단";
  return readOnly ? "시연 옵션 · 주문 불가" : `재고 ${stockQty}개`;
}
