// 최근 본 상품 — 계정별 브라우저 로컬 보관소 [C/069 F09, Ref45/46 관측 인벤토리].
// 상품 상세 '성공' 조회 시에만 기록한다. 가격·이미지 같은 표시 데이터는
// 저장하지 않는다 — 목록은 항상 현재 상품 API 계약으로 렌더한다(저장 스냅샷 정본 금지).
//
// [안전 계약]
// - 저장 namespace는 호출자가 넘긴 세션 검증 user.id다. 전역 scope/binding을
//   두지 않는다 — 마운트 순서·계정 전환으로 이전 계정 버킷을 읽을 경로가 없다.
//   userId가 null이면 읽기·쓰기 모두 no-op이다.
// - storage 실패는 상세 화면 동작을 막지 않는다(조용한 no-op).
// - 저장 계층: localStorage → sessionStorage → 인메모리. 각 레코드는 단조
//   증가 revision at을 가진다 — Date.now()만 쓰면 같은 ms·clock 뒤집힘에서
//   session에 새로 쓴 최신본이 local의 같은/이전 at에 질 수 있으므로, 쓰기 시
//   사용 가능한 모든 계층의 기존 at보다 반드시 1 큰 값을 부여한다. 읽기는
//   모든 계층 중 at이 가장 큰 레코드를 고른다 — local 쓰기만 실패한 환경에서
//   session에 저장한 최신 기록이 reload 뒤 stale local에 가려지지 않는다.
//   local 쓰기가 회복되면 최신 레코드가 local로 이관되고 session 사본은
//   정리된다(local=쓰기 가능할 때 정본 계층).
// - 인메모리는 페이지 생명주기 한정 — 어느 계층을 쓰는지 recentPersistence()로
//   정직하게 노출한다.

export type RecentPersistence = "local" | "session" | "memory";

interface RecentRecord {
  at: number; // 기록 시각(ms) — 계층 간 최신성 비교 기준
  ids: string[];
}

const LS_PREFIX = "recent-viewed-v1:";
const MAX = 50; // 보관 상한 [Project]

// storage 불가 버킷의 인메모리 대체 — storage가 살아나면 다음 저장에서 덮어쓴다.
const mem = new Map<string, string[]>();
// 버킷별 마지막으로 데이터가 실린 계층 — 화면의 persistence 안내에 쓴다.
const lastMode = new Map<string, RecentPersistence>();

const bucket = (userId: string) => LS_PREFIX + userId;

// 저장 id 정제 — 비어 있지 않은 문자열만, 입력 순서를 유지한 중복 제거, 상한.
const sanitize = (ids: unknown[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of ids) {
    if (typeof x !== "string" || x.length === 0 || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length >= MAX) break;
  }
  return out;
};

// at은 유한한 양의 revision이어야 한다 — 손상·NaN·Infinity는 데이터 없음과
// 구분해 무효 레코드로 버린다.
const validAt = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;

// window.localStorage/sessionStorage는 접근 자체가 SecurityError를 던질 수 있어
// globalThis 프로퍼티 조회도 try로 감싼다. 미존재(Node)면 null.
const getStore = (n: "localStorage" | "sessionStorage"): Storage | null => {
  try {
    return ((globalThis as Record<string, unknown>)[n] as Storage) ?? null;
  } catch {
    return null;
  }
};

// 스토어 읽기 시도 — 접근 자체가 불가(비활성·예외)면 usable=false로 다음
// 계층으로 넘긴다. JSON 손상/구형식은 '데이터 없음'으로 처리한다(스토어는 유효).
function tryRead(s: Storage, k: string): { usable: boolean; rec: RecentRecord | null } {
  try {
    const raw = s.getItem(k);
    if (raw == null) return { usable: true, rec: null };
    const v = JSON.parse(raw) as RecentRecord | string[];
    // 신형식 {at, ids} — 구형식 배열은 at=0으로 취급해 신형식에 항상 진다.
    if (Array.isArray(v))
      return { usable: true, rec: { at: 0, ids: sanitize(v) } };
    if (!v || !validAt(v.at) || !Array.isArray(v.ids))
      return { usable: true, rec: null };
    return { usable: true, rec: { at: v.at, ids: sanitize(v.ids) } };
  } catch {
    return { usable: false, rec: null };
  }
}

// 모든 사용 가능 계층의 기존 at 중 최댓값 — 다음 revision은 반드시 이보다
// 커야 한다(같은 ms·clock 뒤집힘에서도 session 최신본이 local 구버전에 지지
// 않도록). 인메모리 버킷은 이번 페이지 최신본이지만 at을 저장하지 않으므로
// storage revision과 비교 대상에서 제외한다.
function maxStoredAt(k: string): number {
  let max = -1;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const s = getStore(name);
    if (!s) continue;
    const r = tryRead(s, k);
    if (r.usable && r.rec && r.rec.at > max) max = r.rec.at;
  }
  return max;
}

// 사용 가능한 모든 계층을 읽고 at이 가장 큰 레코드를 고른다 — 어느 계층에
// 쓰기가 성공했든 reload에서 최신 레코드를 찾는 계약이다.
function readAll(k: string): string[] {
  // 인메모리 버킷은 이번 페이지에서 storage가 실패해 쓴 최신본 — 먼저 본다.
  const m = mem.get(k);
  if (m) return m;
  let best: RecentRecord | null = null;
  let bestMode: RecentPersistence = "local";
  for (const [storeName, mode] of [
    ["localStorage", "local"],
    ["sessionStorage", "session"],
  ] as const) {
    const s = getStore(storeName);
    if (!s) continue;
    const r = tryRead(s, k);
    if (!r.usable || !r.rec) continue;
    if (!best || r.rec.at > best.at) {
      best = r.rec;
      bestMode = mode;
    }
  }
  if (best) {
    lastMode.set(k, bestMode);
    return best.ids;
  }
  // 데이터가 없어도 계층 사용 가능 여부는 쓰기 경로와 동일하게 추정해 둔다.
  if (getStore("localStorage")) lastMode.set(k, "local");
  else if (getStore("sessionStorage")) lastMode.set(k, "session");
  else lastMode.set(k, "memory");
  return [];
}

// 정본 계층은 local — 쓰기가 성공하면 최신 레코드를 local에 두고 하위 계층의
// stale 사본을 지운다. local 쓰기 실패 시 session, 둘 다 실패 시 인메모리.
function writeAll(k: string, ids: string[]) {
  // 단조 revision — 사용 가능 계층의 기존 at을 넘는 값을 보장한다.
  const rec: RecentRecord = {
    at: Math.max(Date.now(), maxStoredAt(k) + 1),
    ids: sanitize(ids),
  };
  const payload = JSON.stringify(rec);
  const local = getStore("localStorage");
  if (local) {
    try {
      local.setItem(k, payload);
      try {
        getStore("sessionStorage")?.removeItem(k);
      } catch {
        /* no-op */
      }
      mem.delete(k);
      lastMode.set(k, "local");
      return;
    } catch {
      /* 다음 계층 */
    }
  }
  const sess = getStore("sessionStorage");
  if (sess) {
    try {
      sess.setItem(k, payload);
      // session에만 쓰인 최신본이 local의 오래된 사본에 가려지지 않는다 —
      // 읽기는 at 비교로 session을 고른다. 지울 수 있으면 stale local도 정리한다.
      try {
        local?.removeItem(k);
      } catch {
        /* no-op */
      }
      mem.delete(k);
      lastMode.set(k, "session");
      return;
    } catch {
      /* 다음 계층 */
    }
  }
  mem.set(k, rec.ids);
  lastMode.set(k, "memory");
}

// userId가 null이면 기록하지 않는다 — 계정을 알 수 없는 조회를 이후 다른
// 계정의 목록에 섞지 않기 위함이다 [C/069 F09 가드].
export function recordRecentView(userId: string | null, productId: string) {
  if (!userId || typeof productId !== "string" || !productId) return;
  try {
    const k = bucket(userId);
    writeAll(k, [productId, ...readAll(k).filter((x) => x !== productId)]);
  } catch {
    /* 기록 실패는 상세 동작을 막지 않는다 */
  }
}

// 최신 방문이 앞 — userId가 null이면 노출하지 않는다.
export const listRecentViews = (userId: string | null): string[] =>
  userId ? readAll(bucket(userId)) : [];

// 개별 삭제 — Ref46의 선택 탭은 '찜'으로 확인되어 최근본 삭제의 관측 근거로
// 쓰지 않는다. 프로젝트 자체 유용성 결정이다 [Project / 인벤토리 Gap].
export function removeRecentView(userId: string | null, productId: string) {
  if (!userId) return;
  try {
    const k = bucket(userId);
    writeAll(k, readAll(k).filter((x) => x !== productId));
  } catch {
    /* no-op */
  }
}

// 마지막으로 데이터가 실린 계층 — 'local'이 아니면 reload 뒤 목록이 유실될 수
// 있음을 화면에 정직하게 안내해야 한다.
export const recentPersistence = (userId: string | null): RecentPersistence =>
  (userId && lastMode.get(bucket(userId))) || "local";
