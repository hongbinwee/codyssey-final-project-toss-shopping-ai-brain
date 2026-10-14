// 찜 클라이언트 컨트롤러 [PMQA-070] — 계정 스코프 공유 스토어.
//
// [안전 계약]
// - 스토어는 명시 userId 키의 버킷이다 — 전역 scope가 없어 계정 전환/복원
//   타이밍에 다른 계정의 찜 집합을 읽을 경로가 없다. userId=null이면
//   읽기·쓰기 모두 no-op이다.
// - 모든 IO 진입점은 시작 시점과 각 await 완료 시점에 io.scope()===userId를
//   재검증한다 [PM070-1]. pending 저장소는 전역 scope 버킷이라 scope가 바뀐
//   뒤 removePending/putPending을 호출하면 새 계정 버킷을 건드린다 — 불일치
//   시 intent·스토어 변경 없이 ABORTED로 방치한다(원 계정 버킷에 보존).
// - GET 적용은 fetchSeq(마지막 fetch만)+gen(확정 PUT·적용 GET마다 증가)의
//   이중 가드 — GET 시작 후 완료된 PUT이 gen을 올렸으면 늦게 도착한 GET
//   응답은 버려 확정 상태를 덮지 않는다 [PM070-2]. force 재조회는 fetchSeq로
//   직전 fetch를 무효화해 경합을 정리한다.
// - 같은 상품의 미해결 SET_WISHLIST intent가 있으면 새 키 토글을 차단한다
//   (PENDING_EXISTS) — commit 여부가 불명인 동안 반대 intent를 새로 만들지
//   않는다. '결과 확인'/'같은 키 다시 시도'로만 해소한다 [PM070-3].
// - 하트는 'confirmed'만 표시한다 — 낙관적 토글 없이 서버 ok 확정 뒤에만
//   저장 상태를 바꾼다. PUT 응답에는 표시 정보가 없으므로 저장 확정 시
//   display가 없으면 목록 재조회로 보강한다(합성 금지).
// - 복구·재시도는 저장된 pending의 kind·method·path·payload(saved·
//   product_id·idempotency_key)·현재 계정 소속을 검증한다 — 변조된
//   payload를 임의 값으로 강제 변환해 실행하지 않는다 [PM070-4].
// - React 효과 순서: 자식의 ensure effect는 부모의 bindPendingUser보다
//   먼저 실행될 수 있다 — scope 미확정 시 ensure는 no-op이므로,
//   useWishlist는 bind가 쏘는 'pending-writes'를 구독해 scope 확정 뒤
//   재적재한다 [PM070 scope 순서 지적].
// - IO는 주입식(cancel-flow 패턴) — 화면은 실제 api/pending을, unit
//   테스트는 mock을 꽂아 같은 핸들러를 DB·브라우저 없이 검증한다.
import { apiSafe, newActionKey, AMBIGUOUS_CODES, type ApiResult } from "./api.ts";
import type { WishlistItemView, WishlistView, SetWishlistResult } from "../contracts.ts";
import { useEffect, useReducer, useState } from "react";
import {
  listPendingByKind, lookupAction, putPending, removePending, pendingScope,
  type PendingWrite,
} from "./pending.ts";

export interface WishlistIO {
  getList(): Promise<ApiResult<WishlistView>>;
  putSaved(
    path: string,
    body: { product_id: string; saved: boolean; idempotency_key: string },
  ): Promise<ApiResult<SetWishlistResult>>;
  lookupAction(
    uiKey: string,
  ): Promise<ApiResult<{ status: string; result?: unknown; error_code?: string | null }>>;
  putPending(pw: PendingWrite): void;
  removePending(uiKey: string): void;
  listPending(): PendingWrite[];
  scope(): string | null;
}

// 실제 배선 — 찜 pending 조회는 'ui-' 접두 키로 서버 action을 조회한다.
const defaultIo: WishlistIO = {
  getList: () => apiSafe<WishlistView>("/api/wishlist"),
  putSaved: (path, body) =>
    apiSafe<SetWishlistResult>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  lookupAction: (uiKey) =>
    lookupAction({
      uiKey,
      kind: "SET_WISHLIST",
      path: "/api/wishlist",
      method: "PUT",
      payload: {},
      label: "",
      at: 0,
    }),
  putPending,
  removePending,
  listPending: () => listPendingByKind("SET_WISHLIST"),
  scope: pendingScope,
};

export type WishlistOutcome =
  | { kind: "SAVED"; saved: boolean; count: number }
  | { kind: "BUSY" }                       // 같은 상품 쓰기 진행 중 — 추가 호출 0
  | { kind: "PENDING_EXISTS" }             // 같은 상품 미해결 intent — 새 키 차단
  | { kind: "NOACTOR" }                    // 계정 없음/scope 불일치 — 어떤 쓰기도 0
  | { kind: "ABORTED" }                    // await 중 scope 변경 — intent만 원 계정에 보존
  | { kind: "LOST" }                       // commit 불확정 — intent 유지, 복구 필요
  | { kind: "RETRYABLE" }                  // 서버 기록 없음 — 같은 키 명시 재시도 가능
  | { kind: "REJECTED"; code: string; message: string } // 확정 거절 — intent 해제
  | { kind: "DONE" }                       // 복구: 서버가 완료 확정
  | { kind: "UNKNOWN_KEEP" };              // 복구 불가/처리 중 — intent 유지

type Store = {
  status: "idle" | "loading" | "ready" | "error";
  items: Map<string, string>;                    // product_id → saved_at
  display: Map<string, WishlistItemView>;        // product_id → 표시 정보(서버 목록)
  busy: Set<string>;                             // 쓰기 진행 중인 product_id
  inflight: Promise<void> | null;
  gen: number;      // 확정 PUT·적용 GET마다 증가 — 늦은 GET의 덮어쓰기 차단
  fetchSeq: number; // 시작된 GET 순번 — 마지막 fetch만 적용
};

const stores = new Map<string, Store>();
const EMPTY: Store = {
  status: "idle",
  items: new Map(),
  display: new Map(),
  busy: new Set(),
  inflight: null,
  gen: 0,
  fetchSeq: 0,
};

const storeFor = (uid: string): Store => {
  let s = stores.get(uid);
  if (!s) {
    s = {
      status: "idle",
      items: new Map(),
      display: new Map(),
      busy: new Set(),
      inflight: null,
      gen: 0,
      fetchSeq: 0,
    };
    stores.set(uid, s);
  }
  return s;
};

const emit = () => {
  try {
    dispatchEvent(new Event("wishlist-changed"));
  } catch {
    /* Node 환경 — 무시 */
  }
};

// 목록 1회 적재(동시 호출 dedupe). force면 확정 후 재조회에도 쓴다.
// scope는 시작·완료 양쪽에서 검증한다 — 다른 계정 컨텍스트의 API 결과를
// 이 uid 버킷에 쓰지 않는다 [PM070-1].
export function ensureWishlist(
  userId: string | null,
  opts?: { force?: boolean; io?: WishlistIO },
): Promise<void> | null {
  if (!userId) return null;
  const io = opts?.io ?? defaultIo;
  if (io.scope() !== userId) return null; // scope 미확정/다른 계정 — 시작 거절
  const s = storeFor(userId);
  if (s.inflight && !opts?.force) return s.inflight;
  if (!opts?.force && (s.status === "ready" || s.status === "loading"))
    return null;
  // force+inflight — 진행 중인 구 GET을 기다리지 않고 실제 새 GET을 시작한다.
  // 아래 fetchSeq 증가로 구 fetch의 결과는 폐기되고(덮어쓰기 방지),
  // inflight 자기검사로 구 fetch가 새 promise를 clear하지 못한다 [PM070-2 재검수].
  const my = ++s.fetchSeq;
  const genAt = s.gen;
  s.status = "loading";
  emit();
  const p = (async () => {
    const r = await io.getList();
    // 소유 seq만 clear·적용 — 무효화된 구 fetch는 새 fetch의 inflight를
    // 지우지도 상태를 덮지도 못한다.
    if (s.fetchSeq === my) {
      s.inflight = null;
      // 완료 시점 재검증 — 계정이 바뀌었거나 사이에 PUT이 확정(gen 변경)된
      // 응답은 버린다 [PM070-1/2].
      if (io.scope() === userId && s.gen === genAt) {
        if (r.ok) {
          s.items = new Map(
            r.data.items.map((i) => [i.product_id, i.saved_at]),
          );
          s.display = new Map(
            r.data.items.map((i) => [i.product_id, i]),
          );
          s.status = "ready";
        } else {
          s.status = "error";
        }
      } else if (io.scope() !== userId) {
        // 다른 계정 컨텍스트 — loading에 머물지 않게 idle로 돌려 다음
        // 진입 시 재조회하게 한다.
        s.status = "idle";
      }
      // gen만 불일치면 확정 PUT이 더 최신 상태를 이미 반영한 것 — 그대로 둔다.
    }
    // fetchSeq가 바뀌었으면 더 새로운 fetch가 상태를 책임진다.
    emit();
  })();
  s.inflight = p;
  return p;
}

// 복구·거절·표시 보강 후 최신 서버 목록으로 확정한다 — replay/과거 결과를
// 현재 상태로 쓰지 않는다.
export const refreshWishlist = (userId: string | null, io?: WishlistIO) =>
  ensureWishlist(userId, { force: true, io });

export type WishlistSnap = {
  status: Store["status"];
  saved: ReadonlyMap<string, string>;
  display: ReadonlyMap<string, WishlistItemView>;
  busy: ReadonlySet<string>;
  count: number;
};

export const wishlistSnap = (userId: string | null): WishlistSnap => {
  const s = userId ? (stores.get(userId) ?? EMPTY) : EMPTY;
  return {
    status: s.status,
    saved: s.items,
    display: s.display,
    busy: s.busy,
    count: s.items.size,
  };
};

// 저장/해제 — confirmed만 반영한다. 같은 상품의 진행 중 write는 BUSY로,
// 미해결 intent는 PENDING_EXISTS로 거절해 중복 호출·연타·반대 intent 생성을
// 막는다 [PM070-3].
export async function toggleWishlist(
  userId: string | null,
  productId: string,
  saved: boolean,
  io: WishlistIO = defaultIo,
): Promise<WishlistOutcome> {
  if (!userId || io.scope() !== userId) return { kind: "NOACTOR" };
  const s = storeFor(userId);
  if (s.busy.has(productId)) return { kind: "BUSY" };
  if (
    io.listPending().some(
      (p) => p.kind === "SET_WISHLIST" && p.payload.product_id === productId,
    )
  ) return { kind: "PENDING_EXISTS" };
  s.busy.add(productId);
  emit();
  const key = newActionKey();
  const path = "/api/wishlist/" + encodeURIComponent(productId);
  const body = { product_id: productId, saved, idempotency_key: key };
  io.putPending({
    uiKey: key,
    kind: "SET_WISHLIST",
    path,
    method: "PUT",
    payload: body,
    label: productId,
    at: Date.now(),
  });
  const r = await io.putSaved(path, body);
  s.busy.delete(productId);
  // await 이후 scope 재검증 — 바뀌었으면 intent는 원 계정 버킷에 두고
  // removePending·스토어 변경 없이 방치한다 [PM070-1].
  if (io.scope() !== userId) { emit(); return { kind: "ABORTED" }; }
  if (r.ok) {
    io.removePending(key);
    s.gen++; // 늦은 GET이 이 확정을 덮지 않게 세대를 올린다 [PM070-2]
    if (r.data.saved) {
      s.items.set(productId, new Date().toISOString());
      // PUT 응답에는 표시 정보가 없다 — 없으면 서버 목록으로 보강한다.
      if (!s.display.has(productId))
        void ensureWishlist(userId, { force: true, io });
    } else {
      s.items.delete(productId);
      s.display.delete(productId);
    }
    s.status = "ready";
    emit();
    return { kind: "SAVED", saved: r.data.saved, count: r.data.wishlist_count };
  }
  emit();
  if (AMBIGUOUS_CODES.has(r.error.code)) return { kind: "LOST" };
  io.removePending(key);
  return {
    kind: "REJECTED",
    code: r.error.code,
    message: r.error.message,
  };
}

// 저장된 intent의 형식·소속 검증 — 변조된 payload는 임의 값으로 강제 변환해
// 실행하지 않고 거절한다 [PM070-4]. requireListed는 현재 계정 버킷에 아직
// 남아 있는 intent인지까지 확인한다(재시도용 — 이미 해소된 intent의
// 재전송을 막는다).
export function wishPendingError(
  pw: PendingWrite,
  io: Pick<WishlistIO, "listPending">,
  opts?: { requireListed?: boolean },
): string | null {
  if (pw.kind !== "SET_WISHLIST") return "찜 요청이 아닙니다";
  if (pw.method !== "PUT") return "요청 방식이 다릅니다";
  const pid =
    typeof pw.payload.product_id === "string" ? pw.payload.product_id : "";
  if (!pid || pw.path !== "/api/wishlist/" + encodeURIComponent(pid))
    return "요청 대상이 일치하지 않습니다";
  if (typeof pw.payload.saved !== "boolean")
    return "요청 형식이 올바르지 않습니다";
  if (pw.payload.idempotency_key !== pw.uiKey)
    return "요청 키가 일치하지 않습니다";
  if (
    opts?.requireListed &&
    !io.listPending().some((x) => x.uiKey === pw.uiKey)
  )
    return "현재 계정의 대기 요청이 아닙니다";
  return null;
}

// '결과 확인' 복구 — 서버 action 조회로 확정한다. SUCCEEDED/REJECTED면
// 저장 스냅샷을 믿지 않고 최신 목록을 다시 읽어 확정한다(saved는 과거
// 결과일 수 있다).
export async function recoverWishlistPending(
  userId: string | null,
  pw: PendingWrite,
  io: WishlistIO = defaultIo,
): Promise<WishlistOutcome> {
  if (!userId || io.scope() !== userId) return { kind: "NOACTOR" };
  const bad = wishPendingError(pw, io);
  if (bad) return { kind: "REJECTED", code: "VALIDATION", message: bad };
  const r = await io.lookupAction(pw.uiKey);
  if (!r.ok) {
    // 서버에 기록이 없음 — 자동 재전송 없이 '다시 시도'로 같은 intent를
    // 명시 재전송할 수 있게 intent는 유지한다.
    if (r.error.code === "NOT_FOUND") return { kind: "RETRYABLE" };
    return { kind: "UNKNOWN_KEEP" };
  }
  const st = r.data.status;
  if (st === "SUCCEEDED" || st === "REJECTED") {
    if (io.scope() !== userId) return { kind: "ABORTED" };
    io.removePending(pw.uiKey);
    await refreshWishlist(userId, io);
    if (st === "SUCCEEDED") return { kind: "DONE" };
    return {
      kind: "REJECTED",
      code: r.data.error_code ?? "REJECTED",
      message: "요청이 거절되었어요. 최신 상태를 확인해 주세요.",
    };
  }
  return { kind: "UNKNOWN_KEEP" };
}

// '다시 시도' — 같은 키+같은 payload를 명시 재전송한다. 서버는 같은 키의
// replay/IDEMPOTENCY_CONFLICT로 응답하므로 중복 저장이 생기지 않는다.
export async function retryWishlistPending(
  userId: string | null,
  pw: PendingWrite,
  io: WishlistIO = defaultIo,
): Promise<WishlistOutcome> {
  if (!userId || io.scope() !== userId) return { kind: "NOACTOR" };
  // saved 타입·kind·method·path/product 일치·현재 계정 소속까지 검증한다 —
  // 변조 payload를 false로 강제 변환해 재전송하지 않는다 [PM070-4].
  const bad = wishPendingError(pw, io, { requireListed: true });
  if (bad) return { kind: "REJECTED", code: "VALIDATION", message: bad };
  const productId = pw.payload.product_id as string;
  const saved = pw.payload.saved as boolean;
  const s = storeFor(userId);
  if (s.busy.has(productId)) return { kind: "BUSY" };
  s.busy.add(productId);
  emit();
  const r = await io.putSaved(pw.path, {
    product_id: productId,
    saved,
    idempotency_key: pw.uiKey,
  });
  s.busy.delete(productId);
  if (io.scope() !== userId) { emit(); return { kind: "ABORTED" }; }
  if (r.ok) {
    io.removePending(pw.uiKey);
    // 재시도는 보통 replay — 저장 스냅샷 대신 최신 목록으로 확정한다.
    await refreshWishlist(userId, io);
    return { kind: "DONE" };
  }
  emit();
  if (AMBIGUOUS_CODES.has(r.error.code)) return { kind: "LOST" };
  io.removePending(pw.uiKey);
  return { kind: "REJECTED", code: r.error.code, message: r.error.message };
}

// React 구독 훅 — 명시 userId로만 읽는다. userId가 null이면 빈 스냅샷이고
// 구독도 하지 않는다.
export function useWishlist(userId: string | null): WishlistSnap {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const uid = userId ?? null;
  useEffect(() => {
    if (!uid) return;
    // 자식 effect는 부모의 bindPendingUser보다 먼저 실행될 수 있다 — scope가
    // 미확정이면 ensure가 no-op이므로, bind가 쏘는 'pending-writes'를 구독해
    // scope 확정 뒤 재적재한다 [PM070 scope 순서 지적]. putPending 등 다른
    // emit에서도 호출되지만 status/inflight dedupe로 중복 fetch는 없다.
    const onBind = () => void ensureWishlist(uid);
    void ensureWishlist(uid);
    addEventListener("pending-writes", onBind);
    const on = () => bump();
    addEventListener("wishlist-changed", on);
    return () => {
      removeEventListener("wishlist-changed", on);
      removeEventListener("pending-writes", onBind);
    };
  }, [uid]);
  return wishlistSnap(uid);
}

export type WishFeedback = { msg: string; goWish: boolean };

// 하트 토글 훅 — 목록 미확정이면 intent 방향을 만들 수 없어 토글 대신
// 명시 재조회만 수행한다 [PM070-②]. LOST/PENDING_EXISTS는 '찜에서 확인'
// 복구 진입 안내로 표면화하고, 확정 저장 시 savedOpen을 연다.
export function useWishToggle(userId: string | null, productId: string) {
  const w = useWishlist(userId);
  const [fb, setFb] = useState<WishFeedback | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  // 계정 전환 시 이전 계정의 비동기 시트/메시지가 새 화면에 남지 않게 닫는다.
  useEffect(() => {
    setFb(null);
    setSavedOpen(false);
  }, [userId]);
  const saved = w.saved.has(productId);
  const busy = w.busy.has(productId);
  const ready = w.status === "ready";
  const toggle = async () => {
    if (!userId) return;
    setFb(null);
    if (!ready) {
      // saved 방향을 모른 채 PUT하면 이미 저장된 상품에 saved=true를 다시
      // 보낼 수 있다 — 토글 대신 목록 재조회만 한다 [PM070 ②].
      const prm = ensureWishlist(userId, {
        force: w.status === "error",
      });
      setFb({
        msg: prm
          ? "찜 목록을 확인하는 중…"
          : "찜 목록을 불러오는 중이에요. 잠시 후 다시 눌러 주세요.",
        goWish: false,
      });
      return;
    }
    const r = await toggleWishlist(userId, productId, !saved);
    if (r.kind === "SAVED") {
      if (r.saved) setSavedOpen(true);
    } else if (r.kind === "PENDING_EXISTS" || r.kind === "LOST") {
      setFb({
        msg:
          r.kind === "LOST"
            ? "찜 결과를 확인하지 못했어요."
            : "이전 찜 요청 결과를 먼저 확인해 주세요.",
        goWish: true,
      });
    } else if (r.kind === "REJECTED") {
      setFb({ msg: r.message, goWish: false });
    } else if (r.kind === "BUSY") {
      setFb({ msg: "처리 중이에요.", goWish: false });
    }
    // NOACTOR/ABORTED — 계정 없음·전환 중단은 조용히 무시한다.
  };
  return {
    saved,
    busy,
    ready,
    fb,
    clearFb: () => setFb(null),
    savedOpen,
    closeSaved: () => setSavedOpen(false),
    toggle,
  };
}

