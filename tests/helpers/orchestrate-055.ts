// PMQA-055 — broker stage orchestration (DB-free).
// 모든 claim + PW workdir + IPC 준비가 성공한 뒤에만 DB connect / child /
// PW server 단계가 호출된다. 사전조건 실패 시 후속 단계는 0회 실행된다.
import type { EvidenceBroker } from "./evidence-broker.ts";

export type OrchestrationDeps = {
  reserve: () => Promise<EvidenceBroker>;
  prepareWorkdir: () => Promise<string>;
  prepareIpc: () => Promise<void>;
  connectDb: () => Promise<unknown>;
  startChild: () => Promise<unknown>;
  startPwServer?: () => Promise<unknown>;
};

export type OrchestrationResult = {
  dir: string;
  workDir: string;
  stages: readonly string[]; // 실제 도달한 stage — facts 기록용
};

// stage 순서는 계약이다 — reserve가 실패하면 어떤 준비/연결도 없고,
// workdir/IPC 실패 시 connectDb·startChild·startPwServer는 호출되지 않는다.
// close 오류·abort는 성공으로 바꾸지 않고 호출자에게 그대로 전파된다.
export async function orchestrate(
  deps: OrchestrationDeps,
): Promise<OrchestrationResult> {
  const stages: string[] = [];
  const broker = await deps.reserve();
  stages.push("reserved");
  let primary: unknown = null;
  try {
    const workDir = await deps.prepareWorkdir();
    stages.push("workdir");
    await deps.prepareIpc();
    stages.push("ipc");
    // 모든 claim·workdir·IPC 준비 성공 이후에만 —
    await deps.connectDb();
    stages.push("db");
    await deps.startChild();
    stages.push("child");
    if (deps.startPwServer) {
      await deps.startPwServer();
      stages.push("pw-server");
    }
    return { dir: broker.dir, workDir, stages };
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    // 해제·abort 오류를 삼키지 않는다 — 원래 오류가 있으면 원인에 합쳐
    // 보존하고, 없으면 close 오류 자체를 던진다. 조용한 성공 없음.
    try {
      await broker.close();
    } catch (closeErr) {
      const m =
        closeErr instanceof Error ? closeErr.message : String(closeErr);
      if (primary === null) throw closeErr;
      if (primary instanceof Error) primary.message += " | close: " + m;
    }
  }
}

