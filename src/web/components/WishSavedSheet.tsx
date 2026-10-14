// 찜 저장 피드백 시트 — Ref06 관측 구조의 최소 구현 [PMQA-070]:
//   [썸네일][찜 목록에 추가했어요][우측 파란 바로가기] 한 행 + 하단 큰 단일
//   닫기 CTA. 상품 썸네일·이름은 카드/상세가 이미 가진 데이터를 그대로
//   표시한다 — 없는 추천 알고리즘·가격 변화·혜택 안내는 만들지 않는다.
//   실제 저장 '확정' 후에만 연다(낙관적 시트 금지).
import { BottomSheet } from "./BottomSheet.tsx";
import { productImg } from "../display-meta.ts";

export interface WishSheetProduct {
  product_id: string;
  name: string;
  image: string | null;
  price_won?: number | null; // 호환용 — Ref06 core 행에는 표시하지 않는다
}

export function WishSavedSheet({
  product,
  onClose,
  onGoWish,
}: {
  product: WishSheetProduct;
  onClose: () => void;
  onGoWish: () => void;
}) {
  return (
    <BottomSheet title="찜" onClose={onClose} lockScroll>
      <div className="wish-sheet-body">
        {/* Ref06 core feedback 행 — 썸네일 + 추가 안내 + 우측 파란 바로가기
            [Observed]. 추천 rail은 미지원 — 별도 Gap으로 기록한다. */}
        <div className="wish-sheet-row">
          <span className="wish-sheet-thumb">
            <img
              src={productImg({
                product_id: product.product_id,
                image: product.image,
              })}
              alt=""
            />
          </span>
          <span className="wish-sheet-txt">
            찜 목록에 추가했어요
            <span className="wish-sheet-name">{product.name}</span>
          </span>
          <button className="link wish-sheet-go" onClick={onGoWish}>
            바로가기
          </button>
        </div>
        {/* 하단 큰 단일 닫기 CTA [Observed] */}
        <button className="btn primary wish-sheet-close" onClick={onClose}>
          닫기
        </button>
      </div>
    </BottomSheet>
  );
}

