// 요청 세대 가드 — 화면마다 리소스별 독립 게이트를 둔다.
// 각 begin()은 새 세대를 열고 그 세대의 응답이 아직 유효한지 답하는 확인자를
// 돌려준다. 같은 게이트의 다음 begin()이나 kill()(unmount·계정 전환) 이후의
// 늦은 응답은 상태를 갱신하지 못한다. 서로 다른 게이트는 서로를 무효화하지
// 않는다 — orders/products 병렬 로드가 한쪽을 starving시키지 않는다 [C/069].
export function createRequestGate() {
  let seq = 0;
  let alive = true;
  return {
    begin(): () => boolean {
      const my = ++seq;
      return () => alive && seq === my;
    },
    kill() {
      alive = false;
      seq++;
    },
  };
}
