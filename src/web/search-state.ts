// 검색 화면 상태 판정 — 입력(query) 소유권과 응답을 분리해 stale 결과가
// 현재 검색어 아래 표시/실행되지 않게 한다 [PMQA-071 PM 정정].
// React·DOM·fetch 없는 순수 계산 — 실제 사용 경로를 mock 데이터로 검증한다.
import type { ApiResult } from "./api.ts";
import type { SearchResult } from "../contracts.ts";

// 응답을 발행 시점의 query와 함께 보관한다 — owner가 현재 query와 다르면
// 표시·실행 모두 차단한다 (A 결과가 B 입력 아래 남는 경로 차단).
export interface Owned<T> {
  q: string;
  r: T;
}
export const owned = <T,>(o: Owned<T> | null, q: string): T | null =>
  o !== null && o.q === q ? o.r : null;

export type SuggestState = "loading" | "error" | "empty" | "items";
// 자동완성 표시 상태 — sugs가 현재 입력(text) 소유가 아니면 loading 취급:
// 지우기/수정 중에는 이전 query의 결과를 절대 보여주지 않는다.
// loading(요청 중)·error(실패)·empty(확정 빈 결과)·items를 구분한다 — 실패를
// '일치하는 상품명이 없어요'로 오표시하지 않는다 [PM].
export const suggestState = (
  text: string,
  sugs: Owned<ApiResult<SearchResult>> | null,
): SuggestState => {
  if (sugs === null || sugs.q !== text) return "loading";
  if (!sugs.r.ok) return "error";
  return sugs.r.data.items.length > 0 ? "items" : "empty";
};

export type CountState = "loading" | "error" | "ready";
// 필터 CTA 개수 상태 — '확인 중'과 '실패'를 구분한다. 미확정 개수는
// 약속하지 않는다(실패를 영구 로딩으로 표시하지 않는다) [PM].
export const filterCountState = (
  loading: boolean,
  res: ApiResult<SearchResult> | null,
): CountState => {
  if (loading || res === null) return "loading";
  if (!res.ok) return "error";
  return res.data.has_more ? "loading" : "ready";
};
