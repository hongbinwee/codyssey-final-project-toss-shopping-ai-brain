// 06B 전용 읽기 검증 — 브라우저·API 요청 allowlist [PMQA-048-B0].
// 기본 거부(fail closed): 고정 RO_ORIGIN의 명시된 GET + login POST만 서버까지
// 전달하고, 나머지는 서버 도달 전에 403 RO_GUARD_BLOCKED로 차단한다.
//
// origin 계약 [PMQA-048-B0 검수]: pathname만 보면 외부 서버의 같은 /health·
// /api/orders가 통과한다. 모든 판정은 origin === RO_ORIGIN을 먼저 요구하고
// 외부 origin은 경로와 무관하게 거부한다. roApi의 상대 경로는 RO_ORIGIN으로
// resolve하며, fetch는 maxRedirects:0이라 3xx가 allowlist를 우회해 외부로
// 새지 않는다(redirect 응답은 그대로 돌려보낸다).
//
// 주의 — GET이지만 write를 유발하는 경로: GET /api/cart는 getOrCreateCart의
// carts INSERT를, GET /api/checkout/quote·cancel/quote 등은 승인 목록 밖이다.
// 허용 목록에 없는 GET도 기본 차단이므로 '읽기처럼 보이는 write'는 새지 않는다.
// eligibility GET은 src/cancellation.ts checkCancelEligibility가
// loadCancelFacts(sql,·,·)(forUpdate 생략 → 잠금 없는 SELECT)만 호출함을
// 코드로 확인해 승인 목록에 따라 구체 허용한다.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { APIRequestContext, BrowserContext } from "@playwright/test";
import { assertPwIsolation } from "../helpers/evidence-broker.ts";

export const RO_BLOCKED = "RO_GUARD_BLOCKED";
// 이 경로의 유일 허용 origin — playwright.readonly.config의 baseURL·webServer와
// 반드시 같은 값이어야 한다(둘 다 이 상수를 기준으로 유지한다).
export const RO_ORIGIN = "http://localhost:3102";

const ALLOW: { method: string; re: RegExp; note: string }[] = [
  { method: "GET", re: /^\/health$/, note: "webServer readiness — SELECT 1" },
  { method: "GET", re: /^\/api\/session$/, note: "세션 조회 — SELECT" },
  { method: "POST", re: /^\/api\/session$/, note: "로그인 — users SELECT + 쿠키 서명(DB write 없음)" },
  { method: "GET", re: /^\/api\/orders$/, note: "주문 목록 — SELECT" },
  { method: "GET", re: /^\/api\/orders\/[^/]+$/, note: "주문 상세 — SELECT" },
  { method: "GET", re: /^\/api\/orders\/[^/]+\/shipping$/, note: "배송 상태 — SELECT" },
  { method: "GET", re: /^\/api\/orders\/[^/]+\/cancel\/eligibility$/, note: "취소 자격 — SELECT(잠금 없음 확인)" },
  { method: "GET", re: /^\/$|^\/web\/|^\/assets\/|^\/favicon/, note: "정적 자산" },
];

// 명시 차단 목록 — allowlist 실수 확장으로 write GET이 새는 것을 막는다.
// DENY를 ALLOW보다 먼저 평가한다.
const DENY: { method?: string; re: RegExp; note: string }[] = [
  { method: "GET", re: /^\/api\/cart(\/|$)/, note: "GET이지만 carts INSERT 유발 — 차단" },
  { method: "GET", re: /^\/api\/checkout(\/|$)/, note: "checkout GET도 승인 목록 밖 — 차단" },
  { method: "GET", re: /^\/api\/orders\/[^/]+\/cancel\/quote$/, note: "견적 GET — 승인 목록 밖 차단" },
  { method: "GET", re: /^\/api\/actions(\/|$)/, note: "pending 복구 조회 — 승인 목록 밖 차단" },
  { method: "GET", re: /^\/api\/products(\/|$)/, note: "상품 GET — 승인 목록 밖 차단" },
  { method: "GET", re: /^\/api\/agent(\/|$)/, note: "agent 경로 — 차단" },
  { method: "DELETE", re: /^\/api\//, note: "API DELETE — 차단" },
  { method: "PATCH", re: /^\/api\//, note: "API PATCH — 차단" },
  { method: "PUT", re: /^\/api\//, note: "API PUT — 차단" },
];

// rawUrl은 절대 URL이거나 RO_ORIGIN 기준 상대 경로다. origin이 RO_ORIGIN과
// 다르면 경로와 무관하게 거부한다(외부 서버의 같은 pathname 우회 차단).
export function roDecision(
  method: string,
  rawUrl: string,
): { allow: boolean; reason: string } {
  const u = new URL(rawUrl, RO_ORIGIN);
  if (u.origin !== RO_ORIGIN)
    return {
      allow: false,
      reason: "외부 origin — " + u.origin + " != " + RO_ORIGIN + " (기본 거부)",
    };
  const m = method.toUpperCase();
  const pathname = u.pathname;
  for (const d of DENY)
    if ((!d.method || d.method === m) && d.re.test(pathname))
      return { allow: false, reason: d.note };
  for (const a of ALLOW)
    if (a.method === m && a.re.test(pathname))
      return { allow: true, reason: a.note };
  return { allow: false, reason: "allowlist 미등록 — 기본 거부" };
}

// launcher(readonly-audit.ts)가 원자적으로 예약한 run dir인지 검증한다 —
// run dir 자체가 존재하는 것이 부모의 예약 표식이고, pw-output이 이미
// 있으면 기존 산출물이므로 시작부터 거부한다. UUID 형식만으로는 기존 UUID를
// 직접 넣는 오용을 막지 못한다 [PM B0 최종 검수].
export function assertFreshRunDir(runDir: string): void {
  if (!existsSync(runDir))
    throw new Error(
      "run dir 부재 — launcher의 원자 예약 없이 직접 실행은 금지: " + runDir,
    );
  if (existsSync(join(runDir, "pw-output")))
    throw new Error(
      "pw-output 이미 존재 — 기존 evidence 덮어쓰기 금지: " + runDir,
    );
}

// ── runner/worker 재평가 구분 [PMQA-048-B1F] ──────────────────────
// 실제 설치본으로 검증한 재평가 동작:
//   · workerProcessEntry.js:1376 — WorkerMain 생성자가 TEST_WORKER_INDEX를
//     먼저 설정하고, config 파일 재평가는 이후 common/index.js
//     deserializeConfig → loadConfig → requireOrImport(resolvedConfigFile)가
//     파일을 재import하며 일어난다. runner 측 평가는 같은 프로세스의 모듈
//     캐시로 top-level이 재실행되지 않으므로, pw-output을 보는 두 번째 평가는
//     worker 프로세스뿐이다(B1 실측 — runner가 만든 .last-run.json을
//     '기존 evidence'로 오인해 22중 1 fail/21 not run으로 붙은 원인).
// 계약 — 'worker면 무조건 통과'나 env self-approve가 아니다 [PM B1F 사전검수]:
//   · worker 판정 — TEST_WORKER_INDEX가 정상 숫자 형태일 때만 worker다.
//   · runner 첫 평가 — assertFreshRunDir(예약 run + pw-output 부재) 그대로.
//     같은 실패 run 재시작은 여기서 거부된다.
//   · worker 재평가 — pw-output은 살아있는 runner가 방금 만든 정상 산출물로
//     허용하되, 소유 정합을 전부 요구한다.
//   · 종료 run — 내용이 기록된 audit-after.json·audit-fail.json이 있는 run은
//     worker 플래그가 있어도 거부다(완료된 evidence의 재평가 오용 차단).
//     사전 claim으로 만든 0바이트 예약 파일은 '완료'가 아니다 — 예약(reserved)
//     상태와 완료(written) 상태를 구분한다 [PMQA-054/Luna QA-2].
//   · 소유 정합(runner·worker 공통) — run dir basename === RO_RUN_ID,
//     launcher가 wx로 새긴 run-owner.json의 {runId, nonce}가 env와 정확히
//     일치, audit-before.json을 실제 parse해 runId 일치 + gateOk === true를
//     요구한다. 다른 runId·nonce 불일치·marker 부재·nonce env 부재·before
//     부재/불일치는 전부 거부다.
export type RoRunEnv = {
  RO_RUN_ID?: string;
  RO_WORKER_NONCE?: string;
  TEST_WORKER_INDEX?: string;
  RO_PW_WORKDIR?: string;
};

// claim 계약상 산출물은 실행 시작에 0바이트 'wx'로 사전 생성되고, 내용은
// 나중에 1회만 기록된다 — existsSync만으로는 '기록됨'을 판정할 수 없다.
// 내용이 1바이트라도 있으면 기록된 증거다(부분 기록·손상도 기록으로 간주해
// fail-closed로 종료 판정에 포함한다) [PMQA-054/Luna QA-2].
// ENOENT(부재)만 '미기록'이다 — EACCES/EIO 등 접근 오류는 '읽을 수 없는
// 상태'이지 미기록이 아니므로 던져 gate를 fail-open으로 열지 않는다
// [Luna QA-C].
export function evidenceWritten(p: string): boolean {
  try {
    return statSync(p).size > 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
      return false;
    throw e;
  }
}

// opts.worker — 명시적 worker-side 재평가 강제. TEST_WORKER_INDEX가 없는
// webServer(readonly-server)처럼 runner가 띄운 소비자도 runner 첫 평가가
// 아니라 worker-side 검증을 타야 한다 — runner가 정상 생성한 output
// 파일 때문에 실패하면 안 된다(mode 계약 최소) [PM QA-056 M2].
export function assertRunAccess(
  runDir: string,
  env: RoRunEnv,
  opts?: { worker?: boolean },
): void {
  // 값이 있어도 정상 숫자 형태가 아니면 worker로 인정하지 않는다 — 그 경우
  // 더 엄격한 runner 경로를 탄다(fail-closed).
  const wi = env.TEST_WORKER_INDEX;
  const worker =
    opts?.worker === true ||
    (wi !== undefined &&
      wi.length > 0 &&
      [...wi].every((c) => c >= "0" && c <= "9"));
  // runId ↔ dir 이름 정합 — 다른 run의 디렉터리 위에서 실행되는 오용 차단.
  if (env.RO_RUN_ID && basename(runDir) !== env.RO_RUN_ID)
    throw new Error(
      "run dir 이름이 RO_RUN_ID와 불일치 " + basename(runDir) +
        " != " + env.RO_RUN_ID,
    );
  if (!worker) assertFreshRunDir(runDir);
  else if (!existsSync(runDir))
    throw new Error(
      "run dir 부재 — launcher의 원자 예약 없이 직접 실행은 금지: " + runDir,
    );
  // 종료된 run은 어떤 플래그로도 재평가하지 않는다 — 완료·실패 evidence 보존.
  // 0바이트 예약 claim은 미완료다 — 내용이 기록된 파일만 종료로 판정한다.
  if (
    evidenceWritten(join(runDir, "audit-after.json")) ||
    evidenceWritten(join(runDir, "audit-fail.json"))
  )
    throw new Error(
      "종료된 run(audit-after/audit-fail 존재) — 재평가 금지: " + runDir,
    );
  const markerPath = join(runDir, "run-owner.json");
  if (!evidenceWritten(markerPath))
    throw new Error("run-owner marker 부재 — launcher 소유 증거 없음: " + runDir);
  if (!env.RO_WORKER_NONCE)
    throw new Error("RO_WORKER_NONCE 부재 — 이 run의 소유 env가 아니다");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    runId?: string;
    nonce?: string;
  };
  if (marker.runId !== env.RO_RUN_ID)
    throw new Error(
      "marker runId 불일치 " + String(marker.runId) +
        " != " + String(env.RO_RUN_ID),
    );
  if (marker.nonce !== env.RO_WORKER_NONCE)
    throw new Error("run-owner nonce 불일치 — 다른 실행의 소유다");
  // output 소유 정합 — PW output은 evidence 영역 밖의 부모 예약
  // pw-<runId> workdir다. marker의 pwWorkdir와 env가 정확히 일치해야
  // 이 run 소유 output이다 [PMQA-056 수용기준 ②].
  if (!env.RO_PW_WORKDIR)
    throw new Error("RO_PW_WORKDIR 부재 — output 소유 증거가 아니다");
  const wd = (marker as { pwWorkdir?: string }).pwWorkdir;
  if (!wd || wd !== env.RO_PW_WORKDIR)
    throw new Error("run-owner pwWorkdir 불일치 — 다른 실행의 output이다");
  if (basename(wd) !== "run-pw-" + env.RO_RUN_ID)
    throw new Error("pwWorkdir 이름이 run과 불일치: " + wd);
  if (!existsSync(wd))
    throw new Error("pwWorkdir 부재 — 부모 예약 output이 없다: " + wd);
  // canonical/symlink/보호루트 격리 — runner·worker 공통이다. 예약 이후
  // 외부에서 dir를 junction/보호 경로로 교체한 실행을 차단한다.
  assertPwIsolation({ workDir: wd, evidenceDirs: [runDir] });
  if (!worker && readdirSync(wd).length !== 0)
    // runner 첫 평가 — workdir은 부모가 방금 예약한 신규·빈 디렉터리여야
    // 한다. 중단 run의 기존 marker/env로 재실행해 PW runner가 기존
    // workdir 파일을 지우고 덮어쓰는 경로를 차단한다 [PM QA-056 M1].
    // worker-side 재평가는 runner가 정상 생성한 output 파일을 허용한다.
    throw new Error(
      "pwWorkdir 신규·빈 상태 아님 — runner 첫 평가는 부모 예약 빈 " +
        "workdir만 허용(기존 output 재사용 거부): " + wd,
    );
  const beforePath = join(runDir, "audit-before.json");
  if (!evidenceWritten(beforePath))
    throw new Error(
      "승인 before(audit-before.json) 부재 — gate 미완 run: " + runDir,
    );
  // 존재가 아니라 내용 정합까지 본다 — 다른 run의 before·gate 미통과 run은
  // 소유 증거가 아니다.
  const before = JSON.parse(readFileSync(beforePath, "utf8")) as {
    runId?: string;
    gateOk?: boolean;
  };
  if (before.runId !== env.RO_RUN_ID)
    throw new Error(
      "audit-before runId 불일치 " + String(before.runId) +
        " != " + String(env.RO_RUN_ID),
    );
  if (before.gateOk !== true)
    throw new Error("audit-before gateOk != true — gate 통과 승인 run이 아니다");
}

// context 생성 직후·첫 goto 이전에 설치한다 — page fixture가 이걸 쓴다.
export async function installRoGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const d = roDecision(req.method(), req.url());
    if (d.allow) return route.continue();
    const u = new URL(req.url());
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: RO_BLOCKED,
          message:
            "읽기 검증 차단: " + req.method() + " " +
            u.origin + u.pathname + " — " + d.reason,
        },
      }),
    });
  });
}

// APIRequestContext 래퍼 — 같은 allowlist를 fetch 전에 적용한다.
// 차단 시 blocked:true를 돌려 실제 서버 응답과 절대 혼동하지 않게 한다
// (정상 서버가 403+이 코드를 만들 수 없다 — 차단 응답은 서버를 지나지 않는다).
// maxRedirects:0 — 3xx를 따라가지 않아 redirect가 allowlist를 우회하지 못한다.
export function roApi(request: APIRequestContext) {
  const call = async (method: string, url: string, data?: unknown) => {
    const u = new URL(url, RO_ORIGIN);
    const d = roDecision(method, u.toString());
    if (!d.allow)
      return { blocked: true as const, status: 403, code: RO_BLOCKED, reason: d.reason };
    const res = await request.fetch(u.toString(), {
      method,
      data,
      maxRedirects: 0,
    });
    return { blocked: false as const, status: res.status(), json: await res.json().catch(() => null) };
  };
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, data?: unknown) => call("POST", url, data),
    fetch: call,
  };
}
