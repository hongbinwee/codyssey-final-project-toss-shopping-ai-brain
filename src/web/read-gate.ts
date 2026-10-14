// 조회 가드 — 세대(generation)+언마운트 무효화로 stale/언마운트된 조회의
// 결과 적용(setRes·부모 콜백·setLoading)을 차단한다 [PMQA-072 MAJOR069-07].
// 쓰기 확정이 invalidate()로 진행 중 읽기를 죽이는 기존 계약은 유지한다 —
// 단순히 모든 쓰기 완료 콜백을 막는 것이 아니라 '조회 적용'만 가드한다.
// React·DOM·fetch 없는 순수 상태기 — 실제 사용 경로를 deferred mock IO로 검증.
export interface ReadGate {
  // 새 읽기 시작 — 반환된 generation을 적용 시점에 current()로 검증한다.
  start(): number;
  // 쓰기 확정 등으로 진행 중 읽기를 무효화 — 다음 start 전까지 현재 gen을 죽인다.
  invalidate(): void;
  // 언마운트 — 이후 어떤 적용도 허용하지 않는다.
  kill(): void;
  // 현재 살아있는가 — 언마운트 후에는 항상 false.
  alive(): boolean;
  // 이 generation의 읽기가 지금 적용 가능한가 — 언마운트/무효화/더 새 읽기면 false.
  current(my: number): boolean;
}

export function createReadGate(): ReadGate {
  let seq = 0;
  let dead = false;
  return {
    start: () => ++seq,
    invalidate: () => {
      seq++;
    },
    kill: () => {
      dead = true;
      seq++;
    },
    alive: () => !dead,
    current: (my) => !dead && seq === my,
  };
}

// 조회 적재 — start()로 generation을 배정하고 fetcher가 끝난 뒤 current(my)일
// 때만 apply를 호출한다. stale/언마운트된 조회는 응답을 그대로 돌려주되
// apply(=setRes·콜백)를 호출하지 않는다 — 호출부가 응답 자체를 쓰는
// 경우(복구 안내 등)는 계속 받을 수 있다. my를 미리 넘기면 호출부가 확정한
// generation으로 조회를 묶는다(마운트/재시도의 loading 해제 가드용).
export async function guardedRead<T>(
  gate: ReadGate,
  fetcher: () => Promise<T>,
  apply: (r: T) => void,
  my?: number,
): Promise<T> {
  const gen = my ?? gate.start();
  const r = await fetcher();
  if (!gate.current(gen)) return r;
  apply(r);
  return r;
}
