// PMQA-055 worker child — 실제 Node IPC(process.send)로만 증거 메시지를
// 보낸다. init {nonce, payloads:[{slot,data}]}를 받으면 전송 후 종료.
// worker는 파일 경로·handle을 모른다 — slot 이름과 nonce만 사용한다.
import { createWorkerClient } from "./evidence-broker.ts";

process.on("message", (m) => {
  if (!m || m.type !== "init") return;
  // hold — 부모가 kill/signal lifecycle을 검증할 수 있도록 종료하지 않고
  // 대기한다. init은 받았으므로 IPC는 연결된 상태다.
  if (m.hold) {
    setInterval(() => {}, 1000);
    return;
  }
  const w = createWorkerClient({
    nonce: m.nonce,
    send: (msg) => process.send(msg),
  });
  for (const p of m.payloads ?? []) w.submit(p.slot, p.data);
  process.exit(0);
});

