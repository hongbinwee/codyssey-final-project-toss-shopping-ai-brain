// PMQA-055 — parent broker / worker client (DB-free, 실제 IPC·PW·DB 없음).
//
// 계약:
//   - 부모가 새 run dir + planned slot 전부를 wx 독점 claim하고, 기록은
//     held FileHandle로만 한다 — 일반 mode 재open은 없다.
//   - worker는 slot "이름"과 run nonce만 알고 {nonce, slot, data} 메시지를
//     보낸다 — path/fd/handle은 절대 노출하지 않는다.
//   - duplicate·concurrent·in-flight 실패·abort·close 오류는 전부 FAIL이고
//     기존 bytes는 불변이다 — 조용한 성공 없음.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import {
  checkEvidenceName,
  claimEvidenceFiles,
  reserveCaptureOutput,
  type EvidenceWriter,
} from "./capture-output.ts";

export type BrokerMessage = {
  nonce: string;
  slot: string;
  data: string;
  encoding?: "utf8" | "base64";
};

export type SendFn = (msg: BrokerMessage) => void;

export class EvidenceBroker {
  readonly dir: string;
  readonly nonce: string;
  readonly slots: readonly string[];
  // completeness는 선택된 종료 경로 필수만 검사한다 — 조건부 slot(예:
  // audit-after vs audit-fail)을 전부 기록해야 성공이면 정상 run도 실패한다.
  private readonly required: readonly string[];
  private readonly oneOf: readonly (readonly string[])[];
  // 경로 조건부 완전성 — trigger slot이 기록됐다는 것은 그 경로(예: spawn
  // 실행)가 실제로 시작됐다는 뜻이다. 그 경로의 implied set은 전부 기록돼야
  // 완료다 — required[]+oneOf만으로는 exit 0 + 필수 산출물 미기록 run이
  // PASS할 수 있다 [PM 056 수용기준].
  private readonly implies: readonly {
    when: string;
    require: readonly string[];
  }[];
  private readonly writer: EvidenceWriter;
  // slot은 IO 전에 동기로 소비한다 — 동시 2제출이 두 번 기록하지 못한다.
  private readonly consumed = new Set<string>();
  private abortReason: string | null = null;
  // 거부/실패는 sticky — 한 번이라도 submit이 실패하면 run 전체가 FAIL이고
  // close()도 정상 성공을 반환하지 않는다 [Luna QA].
  private failed: string | null = null;

  constructor(input: {
    dir: string;
    writer: EvidenceWriter;
    slots: readonly string[];
    nonce: string;
    required?: readonly string[];
    oneOf?: readonly (readonly string[])[];
    implies?: readonly { when: string; require: readonly string[] }[];
  }) {
    this.dir = input.dir;
    this.writer = input.writer;
    this.slots = Object.freeze([...input.slots]);
    this.nonce = input.nonce;
    this.required = input.required ?? this.slots;
    this.oneOf = input.oneOf ?? [];
    this.implies = input.implies ?? [];
  }

  // 부모 수신 경로 — 모든 검증은 write 전에 완료된다. 실패는 throw.
  async submit(msg: BrokerMessage): Promise<void> {
    try {
      if (this.abortReason)
        throw new Error("broker aborted: " + this.abortReason);
      if (!msg || typeof msg !== "object")
        throw new Error("malformed broker message");
      if (typeof msg.nonce !== "string" || msg.nonce !== this.nonce)
        throw new Error("broker nonce mismatch");
      checkEvidenceName(msg.slot);
      if (!this.slots.includes(msg.slot))
        throw new Error("unclaimed slot: " + String(msg.slot));
      if (this.consumed.has(msg.slot))
        throw new Error("slot already written: " + msg.slot);
      if (typeof msg.data !== "string")
        throw new Error("broker message data must be string");
      if (
        msg.encoding !== undefined &&
        msg.encoding !== "utf8" &&
        msg.encoding !== "base64"
      )
        throw new Error("malformed broker encoding");
      this.consumed.add(msg.slot);
      const buf =
        msg.encoding === "base64"
          ? Buffer.from(msg.data, "base64")
          : msg.data;
      await this.writer.write(msg.slot, buf);
    } catch (e) {
      // 어떤 거부든 전체 run을 실패로 고정한다 — catch해도 close 성공 불가.
      this.failed = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  // 중간 abort — 이후 submit은 전부 거부, close도 실패로 전파한다.
  abort(reason: string): void {
    if (!this.abortReason) this.abortReason = reason;
  }

  private closing: Promise<void> | null = null;

  // 현재 실패 사유를 계산한다 — abort·sticky 거부·미기록 manifest slot.
  private computeFailure(): string | null {
    const parts: string[] = [];
    if (this.abortReason) parts.push("aborted: " + this.abortReason);
    if (this.failed) parts.push(this.failed);
    // incomplete manifest — 필수 planned slot 중 미기록이 있으면 실패다
    // (worker 조기 종료로 절반만 기록된 run을 완료로 보지 않는다).
    for (const s of this.required)
      if (!this.consumed.has(s)) parts.push("manifest slot unwritten: " + s);
    // 조건부 그룹 — 각 그룹에서 최소 하나는 선택되어 기록돼야 한다.
    for (const g of this.oneOf)
      if (!g.some((s) => this.consumed.has(s)))
        parts.push("manifest oneOf slot unwritten: " + g.join("|"));
    // 경로 조건부 — trigger가 기록됐으면 implied set도 전부 필요하다.
    for (const imp of this.implies)
      if (this.consumed.has(imp.when))
        for (const s of imp.require)
          if (!this.consumed.has(s))
            parts.push(
              "manifest implied slot unwritten: " + s +
                " (after " + imp.when + ")",
            );
    return parts.length ? parts.join(" | ") : null;
  }

  // 하나의 close 작업만 실행된다 — 두 번째 호출은 같은 promise를 기다린다.
  async close(): Promise<void> {
    if (!this.closing) this.closing = this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    const early = this.computeFailure();
    if (early) {
      // 해제 오류도 보존한다 — 실패 사유와 합쳐 던진다.
      try {
        await this.writer.close();
      } catch (e) {
        throw new Error(
          early + " | close: " + (e instanceof Error ? e.message : String(e)),
        );
      }
      throw new Error(early);
    }
    try {
      await this.writer.close();
    } catch (e) {
      throw e;
    }
    // drain 이후 재확인 — close 진행 중 발생한 duplicate/abort·늦은 실패도
    // 최초 close 성공으로 누락하지 않는다 [Luna QA].
    const late = this.computeFailure();
    if (late) throw new Error(late);
  }
}

// dir 예약(EEXIST fail-closed) → manifest 이름 검증 → 슬롯별 wx claim.
// 어느 단계에서 실패해도 worker/consumer에는 도달하지 않는다.
export async function reserveBrokerRun(
  root: string,
  slots: readonly string[],
  runId: string = randomUUID(),
  opts: {
    required?: readonly string[];
    oneOf?: readonly (readonly string[])[];
    implies?: readonly { when: string; require: readonly string[] }[];
  } = {},
): Promise<EvidenceBroker> {
  for (const s of slots) checkEvidenceName(s);
  const dir = await reserveCaptureOutput(root, runId);
  const writer = await claimEvidenceFiles(dir, slots);
  return new EvidenceBroker({
    dir,
    writer,
    slots,
    nonce: randomUUID(),
    required: opts.required,
    oneOf: opts.oneOf,
    implies: opts.implies,
  });
}

// worker 측 송신 — transport는 주입된다(실제 IPC 미사용 시 MockSpy).
export function createWorkerClient(input: { nonce: string; send: SendFn }) {
  return {
    submit(slot: string, data: string | Uint8Array): void {
      checkEvidenceName(slot);
      const msg: BrokerMessage =
        typeof data === "string"
          ? { nonce: input.nonce, slot, data }
          : {
              nonce: input.nonce,
              slot,
              data: Buffer.from(data).toString("base64"),
              encoding: "base64",
            };
      input.send(msg);
    },
  };
}

// ── 실제 로컬 IPC 연결 (Node child_process IPC 채널) ───────────────────
// 실제 channel 구현은 승인 범위다 — parent는 받은 메시지를 submit으로만
// 전달하고 fd/path는 절대 worker에 넘기지 않는다. 반환된 pending은 child
// exit 후 호출자가 await한다.
export type IpcParentHandle = {
  readonly pending: Promise<unknown>[];
  readonly errors: unknown[];
  // child exit — code·signal을 전달한다. 0 외 code·signal·error·조기
  // disconnect는 broker.abort로 연결돼 close가 성공하지 못한다 [PMQA-056].
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
};

export function attachIpcParent(
  broker: EvidenceBroker,
  child: {
    on: (ev: string, cb: (...args: any[]) => void) => unknown;
    once: (ev: string, cb: (...args: any[]) => void) => unknown;
  },
): IpcParentHandle {
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  child.on("message", (m) => {
    pending.push(
      Promise.resolve(broker.submit(m as BrokerMessage)).catch((e) => {
        errors.push(e); // 거부는 sticky로 run을 실패시킨다 — 조용한 손실 없음
      }),
    );
  });
  // lifecycle — worker error/nonzero exit/signal/mid-termination은 전부
  // 상위 실행 실패다. incomplete evidence는 성공하지 못한다 [PMQA-056].
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      let settled = false;
      const finish = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      };
      child.once("error", (e: unknown) => {
        // spawn 실패 등 — exit 없이 종료될 수 있으므로 exited를 즉시
        // 해소해 상위가 hang 없이 FAIL을 받도록 한다 [PM QA 056].
        broker.abort(
          "worker error: " + (e instanceof Error ? e.message : String(e)),
        );
        finish(null, null);
      });
      child.once("disconnect", () => {
        // 정상 Node child도 disconnect가 exit보다 먼저 올 수 있다 —
        // 자체로는 실패가 아니다. 중간 종료는 뒤따르는 비정상 exit/
        // signal이 잡는다 [PM QA 056].
      });
      child.once(
        "exit",
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (code !== 0 || signal !== null)
            broker.abort(
              "worker exit code=" + String(code) + " signal=" + String(signal),
            );
          finish(code, signal);
        },
      );
    },
  );
  return { pending, errors, exited };
}

// Windows 재귀 삭제 전 resolved self-owned 검증 — 허용 root 밖 경로나
// symlink 대상은 절대 rm -rf하지 않는다 [PMQA-056].
export function safeRmrf(dir: string, allowedRoot: string): void {
  const w = resolve(dir);
  if (lstatSync(w).isSymbolicLink())
    throw new Error("rmrf 대상 symlink 금지: " + w);
  const wc = canon(w);
  const rc = canon(allowedRoot);
  if (wc === rc || !wc.startsWith(rc + sep))
    throw new Error("rmrf 대상이 허용 root 밖: " + w);
  rmSync(w, { recursive: true, force: true });
}

// ── PW 격리 작업 디렉터리 ─────────────────────────────────────────────
// PW의 outputDir 초기삭제·.last-run 일반 write·error-context는 자기 새
// workdir 안에서만 일어난다. evidence/backup/src/이전 run과 분리한다.
// 경로 비교는 realpath+lowercase — Windows case-insensitive와 junction을
// lexical 비교로 우회하지 못한다.
const canon = (p: string): string => {
  let real = p;
  try {
    real = realpathSync(p);
  } catch {
    // 없는 경로는 lexical — 존재 확인은 호출부가 한다.
  }
  return resolve(real).toLowerCase();
};

// 보호 루트 — PW workdir가 이 경로들과 같거나 포함/포함되면 거부한다.
export const PW_PROTECTED_DIRS: readonly string[] = Object.freeze([
  "shots",
  "reference",
  "src",
  "backups",
  "test-results",
  "node_modules",
]);

export async function reservePwWorkdir(
  root: string,
  runId: string = randomUUID(),
): Promise<string> {
  const dir = await reserveCaptureOutput(root, "pw-" + runId);
  // symlink/junction/path traversal — 실제 경로가 root 안이어야 한다.
  if (!canon(dir).startsWith(canon(root) + sep))
    throw new Error("pw workdir가 root를 벗어남: " + dir);
  // 보호 루트와의 중첩도 예약 시점에 거부한다 — 호출자가 검사를 빼먹을 수 없다.
  assertPwIsolation({ workDir: dir });
  return dir;
}

// workdir와 evidence 경로는 서로를 포함할 수 없다 — 중첩 시 실행 전 거부.
export function assertPwIsolation(opts: {
  workDir: string;
  evidenceDirs?: readonly string[];
  protectedRoots?: readonly string[];
}): void {
  const w = resolve(opts.workDir);
  if (!existsSync(w) || !statSync(w).isDirectory())
    throw new Error("pw workdir가 실제 디렉터리가 아님: " + w);
  const st = lstatSync(w);
  if (st.isSymbolicLink())
    throw new Error("pw workdir symlink 금지: " + w);
  if (canon(w) !== w.toLowerCase())
    throw new Error("pw workdir junction/alias 의심: " + w);
  const wc = canon(w);
  const roots = [
    ...(opts.evidenceDirs ?? []),
    ...(opts.protectedRoots ?? PW_PROTECTED_DIRS).map((d) => resolve(d)),
  ];
  for (const e of roots) {
    const ev = canon(e);
    if (wc === ev || wc.startsWith(ev + sep) || ev.startsWith(wc + sep))
      throw new Error("pw workdir↔보호 경로 중첩 금지: " + w);
  }
}

// 상속된 output/reporter override·CLI 직접 실행을 차단한다 — env는
// case-insensitive 비교(Windows 혼합 case 우회 차단), OUTPUT_NAME 포함.
const PW_OVERRIDE_ENV_RE = /^(playwright_|output_name|pwio_)/i;

// argv 계약 — 호출자는 전체 process.argv를 넘긴다(argv[0]=node,
// argv[1]=entry script). 빈 argv는 env만 검사한다(launcher preflight의
// env 전용 검사 경로). 설치본 실측 [runner/index.js:1915]:
//   · runner — node <pw-cli> test -c <config>: 사용자 argv는
//     정확히 ["test","-c","<config>"]다.
//   · fork 자식 — ProcessHost.fork(entryScript)는 args를 넘기지 않는다:
//     worker/loader 재평가의 정상 사용자 argv는 비어있다. worker는
//     workerProcessEntry.js가 config 재평가 전 TEST_WORKER_INDEX를 설정한다.
//   그 외의 bare arg·중복/결합 -c·다른 -c 대상·임의 flag·알 수 없는
//   entry는 전부 거부다 — denylist는 불완전하므로 정확한 정상 argv만
//   통과시킨다 [PM QA-056 ③].
const PW_RUNNER_OK_FORMS = (
  cfg: string,
): readonly (readonly string[])[] => [
  ["test", "-c", cfg],
  ["--version"],
  ["--help"],
  ["-h"],
  ["--list"],
];

// 무인자 fork 자식의 정상 entry — 표준 test 경로의 유일 out-of-process
// 자식은 workerProcessEntry다. 설치본 실측: 표준 'playwright test' 실행은
// in-process loader를 쓴다(runner/index.js:6952 createLoadTask
// ("in-process")). loaderProcessEntry fork는 test server/IDE 경로 전용
// (:2092 OutOfProcessLoaderHost, :6782/:6858/:6884)이라 미지원 — 이 경로의
// 무인자 eval은 worker entry만 통과시키고 나머지는 fail-closed로 거부한다
// [PM QA-056 ③ — loader 미사용 근거 기록].
const PW_WORKER_ENTRY = "workerProcessEntry.js";

export function assertNoPwOverrides(opts: {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  // 부모가 runner를 spawned 할 때 쓰는 "-c <이 설정 파일>" 형태만 허용한다.
  // 지정되지 않으면 사용자 인자가 있는 argv는 전부 거부다 [PMQA-056 ③].
  allowedConfig?: string;
}): void {
  const a = opts.argv;
  const wi = opts.env.TEST_WORKER_INDEX;
  const wiNumeric =
    wi !== undefined &&
    wi.length > 0 &&
    [...wi].every((c) => c >= "0" && c <= "9");
  // 검증된 fork worker 형태 — numeric TEST_WORKER_INDEX + entry basename이
  // workerProcessEntry.js + 사용자 인자 0. env 검사보다 먼저 계산한다:
  // Playwright가 fork worker env에 PLAYWRIGHT_TEST='1'을 스스로 심는다
  // (설치본 coreBundle:8185 setPlaywrightTestProcessEnv() → :8186 exact
  // '1'; ProcessHost env 상속 :1920). 이 형태에서만 그 한 키를 통과시켜야
  // worker의 config 재평가가 산다 [PMQA-057-2].
  const isVerifiedWorker =
    wiNumeric &&
    a.length === 2 &&
    !!a[1] &&
    basename(a[1]) === PW_WORKER_ENTRY;
  for (const k of Object.keys(opts.env)) {
    // exact key + exact value '1' + 검증된 worker 형태에서만 예외다 —
    // mixed-case 키·다른 값·runner argv·env-only·무인자 fork·인자 첨부
    // 형태는 전부 기존 prefix deny 그대로 차단된다.
    if (
      k === "PLAYWRIGHT_TEST" &&
      opts.env[k] === "1" &&
      isVerifiedWorker
    )
      continue;
    if (PW_OVERRIDE_ENV_RE.test(k))
      throw new Error("PW override env 차단: " + k);
  }
  if (!a.length) return; // env 전용 검사 경로 (preflight)
  if (a.length < 2 || !a[1])
    throw new Error("PW argv 불완전 — entry script 위치 없음");
  const user = a.slice(2);
  if (wiNumeric) {
    // fork worker 정상 argv — 정확히 [node, workerProcessEntry.js]다.
    if (basename(a[1]) !== PW_WORKER_ENTRY)
      throw new Error("PW worker entry 불일치: " + a[1]);
    if (user.length)
      throw new Error(
        "PW worker argv 허용 외 인자: " + JSON.stringify(user),
      );
    return;
  }
  if (!user.length) {
    // worker env 미설정 무인자 자식 — 표준 경로에서 지원하는 worker
    // entry만 통과한다(loader fork는 미지원 — in-process loader 실측).
    if (basename(a[1]) !== PW_WORKER_ENTRY)
      throw new Error("PW fork entry 불일치: " + a[1]);
    return;
  }
  if (!opts.allowedConfig)
    throw new Error(
      "PW argv 허용 외 — 허용 config 없는 인자: " + JSON.stringify(user),
    );
  const ok = PW_RUNNER_OK_FORMS(opts.allowedConfig).some(
    (f) => f.length === user.length && f.every((v, i) => user[i] === v),
  );
  if (!ok)
    throw new Error(
      "PW runner argv 허용 형태 외: " + JSON.stringify(user),
    );
}

