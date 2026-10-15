// PMQA-078 — fixed suite runner의 orchestration을 DB·브라우저 없이 mock
// 주입으로 검증한다. 검증 대상은 PM requiredFixes/정정이다:
//   1) 부모 소유 exclusive 자식 로그(prePG wx 예약·잔류 close)
//   2) PW workdir·run-owner marker·exec 계획은 첫 PG connect 전 사전조건
//   3) 핀 게이트는 주입 불가 — 실제 승인 파일(read-only)만 baseline으로
//   4) 자식 실패/미종료·로그 실패·drift 시 다음 suite·owned DROP 전 중단
//   5) 실행 순서는 파일명 정렬이 아니라 project dependency로 고정(config)
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { spawn } from "node:child_process";
import {
  runIsolatedSuite,
  runNode,
  type OwnerMarker,
  type SourceShaMap,
  type SuiteDeps,
} from "../../scripts/isolated-suite.ts";
import { PINS, parseApprovedAudit } from "../../scripts/isolated-smoke.ts";
import type { DbSnap } from "../e2e/readonly-db.ts";

const SCRATCH_DB = "scratch_0123456789abcdef";
// contractFromScratch는 UUID runId + localhost postgres URL을 요구한다.
const SCRATCH_RUN_ID = "11111111-2222-3333-4444-555555555555";
const ENV_KEYS = [
  "SCRATCH_DB_TESTS",
  "ISOLATED_STRICT",
  "SCRATCH_ADMIN_URL",
  "SCRATCH_DB_TARGET",
  "SCRATCH_PROTECTED_ADMIN_URL",
  "DATABASE_URL",
  "TEST_DB_URL",
  "ISOLATED_DB_URL",
  "ISOLATED_DB_NAME",
  "ISOLATED_DB_OID",
  "ISOLATED_DB_OWNER",
  "ISOLATED_RUN_ID",
  "ISO_PW_WORKDIR",
  "ISO_PW_RUN_ID",
  "ISO_PW_NONCE",
  "ISO_EVIDENCE_DIR",
  "SMOKE_OUTPUT_DIR",
  "SMOKE_EVIDENCE_DIR",
  "NODE_OPTIONS",
  "NODE_PATH",
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of Object.keys(process.env))
    if (
      /^PG(HOST|PORT|DATABASE|USER|PASSWORD|SSLMODE)$/i.test(k) ||
      /^(playwright_|output_name|pwio_)/i.test(k)
    ) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SCRATCH_DB_TESTS = "1";
  process.env.ISOLATED_STRICT = "1";
  process.env.SCRATCH_ADMIN_URL =
    "postgres://commerce:commerce@localhost:5432/postgres";
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Rec = {
  events: string[];
  slots: string[];
  submitted?: { slot: string; data: string }[];
  spawns: string[][];
  envs?: NodeJS.ProcessEnv[];
  marker?: OwnerMarker;
  pwId?: string;
  pwDir?: string;
  connectUrls?: string[];
  scratchUrl?: string;
  scratchTarget?: string;
};

// 실제 승인 파일을 읽기 전용으로 baseline을 만든다 — checkPins 주입은
// 제거됐으므로 fixed gate의 진짜 기준과 같은 값으로 RO 응답을 흉내낸다.
// 원본 backup/audit 파일은 변경하지 않는다 [③].
function approvedBaseline(): { after: DbSnap; afterDev: DbSnap } {
  for (const p of PINS) {
    if (p.key !== "audit048") continue;
    const a = parseApprovedAudit(JSON.parse(readFileSync(p.path, "utf8")));
    if (!a.ok) throw new Error("승인 audit 거부: " + a.reasons.join(" | "));
    return { after: a.after, afterDev: a.afterDev };
  }
  throw new Error("audit048 pin 부재");
}
const BASELINE = approvedBaseline();

// roSnap이 요구하는 응답만 주는 connect mock — 어떤 PG 접속도 열지 않는다.
// snapDb의 실제 쿼리 형태에 맞춰 baseline의 n/h·oid를 돌려준다.
// driftAfterCalls: N번째 connect 이후 스냅의 h를 변조해 live drift를 재현.
function mockConnect(
  rec: Rec,
  opts: { driftAfterCalls?: number } = {},
): NonNullable<SuiteDeps["connect"]> {
  let calls = 0;
  return ((url: string) => {
    const db = new URL(url).pathname.slice(1);
    (rec.connectUrls ??= []).push(url);
    rec.events.push("connect:" + db);
    calls++;
    const snap = db === "commerce_test" ? BASELINE.after : BASELINE.afterDev;
    const drift =
      opts.driftAfterCalls !== undefined && calls > opts.driftAfterCalls;
    const q = {
      unsafe: async <T = Record<string, unknown>[]>(sql: string): Promise<T> => {
        if (sql.includes("SET TRANSACTION")) return [] as T;
        if (sql.includes("pg_stat_activity")) return [] as T;
        if (sql.includes("current_database()"))
          return [{ d: db, oid: snap.oid }] as T;
        const m = /\bFROM\s+([a-zA-Z_][\w]*)\s+x\b/.exec(sql);
        if (m && snap.tables[m[1]]) {
          const t = snap.tables[m[1]];
          return [{ n: t.n, h: drift ? t.h + "!" : t.h }] as T;
        }
        return [] as T;
      },
    };
    return {
      unsafe: q.unsafe,
      begin: async <T>(fn: (x: typeof q) => Promise<T>) => fn(q),
      end: async () => {},
    };
  }) as NonNullable<SuiteDeps["connect"]>;
}

function makeDeps(rec: Rec, snapshots?: SourceShaMap[]): SuiteDeps {
  let snapshotIndex = 0;
  const broker = {
    dir: "run-x/",
    nonce: "n",
    submit: async (m: { slot: string; data: string }) => {
      rec.slots.push(m.slot);
      (rec.submitted ??= []).push(m);
      rec.events.push("submit:" + m.slot);
    },
    close: async () => {
      rec.events.push("broker.close");
    },
  };
  return {
    connect: mockConnect(rec),
    // checkPins는 주입 대상이 아니다 — runIsolatedSuite는 항상 고정
    // PINS+048 audit gate를 실행하고, 이 테스트는 실제 승인 파일을
    // 읽기 전용으로 쓴다. 아래 mock은 '호출 순서' 기록용이며 어떤
    // 체크도 대체하지 않는다 [③].
    reserveBrokerRun: (async () => {
      rec.events.push("broker.reserve");
      return broker;
    }) as unknown as NonNullable<SuiteDeps["reserveBrokerRun"]>,
    createOwnedScratchDb: (async (
      adminUrl: string,
      d: { target?: string; events?: (e: unknown) => Promise<void>; guard?: () => void },
    ) => {
      rec.events.push("scratch.create");
      rec.scratchTarget = d.target;
      rec.scratchUrl = adminUrl.replace(/\/postgres$/, "/" + SCRATCH_DB);
      await d.events?.({
        stage: "planned",
        dbName: SCRATCH_DB,
        runId: SCRATCH_RUN_ID,
      });
      await d.events?.({ stage: "created", dbName: SCRATCH_DB });
      await d.events?.({
        stage: "identified",
        dbName: SCRATCH_DB,
        oid: 99001,
        owner: 10,
      });
      return {
        dbName: SCRATCH_DB,
        runId: SCRATCH_RUN_ID,
        dbUrl: rec.scratchUrl,
        createdIdentity: { oid: 99001, owner: 10 },
        cleanup: async () => {
          rec.events.push("scratch.cleanup");
        },
      };
    }) as NonNullable<SuiteDeps["createOwnedScratchDb"]>,
    prepareIsolatedDb: (async (
      _env: unknown,
      _d: unknown,
      opts: { phase?: number },
    ) => {
      rec.events.push("prepare.phase" + opts?.phase);
      return { ok: true, dbName: SCRATCH_DB, migrations: [], seededFiles: [] };
    }) as NonNullable<SuiteDeps["prepareIsolatedDb"]>,
    reservePwWorkdir: (async (_root: string, runId: string) => {
      rec.pwId = runId;
      rec.pwDir = "pw-output/run-pw-" + runId;
      rec.events.push("pw.reserve");
      return rec.pwDir;
    }) as NonNullable<SuiteDeps["reservePwWorkdir"]>,
    assertPwIsolation: (() => {
      rec.events.push("pw.isolation");
    }) as NonNullable<SuiteDeps["assertPwIsolation"]>,
    assertExecPlan: ((opts: { dbNames?: readonly string[] }) => {
      rec.events.push(
        "execplan" + (opts.dbNames ? ".dbnames:" + opts.dbNames.join(",") : ""),
      );
    }) as NonNullable<SuiteDeps["assertExecPlan"]>,
    writeOwnerMarker: (async (_dir: string, m: OwnerMarker) => {
      rec.marker = m;
      rec.events.push("pw.owner:" + m.runId);
    }) as NonNullable<SuiteDeps["writeOwnerMarker"]>,
    spawnNode: (async (
      args: string[],
      env: NodeJS.ProcessEnv,
      _t: number,
      logs?: { stdout: Writable; stderr: Writable },
    ) => {
      rec.spawns.push(args);
      (rec.envs ??= []).push(env);
      rec.events.push(
        args[0].includes("playwright") ? "spawn.e2e" : "spawn.integration",
      );
      if (logs) {
        logs.stdout.write("child-out");
        logs.stderr.write("child-err");
        logs.stdout.end();
        logs.stderr.end();
      }
      return {
        code: 0,
        signal: null,
        timedOut: false,
        spawnError: false,
        closed: true,
        logError: false,
      };
    }) as NonNullable<SuiteDeps["spawnNode"]>,
    openLog: (async (_dir: string, name: string) => {
      rec.events.push("log:" + name);
      return new Writable({ write: (_c, _e, cb) => cb() });
    }) as NonNullable<SuiteDeps["openLog"]>,
    // Parent evidence runner도 shots/ 아래 unit.log를 쓰므로 DB-free mock은
    // 실제 파일 트리 대신 고정 snapshot을 사용한다. 기본 CLI에는 주입되지 않는다.
    evidenceSnapshot: () =>
      snapshots?.[snapshotIndex++] ?? { "mock/evidence.png": "fixed-sha" },
  };
}

describe("PMQA-078 suite orchestration (mock)", () => {
  test("PG18 mode keeps owned scratch on 5433 and protected snapshots on PG17 5432", async () => {
    const previous = new Map(
      ["SCRATCH_DB_TARGET", "SCRATCH_ADMIN_URL", "SCRATCH_PROTECTED_ADMIN_URL"]
        .map((k) => [k, process.env[k]] as const),
    );
    process.env.SCRATCH_DB_TARGET = "pg18";
    process.env.SCRATCH_ADMIN_URL = "postgres://commerce:commerce@localhost:5433/postgres";
    process.env.SCRATCH_PROTECTED_ADMIN_URL =
      "postgres://commerce:commerce@localhost:5432/postgres";
    try {
      const rec: Rec = { events: [], slots: [], spawns: [] };
      const r = await runIsolatedSuite(makeDeps(rec));
      assert.equal(r.ok, true, r.stage);
      assert.equal(rec.scratchTarget, "pg18");
      assert.equal(new URL(rec.scratchUrl!).port, "5433");
      assert.ok(rec.envs?.every((e) => new URL(e.DATABASE_URL!).port === "5433"));
      const protectedPorts = rec.connectUrls!
        .filter((u) => ["commerce", "commerce_test"].includes(new URL(u).pathname.slice(1)))
        .map((u) => new URL(u).port);
      assert.ok(protectedPorts.length > 0);
      assert.ok(protectedPorts.every((port) => port === "5432"));
    } finally {
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("prePG 사전조건·run-owner workdir·지문·정상 drop 순서", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const r = await runIsolatedSuite(makeDeps(rec));
    const evidenceAfter = rec.submitted?.find((s) => s.slot === "evidence-after.json");
    const evidenceDrift = evidenceAfter
      ? (JSON.parse(evidenceAfter.data) as { drift?: string[] }).drift
      : undefined;
    assert.equal(
      r.ok,
      true,
      "happy path 결과: " + JSON.stringify({ r, evidenceDrift }),
    );
    assert.equal(r.stage, "done");
    assert.equal(r.scratchState, "dropped");

    const at = (s: string) => rec.events.indexOf(s);
    // prePG: source-before·pin gate·4개 로그 예약·exec 정적 검증은 첫 PG 전.
    assert.ok(at("submit:gate-pins.json") !== -1 && at("submit:gate-pins.json") < at("connect:commerce_test"));
    assert.ok(at("submit:source-before.json") < at("connect:commerce_test"));
    for (const n of [
      "e2e.stdout.log",
      "e2e.stderr.log",
      "integration.stdout.log",
      "integration.stderr.log",
    ])
      assert.ok(
        at("log:" + n) !== -1 && at("log:" + n) < at("connect:commerce_test"),
        n,
      );
    assert.ok(at("execplan") !== -1 && at("execplan") < at("connect:commerce_test"));
    // 보호 지문 before가 owned CREATE 전이다.
    assert.ok(at("connect:commerce_test") < at("scratch.create"));
    assert.ok(at("connect:commerce") < at("scratch.create"));
    // ① workdir 예약·run-owner marker는 첫 PG connect 전이다 — 경로/파일
    // 충돌이면 connect 0·spawn 0으로 멈춘다 [requiredFix ②].
    assert.ok(at("pw.reserve") !== -1);
    assert.ok(at("pw.reserve") < at("connect:commerce_test"));
    assert.ok(at("pw.owner:" + String(rec.pwId)) !== -1);
    assert.ok(
      at("pw.owner:" + String(rec.pwId)) < at("connect:commerce_test"),
    );
    // workdir는 부모 suite runId로 잇고, child env·marker·경로가 정합이다.
    assert.ok(rec.marker, "run-owner marker 미기록");
    assert.equal(rec.marker!.runId, rec.pwId);
    assert.equal(rec.marker!.pwWorkdir, resolve(rec.pwDir!));
    // 부모 증거 경로도 marker·env에 묶인다 — 종료 result.json 거부 계약.
    assert.equal(rec.marker!.evidenceDir, resolve("run-x/"));
    const e2eEnv = rec.envs![0]!;
    assert.equal(e2eEnv.ISO_PW_WORKDIR, rec.pwDir);
    assert.equal(e2eEnv.ISO_PW_RUN_ID, rec.pwId);
    assert.equal(e2eEnv.ISO_PW_NONCE, rec.marker!.nonce);
    assert.equal(e2eEnv.ISO_EVIDENCE_DIR, resolve("run-x/"));
    // exec 계획 — 정적 형태는 PG 전, scratch dbName 바인딩은 CREATE 계획 시점.
    assert.ok(
      at("execplan") !== -1 && at("execplan") < at("connect:commerce_test"),
    );
    assert.ok(at("execplan.dbnames:" + SCRATCH_DB) !== -1);
    assert.ok(
      at("execplan.dbnames:" + SCRATCH_DB) < at("submit:scratch-created.json"),
    );
    // 순서: e2e → integration → protected-after → cleanup → broker.close
    const secondTest = rec.events.lastIndexOf("connect:commerce_test");
    assert.ok(at("spawn.integration") < secondTest);
    assert.ok(secondTest < at("scratch.cleanup"));
    assert.ok(at("scratch.cleanup") < at("broker.close"));
    // cleanup.json은 DROP 완료 선언이 아니라 의도의 pre-commit 기록이다 —
    // owned DROP 실행 전에 submit된다 [④-2].
    assert.ok(at("submit:cleanup.json") < at("scratch.cleanup"));
    // evidence slots — 지문·핀·자식·정리·결과 전부 기록됐다.
    for (const s of [
      "source-before.json",
      "gate-pins.json",
      "child-logs.json",
      "protected-before.json",
      "evidence-before.json",
      "protected-after.json",
      "source-after.json",
      "evidence-after.json",
      "e2e.json",
      "integration.json",
      "cleanup.json",
      "result.json",
    ])
      assert.ok(rec.slots.includes(s), "slot 누락: " + s);
  });

  test("e2e 자식 실패 — integration 미실행·cleanup 미실행·retained-owned", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    let n = 0;
    deps.spawnNode = (async () => {
      n++;
      return {
        code: n === 1 ? 3 : 0,
        signal: null,
        timedOut: false,
        spawnError: false,
        closed: true,
        logError: false,
      };
    }) as NonNullable<SuiteDeps["spawnNode"]>;
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "e2e");
    assert.equal(r.scratchState, "retained-owned");
    assert.equal(n, 1);
    assert.ok(!rec.events.includes("scratch.cleanup"));
  });

  test("child closed=false — 다음 suite·DROP 전 중단", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    deps.spawnNode = (async () => ({
      code: 0,
      signal: null,
      timedOut: false,
      spawnError: false,
      closed: false,
      logError: false,
    })) as NonNullable<SuiteDeps["spawnNode"]>;
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "e2e");
    assert.ok(!rec.events.includes("spawn.integration"));
    assert.ok(!rec.events.includes("scratch.cleanup"));
  });

  test("child logError — 다음 suite·DROP 전 중단", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    deps.spawnNode = (async () => ({
      code: 0,
      signal: null,
      timedOut: false,
      spawnError: false,
      closed: true,
      logError: true,
    })) as NonNullable<SuiteDeps["spawnNode"]>;
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "e2e");
    assert.ok(!rec.events.includes("spawn.integration"));
    assert.ok(!rec.events.includes("scratch.cleanup"));
  });

  test("보호 DB drift — cleanup 전 중단", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    deps.connect = mockConnect(rec, { driftAfterCalls: 2 });
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "protected-after");
    assert.ok(!rec.events.includes("scratch.cleanup"));
  });

  test("live 지문이 승인 baseline과 다름 — CREATE 자체가 나가지 않는다", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    // baseline 자체는 고정 gate가 실제 승인 파일로 검증한다 — 불일치는
    // live 스냅(mockConnect 응답) 변조로만 재현한다 [③].
    deps.connect = mockConnect(rec, { driftAfterCalls: 0 });
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "protected-before");
    assert.ok(!rec.events.includes("scratch.create"));
  });

  test("pw workdir 예약 실패 — PG connect·spawn·CREATE 전부 0이다", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    deps.reservePwWorkdir = (async () => {
      rec.events.push("pw.reserve");
      throw new Error("pw-output 경로 충돌");
    }) as NonNullable<SuiteDeps["reservePwWorkdir"]>;
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "pw-workdir-reserve");
    assert.ok(
      !rec.events.some((e) => e.startsWith("connect:")),
      "workdir 예약 실패 시 PG connect 0이어야 한다",
    );
    assert.ok(!rec.events.includes("scratch.create"));
    assert.equal(rec.spawns.length, 0);
  });

  test("env preflight 거부 — 어떤 deps도 호출하지 않는다", async () => {
    delete process.env.SCRATCH_DB_TESTS;
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const r = await runIsolatedSuite(makeDeps(rec));
    assert.equal(r.ok, false);
    assert.equal(r.stage, "preflight");
    assert.equal(rec.events.length, 0);
  });

  test("로그 finish 후 close 없음 — owned DROP 0·전체 FAIL", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    // emitClose:false — end() 후 finish는 나지만 close는 오지 않는다.
    // cleanup의 로그 마감 게이트가 bounded 대기 뒤 실패해야 한다 [④-1].
    deps.openLog = (async (_dir: string, name: string) => {
      rec.events.push("log:" + name);
      return new Writable({ write: (_c, _e, cb) => cb(), emitClose: false });
    }) as NonNullable<SuiteDeps["openLog"]>;
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "cleanup");
    assert.equal(r.scratchState, "retained-owned");
    assert.ok(!rec.events.includes("scratch.cleanup"));
    // close 게이트가 intent submit보다 먼저 — cleanup.json도 남지 않는다.
    assert.ok(!rec.slots.includes("cleanup.json"));
  });

  test("로그 close 중 오류 — owned DROP 0·전체 FAIL", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    // destroy(err)는 close와 함께 error를 남긴다 — sticky logWriteError와
    // close 게이트 어느 쪽이 먼저 잡아도 owned DROP 전에 멈춰야 한다 [④-1].
    deps.spawnNode = (async (
      args: string[],
      env: NodeJS.ProcessEnv,
      _t: number,
      logs?: { stdout: Writable; stderr: Writable },
    ) => {
      rec.spawns.push(args);
      (rec.envs ??= []).push(env);
      rec.events.push(
        args[0].includes("playwright") ? "spawn.e2e" : "spawn.integration",
      );
      if (logs) {
        logs.stderr.end();
        logs.stdout.destroy(new Error("close-fail"));
      }
      return {
        code: 0,
        signal: null,
        timedOut: false,
        spawnError: false,
        closed: true,
        logError: false,
      };
    }) as NonNullable<SuiteDeps["spawnNode"]>;
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "cleanup");
    assert.equal(r.scratchState, "retained-owned");
    assert.ok(!rec.events.includes("scratch.cleanup"));
  });

  test("cleanup intent submit 실패 — owned DROP 0", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const deps = makeDeps(rec);
    const baseReserve = deps.reserveBrokerRun!;
    deps.reserveBrokerRun = (async (
      ...a: Parameters<typeof baseReserve>
    ) => {
      const b = await baseReserve(...a);
      return {
        ...b,
        // cleanup.json은 DROP 의도의 pre-commit 기록 — 이 submit이 실패하면
        // owned DROP 자체를 실행하지 않는 계약을 재현한다 [④-2].
        submit: async (m: { slot: string; data: string }) => {
          rec.slots.push(m.slot);
          rec.events.push("submit:" + m.slot);
          if (m.slot === "cleanup.json") throw new Error("intent 기록 실패");
        },
      };
    }) as unknown as NonNullable<SuiteDeps["reserveBrokerRun"]>;
    const r = await runIsolatedSuite(deps);
    assert.equal(r.ok, false);
    assert.equal(r.stage, "cleanup");
    assert.equal(r.scratchState, "retained-owned");
    assert.ok(rec.slots.includes("cleanup.json"));
    assert.ok(!rec.events.includes("scratch.cleanup"));
  });

  test("mock evidence drift — evidence-after 실패·owned DROP 0", async () => {
    const rec: Rec = { events: [], slots: [], spawns: [] };
    const r = await runIsolatedSuite(
      makeDeps(rec, [
        { "mock/evidence.png": "before-sha" },
        { "mock/evidence.png": "after-sha" },
      ]),
    );
    const submitted = rec.submitted?.find((s) => s.slot === "evidence-after.json");
    const evidence = submitted
      ? (JSON.parse(submitted.data) as { drift?: string[] })
      : undefined;
    assert.equal(r.ok, false);
    assert.equal(r.stage, "evidence-after");
    assert.equal(r.scratchState, "retained-owned");
    assert.deepEqual(evidence?.drift, [
      "mock/evidence.png 변경 before-sha → after-sha",
    ]);
    assert.ok(!rec.events.includes("scratch.cleanup"));
  });
});

// 실제 runNode의 자식 계약을 fake EventEmitter child로 실패 주입해 검증한다 —
// mock spawnNode가 아니라 진짜 종료/로그 관측 경로다 [④].
describe("runNode 실패 주입 (real spawn 경로)", () => {
  type FakeChild = EventEmitter & {
    stdout: PassThrough | null;
    stderr: PassThrough | null;
    kill: () => boolean;
  };
  const fakeChild = (killCloses = true): FakeChild => {
    const c = new EventEmitter() as FakeChild;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = () => {
      if (killCloses) queueMicrotask(() => c.emit("close", 143, "SIGTERM"));
      return true;
    };
    return c;
  };
  const spawnOf = (c: FakeChild) => (() => c) as unknown as typeof spawn;

  test("spawnImpl throw — spawnError·미종료로 보고된다", async () => {
    const r = await runNode(
      ["x"],
      {},
      50,
      undefined,
      (() => {
        throw new Error("spawn 불가");
      }) as unknown as typeof spawn,
    );
    assert.equal(r.spawnError, true);
    assert.equal(r.closed, false);
    assert.equal(r.code, null);
    assert.equal(r.timedOut, false);
  });

  test("정상 close(0) — code·closed 보존·logError 없음", async () => {
    const c = fakeChild();
    setImmediate(() => c.emit("close", 0, null));
    const r = await runNode(["x"], {}, 5000, undefined, spawnOf(c));
    assert.equal(r.code, 0);
    assert.equal(r.closed, true);
    assert.equal(r.logError, false);
    assert.equal(r.timedOut, false);
  });

  test("timeout — kill 뒤 close면 timedOut·closed 둘 다 기록된다", async () => {
    const c = fakeChild();
    const r = await runNode(["x"], {}, 50, undefined, spawnOf(c));
    assert.equal(r.timedOut, true);
    assert.equal(r.closed, true);
  });

  test("로그 스트림 error — logError 경로로 kill·중단된다", async () => {
    const c = fakeChild();
    const logs = {
      stdout: new Writable({
        write: (_c, _e, cb) => cb(new Error("disk full")),
      }),
      stderr: new Writable({ write: (_c, _e, cb) => cb() }),
    };
    setImmediate(() => c.stdout!.write("x"));
    const r = await runNode(["x"], {}, 5000, logs, spawnOf(c));
    assert.equal(r.logError, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.closed, true);
  });
});
