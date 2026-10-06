// 서버 API 호출 래퍼. 응답은 공통 ToolResult 봉투다.
export type ApiResult<T> =
  | { ok: true; data: T; operation_id?: string; replayed?: boolean }
  | { ok: false; error: { code: string; message: string }; operation_id?: string };

export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return (await r.json()) as ApiResult<T>;
}

export const fmtWon = (n: number) => n.toLocaleString("ko-KR") + "원";

// 어느 Brain과 대화할지. 서버는 user:brain 단위로 Tool 목록과 히스토리를 나눈다.
export type AgentBrain = "shopping" | "cs";

// 카트 변경은 같은 사용자 행동에 같은 키를 쓴다. 재시도 시 이 키를 재사용한다.
export const newActionKey = () => crypto.randomUUID();
