import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Writable } from "node:stream";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ClaimWriter,
  checkEvidenceName,
  claimEvidenceFiles,
  claimEvidenceFilesSync,
  drainWriteAsync,
  drainWriteSync,
  reserveCaptureOutput,
  reserveEvidenceRun,
} from "../helpers/capture-output.ts";
import {
  childEnv,
  run054,
  RUN_SLOTS,
} from "../../scripts/pmqa054-evidence-run.ts";

const sha256 = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");

test("capture output reservation: an existing run directory fails before consumer side effects", async () => {
  const temp = mkdtempSync(join(tmpdir(), "capture-reserve-"));
  try {
    const root = join(temp, "runs");
    const existing = join(root, "run-fixed");
    mkdirSync(existing, { recursive: true });
    const sentinels = ["impl.png", "facts.json", "facts-progress.json"];
    for (const name of sentinels) writeFileSync(join(existing, name), "preserve:" + name);
    let cartMutations = 0;
    let captures = 0;
    await assert.rejects(async () => {
      const out = await reserveCaptureOutput(root, "fixed");
      cartMutations++;
      captures++;
      return out;
    }, /EEXIST|already exists|capture output/i);
    assert.equal(cartMutations, 0);
    assert.equal(captures, 0);
    for (const name of sentinels)
      assert.equal(readFileSync(join(existing, name), "utf8"), "preserve:" + name);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("capture output reservation: concurrent claim of the same run path has exactly one winner", async () => {
  const temp = mkdtempSync(join(tmpdir(), "capture-reserve-race-"));
  try {
    const root = join(temp, "runs");
    const results = await Promise.allSettled([
      reserveCaptureOutput(root, "same-run"),
      reserveCaptureOutput(root, "same-run"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const winner = results.find((r) => r.status === "fulfilled");
    assert.ok(winner && winner.status === "fulfilled");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("capture output reservation: unrelated prior evidence directories are untouched", async () => {
  const temp = mkdtempSync(join(tmpdir(), "capture-reserve-evidence-"));
  try {
    const root = join(temp, "shots", "06a");
    for (const name of ["pmqa040", "pmqa043", "pmqa044"]) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "facts.json"), "approved:" + name);
      writeFileSync(join(dir, "approved.png"), "png:" + name);
    }
    const out = await reserveCaptureOutput(join(root, "pmqa040-runs"), "new-run");
    assert.equal(out.replace(/[\\/]+$/, ""), join(root, "pmqa040-runs", "run-new-run"));
    for (const name of ["pmqa040", "pmqa043", "pmqa044"]) {
      assert.equal(readFileSync(join(root, name, "facts.json"), "utf8"), "approved:" + name);
      assert.equal(readFileSync(join(root, name, "approved.png"), "utf8"), "png:" + name);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// ── PMQA-054 claim 계층 — wx 사전 claim·1회 기록·retain·오류 집계 close ──

test("claim: 기존 sentinel 파일과 충돌하면 거부 — sentinel bytes/SHA256 불변, consumer 0", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-sentinel-"));
  try {
    const dir = join(temp, "evidence");
    mkdirSync(dir, { recursive: true });
    for (const kind of ["log.txt", "README.md", "shot.png", "facts.json"]) {
      const p = join(dir, kind);
      writeFileSync(p, "sentinel:" + kind);
      const before = sha256(readFileSync(p));
      let consumers = 0;
      await assert.rejects(async () => {
        await claimEvidenceFiles(dir, [kind]);
        consumers++;
      }, /EEXIST|already exists/i);
      assert.equal(consumers, 0);
      assert.equal(sha256(readFileSync(p)), before);
      assert.equal(readFileSync(p, "utf8"), "sentinel:" + kind);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("claim: 부분 claim 실패 — 생성된 claim 파일은 삭제되지 않고 retain, 기존 파일 불변", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-partial-"));
  try {
    const dir = join(temp, "evidence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "c.json"), "pre-existing");
    // a·b는 새 claim으로 생성되고, c는 기존 파일이라 여기서 실패한다.
    await assert.rejects(() =>
      claimEvidenceFiles(dir, ["a.json", "b.json", "c.json", "d.json"]),
    );
    // 생성된 claim(a·b)은 삭제되지 않는다 — abort 흔적 retain.
    assert.equal(existsSync(join(dir, "a.json")), true);
    assert.equal(existsSync(join(dir, "b.json")), true);
    assert.equal(existsSync(join(dir, "d.json")), false); // 도달하지 않은 이름
    assert.equal(readFileSync(join(dir, "c.json"), "utf8"), "pre-existing");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("claim: 이름 검증 — 경로 구분자·상위 참조·숨김·중복 전부 거부", () => {
  for (const bad of ["../x", "a/b", "a\\b", "..", ".", ".hidden", "a..b"])
    assert.throws(() => checkEvidenceName(bad), JSON.stringify(bad));
  for (const ok of ["facts.json", "impl_a-b.png", "x.md"])
    assert.doesNotThrow(() => checkEvidenceName(ok));
});

test("claim: 목록 내 중복 이름 거부", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-dup-"));
  try {
    await assert.rejects(() =>
      claimEvidenceFiles(join(temp, "d"), ["a.json", "a.json"]),
      /duplicate/i,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("claim: 동시 claim 경쟁 — 정확히 1승 1패", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-race-"));
  try {
    const dir = join(temp, "d");
    const results = await Promise.allSettled([
      claimEvidenceFiles(dir, ["x.json"]),
      claimEvidenceFiles(dir, ["x.json"]),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner && winner.status === "fulfilled") await winner.value.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("writer: 미claim write·두 번째 write·close 후 write 전부 거부", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-write-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["a.json", "b.bin"]);
    await assert.rejects(() => w.write("nope.json", "x"), /not claimed/);
    await w.write("a.json", "first");
    await assert.rejects(() => w.write("a.json", "second"), /already written/);
    await assert.rejects(
      () => w.writeJson("a.json", { x: 1 }),
      /already written/,
    );
    await w.close();
    await assert.rejects(() => w.write("b.bin", "late"), /closed/);
    assert.equal(readFileSync(join(dir, "a.json"), "utf8"), "first");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("writer: 동시 write 경쟁 — 두 번째 호출은 거부된다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-conc-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["a.txt"]);
    const [r1, r2] = await Promise.allSettled([
      w.write("a.txt", "one"),
      w.write("a.txt", "two"),
    ]);
    // written 플래그가 IO 전 동기 소비이므로 정확히 하나만 성공한다.
    assert.equal(
      [r1, r2].filter((r) => r.status === "fulfilled").length,
      1,
    );
    await w.close();
    const body = readFileSync(join(dir, "a.txt"), "utf8");
    assert.ok(body === "one" || body === "two");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("writer: PNG 바이너리 bytes write→read 동일", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-png-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["img.png"]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 0xab),
    ]);
    await w.write("img.png", png);
    await w.close();
    assert.deepEqual(readFileSync(join(dir, "img.png")), png);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("writer: 재실행은 재사용이 아니라 새 claim — 기존 파일이면 거부", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-rerun-"));
  try {
    const dir = join(temp, "d");
    const w1 = await claimEvidenceFiles(dir, ["a.json"]);
    await w1.writeJson("a.json", { n: 1 });
    await w1.close();
    // 같은 dir 재실행 — 기존 증거 위에 쓰지 않는다.
    await assert.rejects(() => claimEvidenceFiles(dir, ["a.json"]));
    assert.equal(
      JSON.parse(readFileSync(join(dir, "a.json"), "utf8")).n,
      1,
    );
    // 새 이름은 계속 claim 가능하다.
    const w2 = await claimEvidenceFiles(dir, ["b.json"]);
    await w2.writeJson("b.json", { n: 2 });
    await w2.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// ── full-write 루프 — partial/0진행 주입 회귀 [PM 품질보완] ─────────────

test("drainWriteAsync: 짧은 쓰기를 반복해 전체 버퍼를 기록한다", async () => {
  const buf = Buffer.alloc(1000, 0x61);
  let off = 0;
  const parts: number[] = [];
  await drainWriteAsync(buf, async (part, rel) => {
    assert.equal(rel, off);
    const n = Math.min(128, part.length);
    parts.push(n);
    off += n;
    return n;
  });
  assert.equal(off, 1000);
  assert.ok(parts.length > 1); // 실제로 여러 번 나눠 썼다
});

test("drainWriteAsync: 0바이트 진행은 즉시 실패 — 미기록 tail PASS 금지", async () => {
  const buf = Buffer.alloc(64, 0x62);
  let calls = 0;
  await assert.rejects(
    drainWriteAsync(buf, async () => {
      calls++;
      return calls < 3 ? 8 : 0; // 16바이트 쓰고 멈춤
    }),
    /0바이트|진행/,
  );
});

test("drainWriteSync: partial→전체 기록, 0진행→실패", () => {
  const buf = Buffer.alloc(300, 0x63);
  let off = 0;
  drainWriteSync(buf, (part, rel) => {
    const n = Math.min(50, part.length);
    off += n;
    return n;
  });
  assert.equal(off, 300);
  assert.throws(() =>
    drainWriteSync(buf, () => 0),
    /0바이트|진행/,
  );
});

// ── stream: child stdout 파이프·drain·실패 retain ──────────────────────

test("stream: child stdout을 claim 파일로 파이프 — drain 후 bytes 확인", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-stream-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["cmd.log"]);
    const s = w.stream("cmd.log");
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('LINE-A|');process.stderr.write('LINE-B|')"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.pipe(s, { end: false });
    child.stderr.pipe(s, { end: false });
    await once(child, "close");
    s.end();
    await once(s, "finish");
    await w.close();
    const body = readFileSync(join(dir, "cmd.log"), "utf8");
    assert.match(body, /LINE-A/);
    assert.match(body, /LINE-B/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("stream: 이미 끝난 stream의 close는 hang 없이 완료된다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-stream-end-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["s.log"]);
    const s = w.stream("s.log");
    s.end("done");
    await once(s, "finish");
    // writableFinished 상태에서 close — once(finish)를 뒤늦게 걸지 않는다.
    await w.close();
    assert.equal(readFileSync(join(dir, "s.log"), "utf8"), "done");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("close: 두 번째 호출은 같은 작업을 기다려 조기 성공을 반환하지 않는다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-close-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["a.json"]);
    await w.writeJson("a.json", { ok: true });
    const p1 = w.close();
    const p2 = w.close(); // 동시 호출 — 같은 promise 공유
    await Promise.all([p1, p2]);
    const p3 = w.close(); // 완료 후 호출도 즉시 같은 종료 상태
    await p3;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("seal: 읽기전용 표시 후 경로 재open 기록은 EPERM/EACCES로 거부된다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-seal-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["locked.json"]);
    await w.writeJson("locked.json", { v: 1 });
    await w.seal("locked.json");
    await w.close();
    assert.throws(
      () => writeFileSync(join(dir, "locked.json"), "overwrite"),
      /EPERM|EACCES/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, "locked.json"), "utf8")).v,
      1,
    );
  } finally {
    // 읽기전용 파일도 디렉터리 정리는 된다(Windows readonly flag 해제 불필요).
    rmSync(temp, { recursive: true, force: true });
  }
});

// ── reserveEvidenceRun — 예약 dir + claim 통합 ──────────────────────────

test("reserveEvidenceRun: 새 run dir에 planned 산출물이 claim된다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "reserve-run-"));
  try {
    const w = await reserveEvidenceRun(join(temp, "runs"), [
      "a.log",
      "result.json",
    ]);
    await w.writeJson("result.json", { pass: true });
    await w.close();
    assert.ok(existsSync(join(w.dir, "a.log")));
    assert.equal(
      JSON.parse(readFileSync(join(w.dir, "result.json"), "utf8")).pass,
      true,
    );
    // 같은 runId 재실행은 예약 충돌로 거부된다.
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// ── sync 변형 — launcher/audit 경로 계약 ───────────────────────────────

test("sync claim: write→read·1회 기록·미claim 거부·close 집계", () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-sync-"));
  try {
    const dir = join(temp, "d");
    const w = claimEvidenceFilesSync(dir, ["a.json", "b.json"]);
    assert.equal(w.dir, dir);
    w.writeJson("a.json", { runId: "r1", gateOk: true });
    assert.throws(() => w.writeJson("a.json", {}), /already written/);
    assert.throws(() => w.write("nope.json", "x"), /not claimed/);
    w.close();
    assert.throws(() => w.write("b.json", "late"), /closed/);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "a.json"), "utf8")).gateOk,
      true,
    );
    // b.json은 미기록 claim — 0바이트로 retain.
    assert.equal(statSync(join(dir, "b.json")).size, 0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("sync claim: sentinel 충돌 시 생성 claim은 retain·sentinel 불변", () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-sync-s-"));
  try {
    const dir = join(temp, "d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "exists.json"), "keep");
    assert.throws(() =>
      claimEvidenceFilesSync(dir, ["new1.json", "exists.json"]),
    );
    assert.equal(existsSync(join(dir, "new1.json")), true); // retain
    assert.equal(readFileSync(join(dir, "exists.json"), "utf8"), "keep");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// ── Luna QA-A/B — pending write settle·stream premature close 회귀 ──────

test("close: 진행 중 write가 settle할 때까지 기다린 뒤 handle을 닫는다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-pending-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["big.bin"]);
    const buf = Buffer.alloc(1 << 20, 0x61); // 1MB
    const pw = w.write("big.bin", buf); // await하지 않고 진행시킨다
    const pc = w.close(); // close는 이 write가 끝날 때까지 기다려야 한다
    await Promise.all([pw, pc]);
    assert.equal(readFileSync(join(dir, "big.bin")).length, buf.length);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("stream: error 없이 destroy된 미완료 stream은 close 실패 + 기록분 retain", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-destroy-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["s.log"]);
    const s = w.stream("s.log");
    s.write("partial-data");
    s.destroy(); // finish 없이 destroy — pending data 유실 가능 상태
    // 미완료를 성공으로 간주하지 않는다 — close는 실패다 [Luna QA-B].
    await assert.rejects(() => w.close(), /prematurely closed|closed before finish/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("stream: destroy(error)는 close에서 전파된다 — 조용한 성공 없음", async () => {
  const temp = mkdtempSync(join(tmpdir(), "claim-err-"));
  try {
    const dir = join(temp, "d");
    const w = await claimEvidenceFiles(dir, ["s.log"]);
    const s = w.stream("s.log");
    s.write("x");
    s.destroy(new Error("io failure"));
    await assert.rejects(() => w.close(), /io failure/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// ── 054 runner — 고정 커맨드·claim 경로 회귀 ────────────────────────────

test("run054: 예약/claim 충돌은 spawn 0으로 거부된다", async () => {
  let spawns = 0;
  await assert.rejects(
    () =>
      run054({
        reserve: async () => {
          throw new Error("EEXIST: run 이미 존재");
        },
        spawnImpl: (() => {
          spawns++;
          throw new Error("spawn이 실행되면 안 된다");
        }) as never,
      }),
    /EEXIST/,
  );
  assert.equal(spawns, 0); // collision은 spawn 시작 전 거부다
});

test("run054: 고정 커맨드 spawn → 로그 claim 기록 → 결과·README 기록 → 해제", async () => {
  const temp = mkdtempSync(join(tmpdir(), "run054-"));
  try {
    const r = await run054({
      reserve: (_root, names) => claimEvidenceFiles(join(temp, "d"), names),
      // 고정 argv는 무시하고 항상 같은 출력을 내는 fake child — 실행 자체는
      // 실제 spawn으로 검증한다(stdio pipe·close·drain 경로).
      spawnImpl: ((f: string, _a: string[], o: never) =>
        spawn(
          f,
          ["-e", "process.stdout.write('OUT|');process.stderr.write('ERR|')"],
          o,
        )) as never,
    });
    assert.equal(r.code, 0);
    assert.equal(r.results.length, 3);
    for (const c of r.results) assert.equal(c.status, 0, c.name);
    for (const name of ["check.log", "build.log", "unit.log"]) {
      const log = readFileSync(join(temp, "d", name), "utf8");
      // 빈 매치되는 /OUT|/ 같은 패턴 금지 — literal 포함만 인정 [Luna QA].
      assert.ok(log.includes("OUT|"), name);
      assert.ok(log.includes("ERR|"), name);
    }
    const res = JSON.parse(
      readFileSync(join(temp, "d", "result.json"), "utf8"),
    );
    // result.json은 측정 기록만 — 최종 verdict 필드를 두지 않는다.
    assert.equal("pass" in res, false);
    assert.equal(res.results.length, 3);
    for (const c of res.results) assert.equal(c.status, 0, c.name);
    assert.ok(existsSync(join(temp, "d", "README.md")));
    assert.equal(
      readFileSync(join(temp, "d", "README.md"), "utf8").includes("PMQA-054"),
      true,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("run054: 커맨드 실패(status != 0)는 code=1 + 로그·결과는 기록된다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "run054-fail-"));
  try {
    const r = await run054({
      reserve: (_root, names) => claimEvidenceFiles(join(temp, "d"), names),
      spawnImpl: ((f: string, _a: string[], o: never) =>
        spawn(
          f,
          ["-e", "process.stderr.write('FAILLOG|');process.exit(3)"],
          o,
        )) as never,
    });
    assert.equal(r.code, 1);
    for (const c of r.results) assert.equal(c.status, 3, c.name);
    const res = JSON.parse(
      readFileSync(join(temp, "d", "result.json"), "utf8"),
    );
    assert.equal("pass" in res, false);
    for (const c of res.results) assert.equal(c.status, 3, c.name);
    const log = readFileSync(join(temp, "d", "check.log"), "utf8");
    assert.ok(log.includes("FAILLOG|"));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("run054: 실제 claim 경로 충돌 — sentinel 슬롯 SHA256 불변·spawn 0", async () => {
  const temp = mkdtempSync(join(tmpdir(), "run054-collision-"));
  try {
    const dir = join(temp, "run-fixed");
    mkdirSync(dir);
    const before = new Map<string, string>();
    for (const n of RUN_SLOTS) {
      writeFileSync(join(dir, n), Buffer.from("prior-evidence-" + n));
      before.set(n, sha256(readFileSync(join(dir, n))));
    }
    let spawns = 0;
    await assert.rejects(
      run054({
        // 실제 claim 경로 — run-fixed/sentinel 슬롯이 이미 존재하므로
        // reserve 자체가 거부돼야 한다 (mock throw가 아닌 실FS 경로).
        reserve: (_root, names) => reserveEvidenceRun(temp, names, "fixed"),
        spawnImpl: (() => {
          spawns++;
          throw new Error("spawn이 실행되면 안 된다");
        }) as never,
      }),
    );
    assert.equal(spawns, 0); // collision은 spawn 시작 전 거부다
    for (const n of RUN_SLOTS) {
      assert.equal(sha256(readFileSync(join(dir, n))), before.get(n), n);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("run054: child env는 Node 실행 제어 변수를 제거한 사본이다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "run054-env-"));
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--require x";
  let captured: NodeJS.ProcessEnv | undefined;
  try {
    const r = await run054({
      reserve: (_root, names) => claimEvidenceFiles(join(temp, "d"), names),
      spawnImpl: ((f: string, _a: readonly string[], o: {
        stdio: ["ignore", "pipe", "pipe"];
        env: NodeJS.ProcessEnv;
      }) => {
        captured = o.env;
        return spawn(
          f,
          ["-e", "process.exit(0)"],
          { stdio: o.stdio, env: o.env },
        );
      }) as never,
    });
    assert.equal(r.code, 0);
    assert.ok(captured);
    assert.ok(!("NODE_OPTIONS" in captured));
    // 부모 env 전역은 수정되지 않았다 — 사본만 sanitize된다 [Luna QA].
    assert.equal(process.env.NODE_OPTIONS, "--require x");
  } finally {
    if (prev === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prev;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("childEnv: Windows 혼합 대소문자 실행 제어 key도 제거 — 원본 base 불변", () => {
  // Windows env는 case-insensitive — Node_Options/node_path 혼합 key가
  // child에 남으면 --require 주입 등 실행 통제가 우회된다 [Luna QA].
  const base: NodeJS.ProcessEnv = {
    PATH: "p",
    Node_Options: "--require evil",
    node_path: "evil",
    NODE_INSPECT_RESUME_ON_START: "1",
    keep_me: "ok",
  };
  const out = childEnv(base);
  for (const k of Object.keys(out)) {
    assert.ok(
      !["NODE_OPTIONS", "NODE_PATH", "NODE_INSPECT_RESUME_ON_START"].includes(
        k.toUpperCase(),
      ),
      k,
    );
  }
  assert.equal(out.keep_me, "ok");
  assert.equal(out.PATH, "p");
  // 입력 base는 수정되지 않는다 — 전역/외부 env 변경 0.
  assert.equal(base.Node_Options, "--require evil");
  assert.equal(base.node_path, "evil");
});

test(
  "run054: 로그 스트림 실패 — 이후 커맨드 spawn 0, 실패가 기록된다",
  // busy child가 kill되지 않으면 regression이 영구 대기한다 — timeout+kill 가드.
  { timeout: 30000 },
  async () => {
  const temp = mkdtempSync(join(tmpdir(), "run054-logfail-"));
  // 객체 프로퍼티로 들고 있어 TS의 null narrowing을 피한다.
  const ref: { child?: { kill: () => void } } = {};
  try {
    const inner = await claimEvidenceFiles(join(temp, "d"), RUN_SLOTS);
    const bad = new Writable({
      write(_c, _e, cb) {
        cb(new Error("injected log failure"));
      },
    });
    // 실제 claim writer를 유지하고 check.log 스트림만 오류 주입한다.
    const saboteur = {
      dir: inner.dir,
      write: (n: string, d: string | Uint8Array) => inner.write(n, d),
      writeJson: (n: string, o: unknown) => inner.writeJson(n, o),
      seal: (n: string) => inner.seal(n),
      stream: (n: string) => (n === "check.log" ? bad : inner.stream(n)),
      close: () => inner.close(),
    };
    let spawns = 0;
    const r = await run054({
      reserve: async () => saboteur,
      spawnImpl: ((f: string, _a: readonly string[], o: never) => {
        spawns++;
        // 무한히 stdout에 쓰는 busy child — 로그 실패 시 runner가 kill하지
        // 않으면 이 테스트 자체가 영구 대기한다(종료 자체가 bounded 검증).
        ref.child = spawn(
          f,
          [
            "-e",
            "setInterval(()=>{try{process.stdout.write('X'.repeat(16384))}catch{}},1)",
          ],
          o,
        );
        return ref.child;
      }) as never,
    });
    assert.equal(spawns, 1); // check 로그 실패 후 build/unit은 spawn 0
    assert.equal(r.code, 1);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].status, null);
    assert.ok(r.results[0].error);
    const res = JSON.parse(
      readFileSync(join(temp, "d", "result.json"), "utf8"),
    );
    assert.equal("pass" in res, false);
    assert.ok(res.results[0].error);
    await saboteur.close();
  } finally {
    ref.child?.kill(); // regression 보호 — 남은 child를 항상 정리한다.
    rmSync(temp, { recursive: true, force: true });
  }
});

test("run054: close 실패는 command 성공과 무관하게 caller에게 reject된다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "run054-closefail-"));
  try {
    const claims = new Map(
      RUN_SLOTS.map((n) => [
        n,
        {
          name: n,
          path: join(temp, n),
          fh: {
            write: async (buf: Uint8Array, _o: number, len: number) => ({
              bytesWritten: len,
              buffer: buf,
            }),
            close: async () => {
              throw new Error("injected close failure");
            },
          } as never,
          pos: 0,
          written: false,
          fhOpen: true,
        },
      ]),
    );
    const w = new ClaimWriter(temp + sep, claims as never);
    await assert.rejects(
      run054({
        reserve: async () => w,
        spawnImpl: ((f: string, _a: readonly string[], o: never) =>
          spawn(f, ["-e", "process.exit(0)"], o)) as never,
      }),
      /close failure|close failed/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("writer: caller가 write 실패를 catch해도 close는 그 실패를 다시 던진다", async () => {
  const temp = mkdtempSync(join(tmpdir(), "write-fail-close-"));
  try {
    const claims = new Map([
      [
        "a.txt",
        {
          name: "a.txt",
          path: join(temp, "a.txt"),
          fh: {
            write: async () => {
              throw new Error("injected write failure");
            },
            close: async () => {},
          } as never,
          pos: 0,
          written: false,
          fhOpen: true,
        },
      ],
    ]);
    const w = new ClaimWriter(temp + sep, claims as never);
    // caller가 write 실패를 catch해도 조용한 성공 close는 허용되지 않는다.
    await assert.rejects(w.write("a.txt", "x"), /injected write failure/);
    await assert.rejects(w.close(), /injected write failure/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// 슬롯별 실제 wx 파일 충돌 — mock throw가 아니라 claimEvidenceFiles 자체를
// run054에 연결하고, sentinel 1개만 precreate해 거부를 검증한다.
for (const slot of RUN_SLOTS) {
  test(
    "run054: 파일 충돌 " + slot + " — sentinel 불변·이전 claim 보존·spawn 0",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "run054-file-coll-"));
      try {
        const dir = join(temp, "d");
        mkdirSync(dir, { recursive: true });
        const sentinel = Buffer.from("sentinel-" + slot);
        writeFileSync(join(dir, slot), sentinel);
        const sentinelSha = sha256(sentinel);
        let spawns = 0;
        await assert.rejects(
          run054({
            reserve: (_root, names) => claimEvidenceFiles(dir, names),
            spawnImpl: (() => {
              spawns++;
              throw new Error("spawn이 실행되면 안 된다");
            }) as never,
          }),
        );
        assert.equal(spawns, 0);
        assert.equal(
          sha256(readFileSync(join(dir, slot))),
          sentinelSha,
          "sentinel 불변",
        );
        // sentinel 이전에 claim된 빈 파일은 삭제하지 않고 보존된다 [계약].
        const idx = RUN_SLOTS.indexOf(slot);
        for (let i = 0; i < idx; i++) {
          const p = join(dir, RUN_SLOTS[i]);
          assert.ok(existsSync(p), RUN_SLOTS[i] + " claim retained");
          assert.equal(statSync(p).size, 0);
        }
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
}

// 다른 소비자 산출물 명명(PNG·facts·audit·incident)도 같은 helper/실FS
// 계약으로 소비자 0을 검증한다 — 이름 계약은 슬롯과 무관하게 동일하다.
for (const sentinel of [
  "p-001.png",
  "facts.json",
  "audit-after.json",
  "incident.md",
]) {
  test(
    "claim: 소비자 산출물 충돌 " + sentinel + " — 불변·순서 보존·후속 미생성",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "claim-coll-"));
      try {
        const dir = join(temp, "d");
        mkdirSync(dir, { recursive: true });
        const bytes = Buffer.from("prior-" + sentinel);
        writeFileSync(join(dir, sentinel), bytes);
        const before = sha256(bytes);
        const names = ["aa-first.txt", sentinel, "zz-last.txt"];
        await assert.rejects(claimEvidenceFiles(dir, names));
        assert.equal(
          sha256(readFileSync(join(dir, sentinel))),
          before,
          "sentinel 불변",
        );
        // 앞서 생성된 claim은 retain, sentinel 이후 이름은 생성되지 않는다.
        assert.ok(existsSync(join(dir, "aa-first.txt")));
        assert.equal(statSync(join(dir, "aa-first.txt")).size, 0);
        assert.ok(!existsSync(join(dir, "zz-last.txt")));
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
}
