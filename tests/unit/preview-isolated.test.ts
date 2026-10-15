// PMQA-079 — preview-isolated.ts의 자식 lifecycle을 DB·API·브라우저 접속 0
// 상태의 fake spawn/stream 주입으로 검증한다 [Luna 정적 MAJOR ①② 회귀].
//   A) spawn 직후 감시 등록 — writer.stream/pipe 실패 시에도 childDone 보유
//   B) 준비 판정(result.json READY/FAIL)과 자식 종료 판정(shutdown.json
//      childTerminationStatus)의 분리 — 최종 runner PASS는 shutdown 기록 +
//      writer.close 성공 + native exit 0으로만 판정된다(close 전 PASS 없음).
//   C) server.log 증거 마감은 자식 'close'(stdio drain) 이후다.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  watchChild,
  startPreviewChild,
  finalizePreviewRun,
  previewHealthMatches,
  resumePreviewContract,
  countScratchCapacity,
} from "../../scripts/preview-isolated.ts";

test("Preview resume는 기존 생성 identity를 유지하고 보호 DB와 불완전 계약을 거부한다", () => {
  const record = {
    dbName: "scratch_0123456789abcdef", oid: 70001,
    owner: 10, runId: "11111111-2222-3333-4444-555555555555",
  };
  const admin = "postgres://commerce:unit-only@127.0.0.1:5432/postgres";
  const contract = resumePreviewContract(record, admin);
  assert.equal(new URL(contract.dbUrl).pathname, "/" + record.dbName);
  assert.equal(contract.dbOid, record.oid);
  assert.equal(contract.dbOwner, record.owner);
  assert.equal(contract.runId, record.runId);
  const pg18 = resumePreviewContract(
    record,
    "postgres://commerce:unit-only@127.0.0.1:5433/postgres",
  );
  assert.equal(new URL(pg18.dbUrl).port, "5433");
  for (const dbName of ["scratch_307187680bdc451e", "scratch_cd2043674f254b82"]) {
    const restored = { ...record, dbName };
    assert.throws(
      () => resumePreviewContract(restored, "postgres://commerce:unit-only@127.0.0.1:5433/postgres"),
      /restored PG18 scratch database/,
    );
    assert.equal(resumePreviewContract(restored, admin).dbName, dbName);
  }
  assert.throws(() => resumePreviewContract({ ...record, dbName: "commerce_test" }, admin));
  assert.throws(() => resumePreviewContract({ ...record, oid: 0 }, admin));
  assert.throws(() => resumePreviewContract({ ...record, runId: "" }, admin));
});

test("Preview readiness는 HTTP 200만이 아니라 승인 DB identity 전체 일치를 요구한다", () => {
  const expected = {
    dbName: "scratch_0123456789abcdef", dbOid: 70001,
    dbOwner: 10, runId: "11111111-2222-3333-4444-555555555555",
  };
  const valid = { ok: true, db: "connected", isolated: expected };
  assert.equal(previewHealthMatches(valid, expected), true);
  for (const invalid of [null, {}, { ok: true, db: "connected" },
    { ...valid, ok: false }, { ...valid, db: "down" },
    ...Object.keys(expected).map((key) => ({
      ...valid, isolated: { ...expected, [key]: "mismatch" },
    })),
  ]) assert.equal(previewHealthMatches(invalid, expected), false);
});

test("scratch cap은 PG18 복원 scratch 두 개만 제외하고 PG17은 기존 카운트를 유지한다", () => {
  const restored = [
    "scratch_307187680bdc451e",
    "scratch_cd2043674f254b82",
  ];
  assert.equal(countScratchCapacity(restored, "pg18"), 0);
  assert.equal(countScratchCapacity([...restored, "scratch_new"], "pg18"), 1);
  assert.equal(countScratchCapacity([...restored, "scratch_new"], "pg17"), 3);
  assert.equal(
    countScratchCapacity([...restored, "scratch_new", "scratch_other"], "pg18"),
    2,
  );
});

// 최소 fake 자식 — EventEmitter에 stdout/stderr/pid/exitCode·exit()/close()
// 만 붙인다. 실제 Node처럼 exit이 close보다 먼저 오도록 순서를 분리한다.
function fakeChild(pid = 4242) {
  const ee = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    exit(c: number | null, s?: string | null): void;
    close(): void;
  };
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.pid = pid;
  ee.exitCode = null;
  ee.exit = (c: number | null, s: string | null = null) => {
    ee.exitCode = c;
    ee.emit("exit", c, s);
  };
  ee.close = () => ee.emit("close", 0, null);
  return ee as unknown as ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    exit(c: number | null, s?: string | null): void;
    close(): void;
  };
}

type WriteCall = { name: string; obj: Record<string, unknown> };
function fakeWriter(opts: {
  failWrite?: string;
  failClose?: boolean;
  throwStream?: boolean;
  assertWatchBeforeStream?: ChildProcess;
  order?: string[];
} = {}) {
  const writes: WriteCall[] = [];
  const streams: Writable[] = [];
  let streamCalls = 0;
  return {
    writes,
    streams,
    streamCalls: () => streamCalls,
    async writeJson(name: string, obj: unknown): Promise<void> {
      if (opts.failWrite === name) throw new Error("write fail " + name);
      writes.push({ name, obj: obj as Record<string, unknown> });
      opts.order?.push("writeJson:" + name);
    },
    stream(name: string): Writable {
      streamCalls++;
      // Luna ① 회귀 — stream 호출 시점에 감시가 이미 등록돼 있어야 한다.
      if (opts.assertWatchBeforeStream) {
        const c = opts.assertWatchBeforeStream as unknown as EventEmitter;
        assert.ok(
          c.listenerCount("exit") > 0 &&
            c.listenerCount("error") > 0 &&
            c.listenerCount("close") > 0,
          "stream() 호출 시점에 자식 exit/error/close 감시가 등록돼야 한다",
        );
      }
      if (opts.throwStream) throw new Error("stream fail");
      const w = new Writable({
        write(_c, _e, cb) { cb(); },
      });
      streams.push(w);
      void name;
      return w;
    },
    async close(): Promise<void> {
      opts.order?.push("close");
      if (opts.failClose) throw new Error("close fail");
    },
  };
}

const ENV = { PATH: "x" };
const okSpawn = (c: ChildProcess) => () => c;
const failSpawn = () => {
  throw new Error("spawn fail");
};

describe("preview-isolated lifecycle (DB/API/browser 0)", () => {
  test("watchChild: exit는 done에, close는 closed에 각각 기록된다", async () => {
    const c = fakeChild();
    const w = watchChild(c);
    let closedSeen = false;
    void w.closed.then(() => {
      closedSeen = true;
    });
    c.exit(0);
    assert.deepEqual(await w.done, { kind: "exit", code: 0, signal: null });
    await new Promise((r) => setImmediate(r));
    assert.equal(closedSeen, false, "exit만으로 stdio drain이 끝나지 않는다");
    c.close();
    await w.closed;
  });

  test("watchChild: error는 범주로만 기록되고 closed는 실제 close에서만 해소된다", async () => {
    const c = fakeChild();
    const w = watchChild(c);
    let closedSeen = false;
    void w.closed.then(() => {
      closedSeen = true;
    });
    c.emit("error", new Error("SQLSTATE 28P01 bad"));
    assert.deepEqual(await w.done, { kind: "error", category: "auth" });
    await new Promise((r) => setTimeout(r, 20));
    // error는 종료가 아닐 수 있다 — closed는 실제 close 전까지 미해소다.
    assert.equal(closedSeen, false);
    c.close();
    await w.closed;
    assert.equal(closedSeen, true);
  });

  test("startPreviewChild: stream 호출 전에 exit/error/close 감시가 등록된다", async () => {
    const c = fakeChild();
    const w = fakeWriter({ assertWatchBeforeStream: c });
    const r = startPreviewChild({
      spawn: okSpawn(c),
      writer: w,
      env: ENV,
    });
    assert.equal(r.pipeError, null);
    assert.equal(r.serverPid, 4242);
    c.stdout!.write("hello"); // pipe 연결 확인
    await new Promise((r2) => setImmediate(r2));
    c.exit(0);
    c.close();
    assert.equal((await r.childDone).kind, "exit");
    await r.childClosed;
  });

  test("startPreviewChild: stream 실패는 pipeError로 돌아오고 감시는 유지된다", async () => {
    const c = fakeChild();
    const w = fakeWriter({ throwStream: true });
    const r = startPreviewChild({ spawn: okSpawn(c), writer: w, env: ENV });
    assert.ok(r.pipeError instanceof Error);
    // Luna ① — pipe 단계 실패 후에도 자식 수명 관측은 살아 있다.
    c.exit(1);
    c.close();
    assert.deepEqual(await r.childDone, {
      kind: "exit",
      code: 1,
      signal: null,
    });
    await r.childClosed;
  });

  test("startPreviewChild: spawn 자체 실패는 throw다", () => {
    const w = fakeWriter();
    assert.throws(() =>
      startPreviewChild({ spawn: failSpawn, writer: w, env: ENV }),
    );
    assert.equal(w.streamCalls(), 0);
  });

  test("finalize: READY + exit 0 + close → childTerminationStatus clean, 반환 0", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const w = fakeWriter();
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
    });
    c.exit(0);
    c.close();
    assert.equal(await p, 0);
    const s = w.writes.find((x) => x.name === "shutdown.json")!;
    assert.equal(s.obj.childTerminationStatus, "clean");
    assert.equal(s.obj.readiness, "READY");
    assert.equal(s.obj.kind, "exit");
    assert.equal(s.obj.code, 0);
    assert.equal(s.obj.stdioClosed, true);
  });

  test("finalize: writer.close는 자식 'close'(stdio drain) 이후에만 호출된다", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const order: string[] = [];
    const w = fakeWriter({ order });
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
    });
    c.exit(0);
    // exit만으로 stdio drain이 안 끝났다 — 아직 close하면 안 된다.
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!order.includes("close"), "자식 close 전 writer.close 금지");
    c.close();
    assert.equal(await p, 0);
    assert.deepEqual(order, ["writeJson:shutdown.json", "close"]);
  });

  test("finalize: exit 후 close가 오지 않으면 timeout으로 abnormal → 1", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const w = fakeWriter();
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
      closeTimeoutMs: 30,
    });
    c.exit(0); // close 미발생
    assert.equal(await p, 1);
    const s = w.writes.find((x) => x.name === "shutdown.json")!;
    assert.equal(s.obj.childTerminationStatus, "abnormal");
    assert.equal(s.obj.stdioClosed, false);
  });

  test("finalize: signal 종료(code null) + close → abnormal → 1", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const w = fakeWriter();
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
    });
    c.exit(null, "SIGTERM");
    c.close();
    assert.equal(await p, 1);
    const s = w.writes.find((x) => x.name === "shutdown.json")!;
    assert.equal(s.obj.childTerminationStatus, "abnormal");
    assert.equal(s.obj.code, null);
    assert.equal(s.obj.signal, "SIGTERM");
  });

  test("finalize: 자식 error 종료 → abnormal → 1", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const w = fakeWriter();
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
    });
    c.emit("error", new Error("ECONNRESET"));
    c.close();
    assert.equal(await p, 1);
    assert.equal(
      w.writes.find((x) => x.name === "shutdown.json")!.obj
        .childTerminationStatus,
      "abnormal",
    );
  });

  test("finalize: 준비 실패 + 살아있는 자식은 close까지 기다린 뒤 FAIL", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const w = fakeWriter();
    let resolved = false;
    const p = finalizePreviewRun({
      writer: w,
      readiness: "FAIL",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
    }).then((r) => {
      resolved = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolved, false, "자식 생존 중 finalize는 완료되지 않는다");
    c.exit(0);
    c.close();
    assert.equal(await p, 1);
    const s = w.writes.find((x) => x.name === "shutdown.json")!;
    assert.equal(s.obj.readiness, "FAIL");
    // 자식 자체는 정상 종료해도 준비 실패로 runner는 FAIL이다.
    assert.equal(s.obj.childTerminationStatus, "clean");
  });

  test("finalize: shutdown 기록 실패는 sticky FAIL", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const w = fakeWriter({ failWrite: "shutdown.json" });
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
    });
    c.exit(0);
    c.close();
    assert.equal(await p, 1);
  });

  test("finalize: writer close 실패는 sticky FAIL — close 전 PASS 파일 없음", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const order: string[] = [];
    const w = fakeWriter({ failClose: true, order });
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: true,
    });
    c.exit(0);
    c.close();
    assert.equal(await p, 1);
    const s = w.writes.find((x) => x.name === "shutdown.json")!;
    // shutdown.json에 남는 것은 자식 종료 판정뿐 — 최종 runner PASS 아님.
    assert.equal(s.obj.childTerminationStatus, "clean");
    assert.ok(!("finalStatus" in s.obj), "finalStatus 필드는 존재하지 않는다");
    assert.equal(s.obj.note !== undefined, true);
    assert.deepEqual(order, ["writeJson:shutdown.json", "close"]);
  });

  test("finalize: result.json 기록 실패(resultOk=false)는 runner를 FAIL로 한다", async () => {
    const c = fakeChild();
    const w2 = watchChild(c);
    const w = fakeWriter();
    const p = finalizePreviewRun({
      writer: w,
      readiness: "READY",
      child: c,
      childDone: w2.done,
      childClosed: w2.closed,
      serverPid: 4242,
      resultOk: false,
    });
    c.exit(0);
    c.close();
    assert.equal(await p, 1);
  });

  test("finalize: 자식 없음(childDone null) → no-running-child + 1", async () => {
    const w = fakeWriter();
    const code = await finalizePreviewRun({
      writer: w,
      readiness: "FAIL",
      child: null,
      childDone: null,
      childClosed: null,
      serverPid: null,
      resultOk: true,
    });
    assert.equal(code, 1);
    const s = w.writes.find((x) => x.name === "shutdown.json")!;
    assert.equal(s.obj.state, "no-running-child");
    assert.equal(s.obj.childTerminationStatus, "abnormal");
  });

  test("finalize: child는 있는데 childDone 누락 → child-outcome-missing + 1", async () => {
    const c = fakeChild();
    const w = fakeWriter();
    const code = await finalizePreviewRun({
      writer: w,
      readiness: "FAIL",
      child: c,
      childDone: null,
      childClosed: null,
      serverPid: 4242,
      resultOk: true,
    });
    assert.equal(code, 1);
    assert.equal(
      w.writes.find((x) => x.name === "shutdown.json")!.obj.state,
      "child-outcome-missing",
    );
  });
});
