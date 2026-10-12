// PMQA-056 — 실제 로컬 통신 채널 (127.0.0.1 loopback, newline-delimited
// JSON). worker submit은 parent가 broker.submit으로 기록한 뒤 ACK를 돌려
// 보낸다 — parent write 오류는 worker submit의 rejection과 최종 verdict
// 까지 전달된다 (fire-and-forget 아님).
//
// 전송 수준 오류(malformed frame·oversize·socket error·ACK write 실패)는
// broker.submit에 도달하지 못해 sticky 거부가 생기지 않는다 — 이런 오류는
// broker.abort로 연결해 run 전체를 fail-closed로 만들고 channel.close도
// 성공을 반환하지 않는다 [PM QA 056].
import { createServer, connect, type Server, type Socket } from "node:net";
import type { EvidenceBroker, BrokerMessage } from "./evidence-broker.ts";

const DEFAULT_MAX_LINE = 64 * 1024 * 1024;
const DEFAULT_ACK_TIMEOUT_MS = 30_000;

const msgOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// broker.submit 거부(설계된 ACK 오류)와 전송 수준 오류를 구분하는 표식.
const transportErr = (m: string): Error => {
  const e = new Error(m);
  (e as { transport?: boolean }).transport = true;
  return e;
};
const isTransport = (e: unknown): boolean =>
  (e as { transport?: boolean } | null)?.transport === true;

export type BrokerChannel = {
  readonly port: number;
  readonly errors: unknown[];
  close(): Promise<void>;
};

// parent 측 서버 — 메시지당 {id,ok}|{id,error} ACK를 돌린다.
export async function startBrokerChannel(
  broker: EvidenceBroker,
  opts: { maxLineBytes?: number } = {},
): Promise<BrokerChannel> {
  const maxLine = opts.maxLineBytes ?? DEFAULT_MAX_LINE;
  const errors: unknown[] = [];
  const socks = new Set<Socket>();
  const pending = new Set<Promise<unknown>>();
  // 전송 수준 오류 공통 처리 — 기록 + broker abort (run FAIL 보장).
  const fail = (e: unknown) => {
    errors.push(e);
    broker.abort("channel: " + msgOf(e));
  };
  const server: Server = createServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    // socket error — 데이터 유실 가능성이 있으므로 fail-closed.
    sock.on("error", (e) => fail(e));
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let id: unknown = null;
        const raw = (async () => {
          let m: BrokerMessage & { id?: unknown };
          try {
            m = JSON.parse(line) as BrokerMessage & { id?: unknown };
          } catch {
            // parse 실패 — broker에 도달하지 못한 전송 수준 오류.
            throw transportErr("malformed frame");
          }
          id = m.id;
          // 거부(nonce/duplicate/unclaimed)는 broker가 sticky로 기록 —
          // error ACK로 worker에 그대로 돌린다 (설계된 경로).
          await broker.submit(m);
          try {
            sock.write(JSON.stringify({ id, ok: true }) + "\n");
          } catch {
            throw transportErr("ack write failed");
          }
        })();
        // settle-safe — rejection은 여기서 모두 소비되므로 finally 파생
        // promise도 unhandled가 되지 않는다 [PM QA 056].
        const settled: Promise<void> = raw.then(
          () => {},
          (e: unknown) => {
            errors.push(e);
            // 전송 수준 오류만 abort — broker 거부는 sticky가 이미 FAIL.
            if (isTransport(e)) broker.abort("channel: " + msgOf(e));
            try {
              sock.write(
                JSON.stringify({ id, ok: false, error: msgOf(e) }) + "\n",
              );
            } catch (e2) {
              fail(e2);
            }
          },
        );
        pending.add(settled);
        settled.finally(() => pending.delete(settled)).catch(() => {});
      }
      if (buf.length > maxLine) {
        fail(transportErr("oversize frame"));
        sock.destroy();
      }
    });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    errors,
    // channel close + pending drain — 기록 중인 submit이 끝난 뒤 닫는다.
    // 누적된 오류가 있으면 close는 성공을 반환하지 않는다 [PM QA 056].
    close: async () => {
      for (const s of socks) s.destroy();
      await Promise.allSettled([...pending]);
      await new Promise<void>((res) => server.close(() => res()));
      if (errors.length) throw errors[0];
    },
  };
}

export type ChannelWorkerClient = {
  submit(slot: string, data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
};

// worker 측 클라이언트 — submit은 parent ACK까지 기다리고, parent 거부/
// write 오류는 그대로 reject된다. malformed ACK·socket error·close·
// timeout은 pending 전부를 reject하고 이후 submit도 즉시 실패한다 —
// 무한 대기 없음 [PM QA 056].
export async function connectWorkerClient(opts: {
  nonce: string;
  port: number;
  ackTimeoutMs?: number;
}): Promise<ChannelWorkerClient> {
  const ackTimeout = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const sock = connect(opts.port, "127.0.0.1");
  let dead: Error | null = null;
  let closedFlag = false;
  const waits = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  const failAll = (e: Error) => {
    if (!dead) dead = e;
    for (const w of waits.values()) w.reject(dead);
    waits.clear();
  };
  sock.on("error", (e) => failAll(e instanceof Error ? e : new Error(msgOf(e))));
  sock.on("close", () => failAll(new Error("channel closed before ack")));
  // connect 실패는 error로 표면화한다 — connect만 기다리면 unhandled.
  await new Promise<void>((res, rej) => {
    const onErr = (e: unknown) =>
      rej(e instanceof Error ? e : new Error(msgOf(e)));
    sock.once("connect", () => {
      sock.off("error", onErr);
      res();
    });
    sock.once("error", onErr);
  });
  let nextId = 1;
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: { id?: unknown; ok?: unknown; error?: unknown };
      try {
        m = JSON.parse(line) as typeof m;
      } catch {
        // malformed ACK는 어느 submit과도 매칭 불가 — 무시하면 무한 wait.
        // 채널을 실패로 고정하고 pending 전부를 reject한다.
        failAll(new Error("malformed ack frame"));
        sock.destroy();
        return;
      }
      const w = waits.get(m.id as number);
      if (w) {
        waits.delete(m.id as number);
        if (m.ok) w.resolve();
        else w.reject(new Error(String(m.error ?? "broker rejected")));
      }
      // 알 수 없는 id의 ACK — 무시한다 (이미 timeout/close로 정리됐을 수 있음).
    }
  });
  return {
    submit(slot, data) {
      if (dead || closedFlag)
        return Promise.reject(dead ?? new Error("channel closed"));
      const id = nextId++;
      const msg: BrokerMessage & { id: number } =
        typeof data === "string"
          ? { id, nonce: opts.nonce, slot, data }
          : {
              id,
              nonce: opts.nonce,
              slot,
              data: Buffer.from(data).toString("base64"),
              encoding: "base64",
            };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const p = new Promise<void>((resolve, reject) => {
        waits.set(id, {
          resolve: () => {
            if (timer) clearTimeout(timer);
            resolve();
          },
          reject: (e) => {
            if (timer) clearTimeout(timer);
            reject(e);
          },
        });
      });
      // ACK가 오지 않는 서버에 대한 무한 대기 방지.
      timer = setTimeout(() => {
        const w = waits.get(id);
        if (w) {
          waits.delete(id);
          w.reject(new Error("ack timeout"));
        }
      }, ackTimeout);
      if (typeof timer.unref === "function") timer.unref();
      try {
        sock.write(JSON.stringify(msg) + "\n");
      } catch (e) {
        waits.delete(id);
        const err = e instanceof Error ? e : new Error(msgOf(e));
        failAll(err);
        return Promise.reject(err);
      }
      return p;
    },
    close: () => {
      closedFlag = true;
      return new Promise<void>((res) => {
        if (sock.destroyed) {
          res();
          return;
        }
        sock.end(() => res());
      });
    },
  };
}

