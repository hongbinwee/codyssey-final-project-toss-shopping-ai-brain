// 주문서(Checkout) 비동기 작업의 세대·actor 스코프 가드 [PMQA-067-R2].
// 대상(target) 변경·계정 전환·unmount 이후 도착한 늦은 응답은 화면 상태·
// pending intent·화면 이동을 건드리지 않는다 — intent는 보낸 actor의
// pending 버킷에 남아, 그 계정 복귀 시 '결과 확인'으로 명시 복구된다.
//
// 이 모듈은 판정만 한다(React·DOM·fetch 없음) — 실제 상태 적용·호출은
// screens/Checkout.tsx가 수행하고, 여기는 DB-free 단위 검증이 가능한
// 순수 계약만 둔다 [detail-resume.ts·cancel-flow.ts와 같은 분리 패턴].

export interface OpCtx {
  seq: number; // 작업 세대 — 시작할 때마다 1 증가
  scope: string | null; // pendingScope() 스냅샷 — 세션 사용자 버킷
  target: string; // 시작 시점의 targetKey — 새 작업 없이 대상만 바뀌어도
  // 이전 작업의 늦은 응답을 stale로 만든다(렌더 후 passive effect 이전 창 포함).
}

// 시작 시점과 응답 시점이 같은 세대·같은 actor일 때만 결과를 적용한다.
// 계정 전환은 targetKey 변경 없이 일어날 수 있어 seq만으로는 감지하지 못한다.
export const sameOpContext = (start: OpCtx, now: OpCtx): boolean =>
  start.seq === now.seq &&
  start.scope === now.scope &&
  start.target === now.target;

// 작업 세대 카운터 + actor 판정. start()마다 세대를 올려 이전에 시작된
// 작업의 늦은 응답을 stale로 만들고, unmount 시 invalidate()로 진행 중인
// 모든 응답을 무효화한다.
export function createOpGuard(
  getScope: () => string | null,
  getTarget: () => string,
) {
  let seq = 0;
  const now = (): OpCtx => ({ seq, scope: getScope(), target: getTarget() });
  return {
    // 작업 시작 — 반환된 OpCtx를 await 이후 stale() 판정에 사용한다.
    start(): OpCtx {
      seq += 1;
      return now();
    },
    // stale = 세대가 밀렸거나(더 새 작업 시작·unmount) actor가 바뀐 응답.
    // stale 응답은 서버 성공이어도 상태·intent·이동을 바꾸지 않는다.
    stale(start: OpCtx): boolean {
      return !sameOpContext(start, now());
    },
    // unmount — 진행 중인 모든 비동기 응답을 stale로 만든다.
    invalidate(): void {
      seq += 1;
    },
  };
}

// 견적·행동 키는 발급 대상(targetKey)과 actor에 묶인다. 대상이 바뀐
// 상태에서 이전 견적의 금액·결제 버튼이 남거나, 이전 대상의 토큰으로
// 결제가 진행되지 않게 한다.
export interface Bound<T> {
  key: string; // 발급 시점의 targetKey
  scope: string | null; // 발급 시점의 actor 버킷
  value: T;
}
// unbound(scope null)로 발급된 값은 절대 풀리지 않는다 — 세션 확인 전
// 발급·사용을 막는다 [PMQA-067-R2 추가 검수].
export const boundFor = <T>(
  b: Bound<T> | null,
  key: string,
  scope: string | null,
): T | null =>
  b && b.scope !== null && b.key === key && b.scope === scope ? b.value : null;
