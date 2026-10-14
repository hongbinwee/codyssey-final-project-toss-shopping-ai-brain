// scripts/migrate.ts의 phase→migration 매니페스트 — top-level DB 부작용이
// 없는 순수 모듈이다. unit 테스트가 DB 없이 등록·계획 동작을 검증한다
// [PMQA-070 등록 정정 — migrate.ts를 직접 import하면 DB 연결이 실행되므로
// 매니페스트만 여기서 관리한다].
//
// [등록 계약]
// - 새 migration 파일은 반드시 어느 phase에든 등록한다 — 미등록 파일은
//   unknown으로 fail closed다.
// - 이번 실행(phase<=N) 대상이 아니지만 등록된 상위 phase 파일은 skip한다
//   — 신규 파일이 있다고 기존 setup 명령이 새 DDL을 자동 적용하지 않는다.
export const PHASE_MIGRATIONS: Record<number, string[]> = {
  0: [],
  1: ["001_catalog_cart_actions.sql"],
  2: [],
  3: ["002_orders_payments_shipments.sql"],
  4: ["003_cancel_requests.sql"],
  5: [],
  // post-Phase-5 commerce environment 확장(찜) — 명시 `--phase=6` opt-in에서만
  // 적용된다. 기존 phase<=4 setup 경로는 이 파일을 skip한다 [PMQA-070].
  6: ["004_wishlist_items.sql"],
};

export const MAX_PHASE = Math.max(
  ...Object.keys(PHASE_MIGRATIONS).map(Number),
);

export function requiredMigrations(phase: number): string[] {
  return Object.entries(PHASE_MIGRATIONS)
    .filter(([p]) => Number(p) <= phase)
    .flatMap(([, files]) => files);
}

// --phase 인자의 순수 검증 — 유효 정수 범위(0..MAX_PHASE)만 허용한다.
export function parsePhaseArg(raw: string | undefined): number | null {
  const n = Number(raw ?? "0");
  return Number.isInteger(n) && n >= 0 && n <= MAX_PHASE ? n : null;
}

export type MigrationPlan = {
  apply: string[];   // 미적용 + 이번 phase 대상
  skip: string[];   // 미적용 + 등록된 상위 phase — 이번 실행 대상 아님
  unknown: string[]; // 미적용 + 미등록 — fail closed 대상
};

// 디스크 파일 목록과 _migrations 적용 기록으로 이번 실행 계획을 계산한다.
// applied는 이름 집합만 필요하다(sha 불일치 감지는 호출자가 별도 수행).
export function planMigrations(
  files: string[],
  applied: ReadonlySet<string>,
  phase: number,
): MigrationPlan {
  const wanted = new Set(requiredMigrations(phase));
  const registered = new Set(Object.values(PHASE_MIGRATIONS).flat());
  const apply: string[] = [];
  const skip: string[] = [];
  const unknown: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    if (wanted.has(f)) apply.push(f);
    else if (registered.has(f)) skip.push(f);
    else unknown.push(f);
  }
  return { apply, skip, unknown };
}
