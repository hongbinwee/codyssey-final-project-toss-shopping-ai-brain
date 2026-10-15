// scripts/isolated-smoke.ts의 DB-free 단위 검증 [PMQA-052].
// 실제 PostgreSQL 없이 deps.connect/readFile/writeJson 등을 주입해 env 게이트·
// pin 검증·fault sentinel 동일성·롤백 관측 순서·보호 DB write 0·evidence wx·
// cleanup 순서를 증명한다 — mock은 계약 증거이며 실DB 보장이 아니다.
// pins 주입 경로는 없으므로 fixture는 실제 고정 3 pin 파일을 read-only로 읽어
// 재사용한다 — 가짜 pin으로 whole-path PASS를 만드는 경로 자체가 없다 [MJ052-5].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  planSmokeEnv,
  parseApprovedAudit,
  wrapTxnUnsafe,
  makeFault1,
  makeFault2,
  faultedConnect,
  guardedConnect,
  diffOwned,
  sanitizeErr,
  SmokeError,
  runSmoke,
  PINS,
  ARTIFACT_FILES,
  SMOKE_OPTIN_ENV,
  SMOKE_STRICT_ENV,
  SMOKE_ADMIN_ENV,
  SMOKE_BLOCKED_ENV_KEYS,
  APPROVED_AUDIT_RUN_ID,
  SMOKE_EVIDENCE_SLOTS,
} from "../../scripts/isolated-smoke.ts";

const ADMIN = "postgres://commerce:secret@localhost:5432/postgres";
const PG18_ADMIN = "postgres://commerce:secret@localhost:5433/postgres";
const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

function env(over: Record<string, string | undefined> = {}) {
  return {
    [SMOKE_OPTIN_ENV]: "1",
    [SMOKE_STRICT_ENV]: "1",
    [SMOKE_ADMIN_ENV]: ADMIN,
    ...over,
  };
}

// ── global env — runner는 source(deps.env)와 실제 global(process.env) 둘
// 다 검증한다 [MJ052-2]. 이 파일 안에서만 쓰고 반드시 복원한다. ────────
const GLOBAL_KEYS = [
  SMOKE_OPTIN_ENV,
  SMOKE_STRICT_ENV,
  SMOKE_ADMIN_ENV,
  "SCRATCH_DB_TARGET",
  "SCRATCH_PROTECTED_ADMIN_URL",
  ...SMOKE_BLOCKED_ENV_KEYS,
] as const;
function setGlobal() {
  const saved = new Map<string, string | undefined>();
  for (const k of GLOBAL_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  process.env[SMOKE_OPTIN_ENV] = "1";
  process.env[SMOKE_STRICT_ENV] = "1";
  process.env[SMOKE_ADMIN_ENV] = ADMIN;
  return () => {
    for (const k of GLOBAL_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("planSmokeEnv — connect 전 게이트", () => {
  test("기본 env는 PG17 scratch와 protected snapshot 경로를 유지한다", () => {
    const p = planSmokeEnv(env());
    assert.equal(p.ok, true);
    if (p.ok) assert.deepEqual(p, {
      ok: true,
      adminUrl: ADMIN,
      protectedAdminUrl: ADMIN,
      target: "pg17",
    });
  });

  test("PG18 scratch는 5433, protected snapshots는 명시된 PG17 5432를 사용한다", () => {
    const p = planSmokeEnv(env({
      SCRATCH_DB_TARGET: "pg18",
      SCRATCH_ADMIN_URL: PG18_ADMIN,
      SCRATCH_PROTECTED_ADMIN_URL: ADMIN,
    }));
    assert.deepEqual(p, {
      ok: true,
      adminUrl: PG18_ADMIN,
      protectedAdminUrl: ADMIN,
      target: "pg18",
    });
  });

  test("PG18 mode는 protected URL 누락·잘못된 포트·알 수 없는 target에서 fallback하지 않는다", () => {
    const base = env({ SCRATCH_DB_TARGET: "pg18", SCRATCH_ADMIN_URL: PG18_ADMIN });
    assert.equal(planSmokeEnv(base).ok, false);
    assert.equal(planSmokeEnv(env({
      SCRATCH_DB_TARGET: "pg18",
      SCRATCH_ADMIN_URL: ADMIN,
      SCRATCH_PROTECTED_ADMIN_URL: ADMIN,
    })).ok, false);
    assert.equal(planSmokeEnv(env({
      SCRATCH_DB_TARGET: "pg22",
      SCRATCH_ADMIN_URL: ADMIN,
    })).ok, false);
    assert.equal(planSmokeEnv(env({
      SCRATCH_DB_TARGET: "pg18",
      SCRATCH_ADMIN_URL: PG18_ADMIN,
      SCRATCH_PROTECTED_ADMIN_URL: PG18_ADMIN,
    })).ok, false);
  });

  test("flags·admin 형식·외부 주입 env는 거부 — reason에 credential 0", () => {
    const cases: [Record<string, string | undefined>, RegExp][] = [
      [{ [SMOKE_STRICT_ENV]: "1", [SMOKE_ADMIN_ENV]: ADMIN }, /opt-in/],
      [{ [SMOKE_OPTIN_ENV]: "1", [SMOKE_ADMIN_ENV]: ADMIN }, /strict/],
      [{ ...env(), DATABASE_URL: ADMIN }, /DATABASE_URL/],
      [{ ...env(), TEST_DB_URL: ADMIN }, /TEST_DB_URL/],
      [{ ...env(), ISOLATED_DB_URL: "postgres://x" }, /ISOLATED_DB_URL/],
      [{ ...env(), ISOLATED_RUN_ID: "x" }, /ISOLATED_RUN_ID/],
      [{ ...env(), SMOKE_OUTPUT_DIR: "x" }, /SMOKE_OUTPUT_DIR/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: "" }, /없음|필요/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: ADMIN + "?database=commerce_test" }, /query/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: ADMIN + "#f" }, /fragment/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: "postgres://u:p@example.com:5432/postgres" }, /호스트/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: "postgres://u:p@localhost:5433/postgres" }, /포트/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: "postgres://u:p@localhost:5432/commerce" }, /경로/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: "http://localhost:5432/postgres" }, /프로토콜/],
      [{ ...env(), [SMOKE_ADMIN_ENV]: "not-a-url" }, /파싱/],
    ];
    for (const [e, re] of cases) {
      const p = planSmokeEnv(e);
      assert.equal(p.ok, false, JSON.stringify(e));
      if (!p.ok) {
        assert.match(p.reasons.join("|"), re);
        assert.equal(p.reasons.join("|").includes("secret"), false);
      }
    }
  });
});

// ── 승인 048 감사 — 실제 고정 pin 파일에서 읽는다(가짜 정본 금지) ────
const auditText = readFileSync(
  PINS.find((p) => p.key === "audit048")!.path,
  "utf8",
);
const auditObj = JSON.parse(auditText) as {
  runId: string;
  after: {
    db: string; oid: number; at: string;
    tables: Record<string, { n: number; h: string }>;
    writers: number[]; writersError: string | null; unreadableActive: number[];
  };
  afterDev: {
    db: string; oid: number; at: string;
    tables: Record<string, { n: number; h: string }>;
    writers: number[]; writersError: string | null; unreadableActive: number[];
  };
  verdict: { pass: boolean; exit: number };
};
assert.equal(auditObj.runId, APPROVED_AUDIT_RUN_ID); // pin 정본 그 자체

describe("parseApprovedAudit — 승인 048 구조 검증", () => {
  test("정상 구조는 after/afterDev를 돌려준다", () => {
    const r = parseApprovedAudit(auditObj);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.after.db, "commerce_test");
      assert.equal(r.afterDev.db, "commerce");
    }
  });

  test("구조 위반은 전부 거부다", () => {
    const clone = () => JSON.parse(auditText) as typeof auditObj;
    const a0 = auditObj.after;
    const bad: unknown[] = [
      { ...clone(), verdict: { pass: false, exit: 0, reasons: [] } },
      { ...clone(), verdict: { pass: true, exit: 1, reasons: [] } },
      { ...clone(), errors: ["x"] },
      { ...clone(), gateOk: false },
      { ...clone(), drift: ["x"] },
      { ...clone(), driftDev: ["x"] },
      { ...clone(), runId: "다른-run-id" },
      { ...clone(), runId: 123 },
      { ...clone(), after: { ...a0, oid: 99999 } },
      { ...clone(), afterDev: { ...auditObj.afterDev, oid: 1 } },
      { ...clone(), after: { ...a0, writers: [123] } },
      { ...clone(), after: { ...a0, writersError: "e" } },
      { ...clone(), afterDev: { ...auditObj.afterDev, unreadableActive: [1] } },
      { ...clone(), after: { ...a0, tables: {} } },
      // n finite integer>=0 / h md5형식 위반
      { ...clone(), after: { ...a0, tables: { ...a0.tables, users: { n: 1.5, h: a0.tables.users.h } } } },
      { ...clone(), after: { ...a0, tables: { ...a0.tables, users: { n: -1, h: a0.tables.users.h } } } },
      { ...clone(), after: { ...a0, tables: { ...a0.tables, users: { n: a0.tables.users.n, h: "zz" } } } },
      { ...clone(), after: { ...a0, tables: { ...a0.tables, users: { n: a0.tables.users.n, h: "abc" } } } },
      null,
    ];
    for (const b of bad) {
      const r = parseApprovedAudit(b);
      assert.equal(r.ok, false, JSON.stringify(b).slice(0, 80));
    }
  });
});

describe("fault 래핑 — 실제 txn q.unsafe", () => {
  test("wrapTxnUnsafe: canonical SQL 실행 완료 후 hook — 동일 sentinel 객체", async () => {
    const calls: string[] = [];
    const sentinel = new Error("s");
    const orig = (async (q: string) => { calls.push(q); return []; }) as never;
    const w = wrapTxnUnsafe({ unsafe: orig }, async (sql) => {
      if (sql === "BODY") throw sentinel;
    });
    await w.unsafe("OTHER");
    await assert.rejects(() => w.unsafe("BODY"), (e) => e === sentinel);
    // orig가 먼저 실행된 뒤 hook이 돌았다 — canonical 실행 완료 관측.
    assert.deepEqual(calls, ["OTHER", "BODY"]);
  });

  test("makeFault1: migration 002 본문과 정확히 같을 때만 sentinel", async () => {
    const f = makeFault1("REAL-002-BODY");
    const orig = async () => [] as never;
    await f.hook("REAL-002-BODY-SUFFIX", undefined, orig); // 부분 일치는 발사 안 함
    assert.equal(f.fired(), false);
    await assert.rejects(
      () => f.hook("REAL-002-BODY", undefined, orig),
      (e) => e === f.sentinel,
    );
    assert.equal(f.fired(), true);
  });

  test("makeFault2: payments 경계 probe INSERT+exists 관측 후 sentinel — 미관측은 sentinel 아님", async () => {
    const store = new Set<string>();
    const orig = async (q: string, p?: unknown[]) => {
      if (q.startsWith("INSERT INTO products")) { store.add(p![0] as string); return [] as never; }
      if (q.startsWith("SELECT EXISTS")) return [{ e: store.has(p![0] as string) }] as never;
      return [] as never;
    };
    const f = makeFault2("p-probe-1");
    await assert.rejects(
      () => f.hook("INSERT INTO payments (id)", undefined, orig),
      (e) => e === f.sentinel,
    );
    assert.equal(f.fired(), true);
    assert.equal(f.observed.exists, true);
    // exists가 false인 경로는 sentinel이 아니다 — 흡수되면 안 된다.
    const f2 = makeFault2("p-probe-2");
    const origFalse = async (q: string) =>
      (q.startsWith("SELECT EXISTS") ? [{ e: false }] : []) as never;
    await assert.rejects(
      () => f2.hook("INSERT INTO payments (id)", undefined, origFalse),
      (e) => e !== f2.sentinel && /미관측/.test((e as Error).message),
    );
  });

  test("faultedConnect: root unsafe는 감싸지 않고 begin 안의 q만 감싼다", async () => {
    const f = makeFault1("TRIGGER");
    const inner = {
      unsafe: async () => [] as never,
      begin: async (fn: (q: { unsafe: (q: string) => Promise<never> }) => Promise<never>) =>
        fn({ unsafe: async () => [] as never }),
      end: async () => { },
    };
    const c = faultedConnect(() => inner as never, f)("u", { max: 1 });
    await c.unsafe("TRIGGER"); // root — 발사 안 됨
    assert.equal(f.fired(), false);
    await assert.rejects(
      () => c.begin((q) => q.unsafe("TRIGGER") as never),
      (e) => e === f.sentinel,
    );
    assert.equal(f.fired(), true);
  });

  test("guardedConnect: txn 콜백 최후 SQL await 중 flag 소실 — 다음 query 없이도 반환 전 throw → ROLLBACK·COMMIT 0 [052-C]", async () => {
    const calls: string[] = [];
    let flag = true;
    const inner = {
      unsafe: (async (q: string) => { calls.push("root:" + q); return []; }) as never,
      begin: async (fn: (q: { unsafe: (q: string) => Promise<never[]> }) => Promise<never>) => {
        calls.push("<BEGIN>");
        try {
          const r = await fn({
            unsafe: (async (q: string) => { calls.push("txn:" + q); return []; }) as never,
          });
          calls.push("<COMMIT>");
          return r;
        } catch (e) {
          calls.push("<ROLLBACK>");
          throw e;
        }
      },
      end: async () => {},
    };
    const guard = () => { if (!flag) throw new SmokeError("flag 소실"); };
    const c = guardedConnect(() => inner as never, guard)("u", { max: 1 });
    await assert.rejects(
      () =>
        c.begin(async (q) => {
          await q.unsafe("SELECT 1"); // dispatch 직전 guard 1회 통과
          flag = false;               // 최후 SQL await 경계의 flag 소실 모사
          // 다음 unsafe가 없어도 콜백 반환 전 post-sync가 잡아야 한다.
        }),
      /flag 소실/,
    );
    assert.deepEqual(calls, ["<BEGIN>", "txn:SELECT 1", "<ROLLBACK>"]);
  });

  test("guardedConnect: root unsafe도 dispatch 직전 동기 검사 — 소실 시 orig 미호출 [052-C]", async () => {
    const calls: string[] = [];
    const inner = {
      unsafe: (async (q: string) => { calls.push(q); return []; }) as never,
      begin: async () => {},
      end: async () => {},
    };
    const c = guardedConnect(
      () => inner as never,
      () => { throw new SmokeError("flag 소실"); },
    )("u", { max: 1 });
    // guard는 동기 계약 — async 거부가 아니라 동기 throw다.
    assert.throws(() => c.unsafe("SELECT 1"), /flag 소실/);
    assert.equal(calls.length, 0);
  });

  test("guardedConnect: async guard(thenable 반환)는 즉시 거부 — 검사 누락 경로 차단 [052-C]", async () => {
    const calls: string[] = [];
    const inner = {
      unsafe: (async (q: string) => { calls.push(q); return []; }) as never,
      begin: async () => {},
      end: async () => {},
    };
    const c = guardedConnect(
      () => inner as never,
      (() => Promise.resolve()) as never,
    )("u", { max: 1 });
    assert.throws(() => c.unsafe("SELECT 1"), /동기|thenable/i);
    assert.equal(calls.length, 0);
  });
});

// owned snapshot fixture는 RO 13테이블 전체를 채운다 — 부분 스냅은
// '스냅 부재' diff로 잡히는 게 정상 동작이다.
const T_KEYS = Object.keys(auditObj.after.tables);
const mkOwned = (
  over: Record<string, { n: number; h: string }> = {},
  marker = { n: 1, h: "m" },
) => ({
  tables: Object.fromEntries(
    T_KEYS.map((t) => [t, over[t] ?? { n: 1, h: "x" + t }]),
  ),
  marker,
});

describe("diffOwned/sanitizeErr", () => {
  test("diffOwned는 지문·count 변화와 marker 변화를 잡는다", () => {
    const a = mkOwned();
    const b = mkOwned({ users: { n: 2, h: "xusers" } });
    const c = mkOwned({ users: { n: 1, h: "y" } }, { n: 1, h: "z" });
    assert.equal(diffOwned(a, b).length, 1);
    assert.equal(diffOwned(a, c).length, 2);
    // 부분 스냅은 '스냅 부재'로 잡힌다.
    const partial = { tables: { users: { n: 1, h: "xusers" } }, marker: { n: 1, h: "m" } };
    assert.equal(diffOwned(a, partial as never).length, T_KEYS.length - 1);
  });

  test("sanitizeErr: 자체 SmokeError만 detail — 외부 오류는 고정 category만", () => {
    // 자체 검증 오류 — 안전 식별자를 담은 detail이 살아남는다.
    const own = sanitizeErr(new SmokeError("pin sha256 불일치: audit048"));
    assert.equal(own.code, "SMOKE");
    assert.equal(own.detail, "pin sha256 불일치: audit048");
    // 외부 오류 — postgres URL 없는 PG 원문·secret도 detail/name/stack 전부 0.
    const ext = sanitizeErr(
      new Error("FATAL: password authentication failed pw=SensitiveToken detail={q:1}"),
    );
    assert.equal(ext.code, "EXTERNAL");
    assert.equal(ext.detail, null);
    const leak = new Error("connect postgres://user:pw@localhost:5432/x failed");
    assert.equal(sanitizeErr(leak).detail, null);
    assert.equal(sanitizeErr("plain string").code, "EXTERNAL");
  });
});

// ── runSmoke 오케스트레이션 — 상태형 mock ─────────────────────────
type Row = Record<string, unknown>;
type Q = { url: string; q: string };

// mock의 live 보호 DB는 실제 048 audit의 after/afterDev와 동일해야 한다 —
// 다른 값을 넣으면 before gate가 CREATE를 거부하는 게 맞다.
const RO_SNAPS: Record<string, { db: string; oid: number; tables: Record<string, { n: number; h: string }> }> = {
  commerce_test: {
    db: "commerce_test", oid: 16516, tables: auditObj.after.tables,
  },
  commerce: {
    db: "commerce", oid: 16384, tables: auditObj.afterDev.tables,
  },
};

type OwnedState = {
  rels: Map<string, string>; // pg_class public relname → relkind
  mig: Map<string, string>;
  products: Set<string>;
  marker: { run_id: string }[];
};
const freshOwned = (): OwnedState => ({
  rels: new Map(), mig: new Map(), products: new Set(), marker: [],
});

function makeDeps(over: {
  env?: Record<string, string | undefined>;
  failOnQuery?: RegExp;
  armPostSnapFailAfterStage?: string;
  mutateOnStage?: Record<string, () => void>;
  // 해당 query의 await 경계에서 외부 flag 소실 등을 모사한다 — 복원 없음 [052-C].
  mutateOnQuery?: (q: string, url: string) => void;
  // 첫 pg_class(relBase) 응답을 강제한다 — extra/missing/kind 불일치 재현 [052-C].
  relBaseOverride?: { name: string; kind: string }[];
  // claim 단계 자체를 거부한다 — connect·DB 작업 전 evidence-claim 실패 [054].
  claimFail?: boolean;
} = {}) {
  const queries: Q[] = [];
  const written = new Map<string, unknown>();
  const writeOrder: string[] = [];
  const owned: Record<string, OwnedState> = {};
  const claimed: { dir: string; names: string[] }[] = [];
  let postSnapArmed = false;
  let relCalls = 0;

  const respond = (url: string) => async (q: string, p?: unknown[]): Promise<Row[]> => {
    if (over.failOnQuery && over.failOnQuery.test(q))
      throw new Error("FATAL: password authentication failed pw=SensitiveToken — 원문: " + q.slice(0, 60));
    const db = url.replace(/^.*\//, "").split("?")[0];
    if (postSnapArmed && db === "commerce" && q.includes("current_database"))
      throw new Error("주입: post snap 실패");
    if (q.includes("pg_stat_activity")) return [];
    if (q.startsWith("SET TRANSACTION")) return [];
    if (q.startsWith("SELECT datname FROM pg_database WHERE datname="))
      return owned[p![0] as string] ||
        ["commerce", "commerce_test", "postgres"].includes(p![0] as string)
        ? [{ datname: p![0] }]
        : [];
    if (q.startsWith("SELECT datname FROM pg_database"))
      return ["commerce", "commerce_test", "postgres", ...Object.keys(owned)].map(
        (d) => ({ datname: d }),
      );
    if (q.startsWith("SELECT oid, datdba")) return [{ oid: 90001, owner: 10 }];
    if (q.startsWith("CREATE DATABASE")) {
      const name = q.split(" ").pop()!;
      owned[name] = freshOwned();
      return [];
    }
    if (q.startsWith("DROP DATABASE")) {
      const name = q.split(" ").pop()!;
      delete owned[name];
      return [];
    }
    if (db === "commerce_test" || db === "commerce") {
      if (q.includes("current_database() AS d"))
        return [{ d: db, oid: RO_SNAPS[db].oid, owner: 10 }];
      const m = q.match(/FROM (\w+) x/);
      if (m) {
        const t = RO_SNAPS[db].tables[m[1]];
        return t ? [{ n: t.n, h: t.h }] : [{ n: 0, h: "" }];
      }
      return [];
    }
    // ── owned scratch ──
    const o = (owned[db] ??= freshOwned());
    // 'AS db'는 'AS d'의 접두사다 — 더 긴 별칭을 먼저 검사한다.
    if (q.startsWith("SELECT current_database() AS db")) return [{ db }];
    if (q.includes("current_database() AS d"))
      return [{ d: db, oid: 90001, owner: 10 }];
    if (q.includes("to_regclass('public._scratch_owner')"))
      return [{ r: o.rels.has("_scratch_owner") ? "_scratch_owner" : null }];
    if (q.includes("to_regclass('public.cancel_requests')"))
      return [{ r: o.rels.has("cancel_requests") ? "cancel_requests" : null }];
    if (q.includes("INSERT INTO _scratch_owner")) { o.marker = [{ run_id: p![0] as string }]; return []; }
    if (q.includes("SELECT run_id FROM _scratch_owner")) return o.marker;
    if (q.startsWith("SELECT pg_advisory_xact_lock")) return [{}];
    if (q.startsWith("SELECT sha256 FROM _migrations WHERE name"))
      return o.mig.has(p![0] as string) ? [{ sha256: o.mig.get(p![0] as string)! }] : [];
    if (q.startsWith("INSERT INTO _migrations")) { o.mig.set(p![0] as string, p![1] as string); return []; }
    if (q.includes("pg_class c")) {
      relCalls++;
      if (over.relBaseOverride !== undefined && relCalls === 1)
        return over.relBaseOverride.map((x) => ({ ...x }));
      return [...o.rels.entries()]
        .map(([name, kind]) => ({ name, kind }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
    }
    for (const m of q.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)[^;]*/g)) {
      const name = m[1], stmt = m[0];
      o.rels.set(name, "r");
      if (stmt.includes("PRIMARY KEY")) o.rels.set(name + "_pkey", "i");
    }
    for (const m of q.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? (\w+)/g))
      o.rels.set(m[1], "i");
    if (q.startsWith("SELECT EXISTS(SELECT 1 FROM products WHERE id="))
      return [{ e: o.products.has(p![0] as string) }];
    if (q.startsWith("INSERT INTO products")) { o.products.add(p![0] as string); return []; }
    if (q.includes("FROM _scratch_owner")) return [{ n: o.marker.length, h: "mk" + o.marker.length }];
    const mt = q.match(/FROM (\w+) x/);
    if (mt) {
      const t = mt[1];
      if (t === "products") return [{ n: o.products.size, h: "hp" + o.products.size }];
      if (t === "_migrations") return [{ n: o.mig.size, h: "hm" + o.mig.size }];
      return [{ n: 1, h: "h" + t }];
    }
    return []; // 나머지 seed INSERT/DELETE/DDL — 상태 불요 응답
  };

  const unsafe = (url: string) => async (q: string, p?: unknown[]): Promise<Row[]> => {
    queries.push({ url, q });
    const r = await respond(url)(q, p);
    // query await 경계의 외부 변화를 모사한다 — flag를 복원해 계속 진행하지
    // 않는다(테스트 finally의 env 복원과는 별개) [PMQA-052-C].
    over.mutateOnQuery?.(q, url);
    return r;
  };

  const connect = (url: string) => {
    const u = unsafe(url);
    return {
      unsafe: u,
      begin: async <T>(fn: (q: { unsafe: typeof u }) => Promise<T>): Promise<T> => {
        queries.push({ url, q: "<BEGIN>" });
        const db = url.replace(/^.*\//, "").split("?")[0];
        const snapState = owned[db]
          ? {
            rels: new Map(owned[db].rels),
            mig: new Map(owned[db].mig),
            products: new Set(owned[db].products),
            marker: owned[db].marker.map((r) => ({ ...r })),
          }
          : null;
        try {
          const r = await fn({ unsafe: u });
          queries.push({ url, q: "<COMMIT>" });
          return r;
        } catch (e) {
          if (snapState && owned[db]) {
            owned[db].rels = snapState.rels;
            owned[db].mig = snapState.mig;
            owned[db].products = snapState.products;
            owned[db].marker = snapState.marker;
          }
          queries.push({ url, q: "<ROLLBACK>" });
          throw e;
        }
      },
      end: async () => { },
    };
  };

  return {
    env: over.env ?? env(),
    connect: connect as never,
    queries, written, writeOrder, owned, claimed,
    readFile: (p: string) => readFileSync(p), // 실제 pin·artifact 파일만
    writeJson: async (stage: string, obj: unknown) => {
      over.mutateOnStage?.[stage]?.();
      if (over.armPostSnapFailAfterStage === stage) postSnapArmed = true;
      if (written.has(stage)) throw new Error("wx 위반: " + stage);
      written.set(stage, obj);
      writeOrder.push(stage);
    },
    // deps.writeJson 주입과 별개로 사전 claim 자체는 항상 수행된다 —
    // claim 목록을 기록해 28 slot 전체가 claim됐는지 검증한다.
    claimFiles: async (dir: string, names: readonly string[]) => {
      if (over.claimFail) throw new Error("claim 충돌 주입");
      claimed.push({ dir, names: [...names] });
      return {
        dir,
        write: async () => {},
        writeJson: async () => {},
        stream: () => { throw new Error("fake stream 미사용"); },
        seal: async () => {},
        close: async () => {},
      };
    },
    reserveDir: async () => "RUN/",
    out: () => { },
  };
}

const EVIDENCE_STAGES = [
  "manifest", "code-sha", "gate-pins", "snap-protected-before",
  "scratch-planned", "scratch-created", "scratch-identified", "scratch-contract",
  "fault-1", "prepare-1", "prepare-2", "fault-2", "precleanup", "cleanup",
  "snap-protected-afterdrop", "result",
];

describe("runSmoke — DB-free 오케스트레이션", () => {
  test("happy path: PASS + 순서 + 보호 write 0 + DROP 1 + 전 evidence stage", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps();
      const r = await runSmoke(d as never);
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.stage, "done");
      assert.equal(r.dropCompleted, true);
      assert.equal(r.scratchState, "dropped");
      assert.match(r.dbName!, /^scratch_[0-9a-f]{16}$/);
      for (const s of EVIDENCE_STAGES)
        assert.equal(d.written.has(s), true, s);
      // DROP은 정확히 1회·scratch만 — 보호 DB에는 write/DDL 0건.
      const drops = d.queries.filter((x) => x.q.startsWith("DROP DATABASE"));
      assert.equal(drops.length, 1);
      assert.equal(drops[0].q, "DROP DATABASE " + r.dbName);
      const protectedWrites = d.queries.filter(
        (x) => /\/(commerce|commerce_test)(\?|$)/.test(x.url) &&
          /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)/i.test(x.q),
      );
      assert.equal(protectedWrites.length, 0);
      // CREATE는 오직 scratch 이름으로만.
      for (const x of d.queries.filter((x) => x.q.startsWith("CREATE DATABASE")))
        assert.match(x.q, /^CREATE DATABASE scratch_[0-9a-f]{16}$/);
      // cleanup은 precleanup 검증 통과 뒤에만 온다.
      assert.equal(d.writeOrder.indexOf("precleanup") < d.writeOrder.indexOf("cleanup"), true);
      // wx 위반 없이 각 stage가 정확히 한 번씩 기록됐다.
      assert.equal(d.writeOrder.length, new Set(d.writeOrder).size);
      // planned 28 slot 전체가 한 번에 claim됐다 [PMQA-054].
      assert.equal(d.claimed.length, 1);
      assert.deepEqual(d.claimed[0]!.names, [...SMOKE_EVIDENCE_SLOTS]);
      // fault-1 롤백 검증이 evidence로 남는다 — baseline=owner-only 최초 상태.
      const f1 = d.written.get("fault-1") as {
        relationsBaseline: { name: string; kind: string }[];
        relationsAfterRollback: { name: string; kind: string }[];
        equal: boolean;
      };
      assert.deepEqual(f1.relationsBaseline, [
        { name: "_scratch_owner", kind: "r" },
        { name: "_scratch_owner_pkey", kind: "i" },
      ]);
      assert.equal(f1.equal, true);
      assert.deepEqual(f1.relationsAfterRollback, f1.relationsBaseline);
      const f2 = d.written.get("fault-2") as { probeObservedInsideTxn: boolean; probeRolledBack: boolean };
      assert.equal(f2.probeObservedInsideTxn, true);
      assert.equal(f2.probeRolledBack, true);
    } finally {
      un();
    }
  });

  test("env 게이트 거부 — connect 0·evidence 0", async () => {
    const d = makeDeps({ env: { [SMOKE_OPTIN_ENV]: "1" } });
    const r = await runSmoke(d as never);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "gate-env");
    assert.equal(d.queries.length, 0);
    assert.equal(d.written.size, 0);
  });

  test("claim 실패 — connect·DB 작업 0으로 evidence-claim에서 멈춘다 [054]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({ claimFail: true });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "evidence-claim");
      assert.equal(d.queries.length, 0); // connect 자체 0
      assert.equal(d.written.size, 0);
    } finally {
      un();
    }
  });

  test("global env 부재도 초기 gate에서 거부 — source만 유효해도 connect 0", async () => {
    // global에 flag가 없는 채로 deps.env만 유효하면 게이트 실패다.
    const saved = process.env[SMOKE_OPTIN_ENV];
    delete process.env[SMOKE_OPTIN_ENV];
    try {
      const d = makeDeps();
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "gate-env");
      assert.match(r.reason!, /global env/);
      assert.equal(d.queries.length, 0);
    } finally {
      if (saved !== undefined) process.env[SMOKE_OPTIN_ENV] = saved;
    }
  });

  test("pins 주입은 즉시 거부 — 고정 PINS 외 baseline 경로 없음 [MJ052-5]", async () => {
    for (const injected of [
      [],
      [{ key: "x", path: "x", sha256: "x" }],
      PINS, // 동일 값이어도 주입 경로 자체가 없다
    ]) {
      const d = makeDeps();
      const r = await runSmoke({ ...d, pins: injected } as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "gate-env");
      assert.match(r.reason!, /pins 주입 금지/);
      assert.equal(d.queries.length, 0);
    }
  });

  test("pin 파일 부재·변조·empty — gate-pins에서 STOP·connect 0", async () => {
    const un = setGlobal();
    try {
      const auditPath = PINS.find((p) => p.key === "audit048")!.path;
      for (const mutate of [
        (p: string) => { if (p === auditPath) throw new Error("ENOENT"); return readFileSync(p); },
        (p: string) => p === auditPath ? Buffer.from("tampered") : readFileSync(p),
        (p: string) => p === auditPath ? Buffer.alloc(0) : readFileSync(p),
      ]) {
        const d = makeDeps();
        const r = await runSmoke({ ...d, readFile: mutate } as never);
        assert.equal(r.ok, false);
        assert.equal(r.stage, "gate-pins");
        assert.equal(d.queries.length, 0);
        assert.equal(d.queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length, 0);
      }
    } finally {
      un();
    }
  });

  test("live 보호 스냅이 승인 048과 다르면 CREATE하지 않는다", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps();
      // mock RO 응답이 audit과 다른 값을 돌려주도록 users count를 바꾼다.
      const drifted = {
        ...auditObj.after,
        tables: { ...auditObj.after.tables, users: { n: 999999, h: "x" } },
      };
      RO_SNAPS.commerce_test.tables = drifted.tables;
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "snap-protected-before");
      assert.equal(d.queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length, 0);
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      RO_SNAPS.commerce_test.tables = auditObj.after.tables; // 복원
    } finally {
      RO_SNAPS.commerce_test.tables = auditObj.after.tables;
      un();
    }
  });

  test("비예상 오류(비-sentinel)는 흡수되지 않고 STOP — cleanup 미실행·retain 기록·원문 0", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({ failOnQuery: /^INSERT INTO reviews/ });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "prepare-1");
      // 외부 오류 원문·secret·query는 reason·evidence 어디에도 없다 [MJ052-4].
      assert.equal(r.reason!.includes("SensitiveToken"), false);
      assert.equal(r.reason!.includes("INSERT INTO reviews"), false);
      assert.match(r.reason!, /EXTERNAL/);
      const fe = d.written.get("fail-prepare-1") as {
        error: { code: string; detail: string | null };
      };
      assert.equal(fe.error.code, "EXTERNAL");
      assert.equal(fe.error.detail, null);
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      assert.match(r.retainedDb!, /^scratch_/);
      assert.equal(r.scratchState, "createdKnown");
      assert.equal(d.written.has("cleanup"), false);
      // 실패한 txn은 롤백됐다 — mock의 ROLLBACK 흔적.
      assert.equal(d.queries.some((x) => x.q === "<ROLLBACK>"), true);
    } finally {
      un();
    }
  });

  test("flag 소실 — planned 기록 await 중 source 소실이면 CREATE 0·notAttempted [MJ052-2/3]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({
        mutateOnStage: {
          "scratch-planned": () => { delete d.env[SMOKE_OPTIN_ENV]; },
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "scratch-create");
      assert.equal(d.queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length, 0);
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      assert.equal(r.retainedDb, undefined);
      assert.equal(r.candidateDbName, undefined);
      assert.equal(r.scratchState, "notAttempted");
    } finally {
      un();
    }
  });

  test("flag 소실 — create 후 prepare 전 global strict 소실이면 DROP 0·retain [MJ052-2/3]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({
        mutateOnStage: {
          "scratch-contract": () => { delete process.env[SMOKE_STRICT_ENV]; },
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "fault-1");
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      assert.match(r.retainedDb!, /^scratch_/);
      assert.equal(r.scratchState, "createdKnown");
      assert.match(r.reason!, /global env 소실/);
    } finally {
      un();
    }
  });

  test("flag 소실 — precleanup 기록 중 소실이면 cleanup(DROP) 0 [MJ052-2]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({
        mutateOnStage: {
          precleanup: () => { delete process.env[SMOKE_OPTIN_ENV]; },
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "cleanup");
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      assert.match(r.retainedDb!, /^scratch_/);
      assert.equal(r.scratchState, "createdKnown");
    } finally {
      un();
    }
  });

  test("CREATE 반환 오류 — creationOutcomeUnknown + candidateDbName, 추정 삭제 0 [MJ052-3]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({ failOnQuery: /^CREATE DATABASE/ });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "scratch-create");
      assert.equal(r.scratchState, "creationOutcomeUnknown");
      assert.match(r.candidateDbName!, /^scratch_[0-9a-f]{16}$/);
      assert.equal(r.retainedDb, undefined);
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
    } finally {
      un();
    }
  });

  test("created evidence 기록 실패 — createdKnown + retain [MJ052-3]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps();
      const origWrite = d.writeJson;
      d.writeJson = async (stage: string, obj: unknown) => {
        if (stage === "scratch-created") throw new Error("EACCES: evidence 쓰기 실패 — pw=Leaked2");
        return origWrite(stage, obj);
      };
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "scratch-create");
      assert.equal(r.scratchState, "createdKnown");
      assert.match(r.retainedDb!, /^scratch_/);
      assert.equal(r.reason!.includes("Leaked2"), false); // 외부 원문 0
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
    } finally {
      un();
    }
  });

  test("afterDROP 보호 스냅 실패 — dropCompleted=true + 'retained' 거짓 표기 금지", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({ armPostSnapFailAfterStage: "cleanup" });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "snap-protected-afterdrop");
      assert.equal(r.dropCompleted, true);
      assert.equal(r.scratchState, "dropped");
      assert.equal(r.retainedDb, undefined);
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 1);
    } finally {
      un();
    }
  });

  test("ARTIFACT_FILES·PINS는 deep freeze — 외부 변조로 우회 불가 [MJ052-5]", () => {
    assert.equal(Object.isFrozen(PINS), true);
    for (const p of PINS) assert.equal(Object.isFrozen(p), true);
    assert.equal(Object.isFrozen(ARTIFACT_FILES), true);
  });

  // ── PMQA-052-C — await 경계 권한 소실·relBase·증거 보존 회귀 ──────────
  // injectedIdx는 mutateOnQuery가 기록한 'flag 소실이 주입된 query'의 위치다.
  // 그 이후 scratch 대상 실SQL은 0이어야 한다(<BEGIN>/<ROLLBACK>/<COMMIT>
  // 마커 제외). ROLLBACK·DROP 0·retain 상태도 함께 단정한다.
  const assertStopRetain = (
    d: ReturnType<typeof makeDeps>,
    r: Awaited<ReturnType<typeof runSmoke>>,
    injectedIdx: number,
  ) => {
    assert.equal(injectedIdx >= 0, true, "flag 소실 주입 query가 관측돼야 한다");
    const after = d.queries.slice(injectedIdx + 1);
    assert.equal(
      after.filter((x) => /scratch_/.test(x.url) && !x.q.startsWith("<")).length,
      0,
      "주입 이후 scratch 실SQL 0이어야 한다",
    );
    assert.equal(after.filter((x) => /scratch_/.test(x.url) && x.q === "<COMMIT>").length, 0);
    assert.equal(d.queries.some((x) => x.q === "<ROLLBACK>"), true);
    assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
    assert.equal(r.scratchState, "createdKnown");
    assert.match(r.retainedDb!, /^scratch_/);
  };

  test("flag 소실 — 'created' 기록 await 중 source 소실이면 marker CREATE/INSERT 0·retain [052-C]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({
        mutateOnStage: {
          "scratch-created": () => { delete d.env[SMOKE_OPTIN_ENV]; },
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "scratch-create");
      assert.equal(d.queries.filter((x) => x.q.startsWith("CREATE DATABASE")).length, 1);
      assert.equal(d.queries.filter((x) => x.q.startsWith("CREATE TABLE")).length, 0);
      assert.equal(d.queries.filter((x) => x.q.includes("INSERT INTO _scratch_owner")).length, 0);
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      assert.equal(r.scratchState, "createdKnown");
      assert.match(r.retainedDb!, /^scratch_/);
    } finally { un(); }
  });

  test("flag 소실 — 'identified' 기록 await 중 global strict 소실이면 marker CREATE/INSERT 0·retain [052-C]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({
        mutateOnStage: {
          "scratch-identified": () => { delete process.env[SMOKE_STRICT_ENV]; },
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "scratch-create");
      assert.equal(d.queries.filter((x) => x.q.startsWith("CREATE TABLE")).length, 0);
      assert.equal(d.queries.filter((x) => x.q.includes("INSERT INTO _scratch_owner")).length, 0);
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      assert.equal(r.scratchState, "createdKnown");
      assert.match(r.retainedDb!, /^scratch_/);
    } finally { un(); }
  });

  test("flag 소실 — prepare txn verify await 중 source 소실이면 후속 write 0·ROLLBACK·DROP 0 [052-C]", async () => {
    const un = setGlobal();
    try {
      let cdCalls = 0;
      let injectedIdx = -1;
      const d = makeDeps({
        mutateOnQuery: (q, url) => {
          // 'AS d,' — verifyOwnedExec의 멀티 컬럼 조회만 매칭한다. helper 생성
          // 시점의 'AS db'는 접두사 'AS d'에 걸리지 않게 콤마로 구분한다.
          if (/scratch_/.test(url) && q.includes("current_database() AS d,")) {
            cdCalls++;
            // 1회차 = runner owned-verify(별도 연결), 2회차 = prepare txn 안의 verify.
            if (cdCalls === 2) {
              delete d.env[SMOKE_OPTIN_ENV];
              injectedIdx = d.queries.length - 1;
            }
          }
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "fault-1");
      assertStopRetain(d, r, injectedIdx);
    } finally { un(); }
  });

  test("flag 소실 — prepare txn advisory lock await 중 global 소실이면 후속 write 0·ROLLBACK·DROP 0 [052-C]", async () => {
    const un = setGlobal();
    try {
      let injectedIdx = -1;
      const d = makeDeps({
        mutateOnQuery: (q, url) => {
          if (/scratch_/.test(url) && q.startsWith("SELECT pg_advisory_xact_lock")) {
            delete process.env[SMOKE_OPTIN_ENV];
            injectedIdx = d.queries.length - 1;
          }
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "fault-1");
      assertStopRetain(d, r, injectedIdx);
    } finally { un(); }
  });

  test("flag 소실 — prepare txn migration INSERT await 중 source 소실이면 후속 write 0·ROLLBACK·DROP 0 [052-C]", async () => {
    const un = setGlobal();
    try {
      let injectedIdx = -1;
      const d = makeDeps({
        mutateOnQuery: (q, url) => {
          if (/scratch_/.test(url) && q.startsWith("INSERT INTO _migrations")) {
            delete d.env[SMOKE_OPTIN_ENV];
            injectedIdx = d.queries.length - 1;
          }
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "fault-1");
      assertStopRetain(d, r, injectedIdx);
    } finally { un(); }
  });

  test("flag 소실 — prepare txn seed await 중 global 소실이면 후속 write 0·ROLLBACK·DROP 0 [052-C]", async () => {
    const un = setGlobal();
    try {
      let injectedIdx = -1;
      const d = makeDeps({
        mutateOnQuery: (q, url) => {
          // seed 구간 첫 reviews INSERT — fault-1은 002 sentinel로 seed 전에 중단되므로
          // 이 지점은 prepare-1의 seed 내부다.
          if (/scratch_/.test(url) && q.startsWith("INSERT INTO reviews") && injectedIdx < 0) {
            delete process.env[SMOKE_OPTIN_ENV];
            injectedIdx = d.queries.length - 1;
          }
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "prepare-1");
      assertStopRetain(d, r, injectedIdx);
    } finally { un(); }
  });

  test("flag 소실 — prepare txn 최후 SQL await 중 소실이면 다음 query 없이도 COMMIT 전 STOP·ROLLBACK [052-C]", async () => {
    const un = setGlobal();
    try {
      let shipCalls = 0;
      let injectedIdx = -1;
      const d = makeDeps({
        mutateOnQuery: (q, url) => {
          // scenarios의 shipment INSERT — 3회차(prepare-1의 마지막 order)가
          // 해당 txn의 최후 SQL이다. 다음 unsafe 없이 콜백이 반환되는 경계다.
          if (/scratch_/.test(url) && q.startsWith("INSERT INTO shipments")) {
            shipCalls++;
            if (shipCalls === 3) {
              delete d.env[SMOKE_OPTIN_ENV];
              injectedIdx = d.queries.length - 1;
            }
          }
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "prepare-1");
      assertStopRetain(d, r, injectedIdx);
    } finally { un(); }
  });

  test("flag 소실 — fault-2 probe 직전(payments INSERT await) 소실이면 probe 0·sentinel 미발화·ROLLBACK·DROP 0 [052-C]", async () => {
    const un = setGlobal();
    try {
      let payments = 0;
      let injectedIdx = -1;
      const d = makeDeps({
        mutateOnQuery: (q) => {
          if (q.startsWith("INSERT INTO payments (")) {
            payments++;
            // prepare-1/2 각 4건 이후 fault-2의 첫 payments INSERT — hook이
            // probe orig를 호출하기 직전의 await 경계다.
            if (payments === 9) {
              delete d.env[SMOKE_OPTIN_ENV];
              injectedIdx = d.queries.length - 1;
            }
          }
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "fault-2");
      // probe INSERT가 dispatch되지 않았다 — guard가 orig 호출 직전에 차단.
      assert.equal(d.queries.filter((x) => x.q.includes("smoke-probe")).length, 0);
      assertStopRetain(d, r, injectedIdx);
    } finally { un(); }
  });

  test("relBase — owner-only 외 relation(extra/missing/kind 불일치)이면 fault/prepare/DROP 0·retain [052-C]", async () => {
    const un = setGlobal();
    try {
      for (const override of [
        // extra — whitelist 밖의 예상외 kind(sequence)도 잡혀야 한다 [Luna-b]
        [
          { name: "_scratch_owner", kind: "r" },
          { name: "_scratch_owner_pkey", kind: "i" },
          { name: "ghost_seq", kind: "S" },
        ],
        // missing — pkey 부재
        [{ name: "_scratch_owner", kind: "r" }],
        // kind 불일치 — 같은 이름의 다른 kind
        [
          { name: "_scratch_owner", kind: "r" },
          { name: "_scratch_owner_pkey", kind: "r" },
        ],
      ]) {
        const d = makeDeps({ relBaseOverride: override });
        const r = await runSmoke(d as never);
        assert.equal(r.ok, false, JSON.stringify(override));
        assert.equal(r.stage, "owned-verify");
        assert.equal(d.written.has("fault-1"), false);
        assert.equal(d.written.has("prepare-1"), false);
        assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
        assert.equal(r.scratchState, "createdKnown");
        assert.match(r.retainedDb!, /^scratch_/);
      }
    } finally { un(); }
  });

  test("evidence — precleanup/afterDROP에 실측 2DB 스냅·drift 배열이 저장된다 [052-C]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps();
      const r = await runSmoke(d as never);
      assert.equal(r.ok, true, r.reason);
      for (const s of ["precleanup", "snap-protected-afterdrop"] as const) {
        const e = d.written.get(s) as {
          pass: boolean;
          test: { db: string; oid: number; tables: Record<string, { n: number; h: string }> };
          dev: { db: string; oid: number; tables: Record<string, { n: number; h: string }> };
          driftTest: string[];
          driftDev: string[];
        };
        assert.equal(e.pass, true, s);
        assert.equal(e.test.db, "commerce_test");
        assert.equal(e.test.oid, RO_SNAPS.commerce_test.oid);
        assert.deepEqual(e.test.tables, RO_SNAPS.commerce_test.tables);
        assert.equal(e.dev.db, "commerce");
        assert.equal(e.dev.oid, RO_SNAPS.commerce.oid);
        assert.deepEqual(e.dev.tables, RO_SNAPS.commerce.tables);
        assert.deepEqual(e.driftTest, []);
        assert.deepEqual(e.driftDev, []);
      }
    } finally { un(); }
  });

  test("evidence — precleanup drift 발생 시 pass:false + 실측 스냅·drift 배열 보존·DROP 0 [052-C]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({
        mutateOnStage: {
          // before 스냅 이후 live 보호 DB drift를 모사 — 복원은 finally.
          "fault-2": () => {
            RO_SNAPS.commerce_test.tables = {
              ...RO_SNAPS.commerce_test.tables,
              users: { n: 424242, h: "drift" },
            };
          },
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "precleanup");
      const e = d.written.get("precleanup") as {
        pass: boolean;
        driftTest: string[];
        test: { tables: Record<string, { n: number }> };
      };
      assert.equal(e.pass, false);
      assert.equal(e.driftTest.length > 0, true);
      assert.equal(e.test.tables.users.n, 424242); // 실측값이 그대로 저장된다
      assert.equal(d.queries.filter((x) => x.q.startsWith("DROP DATABASE")).length, 0);
      assert.match(r.retainedDb!, /^scratch_/);
      assert.equal(r.scratchState, "createdKnown");
    } finally {
      RO_SNAPS.commerce_test.tables = auditObj.after.tables;
      un();
    }
  });

  test("evidence — afterDROP drift 발생 시 pass:false + drift 보존·dropCompleted=true·'retained' 거짓 표기 0 [052-C]", async () => {
    const un = setGlobal();
    try {
      const d = makeDeps({
        mutateOnStage: {
          cleanup: () => {
            RO_SNAPS.commerce_test.tables = {
              ...RO_SNAPS.commerce_test.tables,
              orders: { n: 777, h: "postdrift" },
            };
          },
        },
      });
      const r = await runSmoke(d as never);
      assert.equal(r.ok, false);
      assert.equal(r.stage, "snap-protected-afterdrop");
      assert.equal(r.dropCompleted, true);
      assert.equal(r.scratchState, "dropped");
      assert.equal(r.retainedDb, undefined);
      const e = d.written.get("snap-protected-afterdrop") as {
        pass: boolean;
        driftTest: string[];
        test: { tables: Record<string, { n: number }> };
      };
      assert.equal(e.pass, false);
      assert.equal(e.driftTest.length > 0, true);
      assert.equal(e.test.tables.orders.n, 777);
    } finally {
      RO_SNAPS.commerce_test.tables = auditObj.after.tables;
      un();
    }
  });
});
