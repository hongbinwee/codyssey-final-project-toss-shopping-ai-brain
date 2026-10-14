// PMQA-062 — Mock 전용 브라우저 격리 계약 [PMQA-062].
// 실제 서버·DB 없이 가상 origin 위에서 context.route catch-all이 전부를
// 처리한다 — route.continue는 어떤 경로에도 호출하지 않는다. 모든 요청은
// 로컬 파일 fulfill·등록 mock fulfill·abort 셋 중 하나로 끝나고 각각
// disposition으로 기록된다(실서버 전달 0의 증거).
//
// 가상 origin — 아무 것도 listen하지 않는 주소다. route 인터셉트가 네트워크
// 스택 이전에 요청을 가로채므로 listen 불필요, PG/외부 접속 경로 자체가 없다.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

const ASSET_MIME: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// localhost 가상 origin — 아무 것도 listen하지 않는다. mock.local 같은
// 비-localhost 호스트는 insecure context라 앱이 쓰는 crypto.randomUUID가
// 비활성화될 수 있으므로 localhost를 쓴다(원앱 실행 계약 보존) [PM preflight].
export const MOCK_ORIGIN = "http://localhost:3199";

export type StaticFile = { file: string | null; mime: string };
// server.ts STATIC 계약과 같은 경로만 허용 — 파일은 로컬 디스크에서 읽는다.
export const STATIC_FILES: Record<string, StaticFile> = Object.freeze({
  "/": Object.freeze({ file: "index.html", mime: "text/html; charset=utf-8" }),
  "/web/app.js": Object.freeze({
    file: join("web", "app.js"),
    mime: "text/javascript; charset=utf-8",
  }),
  "/web/styles.css": Object.freeze({
    file: join("src", "web", "styles.css"),
    mime: "text/css; charset=utf-8",
  }),
  // 파비콘 자산은 없다 — 204로 소비하고 기록만 남긴다.
  "/favicon.ico": Object.freeze({ file: null, mime: "" }),
});

export type NetDisposition =
  | "fulfilled-static"  // 로컬 파일 bytes — 외부 전달 없음
  | "fulfilled-mock"    // 등록된 mock 응답 — 실서버 계산 아님
  | "blocked-origin"    // 가상 origin 외 — abort(외부 전달 0)
  | "blocked-path"      // 미등록 정적 경로 — abort
  | "blocked-api"       // mock 미등록 API — abort
  | "injected-failure"; // 테스트가 의도 주입한 실패(abort) — 위반 아님

export type NetRec = {
  method: string;
  url: string;
  disposition: NetDisposition;
  note?: string;
};

export type Decision =
  | { kind: "static"; file: string | null; mime: string }
  | { kind: "api" }
  | { kind: "block"; disposition: "blocked-origin" | "blocked-path"; reason: string };

// 순수 판정 — IO 없음. origin이 MOCK_ORIGIN이 아니면 경로와 무관하게 거부.
export function decideRequest(method: string, rawUrl: string): Decision {
  const u = new URL(rawUrl, MOCK_ORIGIN);
  if (u.origin !== MOCK_ORIGIN)
    return {
      kind: "block",
      disposition: "blocked-origin",
      reason: "외부 origin — " + u.origin,
    };
  const p = u.pathname;
  if (p.startsWith("/api/")) return { kind: "api" };
  const m = method.toUpperCase();
  if (m !== "GET")
    return {
      kind: "block",
      disposition: "blocked-path",
      reason: "비-API " + m + " " + p,
    };
  const s = STATIC_FILES[p];
  if (s) return { kind: "static", file: s.file, mime: s.mime };
  // 실제 자산 경로는 /assets/<path>(server.ts 정적 계약 — web/assets 파일).
  // flat 검사만으로는 products/ 같은 하위 디렉터리가 막히므로, 정규화 결과가
  // web/assets 안에 머무는 경우만 허용한다(경로 상승 거부) [PM preflight].
  if (p.startsWith("/assets/")) {
    const name = p.slice("/assets/".length);
    const rel = join("web", "assets", name);
    if (
      name &&
      !name.split("/").includes("..") &&
      rel.startsWith(join("web", "assets"))
    )
      return {
        kind: "static",
        file: rel,
        mime: ASSET_MIME[extname(name)] ?? "application/octet-stream",
      };
    return {
      kind: "block",
      disposition: "blocked-path",
      reason: "asset 경로 정합 실패 " + p,
    };
  }
  return { kind: "block", disposition: "blocked-path", reason: "미등록 경로 " + p };
}

// 정적 바이트 — worker가 읽어 fulfill한다(파일 부재는 그대로 throw → FAIL).
export function readStatic(file: string): Buffer {
  return readFileSync(file);
}
