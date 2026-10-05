import { createHmac, timingSafeEqual } from "node:crypto";

export type Origin = "UI" | "AGENT" | "SYSTEM";
export interface RequestContext {
  actorUserId: string;
  origin: Origin;
}

// 서버만 세션 토큰을 발급한다. Phase 1에서 auth_subject -> users.id 매핑에 연결.
export const signSession = (subject: string, secret: string): string =>
  subject + "." + createHmac("sha256", secret).update(subject).digest("base64url");

export function verifySession(token: string, secret: string): string | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const subject = token.slice(0, i);
  const expected = signSession(subject, secret).slice(i + 1);
  const got = token.slice(i + 1);
  return got.length === expected.length &&
    timingSafeEqual(Buffer.from(got), Buffer.from(expected))
    ? subject
    : null;
}

// 실행 주체는 검증된 세션 토큰에서만 온다.
// body/query/header의 user_id·origin 주장은 절대 신뢰하지 않는다.
export function contextFromRequest(
  req: Request,
  secret: string,
): RequestContext | null {
  const cookie = req.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const bearer = req.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const subject =
    (cookie && verifySession(decodeURIComponent(cookie), secret)) ??
    (bearer && verifySession(bearer, secret));
  return subject ? { actorUserId: subject, origin: "UI" } : null;
}
