import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import {
  assertNoPwOverrides,
  assertPwIsolation,
  createWorkerClient,
  EvidenceBroker,
  reserveBrokerRun,
  reservePwWorkdir,
  type BrokerMessage,
} from "../helpers/evidence-broker.ts";
import { orchestrate } from "../helpers/orchestrate-055.ts";
import {
  assertEntryRunnable,
  entryDisposition,
  assertExecPlan,
} from "../helpers/pw-config-gate.ts";
import {
  claimEvidenceFiles,
  ClaimWriter,
} from "../helpers/capture-output.ts";

const sha256 = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
const SLOTS = ["p-001.png", "facts.json", "README.md"] as const;
const PINS: readonly string[] = [];

// ── run/slot 예약 충돌 (실FS, mock throw 아님) ──────────────────────────

test("broker: run dir collision — reserve 거부, 후속 호출 0", async () => {
  const temp = mkdtempSync(join(tmpdir(), "broker-coll-"));
  try {
    mkdirSync(join(temp, "run-fixed"));
    let sent = 0;
    await assert.rejects(
      reserveBrokerRun(temp, SLOTS, "fixed"),
      /EEXIST|exists/i,
    );
    const w = createWorkerClient({ nonce: "x", send: () => sent++ });
    assert.equal(sent, 0); // broker 없이 어떤 메시지도 보내지 않는다
    void w;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

for (const slot of SLOTS) {
  test(
    "broker: slot 파일 충돌 " + slot + " — sentinel SHA 불변·claim 보존",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "broker-file-coll-"));
      try {
        const dir = join(temp, "run-c");
        mkdirSync(dir, { recursive: true });
        const sentinel = Buffer.from("prior-" + slot);
        writeFileSync(join(dir, slot), sentinel);
        const before = sha256(sentinel);
        // run dir은 외부에서 미리 만들고 claimEvidenceFiles를 직접 연결 —
        // claim 실패가 consumer에 도달하지 않음을 실FS로 검증한다.
        await assert.rejects(claimEvidenceFiles(dir, SLOTS));
        assert.equal(sha256(readFileSync(join(dir, slot))), before);
        const idx = SLOTS.indexOf(slot);
        for (let i = 0; i < idx; i++) {
          const p = join(dir, SLOTS[i]);
          assert.ok(existsSync(p), SLOTS[i] + " claim retained");
          assert.equal(statSync(p).size, 0);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
}

// ── 메시지 검증 ────────────────────────────────────────────────────────

async function freshBroker(temp: string) {
  return reserveBrokerRun(temp, [...SLOTS]);
}

test("broker submit: utf8·base64 정상 write → bytes 확인 후 close", async () => {
  const temp = mkdtempSync(join(tmpdir(), "broker-ok-"));
  try {
    const b = await freshBroker(temp);
    const msgs: BrokerMessage[] = [];
    const worker = createWorkerClient({
      nonce: b.nonce,
      send: (m) => msgs.push(m),
    });
    worker.submit("facts.json", '{"ok":true}');
    worker.submit("p-001.png", Buffer.from([1, 2, 3, 250]));
    worker.submit("README.md", "done"); // manifest는 전체 slot 기록이 필요
    for (const m of msgs) await b.submit(m);
    await b.close();
    assert.equal(
      readFileSync(join(b.dir, "facts.json"), "utf8"),
      '{"ok":true}',
    );
    assert.deepEqual(
      [...readFileSync(join(b.dir, "p-001.png"))],
      [1, 2, 3, 250],
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("broker submit: nonce 불일치·미claim slot·중복·malformed 전부 거부", async () => {
  const temp = mkdtempSync(join(tmpdir(), "broker-rej-"));
  try {
    const b = await freshBroker(temp);
    await assert.rejects(
      b.submit({ nonce: "wrong", slot: "facts.json", data: "x" }),
      /nonce/,
    );
    await assert.rejects(
      b.submit({ nonce: b.nonce, slot: "nope.txt", data: "x" }),
      /unclaimed/,
    );
    await assert.rejects(
      b.submit({ nonce: b.nonce, slot: "../evil", data: "x" }),
    );
    await assert.rejects(
      b.submit({ nonce: b.nonce, slot: "facts.json", data: 1 } as never),
    );
    await b.submit({ nonce: b.nonce, slot: "facts.json", data: "ok" });
    await assert.rejects(
      b.submit({ nonce: b.nonce, slot: "facts.json", data: "dup" }),
      /already written/,
    );
    assert.equal(
      readFileSync(join(b.dir, "facts.json"), "utf8"),
      "ok",
    );
    // 거부된 submit은 sticky — close도 실패로 전파된다 [Luna QA].
    await assert.rejects(b.close(), /nonce|already written/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("broker: 동일 slot 동시 submit — 정확히 1승 1패, 기존 bytes 불변", async () => {
  const temp = mkdtempSync(join(tmpdir(), "broker-race-"));
  try {
    const b = await freshBroker(temp);
    const m = (d: string): BrokerMessage => ({
      nonce: b.nonce,
      slot: "facts.json",
      data: d,
    });
    const [r1, r2] = await Promise.allSettled([
      b.submit(m("A")),
      b.submit(m("B")),
    ]);
    const ok = [r1, r2].filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 1);
    await assert.rejects(b.close()); // 패자 reject가 run을 FAIL로 고정
    const out = readFileSync(join(b.dir, "facts.json"), "utf8");
    assert.ok(out === "A" || out === "B");
    assert.equal(out.length, 1); // 두 번 쓰기/append 없음
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("broker abort: 이후 submit 거부 + close는 실패로 전파 — 조용한 PASS 없음", async () => {
  const temp = mkdtempSync(join(tmpdir(), "broker-abort-"));
  try {
    const b = await freshBroker(temp);
    await b.submit({ nonce: b.nonce, slot: "facts.json", data: "x" });
    b.abort("worker died mid-flight");
    await assert.rejects(
      b.submit({ nonce: b.nonce, slot: "README.md", data: "y" }),
      /aborted/,
    );
    await assert.rejects(b.close(), /worker died/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("worker client: slot 이름만 전달 — malformed 이름은 송신 전 거부", () => {
  const sent: BrokerMessage[] = [];
  const w = createWorkerClient({ nonce: "n", send: (m) => sent.push(m) });
  assert.throws(() => w.submit("../escape", "x"));
  assert.throws(() => w.submit("a/b.png", "x"));
  assert.equal(sent.length, 0);
});

// ── PW workdir 격리 ────────────────────────────────────────────────────

test("pw workdir: 독점 신규 dir + evidence 경로 중첩·symlink 거부", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pwdir-"));
  try {
    const w = await reservePwWorkdir(join(temp, "work"));
    const ev = join(temp, "evidence");
    mkdirSync(ev, { recursive: true });
    assertPwIsolation({ workDir: w, evidenceDirs: [ev] }); // 통과
    // 중첩 — evidence 안쪽 workdir는 거부
    const nested = join(ev, "pw");
    mkdirSync(nested, { recursive: true });
    assert.throws(() =>
      assertPwIsolation({ workDir: nested, evidenceDirs: [ev] }),
    );
    // 기존 dir 재사용은 exclusive 예약이 거부한다
    mkdirSync(join(temp, "work2", "run-pw-fixed"), { recursive: true });
    await assert.rejects(
      reservePwWorkdir(join(temp, "work2"), "fixed"),
      /EEXIST|exists/i,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("pw workdir: 실제 junction/symlink 경로는 realpath 불일치로 거부", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pwdir-junction-"));
  try {
    const target = join(temp, "target");
    const link = join(temp, "link");
    mkdirSync(target, { recursive: true });
    try {
      // junction은 Windows에서 관리자 권한 없이 생성 가능한 경우가 많다.
      const { symlinkSync } = await import("node:fs");
      symlinkSync(target, link, "junction");
    } catch (e) {
      // 실제 오류 원인을 기록한다 — 알려진 환경 제약(권한/미지원 FS)만
      // skip하고, 그 외 오류는 검증 공백을 숨기지 않도록 FAIL [PM QA 056].
      const err = e as NodeJS.ErrnoException;
      const code = err?.code ?? "(no code)";
      t.diagnostic(
        "junction 생성 실패: code=" +
          code +
          " message=" +
          (err?.message ?? String(e)),
      );
      const ENV_CONSTRAINT = new Set([
        "EPERM",
        "EACCES",
        "ENOTSUP",
        "EOPNOTSUPP",
      ]);
      if (!ENV_CONSTRAINT.has(code)) throw e;
      t.skip("환경 제약으로 junction 생성 불가: " + code);
      return;
    }
    assert.throws(
      () => assertPwIsolation({ workDir: link }),
      /symlink|junction|alias/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("pw workdir: canonical 보호 루트(shots 등)와 중첩 시 대소문자 무관 거부", () => {
  const temp = mkdtempSync(join(tmpdir(), "pwdir-prot-"));
  try {
    const ev = join(temp, "ShOtS"); // Windows case-insensitive 혼합
    mkdirSync(ev, { recursive: true });
    const inside = join(ev, "run-pw-x");
    mkdirSync(inside, { recursive: true });
    assert.throws(
      () =>
        assertPwIsolation({
          workDir: inside,
          protectedRoots: [join(temp, "shots")],
        }),
      /중첩/,
    );
    // disjoint 경로는 통과
    const ok = join(temp, "pwwork", "run-pw-y");
    mkdirSync(ok, { recursive: true });
    assertPwIsolation({
      workDir: ok,
      protectedRoots: [join(temp, "shots")],
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("pw override: PLAYWRIGHT_*·OUTPUT_NAME·혼합 case env·CLI 직접실행 차단", () => {
  assert.throws(() =>
    assertNoPwOverrides({
      env: { Playwright_Json_Output_Name: "x" },
      argv: [],
    }),
  );
  assert.throws(() =>
    assertNoPwOverrides({ env: { OUTPUT_NAME: "x" }, argv: [] }),
  );
  assert.throws(() =>
    assertNoPwOverrides({
      env: {},
      argv: ["n", "cli.js", "--reporter=json"],
    }),
  );
  assert.throws(() =>
    assertNoPwOverrides({
      env: {},
      argv: ["n", "cli.js", "--output=./ev"],
    }),
  );
  assert.doesNotThrow(() =>
    assertNoPwOverrides({
      env: { PATH: "p" },
      argv: ["n", "cli.js", "--version"],
      allowedConfig: "playwright.readonly.config.ts",
    }),
  );
});

// ── 설정 평가 gate ─────────────────────────────────────────────────────

test("entry gate: protected 통과·not-ready/blocked 사전 거부", () => {
  assert.equal(
    entryDisposition("scripts/pmqa054-evidence-run.ts"),
    "protected",
  );
  assert.doesNotThrow(() =>
    assertEntryRunnable("scripts/pmqa054-evidence-run.ts"),
  );
  // PMQA-056 — parent broker 통합으로 protected 전환된 readonly 삼중주.
  for (const e of [
    "playwright.readonly.config.ts",
    "tests/e2e/readonly-orders.spec.ts",
    "tests/e2e/readonly-audit.ts",
    "playwright.isolated.config.ts",
    "scripts/isolated-suite.ts",
  ]) {
    assert.equal(entryDisposition(e), "protected", e);
    assert.doesNotThrow(() => assertEntryRunnable(e), e);
  }
  for (const e of [
    "playwright.config.ts",
    "playwright.capture.config.ts",
    "tests/e2e/zz-pmqa040-capture.spec.ts",
    "scripts/verify.ts",
    "scripts/shoot-themes.mjs",
    "scripts/isolated-smoke.ts",
  ]) {
    assert.equal(entryDisposition(e), "not-ready", e);
    assert.throws(() => assertEntryRunnable(e), /not-ready/);
  }
  assert.equal(entryDisposition("unknown-tool.ts"), "blocked");
  assert.throws(() => assertEntryRunnable("unknown-tool.ts"), /blocked/);
});

// 선언만이 아니라 실제 엔트리 파일에 사전 거부 호출이 연결됐는지 확인한다.
test("entry wiring: 실제 진입부 파일에 assertEntryRunnable 호출 존재", () => {
  for (const f of [
    "playwright.config.ts",
    "playwright.capture.config.ts",
    "playwright.readonly.config.ts",
    "playwright.isolated.config.ts",
    "scripts/isolated-suite.ts",
    "scripts/verify.ts",
    "scripts/shoot-themes.mjs",
  ]) {
    const src = readFileSync(f, "utf8");
    assert.ok(
      src.includes('assertEntryRunnable("' + f + '")'),
      f + " 에 게이트 호출 없음",
    );
  }
});

// ── orchestration — MockSpy만, 실제 DB/PW/IPC 없음 ─────────────────────

function spyDeps(over: Partial<Parameters<typeof orchestrate>[0]> = {}) {
  const calls: string[] = [];
  const mk = (n: string) => async () => {
    calls.push(n);
    return n === "workdir" ? "/work" : undefined;
  };
  const broker = new EvidenceBroker({
    dir: "/fake",
    writer: {
      dir: "/fake",
      write: async () => {},
      writeJson: async () => {},
      stream: () => {
        throw new Error("unused");
      },
      seal: async () => {},
      close: async () => {},
    },
    slots: [], // fake manifest — completeness는 IPC 테스트에서 검증
    nonce: "n",
  });
  return {
    calls,
    deps: {
      reserve: over.reserve ?? (async () => broker),
      prepareWorkdir: over.prepareWorkdir ?? mk("workdir"),
      prepareIpc: over.prepareIpc ?? mk("ipc"),
      connectDb: over.connectDb ?? mk("db"),
      startChild: over.startChild ?? mk("child"),
      startPwServer: over.startPwServer ?? mk("pw"),
    } as Parameters<typeof orchestrate>[0],
    broker,
  };
}

test("orchestrate: 정상 — stage 순서 reserved→workdir→ipc→db→child→pw", async () => {
  const { deps } = spyDeps();
  const r = await orchestrate(deps);
  assert.deepEqual(r.stages, [
    "reserved",
    "workdir",
    "ipc",
    "db",
    "child",
    "pw-server",
  ]);
});

test("orchestrate: reserve 실패 — connectDb/startChild/PW 0회", async () => {
  const { calls, deps } = spyDeps({
    reserve: async () => {
      throw new Error("claim collision");
    },
  });
  await assert.rejects(orchestrate(deps), /collision/);
  assert.deepEqual(calls, []); // 어떤 후속 단계도 호출되지 않았다
});

test("orchestrate: IPC 준비 실패 — connectDb/startChild 0회", async () => {
  const { calls, deps } = spyDeps({
    prepareIpc: async () => {
      throw new Error("ipc not ready");
    },
  });
  await assert.rejects(orchestrate(deps), /ipc/);
  assert.deepEqual(calls, ["workdir"]); // db/child/pw 미호출
});

test("orchestrate: broker close 실패는 결과를 PASS로 바꾸지 않고 전파", async () => {
  const { deps, broker } = spyDeps();
  (broker as unknown as { writer: { close: () => Promise<void> } })[
    "writer"
  ].close = async () => {
    throw new Error("close fail");
  };
  await assert.rejects(orchestrate(deps), /close fail/);
});

// ── 기존 guard 보존 ────────────────────────────────────────────────────

// ── 실제 로컬 IPC (child_process.fork) — mock이 아닌 진짜 채널 ─────────

import { fork } from "node:child_process";
import { once } from "node:events";
import { attachIpcParent } from "../helpers/evidence-broker.ts";

const IPC_CHILD = "tests/helpers/ipc-worker-055.mjs";

function runWorker(
  b: EvidenceBroker,
  nonce: string,
  payloads: { slot: string; data: string }[],
) {
  const child = fork(IPC_CHILD, [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const h = attachIpcParent(b, child);
  child.send({ type: "init", nonce, payloads });
  return { child, h };
}

test("ipc 실채널: worker submit → parent broker → 파일 기록·close 성공", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ipc-ok-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt", "b.txt"]);
    const { child, h } = runWorker(b, b.nonce, [
      { slot: "a.txt", data: "via-ipc-A" },
      { slot: "b.txt", data: "via-ipc-B" },
    ]);
    await once(child, "exit");
    await Promise.all(h.pending);
    await b.close();
    assert.equal(readFileSync(join(b.dir, "a.txt"), "utf8"), "via-ipc-A");
    assert.equal(readFileSync(join(b.dir, "b.txt"), "utf8"), "via-ipc-B");
    assert.equal(h.errors.length, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("ipc 실채널: 잘못된 nonce는 거부 — close 실패 + 파일 0바이트 유지", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ipc-badnonce-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt"]);
    const { child, h } = runWorker(b, "forged-nonce", [
      { slot: "a.txt", data: "evil" },
    ]);
    await once(child, "exit");
    await Promise.all(h.pending);
    assert.ok(h.errors.length > 0);
    await assert.rejects(b.close(), /nonce/);
    assert.equal(statSync(join(b.dir, "a.txt")).size, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("ipc 실채널: duplicate slot은 1건만 기록 — 두 번째 거부 + close FAIL", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ipc-dup-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt"]);
    const { child, h } = runWorker(b, b.nonce, [
      { slot: "a.txt", data: "first" },
      { slot: "a.txt", data: "second" },
    ]);
    await once(child, "exit");
    await Promise.all(h.pending);
    await assert.rejects(b.close(), /already written|manifest/);
    assert.equal(readFileSync(join(b.dir, "a.txt"), "utf8"), "first");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("ipc 실채널: incomplete manifest — worker 조기 종료는 close FAIL", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ipc-incomplete-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt", "b.txt"]);
    const { child, h } = runWorker(b, b.nonce, [
      { slot: "a.txt", data: "only-one" },
    ]);
    await once(child, "exit");
    await Promise.all(h.pending);
    // b.txt 미기록 — 절반만 쓴 run을 완료로 보지 않는다.
    await assert.rejects(b.close(), /manifest slot unwritten: b.txt/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// close drain이 진행되는 동안 발생한 duplicate/abort도 최초 close를
// 실패시켜야 한다 — drain 후 실패 상태를 다시 읽는다 [Luna QA].
test(
  "broker: close drain 중 duplicate/abort — 지연 write 후 close FAIL",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "close-race-"));
    let release: (() => void) | undefined;
    try {
      const claims = new Map([
        [
          "a.txt",
          {
            name: "a.txt",
            path: join(temp, "a.txt"),
            fh: {
              // 지연 write — release까지 close drain이 완료되지 않는다.
              write: async (buf: Uint8Array, _o: number, len: number) => {
                await new Promise<void>((r) => {
                  release = r;
                });
                return { bytesWritten: len, buffer: buf };
              },
              close: async () => {},
            } as never,
            pos: 0,
            written: false,
            fhOpen: true,
          },
        ],
      ]);
      const writer = new ClaimWriter(temp + sep, claims as never);
      const b = new EvidenceBroker({
        dir: temp + sep,
        writer,
        slots: ["a.txt"],
        nonce: "n",
      });
      const w1 = b.submit({ nonce: "n", slot: "a.txt", data: "slow" });
      const closing = b.close(); // 지연 write 대기 — drain 미완료 구간
      // close 진행 중 duplicate — sticky fail이 close 결과에 반영돼야 한다.
      await assert.rejects(
        b.submit({ nonce: "n", slot: "a.txt", data: "dup" }),
      );
      release!();
      await w1;
      await assert.rejects(closing, /closed|already|manifest/);
    } finally {
      release?.();
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test("preserved: readonly-guard.ts 해시 불변 — 기존 보호 미약화", () => {
  // PMQA-056 수용기준 ② — pwWorkdir 바인딩 추가로 의도적 변경됨.
  // 이전 pin 74ffbc7bf96a7621 → 3542a1467a7032a2 → eceef7473c89f666 →
  // 현재 b0263df935c0bbc3 (worker mode 옵션 + workdir 신선도/격리 검증
  // 추가분까지 허가된 변경) [PM QA-056 M1/M2].
  assert.equal(
    sha256(readFileSync("tests/e2e/readonly-guard.ts")).slice(0, 16),
    "b0263df935c0bbc3",
  );
});
void PINS;

// ── PMQA-056 — 실제 loopback 채널 / lifecycle / exec plan ────────────

import {
  connect as netConnect,
  createServer as netCreateServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { EventEmitter } from "node:events";
import {
  connectWorkerClient,
  startBrokerChannel,
} from "../helpers/ipc-channel.ts";
import {
  AUDIT_SLOTS,
  CAPTURE_SLOTS,
  planReadonlyRun,
} from "../helpers/readonly-broker.ts";

// fixture가 accept한 socket을 추적한다 — srv.close()는 열린 peer가 끝날
// 때까지 영구 대기하므로, 테스트가 생성한 socket은 finally에서 전부
// destroy한다 [PM QA-056 — 실제 hang 진단 확인].
function trackedAcceptor(handler?: (s: Socket) => void) {
  const socks = new Set<Socket>();
  const srv = netCreateServer((s) => {
    socks.add(s);
    s.on("close", () => socks.delete(s));
    handler?.(s);
  });
  const closeAll = async () => {
    for (const s of socks) s.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  };
  return { srv, closeAll };
}

// 소켓에서 개행 1줄 ACK를 읽는다.
function readAckLine(sock: Socket): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      sock.off("data", onData);
      sock.off("error", rej);
      try {
        res(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      } catch (e) {
        rej(e);
      }
    };
    sock.on("data", onData);
    sock.once("error", rej);
  });
}

test("channel 실채널: submit → 부모 broker 기록·close 성공", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ch-ok-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt", "b.bin"]);
    const ch = await startBrokerChannel(b);
    const w = await connectWorkerClient({ nonce: b.nonce, port: ch.port });
    await w.submit("a.txt", "hello");
    await w.submit("b.bin", Buffer.from([9, 8]));
    await w.close();
    await ch.close();
    await b.close();
    assert.equal(readFileSync(join(b.dir, "a.txt"), "utf8"), "hello");
    assert.deepEqual([...readFileSync(join(b.dir, "b.bin"))], [9, 8]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test(
  "channel: bad nonce — worker submit reject + channel/broker close FAIL",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "ch-nonce-"));
    try {
      const b = await reserveBrokerRun(temp, ["a.txt"]);
      const ch = await startBrokerChannel(b);
      const w = await connectWorkerClient({
        nonce: "forged",
        port: ch.port,
      });
      await assert.rejects(w.submit("a.txt", "x"), /nonce/);
      await w.close();
      // 채널에 오류가 쌓였으면 close도 성공을 반환하지 않는다 [PM QA 056].
      await assert.rejects(ch.close());
      await assert.rejects(b.close(), /nonce/);
      assert.equal(statSync(join(b.dir, "a.txt")).size, 0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "channel: malformed frame — broker에 도달 못한 전송 오류도 run FAIL",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "ch-mal-"));
    try {
      const b = await reserveBrokerRun(temp, ["a.txt"]);
      const ch = await startBrokerChannel(b);
      const raw = netConnect(ch.port, "127.0.0.1");
      await once(raw, "connect");
      raw.write("not-json-at-all\n");
      const ack = await readAckLine(raw);
      assert.equal(ack.ok, false);
      raw.end();
      await assert.rejects(ch.close());
      // 전송 수준 오류는 abort로 전파 — all-slots-written와 무관하게 FAIL.
      await assert.rejects(b.close(), /channel|malformed|abort/i);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test("channel: oversize frame — 소켓 파괴 + abort → close FAIL", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ch-over-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt"]);
    const ch = await startBrokerChannel(b, { maxLineBytes: 64 });
    const raw = netConnect(ch.port, "127.0.0.1");
    await once(raw, "connect");
    raw.write("x".repeat(200)); // 개행 없음 — 누적이 한도 초과
    await once(raw, "close"); // 서버가 파괴한다
    await assert.rejects(ch.close());
    await assert.rejects(b.close(), /oversize|abort/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("channel client: connect 실패 — error 표면화, hang 없음", async () => {
  const srv = netCreateServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  await assert.rejects(connectWorkerClient({ nonce: "n", port }));
});

test(
  "channel client: malformed ACK — 무시 금지, submit reject + 이후도 즉시 reject",
  async () => {
    const { srv, closeAll } = trackedAcceptor((s) => {
      s.on("data", () => s.write("garbage-not-json\n"));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const w = await connectWorkerClient({ nonce: "n", port });
      await assert.rejects(w.submit("a.txt", "x"), /malformed/);
      await assert.rejects(w.submit("a.txt", "y"), /malformed/);
      await w.close();
    } finally {
      await closeAll();
    }
  },
);

test("channel client: submit after close — 즉시 reject", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ch-after-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt"]);
    const ch = await startBrokerChannel(b);
    const w = await connectWorkerClient({ nonce: b.nonce, port: ch.port });
    await w.close();
    await assert.rejects(w.submit("a.txt", "x"), /closed/);
    await ch.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test(
  "channel client: 서버 연결 파괴 — pending submit reject (무한 wait 없음)",
  async () => {
    const { srv, closeAll } = trackedAcceptor((s) => {
      s.on("data", () => s.destroy());
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const w = await connectWorkerClient({ nonce: "n", port });
      await assert.rejects(w.submit("a.txt", "x"), /closed|channel|error/i);
      await w.close();
    } finally {
      await closeAll();
    }
  },
);

test("channel client: ACK timeout — 응답 없는 서버에서 reject", async () => {
  const { srv, closeAll } = trackedAcceptor(); // accept만, 읽지도 쓰지도 않음
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const w = await connectWorkerClient({
      nonce: "n",
      port,
      ackTimeoutMs: 100,
    });
    await assert.rejects(w.submit("a.txt", "x"), /ack timeout/);
    await w.close();
  } finally {
    await closeAll();
  }
});

// ── worker lifecycle (fake EventEmitter child — 실제 spawn 아님) ──────

test(
  "lifecycle: disconnect→exit 0 정상 Node 순서 — abort 없이 PASS",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "lc-ok-"));
    try {
      const b = await reserveBrokerRun(temp, ["a.txt"]);
      const fake = new EventEmitter();
      const h = attachIpcParent(b, fake as never);
      fake.emit("disconnect"); // 정상 Node: disconnect가 exit보다 먼저 온다
      fake.emit("exit", 0, null);
      const ex = await h.exited;
      assert.equal(ex.code, 0);
      await b.submit({ nonce: b.nonce, slot: "a.txt", data: "x" });
      await b.close(); // abort가 걸리지 않았다 — 정상 종료
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "lifecycle: spawnfail(error만, exit 없음) — exited 해소 + 상위 FAIL",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "lc-err-"));
    try {
      const b = await reserveBrokerRun(temp, ["a.txt"]);
      const fake = new EventEmitter();
      const h = attachIpcParent(b, fake as never);
      fake.emit("error", new Error("spawn ENOENT"));
      const ex = await h.exited; // exit 없이도 해소 — hang 없음
      assert.equal(ex.code, null);
      await assert.rejects(b.close(), /worker error/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test("lifecycle: 실제 child kill — signal 비정상 종료 → close FAIL", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lc-kill-"));
  try {
    const b = await reserveBrokerRun(temp, ["a.txt"]);
    const child = fork(IPC_CHILD, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const h = attachIpcParent(b, child);
    child.send({ type: "init", hold: true });
    child.kill(); // signal 종료 — 정상 exit 0이 아니다
    const ex = await h.exited;
    assert.notEqual(ex.code, 0);
    await assert.rejects(b.close(), /exit|signal|manifest|abort/i);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// ── 조건부 manifest — 선택된 종료 경로만 완성 검사 [Luna QA] ──────────

test(
  "broker manifest: oneOf 조건부 slot — 선택 경로 완료 시 미기록 sibling OK",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "oneof-"));
    try {
      const slots = ["a.json", "b.json", "c.json"];
      const b = await reserveBrokerRun(temp, slots, undefined, {
        required: ["a.json"],
        oneOf: [["b.json", "c.json"]],
      });
      await b.submit({ nonce: b.nonce, slot: "a.json", data: "1" });
      await b.submit({ nonce: b.nonce, slot: "b.json", data: "2" });
      // c.json 미기록 — oneOf는 b로 충족 → close 성공
      await b.close();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "broker manifest: oneOf 전원 미기록 — 종료 경로 없으므로 close FAIL",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "oneof-fail-"));
    try {
      const slots = ["a.json", "b.json", "c.json"];
      const b = await reserveBrokerRun(temp, slots, undefined, {
        required: ["a.json"],
        oneOf: [["b.json", "c.json"]],
      });
      await b.submit({ nonce: b.nonce, slot: "a.json", data: "1" });
      await assert.rejects(b.close(), /oneOf/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

// ── readonly plan — 부모 전체 claim + 라우팅 + 선택 종료 경로 ─────────

test(
  "readonly plan: 전체 slot claim — audit 루트·captures 하위 라우팅·workdir",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "roplan-"));
    const root = join(temp, "06b");
    const workRoot = join(temp, "pw-output");
    const plan = await planReadonlyRun(undefined, root, workRoot);
    try {
      // run UUID ↔ 경로 정합 [PM 056 ①].
      assert.equal(basename(plan.dir), plan.runId);
      // PW workdir는 evidence 영역 밖 unique dir — run-pw-<runId> [②].
      assert.equal(basename(plan.workDir), "run-pw-" + plan.runId);
      assert.ok(existsSync(plan.workDir));
      for (const s of AUDIT_SLOTS) {
        const p = join(plan.dir, s);
        assert.ok(existsSync(p), s + " claim 부재");
        assert.equal(statSync(p).size, 0);
      }
      for (const s of CAPTURE_SLOTS) {
        const p = join(plan.dir, "captures", s);
        assert.ok(existsSync(p), "captures/" + s + " claim 부재");
        assert.equal(statSync(p).size, 0);
      }
      // audit slot → 루트에 기록
      await plan.broker.submit({
        nonce: plan.nonce,
        slot: "audit-before.json",
        data: "{}",
      });
      // capture 전체 기록 — run-owner implies 요구 조건 충족용.
      for (const s of CAPTURE_SLOTS)
        await plan.broker.submit({
          nonce: plan.nonce,
          slot: s,
          data: s.endsWith(".png") ? "PNG" : "x",
        });
      await plan.broker.submit({
        nonce: plan.nonce,
        slot: "run-owner.json",
        data: '{"runId":"x"}',
      });
      assert.equal(
        readFileSync(join(plan.dir, "run-owner.json"), "utf8"),
        '{"runId":"x"}',
      );
      // capture slot → captures/에 기록됐다.
      assert.equal(
        readFileSync(join(plan.dir, "captures", "capture-notes.md"), "utf8"),
        "x",
      );
      // 종료 경로 선택 — audit-after로 oneOf 충족 → close 성공
      await plan.broker.submit({
        nonce: plan.nonce,
        slot: "audit-after.json",
        data: "{}",
      });
      await plan.channel.close();
      await plan.broker.close();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "readonly plan: spawn 후 필수 캡처 미기록 — exit 0 형태라도 close FAIL",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "roplan-fail-"));
    const plan = await planReadonlyRun(
      undefined,
      join(temp, "06b"),
      join(temp, "pw-output"),
    );
    try {
      await plan.broker.submit({
        nonce: plan.nonce,
        slot: "audit-before.json",
        data: "{}",
      });
      await plan.broker.submit({
        nonce: plan.nonce,
        slot: "run-owner.json",
        data: "{}",
      });
      // spawn 경로가 시작됐는데 captures·after/fail 미기록 — implies+oneOf
      // 모두 실패다 (정상 exit 0 형태로 PASS 불가) [PM 수용기준].
      await assert.rejects(plan.broker.close(), /oneOf|implied/);
      await plan.channel.close();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

// ── strict exec plan [승인 범위 ③] ─────────────────────────────────────

test("exec plan: 허용 형태 통과 + unknown/bare/conflict/bad-db/out 거부", () => {
  const good = {
    entry: "playwright.readonly.config.ts",
    argv: ["test", "-c", "playwright.readonly.config.ts"],
    dbNames: ["commerce_test", "commerce"],
    // output은 부모 예약 envelope의 고정 하위 child 형태만 허용 [057-1].
    outputDir: join(
      "pw-output",
      "run-pw-01234567-89ab-cdef-0123-456789abcdef",
      "playwright",
    ),
  };
  assert.doesNotThrow(() => assertExecPlan(good));
  assert.throws(
    () => assertExecPlan({ ...good, entry: "playwright.config.ts" }),
    /not-ready/,
  );
  assert.throws(() =>
    assertExecPlan({
      ...good,
      argv: ["test", "--reporter=json", "-c", good.entry],
    }),
  );
  assert.throws(() =>
    assertExecPlan({ ...good, argv: ["test", "-c", "playwright.config.ts"] }),
  );
  assert.throws(() => assertExecPlan({ ...good, argv: ["test"] }));
  assert.throws(() => assertExecPlan({ ...good, argv: ["-c", good.entry] }));
  assert.throws(() =>
    assertExecPlan({ ...good, dbNames: ["commerce_demo_verify"] }),
  );
  assert.throws(() =>
    assertExecPlan({
      ...good,
      entry: "playwright.readonly.config.ts",
      argv: ["test", "-c", "playwright.readonly.config.ts"],
      dbNames: ["scratch_0123456789abcdef"],
    }),
    /허용 외/,
  );
  assert.doesNotThrow(() =>
    assertExecPlan({
      ...good,
      entry: "playwright.isolated.config.ts",
      argv: ["test", "-c", "playwright.isolated.config.ts"],
      dbNames: ["scratch_0123456789abcdef"],
    }),
  );
  // evidence 영역·임의 경로 output은 거부 — pw-output/pw-*만 통과.
  assert.throws(() =>
    assertExecPlan({ ...good, outputDir: join("shots", "06b", "x") }),
  );
  assert.throws(() =>
    assertExecPlan({ ...good, outputDir: join("pw-output", "notrunpw") }),
  );
});

// PMQA-057-1 — 실제 PW outputDir은 부모 예약 envelope의 고정 하위
// "playwright" child다 — runner의 outputDir cleanup은 child만 삭제하고
// envelope(run-pw-*)는 부모 예약 그대로 생존한다. envelope 자체를 선언하는
// 구형 계약은 cleanup이 부모 예약을 지워 webServer startup이 죽었다.
test("exec output 057-1: envelope 하위 고정 child만 허용 — bare envelope·wrong child·외부 거부", () => {
  const base = {
    entry: "playwright.readonly.config.ts",
    argv: ["test", "-c", "playwright.readonly.config.ts"],
    dbNames: ["commerce_test", "commerce"],
  };
  const env = join(
    "pw-output",
    "run-pw-01234567-89ab-cdef-0123-456789abcdef",
  );
  assert.doesNotThrow(() =>
    assertExecPlan({ ...base, outputDir: join(env, "playwright") }),
  );
  // envelope 자체(구형 계약)·다른 child명·evidence 영역·child 내부 중첩은 거부.
  assert.throws(
    () => assertExecPlan({ ...base, outputDir: env }),
    /output/,
  );
  assert.throws(() =>
    assertExecPlan({ ...base, outputDir: join(env, "test-results") }),
  );
  assert.throws(() =>
    assertExecPlan({ ...base, outputDir: join("shots", "06b", "x") }),
  );
  assert.throws(() =>
    assertExecPlan({ ...base, outputDir: join(env, "playwright", "deep") }),
  );
});

// 057-1 — config가 envelope 하위 child로 outputDir을 파생하는지 소스 계약
// 고정. outputDir=PW_WORKDIR 자체는 runner cleanup이 부모 예약 dir을 삭제한다.
test("config outputDir — envelope 하위 'playwright' child 파생 (057-1)", () => {
  for (const file of [
    "playwright.readonly.config.ts",
    "playwright.isolated.config.ts",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /outputDir,?/,
      file + " outputDir 선언 부재",
    );
    assert.ok(
      !/outputDir:\s*PW_WORKDIR\b/.test(src),
      file + " outputDir이 envelope 그 자체",
    );
  }
});

test(
  "pw override: -c는 허용 config 짝만 통과 — 단독/결합/다른 대상 거부",
  () => {
    assert.doesNotThrow(() =>
      assertNoPwOverrides({
        env: {},
        argv: ["n", "cli.js", "test", "-c", "playwright.readonly.config.ts"],
        allowedConfig: "playwright.readonly.config.ts",
      }),
    );
    assert.throws(() =>
      assertNoPwOverrides({
        env: {},
        argv: ["n", "cli.js", "test", "-c", "playwright.config.ts"],
        allowedConfig: "playwright.readonly.config.ts",
      }),
    );
    assert.throws(() =>
      assertNoPwOverrides({
        env: {},
        argv: ["n", "cli.js", "test", "-c"],
        allowedConfig: "playwright.readonly.config.ts",
      }),
    );
    assert.throws(() =>
      assertNoPwOverrides({
        env: {},
        argv: ["n", "cli.js", "test", "--config=x"],
        allowedConfig: "playwright.readonly.config.ts",
      }),
    );
    // allowedConfig 없이는 -c 자체가 거부다.
    assert.throws(() =>
      assertNoPwOverrides({
        env: {},
        argv: ["n", "cli.js", "test", "-c", "playwright.readonly.config.ts"],
      }),
    );
  },
);

// ── 실제 파일 배선 검증 — 선언이 아니라 코드에 연결됐는지 확인 ──────────

test("spec wiring: worker는 claim·경로를 소유하지 않는다 — 채널 submit만", () => {
  const src = readFileSync("tests/e2e/readonly-orders.spec.ts", "utf8");
  assert.ok(
    !src.includes("claimEvidenceFiles"),
    "spec이 자체 claim을 유지",
  );
  assert.ok(!src.includes("SHOT_DIR"), "spec이 직접 경로 기록을 유지");
  assert.ok(!src.includes('"unmanaged"'), "unmanaged fallback 잔존");
  assert.ok(src.includes("connectWorkerClient"), "채널 연결 부재");
  assert.ok(src.includes("RO_CHANNEL_PORT"), "채널 env 미참조");
});

test("audit wiring: parent가 전체 claim + async spawn + 채널 env", () => {
  const src = readFileSync("tests/e2e/readonly-audit.ts", "utf8");
  assert.ok(src.includes("planReadonlyRun"), "parent plan 미통합");
  assert.ok(!src.includes("claimEvidenceFilesSync"), "audit 자체 claim 잔존");
  assert.ok(
    !src.includes("spawnSync"),
    "spawnSync 잔존 — 이벤트 루프 블록으로 채널 데드락",
  );
  assert.ok(src.includes("assertExecPlan"), "exec plan 검증 부재");
  assert.ok(src.includes("RO_CHANNEL_PORT"), "채널 env 미전달");
});

// ── PM 056 수용기준 — implies·preflight·workdir 바인딩·caller 계약 ─────

import { assertReadonlyPreflight } from "../helpers/readonly-broker.ts";
import { assertRunAccess } from "../e2e/readonly-guard.ts";

test(
  "broker implies: trigger slot 기록 → implied set 미기록이면 close FAIL",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "imp-"));
    try {
      const b = await reserveBrokerRun(temp, ["t.json", "r.json", "s.json"], undefined, {
        required: [],
        oneOf: [["s.json", "t.json"]],
        implies: [{ when: "r.json", require: ["s.json"] }],
      });
      await b.submit({ nonce: b.nonce, slot: "t.json", data: "1" });
      // trigger 미기록 — implied 검사 없음 → oneOf(t) 충족 → 성공
      await b.close();

      const temp2 = mkdtempSync(join(tmpdir(), "imp2-"));
      try {
        const b2 = await reserveBrokerRun(
          temp2,
          ["t.json", "r.json", "s.json"],
          undefined,
          {
            required: [],
            oneOf: [["s.json", "t.json"]],
            implies: [{ when: "r.json", require: ["s.json"] }],
          },
        );
        await b2.submit({ nonce: b2.nonce, slot: "r.json", data: "1" });
        await b2.submit({ nonce: b2.nonce, slot: "t.json", data: "1" });
        // r 기록 → s 필수화 — 미기록이므로 FAIL
        await assert.rejects(b2.close(), /implied.*s\.json/);
      } finally {
        rmSync(temp2, { recursive: true, force: true });
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test("readonly preflight: argv·상속 DB·PG env·PW override — connect 전 거부", () => {
  const ok = {
    env: { PATH: "p" } as NodeJS.ProcessEnv,
    argv: [] as string[],
    allowedDbUrls: [
      "postgres://commerce:commerce@localhost:5432/commerce_test",
      "postgres://commerce:commerce@localhost:5432/commerce",
    ],
  };
  assert.doesNotThrow(() => assertReadonlyPreflight(ok));
  // 허용 DSN은 통과
  assert.doesNotThrow(() =>
    assertReadonlyPreflight({
      ...ok,
      env: {
        DATABASE_URL:
          "postgres://commerce:commerce@localhost:5432/commerce_test",
      },
    }),
  );
  assert.throws(() =>
    assertReadonlyPreflight({ ...ok, argv: ["--force"] }),
  );
  assert.throws(() =>
    assertReadonlyPreflight({
      ...ok,
      env: { DATABASE_URL: "postgres://x:y@h:1/other" },
    }),
  );
  for (const k of ["PGHOST", "PGDATABASE", "PGUSER", "PGSSLMODE"])
    assert.throws(
      () => assertReadonlyPreflight({ ...ok, env: { [k]: "x" } }),
      k,
    );
  assert.throws(() =>
    assertReadonlyPreflight({
      ...ok,
      env: { PLAYWRIGHT_HTML_REPORT: "x" },
    }),
  );
});

test(
  "run-access: pwWorkdir 바인딩 — env·marker 정합 불일치 전부 거부",
  async () => {
    const temp = mkdtempSync(join(tmpdir(), "roacc-"));
    try {
      const runId = "01234567-89ab-cdef-0123-456789abcdef";
      const runDir = join(temp, runId);
      const wd = join(temp, "run-pw-" + runId);
      mkdirSync(join(runDir, "captures"), { recursive: true });
      mkdirSync(wd, { recursive: true });
      writeFileSync(
        join(runDir, "run-owner.json"),
        JSON.stringify({ runId, nonce: "n1", pwWorkdir: wd }),
      );
      writeFileSync(
        join(runDir, "audit-before.json"),
        JSON.stringify({ runId, gateOk: true }),
      );
      // audit-after/fail은 0바이트 예약 claim만 — 종료 판정 아님.
      writeFileSync(join(runDir, "audit-after.json"), "");
      const env = {
        RO_RUN_ID: runId,
        RO_WORKER_NONCE: "n1",
        RO_PW_WORKDIR: wd,
        TEST_WORKER_INDEX: "0",
      };
      assert.doesNotThrow(() => assertRunAccess(runDir, env));
      // pwWorkdir env 부재·marker 불일치·이름 불일치·실dir 부재 — 전부 거부
      assert.throws(
        () =>
          assertRunAccess(runDir, { ...env, RO_PW_WORKDIR: undefined }),
        /RO_PW_WORKDIR/,
      );
      assert.throws(
        () =>
          assertRunAccess(runDir, {
            ...env,
            RO_PW_WORKDIR: join(temp, "run-pw-other"),
          }),
        /pwWorkdir 불일치/,
      );
      const envBadName = { ...env, RO_PW_WORKDIR: join(temp, "other") };
      writeFileSync(
        join(runDir, "run-owner.json"),
        JSON.stringify({
          runId,
          nonce: "n1",
          // 이름 검사까지 도달하려면 marker===env 정합이 선행 조건이다 —
          // 같지만 run-pw-<runId> 형태가 아닌 경로를 둘 다에 둔다.
          pwWorkdir: join(temp, "other"),
        }),
      );
      mkdirSync(join(temp, "other"), { recursive: true });
      assert.throws(
        () => assertRunAccess(runDir, envBadName),
        /pwWorkdir 이름이 run과 불일치/,
      );
      // 실제 dir 부재 — 이름은 run-pw-<runId> 정합이지만 dir이 없으면 거부.
      rmSync(wd, { recursive: true, force: true });
      writeFileSync(
        join(runDir, "run-owner.json"),
        JSON.stringify({
          runId,
          nonce: "n1",
          pwWorkdir: wd,
        }),
      );
      assert.throws(
        () =>
          assertRunAccess(runDir, {
            ...env,
            RO_PW_WORKDIR: wd,
          }),
        /부재/,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "wiring: readonly-server는 PG 접속 전 caller 계약(marker·pwWorkdir) 검증",
  () => {
    const src = readFileSync("tests/e2e/readonly-server.ts", "utf8");
    const probeIdx = src.indexOf("connectPg ?? postgres");
    const contractIdx = src.indexOf("assertRunAccess");
    assert.ok(contractIdx > -1, "공통 run-access caller 계약 부재");
    assert.ok(
      contractIdx < probeIdx,
      "caller 계약이 PG probe 이후 — 접속 전 검증 필요",
    );
    // 무인자 argv 계약·worker-side mode가 PG 생성 전에 검증된다.
    assert.ok(src.includes("slice(2)"), "무인자 argv 계약 부재");
    assert.ok(src.includes("worker: true"), "worker-side mode 미지정");
    // config outputDir은 부모 예약 workdir env에서 온다.
    const cfg = readFileSync("playwright.readonly.config.ts", "utf8");
    assert.ok(cfg.includes("RO_PW_WORKDIR"), "config workdir env 부재");
    assert.ok(
      !cfg.includes('"shots/06b/" + RUN_ID + "/pw-output"'),
      "구형 shots 내 pw-output 경로 잔존",
    );
  },
);

// ── PM QA-056 보완 배치 — strict argv / preload env / caller 함수 실증 ──

import { pwChildEnv, runAudit, type AuditDeps } from "../e2e/readonly-audit.ts";
import { runReadonlyServer } from "../e2e/readonly-server.ts";

test(
  "exec argv: runner·fork worker 정확한 정상 argv — bare/중복/충돌/entry 거부",
  () => {
    const CFG = "playwright.readonly.config.ts";
    // runner 정상 — [node, pw-cli, test -c cfg] 전체 형태.
    assert.doesNotThrow(() =>
      assertNoPwOverrides({
        env: {},
        argv: ["node", "C:\\x\\cli.js", "test", "-c", CFG],
        allowedConfig: CFG,
      }),
    );
    // fork worker 정상 — [node, workerProcessEntry.js], 무인자.
    assert.doesNotThrow(() =>
      assertNoPwOverrides({
        env: { TEST_WORKER_INDEX: "0" },
        argv: ["node", "C:\\x\\workerProcessEntry.js"],
        allowedConfig: CFG,
      }),
    );
    // worker env 미설정 무인자 자식도 worker entry는 통과(표준 test 경로의
    // 유일 fork 자식 — loader fork는 in-process loader 실측으로 미지원).
    assert.doesNotThrow(() =>
      assertNoPwOverrides({
        env: {},
        argv: ["node", "C:\\x\\workerProcessEntry.js"],
        allowedConfig: CFG,
      }),
    );
    // bare arg·중복 -c·결합형·다른 대상·임의 flag — 전부 거부.
    for (const bad of [
      ["node", "cli.js", "test", "-c", CFG, "extra.spec.ts"],
      ["node", "cli.js", "test", "-c", CFG, "-c", CFG],
      ["node", "cli.js", "test", "-c", "playwright.config.ts"],
      ["node", "cli.js", "test", "--config=" + CFG],
      ["node", "cli.js", "test", "-c" + CFG],
      ["node", "cli.js", "test", "-c", CFG, "--reporter=json"],
      ["node", "cli.js", "test"],
    ])
      assert.throws(
        () =>
          assertNoPwOverrides({ env: {}, argv: bad, allowedConfig: CFG }),
        JSON.stringify(bad),
      );
    // 알 수 없는 entry의 무인자 eval — loaderProcessEntry는 미지원이다.
    for (const entry of ["loaderProcessEntry.js", "random.js"])
      assert.throws(
        () =>
          assertNoPwOverrides({
            env: {},
            argv: ["node", "x\\" + entry],
            allowedConfig: CFG,
          }),
        entry,
      );
    // worker env인데 entry 불일치·인자 존재 — 전부 거부.
    assert.throws(() =>
      assertNoPwOverrides({
        env: { TEST_WORKER_INDEX: "0" },
        argv: ["node", "x\\loaderProcessEntry.js"],
        allowedConfig: CFG,
      }),
    );
    assert.throws(() =>
      assertNoPwOverrides({
        env: { TEST_WORKER_INDEX: "0" },
        argv: ["node", "x\\workerProcessEntry.js", "x"],
        allowedConfig: CFG,
      }),
    );
    // argv 불완전(entry 위치 부재)·1요소 argv — 거부.
    assert.throws(() =>
      assertNoPwOverrides({ env: {}, argv: ["node"], allowedConfig: CFG }),
    );
  },
);

test(
  "exec env: PLAYWRIGHT_TEST=1는 검증된 fork worker에서만 통과 — 그 외 전부 거부",
  () => {
    // PMQA-057-2 — Playwright가 fork worker env에 스스로 심는
    // PLAYWRIGHT_TEST='1'는 정확한 키·값·검증된 worker argv에서만 통과다.
    const WENV = { TEST_WORKER_INDEX: "0", PLAYWRIGHT_TEST: "1" };
    const WARGV = ["node", "C:\\x\\workerProcessEntry.js"];
    assert.doesNotThrow(() =>
      assertNoPwOverrides({ env: { ...WENV }, argv: WARGV }),
    );
    // 값이 '1'이 아니면 검증된 worker argv여도 거부다.
    for (const v of ["0", "true", "01", ""])
      assert.throws(
        () =>
          assertNoPwOverrides({
            env: { TEST_WORKER_INDEX: "0", PLAYWRIGHT_TEST: v },
            argv: WARGV,
          }),
        "PLAYWRIGHT_TEST=" + JSON.stringify(v),
      );
    // 다른 PLAYWRIGHT_* 키는 검증된 worker에서도 그대로 거부다.
    for (const k of ["PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_HTML_REPORT"])
      assert.throws(
        () =>
          assertNoPwOverrides({ env: { ...WENV, [k]: "x" }, argv: WARGV }),
        k,
      );
    // runner argv에서 동일 키 — worker 형태가 아니므로 거부다.
    assert.throws(() =>
      assertNoPwOverrides({
        env: { PLAYWRIGHT_TEST: "1" },
        argv: [
          "node",
          "C:\\x\\cli.js",
          "test",
          "-c",
          "playwright.readonly.config.ts",
        ],
        allowedConfig: "playwright.readonly.config.ts",
      }),
    );
    // env 전용 검사(preflight argv [])에서도 동일 키는 거부다.
    assert.throws(() =>
      assertNoPwOverrides({ env: { PLAYWRIGHT_TEST: "1" }, argv: [] }),
    );
    // TEST_WORKER_INDEX 없는 무인자 fork에서 동일 키 — worker 미검증, 거부.
    assert.throws(() =>
      assertNoPwOverrides({ env: { PLAYWRIGHT_TEST: "1" }, argv: WARGV }),
    );
    // worker env + 허용 외 인자 — 검증된 worker 형태가 아니므로 거부다.
    assert.throws(() =>
      assertNoPwOverrides({
        env: { ...WENV },
        argv: ["node", "C:\\x\\workerProcessEntry.js", "--x"],
      }),
    );
    // mixed-case 키는 exact-key 예외를 통과하지 못한다 — case-insensitive
    // 차단 regex가 잡는다.
    assert.throws(() =>
      assertNoPwOverrides({
        env: { TEST_WORKER_INDEX: "0", Playwright_Test: "1" },
        argv: WARGV,
      }),
    );
    assert.throws(() =>
      assertNoPwOverrides({
        env: { TEST_WORKER_INDEX: "0", Playwright_Junit_Output_Name: "x" },
        argv: WARGV,
      }),
    );
    // TEST_WORKER_INDEX 비숫자 + PLAYWRIGHT_TEST — worker 미검증, 거부.
    assert.throws(() =>
      assertNoPwOverrides({
        env: { TEST_WORKER_INDEX: "x", PLAYWRIGHT_TEST: "1" },
        argv: WARGV,
      }),
    );
  },
);

test("pwChildEnv: Node preload env 사본 제거 — 부모 env 불변", () => {
  const base = {
    PATH: "p",
    NODE_OPTIONS: "--require ./evil.js",
    Node_Path: "C:\\x", // 혼합 case — Windows env는 case-insensitive
    NODE_INSPECT_RESUME_ON_START: "1",
    KEEP_ME: "v",
  } as NodeJS.ProcessEnv;
  const env = pwChildEnv("rid", "nn", 14330, "C:\\wd", base);
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    assert.ok(
      !["NODE_OPTIONS", "NODE_PATH", "NODE_INSPECT_RESUME_ON_START"].includes(u),
      "preload env 잔존: " + k,
    );
  }
  assert.equal(env.KEEP_ME, "v");
  assert.equal(env.RO_RUN_ID, "rid");
  assert.equal(env.RO_WORKER_NONCE, "nn");
  assert.equal(env.RO_CHANNEL_PORT, "14330");
  assert.equal(env.RO_PW_WORKDIR, "C:\\wd");
  // 부모 env 사본만 정화 — 원본은 불변이어야 한다.
  assert.equal(base.NODE_OPTIONS, "--require ./evil.js");
  assert.equal(base.Node_Path, "C:\\x");
});

test("preflight: Node preload env·bad argv → connect/spawn 0 (실제 경로)", async () => {
  const DSN = [
    "postgres://commerce:commerce@localhost:5432/commerce_test",
    "postgres://commerce:commerce@localhost:5432/commerce",
  ];
  // 직접 단정 — 비어있지 않은 preload env는 connect 전 거부.
  for (const k of ["NODE_OPTIONS", "Node_Options", "NODE_PATH"])
    assert.throws(() =>
      assertReadonlyPreflight({
        env: { [k]: "x" },
        argv: [],
        allowedDbUrls: DSN,
      }),
      k,
    );
  // 빈 값은 preload를 실행하지 않으므로 거부 대상이 아니다.
  assert.doesNotThrow(() =>
    assertReadonlyPreflight({
      env: { NODE_OPTIONS: "" },
      argv: [],
      allowedDbUrls: DSN,
    }),
  );
  // runAudit의 실제 mkdirRunDir 위치에서 실제 assertReadonlyPreflight가
  // 던지면 이후 connect/spawnPw는 0이다 [PM — 공통 함수 경로 실증 요구].
  for (const bad of [
    { env: { NODE_OPTIONS: "--require x" }, argv: [] as string[] },
    { env: {}, argv: ["--force"] },
    { env: { DATABASE_URL: "postgres://x:y@h:1/evil" }, argv: [] as string[] },
  ]) {
    const calls = { connect: 0, spawn: 0 };
    const deps = {
      mkdirRunDir: async () => {
        assertReadonlyPreflight({
          env: bad.env,
          argv: bad.argv,
          allowedDbUrls: DSN,
        });
        return "unused";
      },
      runNonce: () => "n",
      runWorkdir: () => "w",
      put: async () => {},
      closeEvidence: async () => {},
      verifyBackupFile: () => {},
      readFileBytes: () => Buffer.alloc(0),
      sha256: () => "x",
      loadSeedOrderIds: () => [],
      connect: () => {
        calls.connect++;
        return {} as never;
      },
      probeDb: async () => {},
      listDatabases: async () => [],
      baselineGate: async () => ({
        ok: true,
        reasons: [],
        detail: {},
        before: null,
      }),
      snapInTxn: async () => ({} as never),
      spawnPw: () => {
        calls.spawn++;
        return { status: 0, error: null };
      },
    } as unknown as AuditDeps;
    const v = await runAudit(deps);
    assert.equal(v.pass, false);
    assert.equal(calls.connect, 0, "connect 도달: " + JSON.stringify(bad));
    assert.equal(calls.spawn, 0, "spawn 도달: " + JSON.stringify(bad));
  }
});

// ── server caller 함수 — mock/spy 실증 (fixture runDir, 실제 PG 없음) ──

function roServerFixture(opts: {
  nonce?: string;
  wd?: "empty" | "populated" | "missing";
  wdName?: string;
  markerPw?: string;
  before?: boolean | null;
  after?: "after" | "fail" | null;
}) {
  const runId = "srv-" + randomUUID().slice(0, 8);
  const parent = mkdtempSync(join(tmpdir(), "rosrv-"));
  const runDir = join(parent, runId);
  mkdirSync(runDir, { recursive: true });
  const wd = join(parent, opts.wdName ?? "run-pw-" + runId);
  if (opts.wd !== "missing") mkdirSync(wd, { recursive: true });
  if (opts.wd === "populated")
    writeFileSync(join(wd, "out.json"), "RUNNER-OUT");
  writeFileSync(
    join(runDir, "run-owner.json"),
    JSON.stringify({
      runId,
      nonce: opts.nonce ?? "n1",
      pwWorkdir: opts.markerPw ?? wd,
    }),
  );
  if (opts.before !== null)
    writeFileSync(
      join(runDir, "audit-before.json"),
      JSON.stringify({ runId, gateOk: opts.before ?? true }),
    );
  if (opts.after === "after")
    writeFileSync(join(runDir, "audit-after.json"), '{"done":1}');
  if (opts.after === "fail")
    writeFileSync(join(runDir, "audit-fail.json"), '{"e":1}');
  const env = {
    RO_RUN_ID: runId,
    RO_WORKER_NONCE: "n1",
    RO_PW_WORKDIR: wd,
    DATABASE_URL:
      "postgres://commerce:commerce@localhost:5432/commerce_test",
  };
  const cleanup = () => rmSync(parent, { recursive: true, force: true });
  return { parent, runDir, wd, env, cleanup };
}

function fakePg(rows?: { db?: string; oid?: number; guc?: string }) {
  const urls: string[] = [];
  const probe = {
    unsafe: async (q: string) =>
      q.includes("current_database")
        ? [{ d: rows?.db ?? "commerce_test", oid: rows?.oid ?? 16516 }]
        : [{ default_transaction_read_only: rows?.guc ?? "on" }],
    end: async () => {},
  };
  const connectPg = ((url: string) => {
    urls.push(url);
    return probe;
  }) as never;
  return { connectPg, urls };
}

test("server caller: 정상 경로 — gate 통과 후에만 PG probe + start", async () => {
  const f = roServerFixture({ wd: "populated" }); // runner 산출물 허용
  try {
    const pg = fakePg();
    let started = 0;
    await runReadonlyServer({
      env: f.env,
      argv: ["node", "tests/e2e/readonly-server.ts"],
      runDirRoot: f.parent,
      connectPg: pg.connectPg,
      importServer: async () => ({ start: async () => { started++; } }),
    });
    assert.equal(started, 1);
    assert.equal(pg.urls.length, 1);
    assert.ok(
      pg.urls[0].includes("default_transaction_read_only=on"),
      "readonly GUC URL 아님",
    );
  } finally {
    f.cleanup();
  }
});

test("server caller: 부정 경로 전부에서 PG 접속 0 (mock/spy 실증)", async () => {
  const cases: {
    name: string;
    fix: Parameters<typeof roServerFixture>[0];
    mutate: (f: ReturnType<typeof roServerFixture>) => {
      env: NodeJS.ProcessEnv;
      argv: readonly string[];
    };
  }[] = [
    {
      name: "bad argv",
      fix: { wd: "empty" },
      mutate: (f) => ({ env: f.env, argv: ["n", "srv", "--x"] }),
    },
    {
      name: "dup argv",
      fix: { wd: "empty" },
      mutate: (f) => ({ env: f.env, argv: ["n", "srv", "a", "a"] }),
    },
    {
      name: "env 부재",
      fix: { wd: "empty" },
      mutate: () => ({ env: {}, argv: ["n", "srv"] }),
    },
    {
      name: "nonce 불일치",
      fix: { wd: "empty" },
      mutate: (f) => ({
        env: { ...f.env, RO_WORKER_NONCE: "no" },
        argv: ["n", "srv"],
      }),
    },
    {
      name: "종료 run(after 기록)",
      fix: { wd: "empty", after: "after" },
      mutate: (f) => ({ env: f.env, argv: ["n", "srv"] }),
    },
    {
      name: "before 부재",
      fix: { wd: "empty", before: null },
      mutate: (f) => ({ env: f.env, argv: ["n", "srv"] }),
    },
    {
      name: "pwWorkdir env-marker 불일치",
      fix: { wd: "empty" },
      mutate: (f) => ({
        env: { ...f.env, RO_PW_WORKDIR: f.wd + "-other" },
        argv: ["n", "srv"],
      }),
    },
  ];
  for (const c of cases) {
    const f = roServerFixture(c.fix);
    try {
      const pg = fakePg();
      const m = c.mutate(f);
      await assert.rejects(
        runReadonlyServer({
          env: m.env,
          argv: m.argv,
          runDirRoot: f.parent,
          connectPg: pg.connectPg,
          importServer: async () => ({ start: async () => {} }),
        })
      );
      assert.equal(pg.urls.length, 0, c.name + " — PG 접속 시도됨");
    } finally {
      f.cleanup();
    }
  }
});

test("server caller: probe 불일치(DB identity·GUC) — start 0", async () => {
  for (const bad of [
    { db: "commerce" }, // 다른 DB
    { oid: 99999 },     // 다른 OID
    { guc: "off" },     // GUC 미적용
  ]) {
    const f = roServerFixture({ wd: "empty" });
    try {
      const pg = fakePg(bad);
      let started = 0;
      await assert.rejects(
        runReadonlyServer({
          env: f.env,
          argv: ["n", "srv"],
          runDirRoot: f.parent,
          connectPg: pg.connectPg,
          importServer: async () => ({ start: async () => { started++; } }),
        }),
        /불일치|GUC/,
      );
      assert.equal(started, 0);
    } finally {
      f.cleanup();
    }
  }
});

test(
  "run-access: runner workdir 신선도 — 빈·격리만 / worker·server 산출물 허용",
  () => {
    // runner 첫 평가 — 비어있는 부모 예약 workdir만 통과.
    {
      const f = roServerFixture({ wd: "empty" });
      try {
        assert.doesNotThrow(() =>
          assertRunAccess(f.runDir, f.env),
        );
      } finally {
        f.cleanup();
      }
    }
    // runner 재실행이 기존 workdir 위에 오는 경로 — 중단 run marker/env
    // 재사용으로 PW가 기존 output을 지우는 시나리오 차단 [PM QA-056 M1].
    {
      const f = roServerFixture({ wd: "populated" });
      try {
        assert.throws(
          () => assertRunAccess(f.runDir, f.env),
          /신규·빈/,
        );
      } finally {
        f.cleanup();
      }
    }
    // 정상 worker 재평가(TEST_WORKER_INDEX)·명시 worker mode(server)는
    // runner가 정상 생성한 workdir 산출물을 허용한다.
    for (const env of [
      { TEST_WORKER_INDEX: "0" },
      {},
    ]) {
      const f = roServerFixture({ wd: "populated" });
      try {
        assert.doesNotThrow(() =>
          assertRunAccess(
            f.runDir,
            { ...f.env, ...env },
            "TEST_WORKER_INDEX" in env ? undefined : { worker: true },
          ),
        );
      } finally {
        f.cleanup();
      }
    }
  },
);

