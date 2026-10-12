// PMQA-056 — readonly capture parent sole-writer 통합.
// 부모(launcher)가 새 run dir를 원자 예약하고 audit 4slot(루트) +
// spec 17slot(captures/)을 전부 사전 claim한다 — worker(Playwright spec)는
// 파일 경로·handle을 모르고 {nonce, slot, data}만 loopback 채널로 보낸다.
// 실제 기록은 부모가 쥔 handle로만 일어난다 [승인 범위 ②].
//
// manifest completeness — 종료 경로(audit-after vs audit-fail)는 둘 중
// 하나만 기록된다. 전부 필수로 두면 정상 run도 실패하므로 required는
// 비우고 oneOf로 선택 종료 경로만 검사한다 [Luna QA 수용].
import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  claimEvidenceFiles,
  reserveCaptureOutput,
  type EvidenceWriter,
} from "./capture-output.ts";
import {
  assertNoPwOverrides,
  EvidenceBroker,
  reservePwWorkdir,
} from "./evidence-broker.ts";
import { startBrokerChannel, type BrokerChannel } from "./ipc-channel.ts";
import { DENIED_CHILD_ENV } from "../../scripts/pmqa054-evidence-run.ts";

// 부모 소유 audit 산출물 — run dir 루트 [기존 레이아웃 보존].
export const AUDIT_SLOTS: readonly string[] = Object.freeze([
  "audit-before.json",
  "run-owner.json",
  "audit-after.json",
  "audit-fail.json",
]);

// spec(worker) 산출물 — run dir의 captures/ 아래 [기존 레이아웃 보존].
export const CAPTURE_SLOTS: readonly string[] = Object.freeze([
  "shipping-focus-chip.json",
  "shipping-focus-dark.json",
  "shipping-focus-light.json",
  "impl_orders_list_dark.png",
  "impl_orders_list_light.png",
  "impl_order_detail_dark.png",
  "impl_order_detail_light.png",
  "impl_order_payment_dark.png",
  "impl_order_payment_light.png",
  "impl_order_shipping_dark.png",
  "impl_order_shipping_light.png",
  "impl_order_detail_paid_noship_dark.png",
  "impl_order_detail_preparing_dark.png",
  "impl_orders_list_requested_dark.png",
  "impl_order_detail_requested_dark.png",
  "capture-notes.md",
]);

export const READONLY_ROOT = join("shots", "06b");

// 이름으로 두 ClaimWriter를 라우팅하는 합성 writer — slot 이름에 '/'를
// 넣을 수 없으므로 captures/ 배치는 writer 측에서 결정한다.
function routedWriter(
  fallback: EvidenceWriter,
  routes: { names: ReadonlySet<string>; w: EvidenceWriter }[],
): EvidenceWriter {
  const pick = (n: string) => {
    for (const r of routes) if (r.names.has(n)) return r.w;
    return fallback;
  };
  const writers = [fallback, ...routes.map((r) => r.w)];
  return {
    dir: fallback.dir,
    write: (n, d) => pick(n).write(n, d),
    writeJson: (n, o) => pick(n).writeJson(n, o),
    stream: (n) => pick(n).stream(n),
    seal: (n) => pick(n).seal(n),
    close: async () => {
      // 한쪽만 닫히는 조용한 부분 해제 금지 — 전부 시도하고 오류 합침.
      const errs: unknown[] = [];
      for (const w of writers)
        try {
          await w.close();
        } catch (e) {
          errs.push(e);
        }
      if (errs.length)
        throw new Error(
          errs
            .map((e) => (e instanceof Error ? e.message : String(e)))
            .join(" | "),
        );
    },
  };
}

export type ReadonlyPlan = {
  readonly runId: string;
  readonly dir: string;
  readonly broker: EvidenceBroker;
  readonly channel: BrokerChannel;
  // 채널 인증 nonce — run-owner.json·RO_WORKER_NONCE env와 동일 값이다.
  readonly nonce: string;
  // 부모가 예약한 고유 PW 작업 디렉터리 — shots evidence 영역 밖 unique
  // temp다. run-owner.json에 바인딩되고 config 재평가가 정합을 요구한다
  // [PM 056 수용기준 ②].
  readonly workDir: string;
};

// launcher 사전 검사 — strict user CLI·상속 DB env·PW override를 DB 접속
// 전에 거부한다 [PM 056 수용기준 ③]. 실행 인자가 하나라도 있거나 허용
// 외 DATABASE_URL·비어있지 않은 PG* env·PW override env가 있으면 실패다.
export function assertReadonlyPreflight(opts: {
  env: NodeJS.ProcessEnv;
  argv: readonly string[]; // launcher 사용자 인자(process.argv.slice(2))
  allowedDbUrls: readonly string[];
}): void {
  if (opts.argv.length)
    throw new Error(
      "launcher 사용자 인자 허용 외: " + opts.argv.join(" "),
    );
  const dbUrl = opts.env.DATABASE_URL;
  if (dbUrl !== undefined && !opts.allowedDbUrls.includes(dbUrl))
    throw new Error("상속 DATABASE_URL 허용 외 — connect 전 거부");
  // postgres.js는 PG* env를 연결 기본값으로 읽는다 — 비어있지 않은 값은
  // 접속 목적지를 바꿀 수 있으므로 connect 전 거부다.
  for (const k of Object.keys(opts.env))
    if (
      /^PG(HOST|PORT|DATABASE|USER|PASSWORD|SSLMODE)$/i.test(k) &&
      opts.env[k]
    )
      throw new Error("상속 PG env 차단: " + k);
  // Node preload env — NODE_OPTIONS의 --require/--import는 어떤 guard보다
  // 먼저 실행되므로 비어있지 않은 값은 connect/spawn 전 거부다. 부모가
  // 이미 preload된 상태는 이 함수가 되돌릴 수 없다 — clean Node env가
  // 진입 조건이다 [PM QA-056 ③, pmqa054 DENIED_CHILD_ENV 정책 재사용].
  const denied = new Set<string>(DENIED_CHILD_ENV);
  for (const k of Object.keys(opts.env))
    if (denied.has(k.toUpperCase()) && opts.env[k])
      throw new Error(
        "Node preload env 차단(clean env 진입 조건 아님): " + k,
      );
  assertNoPwOverrides({ env: opts.env, argv: [] });
}

// run dir 원자 예약 → 두 영역 전체 wx claim → broker + loopback 채널.
// 어느 단계에서 실패해도 worker/spawn에는 도달하지 않는다.
export async function planReadonlyRun(
  runId: string = randomUUID(),
  root: string = READONLY_ROOT,
  workRoot: string = "pw-output",
): Promise<ReadonlyPlan> {
  for (const s of CAPTURE_SLOTS)
    if ((AUDIT_SLOTS as readonly string[]).includes(s))
      throw new Error("slot 이름 충돌(루트↔captures): " + s);
  // run UUID ↔ 경로 정합 — assertRunAccess는 basename(dir)===RO_RUN_ID를
  // 요구한다. reserveCaptureOutput의 "run-" 접두는 이 경로 계약과 다르므로
  // 같은 원자 예약 의미(mkdir EEXIST fail-closed)를 직접 적용한다
  // [PM 056 수용기준 ①].
  if (!/^[a-zA-Z0-9-]+$/.test(runId))
    throw new Error("invalid capture run id");
  await mkdir(root, { recursive: true });
  const dir = join(root, runId);
  await mkdir(dir); // exclusive — EEXIST면 이미 점유된 run dir
  if ((await readdir(dir)).length !== 0)
    throw new Error("run dir가 비어있지 않음: " + dir);
  // PW output은 evidence 영역 밖 고유 workdir(run-pw-<runId>) — run-owner
  // marker에 바인딩돼 config 재평가가 정합을 요구한다.
  const workDir = await reservePwWorkdir(workRoot, runId);
  const rootW = await claimEvidenceFiles(dir, AUDIT_SLOTS);
  const capW = await claimEvidenceFiles(join(dir, "captures"), CAPTURE_SLOTS);
  const broker = new EvidenceBroker({
    dir,
    writer: routedWriter(rootW, [
      { names: new Set(CAPTURE_SLOTS), w: capW },
    ]),
    slots: [...AUDIT_SLOTS, ...CAPTURE_SLOTS],
    nonce: randomUUID(),
    required: [], // 종료 경로는 둘 중 하나 — 아래 oneOf가 선택 종료만 검사
    oneOf: [["audit-after.json", "audit-fail.json"]],
    // run-owner.json이 기록됐다 = spawn이 실제 시작됐다 — 그 성공 경로는
    // audit-before + capture 전체가 없으면 완료가 아니다 [PM 056 수용기준].
    implies: [
      {
        when: "run-owner.json",
        require: ["audit-before.json", ...CAPTURE_SLOTS],
      },
    ],
  });
  const channel = await startBrokerChannel(broker);
  return { runId, dir, broker, channel, nonce: broker.nonce, workDir };
}

