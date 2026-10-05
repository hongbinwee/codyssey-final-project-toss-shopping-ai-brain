import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  contextFromRequest,
  signSession,
  verifySession,
} from "../../src/session.ts";

const SECRET = "test-secret";
const req = (headers: Record<string, string>) =>
  new Request("http://x/", { headers });

describe("session", () => {
  test("valid token resolves actor", () => {
    const token = signSession("u-a", SECRET);
    assert.equal(verifySession(token, SECRET), "u-a");
  });

  test("tampered token rejected", () => {
    assert.equal(verifySession("u-a.forged", SECRET), null);
    assert.equal(verifySession("u-a", SECRET), null);
  });

  test("session_cannot_choose_actor: client-sent ids are ignored", () => {
    assert.equal(
      contextFromRequest(req({ "x-user-id": "u-admin" }), SECRET),
      null,
    );
    assert.equal(
      contextFromRequest(
        req({ cookie: "session=u-admin.forged", "x-user-id": "u-admin" }),
        SECRET,
      ),
      null,
    );
    const valid = signSession("u-a", SECRET);
    const ctx = contextFromRequest(
      req({ cookie: "session=" + valid, "x-user-id": "u-admin" }),
      SECRET,
    );
    assert.equal(ctx?.actorUserId, "u-a");
    assert.equal(ctx?.origin, "UI");
  });
});
