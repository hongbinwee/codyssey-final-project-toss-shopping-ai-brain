import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  open,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { Writable } from "node:stream";
import { join, sep } from "node:path";

// PMQA-054 — 증거 산출물의 쓰기 경로 보호.
//
// 사고 재발 방지 계약:
//   · 새 run dir는 reserveCaptureOutput로 원자 예약한다(EEXIST = fail closed).
//   · 산출 파일은 모두 사전에 'wx' 독점 생성으로 claim한다 — 기존 증거와
//     이름이 충돌하면 소비자(캡처·DB·HTTP) 시작 전에 즉시 실패한다.
//   · 기록은 claim handle/fd를 통해서만 일어난다 — 경로 재open으로 다른
//     파일을 덮어쓰는 경로를 두지 않는다.
//   · claim 이름에 대해 write는 1회뿐이다(written 플래그는 IO 전 동기 소비).
//     stream()도 동일하게 첫 호출에서 소비해 두 번째 기록을 차단한다.
//   · fh.write/writeSync는 partial write가 가능하다 — 모든 쓰기는 전체
//     버퍼가 기록될 때까지 반복하고, 진행이 0바이트면 실패다(미기록 tail을
//     PASS로 두지 않는다 — 증거 truncation 방지) [PMQA-054 품질보완].
//   · 어떤 경로에도 unlink/Remove/덮어쓰기는 없다. claim 실패·미기록 잔여
//     claim·중간 실패 산출물 모두 그대로 보존(retain)한다 — 빈 claim 파일
//     자체가 실행 흔적이다.
//   · close()는 하나의 promise를 공유한다 — 동시/중복 호출이 전체 IO·해제
//     완료 전에 성공을 반환하지 못한다. 모든 claim의 drain+close를 끝까지
//     수행하고 오류를 집계해 던진다.
//
// 한계(정직한 계약): Node fs.open은 Windows에서 share mode를 제어할 수 없으
// 므로 다른 프로세스가 열린 claim 파일을 재open/삭제하는 것까지 OS 수준에서
// 막지는 못한다. 이 계층이 보장하는 것은 O_EXCL 생성·단일 handle 기록·지원
// 경로 외 재open 차단뿐이다.

export async function reserveCaptureOutput(
  root: string,
  runId: string = randomUUID(),
): Promise<string> {
  if (!/^[a-zA-Z0-9-]+$/.test(runId))
    throw new Error("invalid capture run id");
  await mkdir(root, { recursive: true });
  const dir = join(root, "run-" + runId);
  await mkdir(dir); // exclusive: EEXIST means fail closed
  if ((await readdir(dir)).length !== 0)
    throw new Error("capture output directory is not empty");
  return dir + sep;
}

// ── claim 이름 계약 ──────────────────────────────────────────────
// 디렉터리 구분자·상위 참조·숨김 파일은 claim 이름이 될 수 없다. Windows의
// 대소문자 무시 파일시스템까지 고려해 표현을 ASCII 파일명으로 한정한다.
const EVIDENCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function checkEvidenceName(raw: string): void {
  if (
    typeof raw !== "string" ||
    !EVIDENCE_NAME_RE.test(raw) ||
    raw.includes("..") ||
    raw.startsWith(".")
  )
    throw new Error("invalid evidence file name: " + JSON.stringify(raw));
}

// ── full-write 루프 ──────────────────────────────────────────────
// fh.write/writeSync는 partial bytesWritten을 반환할 수 있다. relOff 기준
// 나머지를 모두 기록할 때까지 반복하고, 진행이 0바이트면 즉시 실패한다 —
// 미기록 tail을 조용히 PASS로 두면 증거 truncation이다 [PM 품질보완].
// write fn 주입형이라 짧은 쓰기·0진행을 unit에서 재현한다.
export async function drainWriteAsync(
  buf: Uint8Array,
  write: (part: Uint8Array, relOff: number) => Promise<number>,
): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const n = await write(buf.subarray(off), off);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(
        "evidence write 진행 0바이트 — 미기록 tail 방지를 위해 실패 처리",
      );
    off += n;
  }
}

export function drainWriteSync(
  buf: Uint8Array,
  write: (part: Uint8Array, relOff: number) => number,
): void {
  let off = 0;
  while (off < buf.length) {
    const n = write(buf.subarray(off), off);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(
        "evidence write 진행 0바이트 — 미기록 tail 방지를 위해 실패 처리",
      );
    off += n;
  }
}

export type Claim = {
  name: string;
  path: string;
  fh: FileHandle;
  pos: number;
  written: boolean;
  writable?: Writable;
  streamError?: unknown;
  fhOpen: boolean;
};

export type EvidenceWriter = {
  readonly dir: string;
  write(name: string, data: string | Uint8Array): Promise<void>;
  writeJson(name: string, obj: unknown): Promise<void>;
  // claim된 파일에 쓰는 1회용 Writable — child stdout/stderr 파이프용.
  // 경로 재open 없이 claim handle에 직접 기록한다.
  stream(name: string): Writable;
  // 읽기전용 표시(chmod 0o444) — 보조 장치다. 경로 기반이라 claim 이후
  // inode가 외부에서 교체됐다면 다른 파일을 chmod할 수 있고, 동일 사용자
  // 외부 writer 부재를 절대 보장하지는 못한다 [PM 품질보완].
  seal(name: string): Promise<void>;
  // 하나의 promise 공유 — 전체 drain+handle 해제가 끝나기 전에는 어떤
  // 호출도 성공을 반환하지 않는다. 오류는 집계해 던지고 이후 호출에도
  // 같은 오류를 다시 던진다(조용한 통과 금지).
  close(): Promise<void>;
};

export class ClaimWriter implements EvidenceWriter {
  private closed = false;
  private closingPromise: Promise<void> | null = null;
  // 진행 중 write/drain — close는 이것들이 전부 settle한 뒤에만 handle을
  // 닫는다(진행 중 partial write와 handle close의 경합 차단) [Luna QA-A].
  private readonly pending = new Set<Promise<unknown>>();
  // settle된 write 실패 — 호출자가 rejection을 catch해도 close에서 다시
  // 집계해 조용한 성공을 막는다 [Luna QA/PM 보완].
  private readonly failedWrites: unknown[] = [];
  readonly dir: string;
  private readonly claims: Map<string, Claim>;
  constructor(dir: string, claims: Map<string, Claim>) {
    this.dir = dir;
    this.claims = claims;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    // p.finally()의 파생 promise는 버리지 않는다 — 두 handler로 settle만
    // 관리해 reject 파생이 unhandled가 되지 않게 한다. 실패는 pending 해제와
    // 별개로 failedWrites에 보존한다 [PM 보완].
    p.then(
      () => {
        this.pending.delete(p);
      },
      (e) => {
        this.failedWrites.push(e);
        this.pending.delete(p);
      },
    );
    return p;
  }

  // written은 실제 IO 전에 동기로 소비한다 — 같은 claim에 대한 동시 2호출
  // 또는 실패 후 재시도이 두 번째 기록을 만들지 못한다.
  private claimFor(name: string): Claim {
    if (this.closed) throw new Error("evidence writer already closed");
    const c = this.claims.get(name);
    if (!c) throw new Error("evidence file not claimed: " + name);
    if (c.written) throw new Error("evidence file already written: " + name);
    c.written = true;
    return c;
  }

  async write(name: string, data: string | Uint8Array): Promise<void> {
    const c = this.claimFor(name);
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const start = c.pos;
    const p = this.track(
      drainWriteAsync(buf, (part, rel) =>
        c.fh
          .write(part, 0, part.length, start + rel)
          .then((r) => r.bytesWritten),
      ).then(() => {
        c.pos += buf.length;
      }),
    );
    await p;
  }

  async writeJson(name: string, obj: unknown): Promise<void> {
    await this.write(name, JSON.stringify(obj, null, 2));
  }

  stream(name: string): Writable {
    const c = this.claimFor(name);
    const w = new Writable({
      write: (chunk, _enc, cb) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const start = c.pos;
        const p = this.track(
          drainWriteAsync(buf, (part, rel) =>
            c.fh
              .write(part, 0, part.length, start + rel)
              .then((r) => r.bytesWritten),
          ).then(() => {
            c.pos += buf.length;
          }),
        );
        p.then(() => cb(), cb);
      },
    });
    // 상시 error listener — 미부착 'error' 이벤트의 unhandled crash를 막고,
    // close 시점 이전에 관측된 오류를 기억한다(나중에 once를 걸면 hang).
    w.on("error", (e) => {
      c.streamError = e;
    });
    c.writable = w;
    return w;
  }

  async seal(name: string): Promise<void> {
    const c = this.claims.get(name);
    if (!c) throw new Error("evidence file not claimed: " + name);
    await chmod(c.path, 0o444);
  }

  close(): Promise<void> {
    // 하나의 close 작업만 실행된다 — 두 번째 호출은 같은 promise를 기다려
    // 전체 IO·해제가 끝나기 전 성공을 반환하지 못한다.
    if (!this.closingPromise) this.closingPromise = this.doClose();
    return this.closingPromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    const errs: unknown[] = [];
    // 진행 중 write/drain이 전부 settle할 때까지 기다린다 — close가 pending
    // partial write와 handle 해제를 경합시키지 않는다 [Luna QA-A]. settle된
    // 실패는 track handler가 이미 failedWrites에 보존했다.
    await Promise.allSettled([...this.pending]);
    errs.push(...this.failedWrites);
    for (const c of this.claims.values()) {
      if (c.writable) {
        const w = c.writable;
        c.writable = undefined;
        if (c.streamError !== undefined && !this.failedWrites.includes(c.streamError)) {
          errs.push(c.streamError);
        } else if (w.writableFinished) {
          // 정상 완료 — 대기 불필요.
        } else if (w.destroyed || w.closed) {
          // error 없이 destroy/close된 미완료 stream — pending data가 있을
          // 수 있다. 성공으로 간주하지 않고 실패+retain [Luna QA-B].
          errs.push(
            new Error(
              "stream prematurely closed without finish: " + c.name,
            ),
          );
        } else {
          // finish/error/close 전부 감시 — finish만 기다리면 premature
          // 'close' 이벤트에서 once(finish)가 영구 hang한다 [Luna QA-B].
          const finished = Promise.race([
            once(w, "finish").then(() => "finish" as const),
            once(w, "close").then(() => "close" as const),
          ]);
          w.end();
          try {
            const outcome = await finished;
            if (c.streamError !== undefined) {
              errs.push(c.streamError);
            } else if (outcome === "close") {
              errs.push(
                new Error("stream closed before finish: " + c.name),
              );
            }
          } catch (e) {
            errs.push(e);
          }
        }
      }
      if (c.fhOpen) {
        try {
          await c.fh.close();
        } catch (e) {
          errs.push(e);
        }
        c.fhOpen = false;
      }
    }
    if (errs.length)
      throw new Error(
        "evidence close failed: " +
          errs.map((e) => (e instanceof Error ? e.message : String(e))).join(" | "),
      );
  }
}

// dir 아래 names 전부를 'wx' 독점 생성으로 사전 claim한다. 하나라도 기존
// 파일과 충돌하면 이미 연 handle만 닫고 실패한다 — 생성된 claim 파일은
// 삭제하지 않고 보존한다(abort 흔적).
export async function claimEvidenceFiles(
  dir: string,
  names: readonly string[],
): Promise<EvidenceWriter> {
  await mkdir(dir, { recursive: true });
  const claims = new Map<string, Claim>();
  const seen = new Set<string>();
  try {
    for (const name of names) {
      checkEvidenceName(name);
      if (seen.has(name))
        throw new Error("duplicate evidence name: " + name);
      seen.add(name);
      const path = join(dir, name);
      const fh = await open(path, "wx");
      claims.set(name, { name, path, fh, pos: 0, written: false, fhOpen: true });
    }
  } catch (e) {
    for (const c of claims.values()) {
      c.fhOpen = false;
      await c.fh.close().catch(() => {});
    }
    throw e;
  }
  return new ClaimWriter(dir, claims);
}

// 예약된 새 run dir + planned 산출물 전체 사전 claim을 한 번에 묶는다.
export async function reserveEvidenceRun(
  root: string,
  names: readonly string[],
  runId: string = randomUUID(),
): Promise<EvidenceWriter> {
  const dir = await reserveCaptureOutput(root, runId);
  return claimEvidenceFiles(dir, names);
}

// ── 동기 변형 ────────────────────────────────────────────────────
// launcher/audit 경로(readonly-audit.ts)처럼 동기 deps에서 쓴다. 계약은
// async 변형과 동일하다 — wx 사전 claim, full-write 루프, 1회 기록,
// retain, 오류 집계 close.
type SyncClaim = {
  name: string;
  path: string;
  fd: number;
  pos: number;
  written: boolean;
  fdOpen: boolean;
};

export type SyncEvidenceWriter = {
  readonly dir: string;
  write(name: string, data: string | Uint8Array): void;
  writeJson(name: string, obj: unknown): void;
  seal(name: string): void;
  close(): void;
};

export function claimEvidenceFilesSync(
  dir: string,
  names: readonly string[],
): SyncEvidenceWriter {
  mkdirSync(dir, { recursive: true });
  const claims = new Map<string, SyncClaim>();
  const seen = new Set<string>();
  try {
    for (const name of names) {
      checkEvidenceName(name);
      if (seen.has(name))
        throw new Error("duplicate evidence name: " + name);
      seen.add(name);
      const path = join(dir, name);
      const fd = openSync(path, "wx");
      claims.set(name, { name, path, fd, pos: 0, written: false, fdOpen: true });
    }
  } catch (e) {
    for (const c of claims.values()) {
      c.fdOpen = false;
      try {
        closeSync(c.fd);
      } catch {
        /* handle 해제 실패는 claim 실패 경로에서 부차적이다 */
      }
    }
    throw e;
  }

  let closed = false;
  const claimFor = (name: string): SyncClaim => {
    if (closed) throw new Error("evidence writer already closed");
    const c = claims.get(name);
    if (!c) throw new Error("evidence file not claimed: " + name);
    if (c.written) throw new Error("evidence file already written: " + name);
    c.written = true;
    return c;
  };

  const writer: SyncEvidenceWriter = {
    dir,
    write(name: string, data: string | Uint8Array): void {
      const c = claimFor(name);
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const start = c.pos;
      drainWriteSync(buf, (part, rel) =>
        writeSync(c.fd, part, 0, part.length, start + rel),
      );
      c.pos += buf.length;
    },
    writeJson(name: string, obj: unknown): void {
      writer.write(name, JSON.stringify(obj, null, 2));
    },
    seal(name: string): void {
      const c = claims.get(name);
      if (!c) throw new Error("evidence file not claimed: " + name);
      chmodSync(c.path, 0o444);
    },
    close(): void {
      if (closed) return;
      closed = true;
      const errs: unknown[] = [];
      for (const c of claims.values()) {
        if (c.fdOpen) {
          try {
            closeSync(c.fd);
          } catch (e) {
            errs.push(e);
          }
          c.fdOpen = false;
        }
      }
      if (errs.length)
        throw new Error(
          "evidence close failed: " +
            errs
              .map((e) => (e instanceof Error ? e.message : String(e)))
              .join(" | "),
        );
    },
  };
  return writer;
}
