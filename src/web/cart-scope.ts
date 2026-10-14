// actor 소유 카트 스냅샷 [069-06] — 부모 cart 상태를 {owner, view}로 보관하고,
// 렌더 시점에 owner===현재 userId일 때만 자식·배지에 노출한다.
//
// 왜 필요한가: userId가 바뀌는 첫 렌더에서 Cart는 새 key로 재마운트되지만,
// 부모의 setCart(null)은 useEffect에서만 실행된다 — owner 필터가 없으면
// 그 첫 렌더에 이전 actor의 CartView가 props로 전달돼 자식 useState 초기값과
// 배지에 새어나간다. 순수 함수라 DB·React 없이 입력/상태 전환을 검증한다.
import type { CartView } from "../contracts.ts";

export type OwnedCart = { owner: string | null; v: CartView };

// 렌더용 가시 카트 — 스냅샷 owner가 현재 actor와 정확히 일치할 때만 view를
// 돌려준다(미로그인/전환 직후/다른 계정 스냅샷은 전부 null).
export const visibleCart = (
  snap: OwnedCart | null,
  userId: string | null,
): CartView | null => (snap && snap.owner === userId ? snap.v : null);

