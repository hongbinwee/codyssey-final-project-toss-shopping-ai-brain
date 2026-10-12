// tests/e2e/readonly-audit.ts의 DB-free 주입 검증 — 파일 게이트 fail-closed
// (백업/047 불일치⇒DB 0 접속), demo_verify 존재⇒child 0, child 실패⇒사후감사
// 필수, 기존 run⇒bytes 불변. 모두 실제 runAudit 오케스트레이션 경로다
// [PMQA-048-B0].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  auditVerdict, pwChildEnv, runAudit, type AuditDeps,
} from "../e2e/readonly-audit.ts";
import {
  RO_DB, RO_DB_OID, RO_DEV_DB, RO_DEV_DB_OID, RO_TABLES,
  type DbSnap,
} from "../e2e/readonly-db.ts";
import { RO_FACTS_SHA256 } from "../e2e/readonly-db.ts";

// 승인 facts의 최소 통과 형태 (parse는 readonly-db 테스트가 상세히 본다).
function goodFactsBuf(): Buffer {
  const cancels = [
    { id: "cxl-1", order_id: "ord-n1", status: "REQUESTED", action_request_id: "a-c1" },
    { id: "cxl-2", order_id: "ord-n2", status: "REQUESTED", action_request_id: "a-c2" },
  ];
  const newOrders = Array.from({ length: 12 }, (_, i) => ({
    id: "ord-n" + (i + 1), user_id: "u-c", status: "CONFIRMED",
    items_total_won: 100, shipping_fee_won: 0, total_won: 100,
    items: ["i" + i], payments: ["p" + i], shipments: ["s" + i],
    cancels: i === 0 ? ["cxl-1"] : i === 1 ? ["cxl-2"] : [],
    actions: ["a" + i],
  }));
  return Buffer.from(JSON.stringify({
    auditFail: false, kind: "b3-post-audit",
    postFp: {
      protectedFpNoCartTs: "x", protectedFpNoCartTsMatch: true,
      preservedActionsFp: "y", preservedActionsFpMatch: true,
    },
    rowCounts: {
      orders: 16, order_items: 17, payments: 16, shipments: 15,
      cancel_requests: 2, action_requests: 152, cart_items: 0,
    },
    newOrders, cancels,
  }));
}

const mkSnap = (db: string, oid: number, over: Partial<DbSnap> = {}): DbSnap => ({
  db, oid, at: "t",
  tables: Object.fromEntries(RO_TABLES.map((t) => [t, { n: 1, h: "h" }])),
  writers: [], writersError: null, unreadableActive: [], ...over,
});

type Calls = {
  mkdir: number; connect: number; probe: number; listDb: number;
  gate: number; snap: number; spawn: number; puts: string[];
  putObjs: Record<string, unknown>;
  spawnNonce: string | null;
};

// 통과형 기본 deps — 필요한 것만 overrides로 바꿔 부정 경로를 만든다.
function fakeDeps(over: Partial<AuditDeps> = {}): { deps: AuditDeps; calls: Calls } {
  const calls: Calls = {
    mkdir: 0, connect: 0, probe: 0, listDb: 0, gate: 0, snap: 0, spawn: 0,
    puts: [], putObjs: {}, spawnNonce: null,
  };
  const deps: AuditDeps = {
    mkdirRunDir: () => { calls.mkdir++; return "dir"; },
    put: (_d, name, obj) => { calls.puts.push(name); calls.putObjs[name] = obj; },
    verifyBackupFile: () => {},
    readFileBytes: () => goodFactsBuf(),
    sha256: () => RO_FACTS_SHA256,
    loadSeedOrderIds: () => ["ord-a-pre", "ord-a-ship", "ord-a-done", "ord-b-none"],
    connect: (_u, db) => {
      calls.connect++;
      const isDev = db === RO_DEV_DB;
      return {
        db,
        begin: async (fn: (q: never) => Promise<unknown>) => fn({ unsafe: async () => [] } as never),
        end: async () => {},
        __snap: () => mkSnap(db, isDev ? RO_DEV_DB_OID : RO_DB_OID),
      } as never;
    },
    probeDb: async () => { calls.probe++; },
    listDatabases: async () => {
      calls.listDb++;
      return [
        { datname: RO_DEV_DB, oid: RO_DEV_DB_OID },
        { datname: RO_DB, oid: RO_DB_OID },
      ];
    },
    baselineGate: async () => {
      calls.gate++;
      // 실제 계약: gate의 동일 txn에서 수집한 test before를 함께 돌린다.
      return {
        ok: true, reasons: [], detail: {},
        before: mkSnap(RO_DB, RO_DB_OID, { at: "gate-txn" }),
      };
    },
    snapInTxn: async (conn) => {
      calls.snap++;
      return (conn as unknown as { __snap: () => DbSnap }).__snap();
    },
    spawnPw: (_runId, nonce) => {
      calls.spawn++;
      calls.spawnNonce = nonce;
      return { status: 0, error: null };
    },
    ...over,
  };
  return { deps, calls };
}

describe("runAudit — 파일 게이트 fail-closed", () => {
  test("043 백업 불일치 ⇒ DB 0 접속·child 0·file-gate evidence", async () => {
    const { deps, calls } = fakeDeps({
      verifyBackupFile: () => { throw new Error("SHA 불일치"); },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.connect, 0);
    assert.equal(calls.probe, 0);
    assert.equal(calls.spawn, 0);
    assert.deepEqual(calls.puts, ["audit-fail.json"]);
  });
  test("047 facts SHA 불일치 ⇒ DB 0 접속·child 0", async () => {
    const { deps, calls } = fakeDeps({ sha256: () => "deadbeef" });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.connect, 0);
    assert.equal(calls.spawn, 0);
    assert.ok(v.reasons.some((r) => r.includes("SHA256")));
  });
  test("047 facts 구조 불일치 ⇒ DB 0 접속", async () => {
    const { deps, calls } = fakeDeps({
      readFileBytes: () => Buffer.from('{"auditFail":true}'),
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.connect, 0);
    assert.ok(v.reasons.some((r) => r.includes("047 facts")));
  });
});

describe("runAudit — DB 단계 게이트", () => {
  test("demo_verify 존재 ⇒ gate 실패·child 0·after 시도는 함", async () => {
    const { deps, calls } = fakeDeps({
      listDatabases: async () => [
        { datname: "commerce_demo_verify", oid: 1 },
        { datname: RO_DB, oid: RO_DB_OID },
      ],
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.ok(v.reasons.some((r) => r.includes("demo_verify")));
    assert.equal(calls.snap, 2); // 접속한 경로라 사후 감사(두 DB) 시도
    assert.deepEqual(calls.puts, ["audit-after.json"]);
  });
  test("baselineGate 실패 ⇒ child 0·after 시도", async () => {
    const { deps, calls } = fakeDeps({
      baselineGate: async () => ({ ok: false, reasons: ["보호 지문 불일치"], detail: {} }),
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.equal(calls.snap, 2);
    assert.ok(v.reasons.some((r) => r.includes("before gate")));
  });
  test("test before(gate txn)에 write 세션 ⇒ child 0", async () => {
    const { deps, calls } = fakeDeps({
      baselineGate: async () => ({
        ok: true, reasons: [], detail: {},
        before: mkSnap(RO_DB, RO_DB_OID, { writers: [42] }),
      }),
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.ok(v.reasons.some((r) => r.includes("write 가능 세션")));
  });
  test("dev before에 write 세션 ⇒ child 0", async () => {
    const { deps, calls } = fakeDeps({
      snapInTxn: async (conn) => {
        calls.snap++;
        const c = conn as unknown as { db: string; __snap: () => DbSnap };
        const s = c.__snap();
        if (c.db === RO_DEV_DB && calls.snap === 1) s.writers = [42];
        return s;
      },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.ok(v.reasons.some((r) => r.includes("write 가능 세션")));
  });
  test("unreadable 활성 세션 ⇒ child 0 (안전 PASS 아님)", async () => {
    const { deps, calls } = fakeDeps({
      baselineGate: async () => ({
        ok: true, reasons: [], detail: {},
        before: mkSnap(RO_DB, RO_DB_OID, { unreadableActive: [77] }),
      }),
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.ok(v.reasons.some((r) => r.includes("열람 불가")));
  });
});

describe("runAudit — child·after 경로", () => {
  test("child nonzero ⇒ 사후감사 실행·FAIL", async () => {
    const { deps, calls } = fakeDeps({
      spawnPw: () => ({ status: 1, error: null }),
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.snap, 3);   // dev before + 두 DB after(test before는 gate txn)
    assert.ok(v.reasons.some((r) => r.includes("playwright exit 1")));
    assert.deepEqual(calls.puts, [
      "audit-before.json", "run-owner.json", "audit-after.json",
    ]);
  });
  test("child throw ⇒ 사후감사 실행·FAIL", async () => {
    const { deps, calls } = fakeDeps({
      spawnPw: () => { throw new Error("spawn EINVAL"); },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.snap, 3);
    assert.ok(v.reasons.some((r) => r.includes("spawn EINVAL")));
  });
  test("after 스냅 실패 ⇒ PASS 없음·실패 evidence", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps({
      snapInTxn: async () => {
        calls.snap++;
        n++;
        if (n > 1) throw new Error("after conn lost"); // after 두 건 실패
        return mkSnap(RO_DB, RO_DB_OID);
      },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((r) => r.includes("after 스냅")));
  });
  test("drift 발생 ⇒ FAIL", async () => {
    let n = 0;
    const { deps } = fakeDeps({
      snapInTxn: async (conn) => {
        const c = conn as unknown as { __snap: () => DbSnap };
        const s = c.__snap();
        n++;
        if (n === 2) s.tables.orders = { n: 999, h: "x" }; // test after만 변조
        return s;
      },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((r) => r.includes("commerce_test drift")));
  });
  test("정상 경로 ⇒ PASS·evidence 2종", async () => {
    const { deps, calls } = fakeDeps();
    const v = await runAudit(deps);
    assert.equal(v.pass, true);
    assert.equal(calls.spawn, 1);
    assert.equal(calls.snap, 3);
    assert.deepEqual(calls.puts, [
      "audit-before.json", "run-owner.json", "audit-after.json",
    ]);
  });
});

describe("runAudit — run-owner nonce 바인딩 (B1F)", () => {
  test("spawn env nonce = run-owner marker nonce (소유 정합 키)", async () => {
    const { deps, calls } = fakeDeps();
    const v = await runAudit(deps);
    assert.equal(v.pass, true);
    const owner = calls.putObjs["run-owner.json"] as {
      runId: string; nonce: string; at: string;
    };
    assert.equal(owner.nonce, calls.spawnNonce); // child env와 marker 일치
    assert.match(owner.runId, /^[0-9a-f-]{36}$/);
    // marker는 audit-before(승인 before) 이후·spawn 직전에 새겨진다.
    assert.deepEqual(
      calls.puts.slice(0, 2), ["audit-before.json", "run-owner.json"],
    );
  });
  test("run-owner marker wx 충돌 ⇒ child 0·FAIL·사후 감사 시도", async () => {
    const { deps, calls } = fakeDeps({
      put: (_d, name, obj) => {
        calls.puts.push(name);
        calls.putObjs[name] = obj;
        if (name === "run-owner.json") throw new Error("EEXIST");
      },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.equal(calls.snap, 3); // dev before + 두 DB after
    assert.ok(v.reasons.some((r) => r.includes("EEXIST")));
  });
});

describe("pwChildEnv — child env 정합 (B1F)", () => {
  test("RO_RUN_ID·RO_WORKER_NONCE 바인딩 + 상속 worker 지표 제거", () => {
    const env = pwChildEnv("run-1", "n-1", undefined, undefined, {
      TEST_WORKER_INDEX: "0",
      TEST_PARALLEL_INDEX: "0",
      KEEP: "yes",
    });
    assert.equal(env.RO_RUN_ID, "run-1");
    assert.equal(env.RO_WORKER_NONCE, "n-1");
    assert.equal(env.KEEP, "yes");
    // 상속된 worker 지표는 첫 runner가 worker로 오인하지 않게 제거된다.
    assert.equal("TEST_WORKER_INDEX" in env, false);
    assert.equal("TEST_PARALLEL_INDEX" in env, false);
  });
  test("상속된 출력 경로 override 제거 — 외부 기존 파일 덮어쓰기 차단 (Luna B1F)", () => {
    const env = pwChildEnv("run-1", "n-1", undefined, undefined, {
      PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: "C:/outside/evidence.json",
      PLAYWRIGHT_JUNIT_OUTPUT_FILE: "C:/outside/junit.xml",
      PLAYWRIGHT_BLOB_OUTPUT_DIR: "C:/outside/blob",
      PLAYWRIGHT_HTML_REPORT: "C:/outside/report",
      PLAYWRIGHT_HTML_OPEN: "always",
      KEEP: "yes",
    });
    for (const k of [
      "PLAYWRIGHT_LAST_RUN_OUTPUT_FILE",
      "PLAYWRIGHT_JUNIT_OUTPUT_FILE",
      "PLAYWRIGHT_BLOB_OUTPUT_DIR",
      "PLAYWRIGHT_HTML_REPORT",
      "PLAYWRIGHT_HTML_OPEN",
    ])
      assert.equal(k in env, false, k + " 제거 필요");
    assert.equal(env.KEEP, "yes");
    assert.equal(env.RO_RUN_ID, "run-1");
  });
});

// gate 본문과 before 기준선이 하나의 txn이어야 한다 — runAudit가 gate 산출
// 스냅샷을 그대로 쓰고 test before를 새 txn으로 재촬영하지 않는지 검증한다
// [Luna B0 재검수 MAJOR].
describe("runAudit — gate/before 동일 txn", () => {
  test("gate의 동일 txn before 사용 — test before 재촬영 없음", async () => {
    const gateBefore = mkSnap(RO_DB, RO_DB_OID, { at: "gate-txn" });
    let testSnaps = 0;
    const { deps, calls } = fakeDeps({
      baselineGate: async () => ({
        ok: true, reasons: [], detail: {}, before: gateBefore,
      }),
      snapInTxn: async (conn) => {
        calls.snap++;
        const c = conn as unknown as { db: string; __snap: () => DbSnap };
        if (c.db === RO_DB) { testSnaps++; return { ...gateBefore }; }
        return c.__snap();
      },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, true);
    // test 연결엔 after 스냅 1회만 — before는 gate txn 산출물이다.
    assert.equal(testSnaps, 1);
    assert.equal(calls.snap, 3);
  });
  test("gate ok인데 동일 txn before 부재 ⇒ FAIL·child 0", async () => {
    const { deps, calls } = fakeDeps({
      baselineGate: async () => ({ ok: true, reasons: [], detail: {} }),
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.equal(calls.snap, 2);
    assert.ok(v.reasons.some((r) => r.includes("before를 반환하지 않음")));
  });
  test("probe 실패 ⇒ child 0·사후 감사는 시도", async () => {
    const { deps, calls } = fakeDeps({
      probeDb: async () => { calls.probe++; throw new Error("probe fail"); },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.spawn, 0);
    assert.equal(calls.snap, 2); // 접속한 경로이므로 사후 감사는 시도한다
    assert.ok(v.reasons.some((r) => r.includes("DB probe")));
  });
  test("dev count 동일·내용 지문 변경 ⇒ FAIL (driftDev)", async () => {
    let devN = 0;
    const { deps } = fakeDeps({
      snapInTxn: async (conn) => {
        const c = conn as unknown as { db: string; __snap: () => DbSnap };
        const s = c.__snap();
        if (c.db === RO_DEV_DB && ++devN === 2)
          s.tables.orders = { n: 1, h: "changed" }; // count 동일·지문만 변경
        return s;
      },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.ok(v.reasons.some((r) => r.includes("내용 지문 변경")));
  });
  test("audit-after evidence write 실패 ⇒ FAIL(exit 3)", async () => {
    const { deps, calls } = fakeDeps({
      put: (_d, name) => {
        calls.puts.push(name);
        if (name === "audit-after.json") throw new Error("disk full");
      },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(v.exit, 3);
    assert.ok(v.reasons.some((r) => r.includes("evidence write")));
  });
});

describe("runAudit — run dir 원자성", () => {
  test("기존 run 존재 ⇒ 아무것도 쓰지 않고 실패 (bytes 불변)", async () => {
    const { deps, calls } = fakeDeps({
      mkdirRunDir: () => { calls.mkdir++; throw new Error("EEXIST"); },
    });
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.puts.length, 0);   // 기존 evidence에 어떤 write도 없다
    assert.equal(calls.connect, 0);
    assert.equal(calls.spawn, 0);
    assert.ok(v.reasons.some((r) => r.includes("기존 evidence 보존")));
  });
});

// ── auditVerdict 순수 판정 ─────────────────────────────────────────
describe("auditVerdict", () => {
  const ok = {
    gateOk: true, gateReasons: [] as string[], spawned: true,
    pwStatus: 0 as number | null, pwError: null as string | null,
    drift: [] as string[], driftDev: [] as string[], errors: [] as string[],
  };
  test("전부 정상 → pass", () => {
    const v = auditVerdict(ok);
    assert.equal(v.pass, true);
    assert.equal(v.exit, 0);
  });
  test("gate 실패·pw 실패·drift·errors 각각 FAIL", () => {
    assert.equal(auditVerdict({ ...ok, gateOk: false, gateReasons: ["x"] }).pass, false);
    assert.equal(auditVerdict({ ...ok, pwStatus: 2 }).pass, false);
    assert.equal(auditVerdict({ ...ok, spawned: false }).pass, false); // gate ok인데 spawn 없음
    assert.equal(auditVerdict({ ...ok, drift: ["d"] }).pass, false);
    assert.equal(auditVerdict({ ...ok, driftDev: ["d"] }).pass, false);
    assert.equal(auditVerdict({ ...ok, errors: ["e"] }).pass, false);
  });
});
