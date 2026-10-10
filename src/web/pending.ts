// 미확정 쓰기 intent 보관소 — OUTCOME_UNKNOWN/NETWORK 유실 응답의 복구 근거.
// kind·key·원본 path/method/payload(expected version 포함)를 보존해 결과 조회와
// 사용자 명시 재시도(같은 키/페이로드)를 지원한다.
//
// [안전 계약]
// - intent는 POST/PATCH/DELETE 전송 전에 저장하고, 확정 결과(ok/확정 거절)에서만
//   제거한다 — 서버 commit 직후 탭 종료·route 이동으로 응답이 유실돼도 복구 가능.
// - 저장 namespace는 세션으로 검증된 user.id다. 같은 브라우저에서 계정이 바뀌면
//   이전 계정의 intent는 보이지도 실행되지도 않고, 원 계정 복귀 시 복구된다.
// - 세션 확인 전(scope 미바인딩)에는 어떤 intent도 노출/재시도하지 않는다.
// - localStorage 거부·손상 시 메모리 버킷으로 대체해 intent 유실과 무한 busy를 막는다.
//   (페이지 생명주기 한정 — storage가 죽은 환경에서는 reload 복구 불가)

export interface PendingWrite {
  uiKey: string; // 클라이언트 idempotency key (서버 조회 시 'ui-' 접두)
  kind: "ADD_CART" | "UPDATE_CART" | "REMOVE_CART";
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  payload: Record<string, unknown>;
  label: string;
  at: number;
}

const LS_PREFIX = "pending-writes-v1:";
const LS_LEGACY = "pending-writes-v1"; // 사용자 미구분 구버전 키 — 읽지 않고 정리만.
const MAX = 10;

const KINDS = new Set<string>(["ADD_CART", "UPDATE_CART", "REMOVE_CART"]);
const METHODS = new Set<string>(["POST", "PATCH", "DELETE"]);

const valid = (x: unknown): x is PendingWrite => {
  const p = x as PendingWrite;
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.uiKey === "string" &&
    p.uiKey.length > 0 &&
    KINDS.has(p.kind) &&
    METHODS.has(p.method) &&
    typeof p.path === "string" &&
    p.path.startsWith("/api/") &&
    !!p.payload &&
    typeof p.payload === "object" &&
    typeof p.label === "string" &&
    typeof p.at === "number"
  );
};

let scope: string | null = null;
const mem = new Map<string, PendingWrite[]>();

// 브라우저 전용 이벤트 — Node(unit test) 환경에서는 조용히 무시한다.
const emit = () => {
  try {
    dispatchEvent(new Event("pending-writes"));
  } catch {
    /* no-op */
  }
};

// 세션 확정(로그인·복원) 후 호출한다. user.id가 바뀌면 버킷이 바뀌어 타인 intent가
// 격리된다. 로그아웃/미인증이면 null을 넘겨 노출을 끊는다.
export function bindPendingUser(userId: string | null) {
  scope = userId || null;
  try {
    localStorage.removeItem(LS_LEGACY);
  } catch {
    /* storage 불가 환경 — 정리 실패는 무시 */
  }
  emit();
}

const bucket = () => LS_PREFIX + (scope ?? "unbound");

function readAll(): PendingWrite[] {
  const k = bucket();
  // write 실패로 메모리에만 있는 버킷은 storage보다 최신 — 먼저 본다.
  // (QuotaExceeded처럼 read는 되고 write만 실패하는 환경에서 intent 유실 방지)
  const m = mem.get(k);
  if (m) return m;
  try {
    const v: unknown = JSON.parse(localStorage.getItem(k) ?? "null");
    if (Array.isArray(v)) return v.filter(valid);
  } catch {
    /* storage 손상/거부 → 메모리 버킷 */
  }
  return [];
}

function writeAll(list: PendingWrite[]) {
  const k = bucket();
  const next = list.slice(0, MAX);
  try {
    localStorage.setItem(k, JSON.stringify(next));
    mem.delete(k);
  } catch {
    mem.set(k, next); // 저장 실패 — 메모리로 유지해 spinner·키 유실 방지
  }
  emit();
}

// scope 미바인딩(세션 확인 전)에는 노출하지 않는다.
export const listPending = (): PendingWrite[] => (scope ? readAll() : []);
export const getPending = (uiKey: string) =>
  listPending().find((p) => p.uiKey === uiKey) ?? null;

export function putPending(p: PendingWrite) {
  if (!scope || !valid(p)) return;
  writeAll([p, ...readAll().filter((x) => x.uiKey !== p.uiKey)]);
}

export function removePending(uiKey: string) {
  if (!scope) return;
  writeAll(readAll().filter((x) => x.uiKey !== uiKey));
}

// 결과 조회 응답 해석. 서버 action 조회는 'ui-' 접두 키로 질의한다.
// transport 실패는 NETWORK 봉투로 돌아오므로 호출자는 '조회 불가'로 처리한다.
export async function lookupAction(p: PendingWrite) {
  const { apiSafe } = await import("./api.ts");
  return apiSafe<{ status: string; result?: { cart?: unknown } }>(
    "/api/actions?kind=" +
      p.kind +
      "&idempotency_key=" +
      encodeURIComponent("ui-" + p.uiKey),
  );
}
