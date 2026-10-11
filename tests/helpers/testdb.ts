// 통합 테스트 전용 DB (commerce_test). seed로 매번 같은 상태에서 시작한다.
//
// ── PMQA-040-B0 안전 계약 ─────────────────────────────────────────────
// - CREATE DATABASE/catchall 없음 — commerce_test는 사전 존재가 전제다.
//   없거나 가리키는 대상이 다르면 어떤 write도 하지 않고 즉시 실패한다.
// - 어떤 seed/clean/write 이전에 실제 접속 대상을 current_database()로
//   확인한다. URL 파싱은 기준이 아니다 — ?database= 같은 우회는
//   (1) query 있는 URL을 시작 전 거부하고 (2) 같은 URL로 연 probe의
//   current_database()를 실측해 이중으로 막는다.
//   · 서브프로세스(migrate/seed)는 부모가 같은 URL로 probe한 대상에
//     접속한다 — '자식 연결'을 직접 검사할 수 없으므로 query-free 검증과
//     부모 probe가 경계다(주석·문서에 한계 명시).
//   · in-process sql 풀은 cleanUserData가 그 연결에서 current_database()를
//     다시 확인한다.
// - migrate는 필요 스키마 사전 조회로 판단한다 — _migrations에 phase 요구
//   파일이 현재 파일 sha256과 일치한 채 이미 있으면 실행하지 않는다.
// - cleanUserData는 대상 DB 재검사 + seed 주문 id 집합 로드 성공 후에만
//   fixture 사용자(u-a~d) scoped cleanup을 실행한다. scenarios.json을
//   읽지 못하면 seed 주문 보호가 없어지므로 DELETE 0건으로 throw한다.
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { connectDb, sql } from "../../src/db.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const TEST_DB = "commerce_test";
export const TEST_DB_URL =
  "postgres://commerce:commerce@localhost:5432/" + TEST_DB;

type Exec = {
  unsafe: <T = Record<string, unknown>[]>(
    q: string,
    p?: unknown[],
  ) => Promise<T>;
};

// query가 있는 DATABASE_URL은 시작 전 거부한다 — ?database= 우회나
// 옵션이 조용히 무시되는 혼동을 둘 다 막는다.
export function assertSafeDbUrl(url: string): void {
  if (url.includes("?"))
    throw new Error(
      "DATABASE_URL query 금지 — ?database= 우회/무시 혼동 방지: " + url,
    );
}

// 같은 URL로 연 probe에서 실제 접속 DB를 확인한다.
export async function assertUrlTargetsTestDb(url: string): Promise<void> {
  assertSafeDbUrl(url);
  const probe = postgres(url, { max: 1 });
  try {
    const [r] = await probe.unsafe<{ d: string }[]>(
      "SELECT current_database() AS d",
    );
    if (r.d !== TEST_DB)
      throw new Error(
        "테스트 대상 DB 불일치: " +
          r.d +
          " != " +
          TEST_DB +
          " — 어떤 write도 실행하지 않는다",
      );
  } finally {
    await probe.end().catch(() => {});
  }
}

// in-process executor(보통 전역 sql)의 실제 접속 DB를 확인한다.
export async function assertExecTargetsTestDb(exec: Exec): Promise<void> {
  const [r] = await exec.unsafe<{ d: string }[]>(
    "SELECT current_database() AS d",
  );
  if (r.d !== TEST_DB)
    throw new Error(
      "테스트 대상 DB 불일치: " +
        r.d +
        " != " +
        TEST_DB +
        " — 어떤 write도 실행하지 않는다",
    );
}

// scripts/migrate.ts의 PHASE_MIGRATIONS와 같은 내용 — 스크립트는 top-level
// 부작용이라 import할 수 없어 명시적으로 복제한다. migration 추가 시 함께 갱신.
const PHASE_MIGRATIONS: Record<number, string[]> = {
  0: [],
  1: ["001_catalog_cart_actions.sql"],
  2: [],
  3: ["002_orders_payments_shipments.sql"],
  4: ["003_cancel_requests.sql"],
  5: [],
};

function requiredMigrations(phase: number): string[] {
  return Object.entries(PHASE_MIGRATIONS)
    .filter(([p]) => Number(p) <= phase)
    .flatMap(([, files]) => files);
}

// _migrations에 필요 파일이 디스크 sha256과 일치한 채 있으면 migrate 불요.
// 테이블 부재·행 부족·sha 불일치는 false → migrate가 fail closed로 판단한다.
async function schemaSatisfied(exec: Exec, phase: number): Promise<boolean> {
  const wanted = requiredMigrations(phase);
  if (!wanted.length) return true;
  const [reg] = await exec.unsafe<{ r: string | null }[]>(
    "SELECT to_regclass('public._migrations') AS r",
  );
  if (!reg.r) return false;
  const rows = await exec.unsafe<{ name: string; sha256: string }[]>(
    "SELECT name, sha256 FROM _migrations",
  );
  const have = new Map(rows.map((r) => [r.name, r.sha256]));
  for (const f of wanted) {
    const sha = createHash("sha256")
      .update(readFileSync("db/migrations/" + f, "utf8"))
      .digest("hex");
    if (have.get(f) !== sha) return false;
  }
  return true;
}

// seed 주문 id 집합 — scenarios.json을 읽지 못하면 빈 집합으로 넘어가지 않고
// throw한다(빈 집합 fallback은 seed 주문 보호를 제거해 cleanup이 seed 주문까지
// 지우는 경로가 된다).
export function loadSeedOrderIds(fileText: string): string[] {
  const parsed = JSON.parse(fileText) as { orders?: unknown };
  if (!Array.isArray(parsed.orders) || parsed.orders.length === 0)
    throw new Error(
      "scenarios.json에 비어있지 않은 orders 배열이 없다 — seed 주문 보호 집합을 만들 수 없다",
    );
  const ids = parsed.orders.map((o) => (o as { id?: unknown })?.id);
  return assertSeedIds(ids);
}

// loadIds 경로(파일·주입 공통)의 결과 검증 — 유효하지 않은 집합이면 throw해
// 호출자가 어떤 write도 실행하지 못하게 한다.
export function assertSeedIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length === 0)
    throw new Error("seed 주문 보호 집합이 비어있다 — cleanup write 0건");
  if (ids.some((id) => typeof id !== "string" || id.trim().length === 0))
    throw new Error("seed 주문 id가 비어있거나 문자열이 아니다 — cleanup write 0건");
  if (new Set(ids).size !== ids.length)
    throw new Error("seed 주문 id에 중복이 있다 — cleanup write 0건");
  return ids as string[];
}

function defaultLoadSeedIds(): string[] {
  return loadSeedOrderIds(readFileSync("db/seeds/scenarios.json", "utf8"));
}

export async function setupTestDb(phase = 1) {
  // 1) 대상 실측 — commerce_test가 아니면 이후 어떤 write도 없다.
  //    CREATE DATABASE/catchall 없음: 없는 DB면 connect 자체가 실패한다.
  await assertUrlTargetsTestDb(TEST_DB_URL);
  // 2) 필요 스키마 사전 조회 — 이미 충족이면 migrate를 실행하지 않는다.
  //    확인은 commerce_test를 가리키는 같은 URL의 연결에서 한다.
  const check = postgres(TEST_DB_URL, { max: 1 });
  let migrateNeeded: boolean;
  try {
    const [r] = await check.unsafe<{ d: string }[]>(
      "SELECT current_database() AS d",
    );
    if (r.d !== TEST_DB)
      throw new Error("테스트 대상 DB 불일치: " + r.d + " != " + TEST_DB);
    migrateNeeded = !(await schemaSatisfied(check as unknown as Exec, phase));
  } finally {
    await check.end().catch(() => {});
  }
  // 3) 필요한 단계만 서브프로세스로 — query-free URL이라 자식도 같은 대상에
  //    붙는다(seed는 fixture reset write라 대상 확인 후에만 실행).
  //    ※ 이번 세션은 schema 변경 승인이 없다 — 스키마 불충족이면 migrate를
  //    실행하지 않고 여기서 중단한다(필요하면 별도 보고 후 재개).
  if (migrateNeeded)
    throw new Error(
      "스키마 불충족 — 이번 세션은 schema 변경(migrate) 승인이 없어 seed/delete 전에 중단한다",
    );
  const steps: string[][] = [["scripts/seed.ts", "--phase=" + phase]];
  for (const s of steps) {
    const r = spawnSync("node", s, {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: "pipe",
    });
    if (r.status !== 0)
      throw new Error("setup failed: " + s.join(" ") + "\n" + r.stderr);
  }
}

export async function ensureTestDb(phase = 1) {
  await setupTestDb(phase);
  // 같은 워커에서 suite마다 다시 호출될 때 이전 pool을 닫지 않으면
  // connectDb가 전역 sql을 덮어쓰면서 첫 pool이 누수되고 워커가 종료되지 못한다.
  if (sql) await sql.end();
  connectDb(TEST_DB_URL);
  // 새 풀의 실제 대상도 확인 — 이후 어떤 테스트 write도 이 검증 뒤다.
  await assertExecTargetsTestDb(sql as unknown as Exec);
}

// 테스트가 만든 사용자 데이터만 비운다. seed 카탈로그와 seed 주문(ord-*)은 그대로 둔다.
// (seed 주문의 취소/환불 잔여 상태는 seed.ts가 재시드 시 초기화한다)
//
// 안전 근거(비-fixture 행 무영향): 모든 DELETE/UPDATE는 fixture 사용자
// u-a~d의 cart·action·주문으로만 범위가 한정되고(uids 스코프), 주문 삭제는
// scenarios.json의 seed id를 제외한 집합(ids)으로 다시 좁힌다. u-a~d 외
// 사용자 행·seed 주문·데모 카탈로그는 어느 경로에서도 대상이 아니다.
export async function cleanUserData(
  exec: Exec = sql as unknown as Exec,
  loadIds: () => string[] = defaultLoadSeedIds,
) {
  // 실제 접속 DB가 commerce_test인지 이 연결에서 다시 확인한다 — 대상이
  // 다르면 어떤 DELETE/UPDATE도 실행하지 않는다.
  await assertExecTargetsTestDb(exec);
  // seed 주문 보호 집합 — 로드 실패·빈 배열·깨진 id·중복은 전부 여기서
  // throw해 DELETE 0건으로 끝낸다(주입 loadIds 결과도 동일 검증).
  const seedIds = assertSeedIds(loadIds());
  const uids = ["u-a", "u-b", "u-c", "u-d"];
  // cancel_requests가 action_requests/orders를 FK로 참조하므로 먼저 지운다.
  // seed 주문(ord-*)에 붙은 테스트 취소 요청도 함께 지워 다음 테스트의 자격 판정을 보존한다.
  const [regC] = await exec.unsafe<{ r: string | null }[]>(
    "SELECT to_regclass('public.cancel_requests') AS r",
  );
  if (regC.r)
    await exec.unsafe(
      "DELETE FROM cancel_requests WHERE order_id IN (SELECT id FROM orders WHERE user_id = ANY($1))",
      [uids],
    );
  await exec.unsafe(
    "DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = ANY($1))",
    [uids],
  );
  await exec.unsafe(
    "DELETE FROM action_requests WHERE actor_user_id = ANY($1)",
    [uids],
  );
  await exec.unsafe("UPDATE carts SET version=1 WHERE user_id = ANY($1)", [uids]);
  // orders 테이블은 Phase 3부터 존재한다. checkout이 만든 주문만 지우고 시나리오 seed는 보존.
  const [reg] = await exec.unsafe<{ r: string | null }[]>(
    "SELECT to_regclass('public.orders') AS r",
  );
  if (reg.r) {
    const rows = await exec.unsafe<{ id: string }[]>(
      "SELECT id FROM orders WHERE user_id = ANY($1) AND NOT (id = ANY($2))",
      [uids, seedIds],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      if (regC.r)
        await exec.unsafe(
          "DELETE FROM cancel_requests WHERE order_id = ANY($1)",
          [ids],
        );
      await exec.unsafe("DELETE FROM order_items WHERE order_id = ANY($1)", [ids]);
      await exec.unsafe("DELETE FROM payments WHERE order_id = ANY($1)", [ids]);
      await exec.unsafe("DELETE FROM shipments WHERE order_id = ANY($1)", [ids]);
      await exec.unsafe("DELETE FROM orders WHERE id = ANY($1)", [ids]);
    }
  }
}

// ── PMQA-044-A restricted reset — 승인 13주문 + 직접종속 한정 ──────────
// playwright global-setup 전용 경로. commerce_test에서 감사를 마친
// 13주문(아래 고정 ID)과 그 직접종속(cancel/order_items/payments/shipments
// /주문 직접연결 action)만 삭제하고, 실측 drift fixture(아래 variant·cart)를
// seed 값으로 복원한다.
//
// 원칙 — fail closed:
// - "매 실행 모든 비-seed 동적 산출 삭제"는 이번 승인 범위가 아니다.
//   승인 목록·직접종속·실측 baseline·보존 행 내용이 정확히 일치할 때만
//   write하고, 하나라도 다르면 write 0건으로 중단한다.
// - 모든 write는 단일 트랜잭션(REPEATABLE READ + 관련 테이블
//   SHARE ROW EXCLUSIVE 잠금 + checked-value predicate) — 중간 실패·
//   postcheck 불일치 시 전부 rollback한다.
// - 백업 게이트는 restrictedE2EReset 엔트리 자체가 강제한다 — wrapper를
//   우회한 직접 호출도 검증 없이 실행될 수 없다.
// - cart_items는 0이어야 한다 — 발견 시 임의 삭제하지 않고 중단한다.
// - 보존 36 actions는 ID 존재만이 아니라 행 전체 내용 지문으로 확인한다.
//
// 모드: remediate(승인 13 전부 존재·일치 → 삭제+복원) / verify(0 존재 →
// 이미 정리 상태인지 불변만 확인) / abort(부분 존재·불일치·미감사 행 존재).

const RESTRICTED_USER_IDS = ["u-a", "u-b", "u-c", "u-d"];

// 사용자 승인 삭제 주문 13 — PMQA-043 감사 목록과 정확히 일치해야 한다.
export const RESTRICTED_APPROVED_ORDERS = Object.freeze([
  "ord-08235ca9",
  "ord-62b3f507",
  "ord-36be21f9",
  "ord-14429197",
  "ord-60aeb888",
  "ord-8eb544c3",
  "ord-3c519dd2",
  "ord-e0eab123",
  "ord-5fb50ecc",
  "ord-43c957ee",
  "ord-609c4b8c",
  "ord-c0bdcc4d",
  "ord-6c584622",
]);

// 감사된 승인 취소 요청 — id와 order_id 매핑 모두 일치해야 삭제 대상이다.
const RESTRICTED_CANCEL_ORDER: Record<string, string> = {
  "cxl-5f00f6ea": "ord-3c519dd2",
  "cxl-5f25d64d": "ord-6c584622",
};

// seed 주문(scenarios.json)의 감사 지문 — 내용이 바뀌면 write하지 않는다.
const SEED_ORDER_EXPECTED: Record<
  string,
  { status: string; total: number }
> = {
  "ord-a-pre": { status: "CONFIRMED", total: 183000 },
  "ord-a-ship": { status: "CONFIRMED", total: 152000 },
  "ord-a-done": { status: "CONFIRMED", total: 292000 },
  "ord-b-none": { status: "CONFIRMED", total: 152000 },
};
const SEED_ORDER_IDS = Object.keys(SEED_ORDER_EXPECTED);

// 감사 시점 seed 주문 종속 행 수 — remediate·verify 모두의 preflight에서
// 확인한다(알려진 보존 전제는 write 이전에 검증해야 abort가 write 0건이다).
const SEED_DEP_COUNTS = { items: 4, payments: 4, shipments: 3 };

// variant 실측 drift(PMQA-043 baseline)·복원 목표(seed catalog.json).
// measured·seed 둘 다와 다른 값이면 미감사 상태이므로 abort한다.
const RESTRICTED_VARIANTS: Record<
  string,
  {
    measured: { stock: number; version: number };
    seed: { stock: number; version: number };
  }
> = {
  "v-a-24": {
    measured: { stock: 2, version: 4 },
    seed: { stock: 5, version: 1 },
  },
  "v-a-27": {
    measured: { stock: 0, version: 1 },
    seed: { stock: 0, version: 1 },
  },
  "v-b-24": {
    measured: { stock: 0, version: 9 },
    seed: { stock: 8, version: 1 },
  },
  "v-b-27": {
    measured: { stock: 2, version: 2 },
    seed: { stock: 3, version: 1 },
  },
  "v-c-27": {
    measured: { stock: 2, version: 3 },
    seed: { stock: 4, version: 1 },
  },
  "v-c-32": {
    measured: { stock: 2, version: 1 },
    seed: { stock: 2, version: 1 },
  },
};

// cart 실측 baseline — version 1 또는 이 measured 값만 허용한다.
const RESTRICTED_CART_VERSIONS: Record<string, number> = {
  "u-a": 8,
  "u-b": 5,
  "u-c": 36,
  "u-d": 3,
};

const RESTRICTED_EXPECTED_DEPS = {
  items: 14,
  payments: 13,
  shipments: 13,
  linkedActions: 15,
};

// commerce_test의 pg_database.oid — 이름뿐 아니라 OID까지 일치해야 한다.
export const RESTRICTED_TEST_DB_OID = 16516;

// 승인 스냅샷(로컬 gitignored) — DB write 전 존재·sha256을 확인하고,
// 보호 행과 승인 삭제 대상 전체 행의 baseline을 이 파일에서 파생한다.
export const RESTRICTED_BACKUP = Object.freeze({
  path: "shots/06a/pmqa043/commerce_test_prdump.sql",
  sha256:
    "8ca19650313ddec44b4a83a35afe5ed1d8efc24612ea3adc28b6955d9bdd0b57",
});

// 승인 13주문과 무관한 독립 action 36건 — 보존 대상 ID 집합.
// 존재 확인은 ID로 하고, 내용 불변은 보호 행 전체 내용 지문으로 확인한다
// (ID 집합과 전체 내용 지문은 다른 검증이다).
export const RESTRICTED_PRESERVED_ACTIONS = Object.freeze([
  "510038f3-41c8-4645-92d4-ad2bbab785cb",
  "9bbfd6c4-be10-4efb-8329-ddbd4473007f",
  "ea16ac93-0301-48b2-b238-18edfba4907e",
  "91a12d75-096f-45a5-895a-33f4ac5927e4",
  "a7ce9192-8424-4fbe-8d6a-13bfb8fc7629",
  "84cb4b98-3cc1-4b2d-b0af-da62eaf8d85d",
  "70b83f47-5361-44d8-8b95-89970bc9620b",
  "6336e4ae-e8c9-443d-aacc-24a53f893f48",
  "f2c93237-ca90-49b8-bfaf-b8c2ff651307",
  "d4c53471-2b78-444b-8185-322c9d6d0b83",
  "7580f244-980c-4c23-b485-a40b75b7a4e0",
  "5b6d3503-98b2-4067-9918-ed776b10e593",
  "7d8b0f9f-ac8a-4fea-95e1-483626021c99",
  "524b15c1-00ae-472d-a120-154682a4a4da",
  "864af3c8-c8e3-46bc-ab15-fec91d731db9",
  "585cfbe5-a0c1-40d7-b473-4489901c880d",
  "04d60c78-d06f-4a95-a933-ce1318929005",
  "fa14b1f7-92c5-4d3d-b07c-1a48c8e7e4f8",
  "5757df13-21ff-4690-a89e-cc4bc1f9dc99",
  "1f768ddb-7602-484f-9058-6afd1c56627b",
  "dd6d0ce9-238d-4a33-9538-fcac36897227",
  "323dbd95-4f45-402a-a326-f386b915401d",
  "b53b0be0-3216-4c2a-b7f2-2bac07e26032",
  "b0081215-6bbd-4e52-86f8-7ca724a9a136",
  "e1e8843e-4491-49ea-b6a6-0bce5aa8ac4c",
  "927e3c2a-d2c9-4bf0-a715-b0f275bbfc3d",
  "38016440-0a23-42c6-8714-e34556496f72",
  "00d7d9a5-08d7-472d-be0e-0b20fad89e9e",
  "56933f22-30eb-40f5-8e3e-6e6f031bbf1e",
  "09ef00aa-6a85-4b70-90c2-e590934778f4",
  "c0e788bd-7860-4477-b54c-996592f2967d",
  "28cd03d1-691d-4bdd-bfd2-9bce243c3d9a",
  "9d51d845-432f-4fa1-9e69-5ecdff0827dc",
  "355ec9f4-f83e-4c8c-8a8a-b22b7ddf82a3",
  "2c0e76e0-d442-4804-a786-c1527ae8f364",
  "44b30957-1b9d-4f95-8bea-e83f132f24e0",
]);

// 승인 백업 파일의 존재와 내용 지문을 확인한다. 없거나 다르면 어떤
// restricted write도 허용하지 않는다.
export function verifyBackupFile(
  path: string = RESTRICTED_BACKUP.path,
  sha256: string = RESTRICTED_BACKUP.sha256,
): void {
  let buf: ReturnType<typeof readFileSync>;
  try {
    buf = readFileSync(path);
  } catch {
    throw new Error(
      "승인 백업 파일 부재: " +
        path +
        " — restricted reset은 백업 없이 실행하지 않는다",
    );
  }
  const h = createHash("sha256").update(buf).digest("hex");
  if (h !== sha256)
    throw new Error(
      "승인 백업 SHA256 불일치 — 승인 스냅샷과 다른 파일이다: " + path,
    );
}

// ── 보호 행 전체 내용 지문 ───────────────────────────────────────────
// 보호 대상: seed 주문 전체 + seed 종속(items/payments/shipments) +
// 보존 36 actions + 비대상 fixture(variants·carts·products·reviews·users
// ·cart_items). 지문은 "행 존재"가 아니라 "행 전체 내용(to_jsonb)"의
// 결정적 직렬화 해시다 — actor/payload/result/timestamps가 바뀌면 잡는다.
// variant의 stock_qty·version과 cart의 version은 이 경로가 승인된 복원
// 대상이므로 지문에서 제외하고, 실측 baseline 체크로 따로 검증한다.

type ColType = "t" | "i" | "b" | "j" | "ts";

// 보호 테이블 컬럼 타입 — 덤프 COPY 셀과 live to_jsonb 값을 같은
// 결정적 값으로 변환하는 데 쓴다.
const PROTECTED_SCHEMA: Record<
  string,
  { cols: Record<string, ColType>; minus?: string[] }
> = {
  orders: {
    cols: {
      id: "t",
      user_id: "t",
      status: "t",
      items_total_won: "i",
      shipping_fee_won: "i",
      total_won: "i",
      address_snapshot_json: "j",
      version: "i",
      created_at: "ts",
      cancelled_at: "ts",
    },
  },
  order_items: {
    cols: {
      id: "t",
      order_id: "t",
      variant_id: "t",
      product_name_snapshot: "t",
      option_snapshot_json: "j",
      unit_price_won: "i",
      quantity: "i",
      line_total_won: "i",
    },
  },
  payments: {
    cols: {
      id: "t",
      order_id: "t",
      method: "t",
      status: "t",
      paid_amount_won: "i",
      paid_at: "ts",
      refund_status: "t",
      refunded_amount_won: "i",
      refunded_at: "ts",
    },
  },
  shipments: {
    cols: {
      id: "t",
      order_id: "t",
      status: "t",
      events_json: "j",
      estimated_arrival_at: "ts",
      updated_at: "ts",
    },
  },
  cancel_requests: {
    cols: {
      id: "t",
      order_id: "t",
      action_request_id: "t",
      reason_code: "t",
      status: "t",
      refund_amount_won: "i",
      requested_at: "ts",
      completed_at: "ts",
    },
  },
  action_requests: {
    cols: {
      id: "t",
      actor_user_id: "t",
      kind: "t",
      idempotency_key: "t",
      payload_json: "j",
      payload_hash: "t",
      status: "t",
      confirmed_at: "ts",
      expires_at: "ts",
      result_json: "j",
      error_code: "t",
      created_at: "ts",
      completed_at: "ts",
    },
  },
  product_variants: {
    minus: ["stock_qty", "version"],
    cols: {
      id: "t",
      product_id: "t",
      option_values_json: "j",
      spec_overrides_json: "j",
      unit_price_won: "i",
      stock_qty: "i",
      active: "b",
      version: "i",
    },
  },
  carts: {
    minus: ["version"],
    cols: { id: "t", user_id: "t", version: "i", updated_at: "ts" },
  },
  cart_items: {
    cols: { id: "t", cart_id: "t", variant_id: "t", quantity: "i" },
  },
  products: {
    cols: {
      id: "t",
      name: "t",
      brand: "t",
      category: "t",
      description: "t",
      image_urls: "j",
      specs_json: "j",
      active: "b",
      version: "i",
    },
  },
  reviews: {
    cols: {
      id: "t",
      product_id: "t",
      variant_id: "t",
      rating: "i",
      body: "t",
      source_kind: "t",
      source_ref: "t",
      written_at: "ts",
    },
  },
  users: {
    cols: {
      id: "t",
      auth_subject: "t",
      display_name: "t",
      test_address_json: "j",
      created_at: "ts",
    },
  },
};

// timestamptz를 ISO-8601 canonical로 정규화한다.
// 덤프 COPY 'YYYY-MM-DD HH:MM:SS[.ffffff]+00' 와 live to_jsonb의
// 'YYYY-MM-DDTHH:MM:SS[.ffffff]+00:00'를 같은 값으로 만든다.
function canonTs(s: string): string {
  let t = s.trim().replace(" ", "T").replace(/Z$/, "+00:00");
  t = t.replace(/([+-])(\d\d)$/, "$1$2:00"); // '+00' → '+00:00'
  return t;
}

// minus 키를 빼고 ts 컬럼을 canonical로 맞춘다 — live/dump 양쪽 공통.
function normalizeProtectedRow(
  src: string,
  j: unknown,
): Record<string, unknown> {
  const spec = PROTECTED_SCHEMA[src];
  const row = { ...(j as Record<string, unknown>) };
  for (const k of spec?.minus ?? []) delete row[k];
  if (spec)
    for (const [c, ty] of Object.entries(spec.cols))
      if (ty === "ts" && typeof row[c] === "string")
        row[c] = canonTs(row[c] as string);
  return row;
}

// 결정적 JSON 직렬화 — 객체 키는 항상 알파벳 정렬.
function canonJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v))
    return "[" + v.map((x) => canonJson(x)).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonJson(o[k]))
      .join(",") +
    "}"
  );
}

export type ProtectedRow = { src: string; id: string; j: unknown };

// 보호 행 전체 내용의 sha256 지문 — 정렬된 'src|id|canon' 행의 결합.
export function protectedFingerprint(rows: ProtectedRow[]): string {
  const lines = rows
    .map(
      (r) =>
        r.src + "|" + r.id + "|" + canonJson(normalizeProtectedRow(r.src, r.j)),
    )
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// COPY 블록의 셀 하나를 복원한다 — '\\N'은 NULL, 나머지는 역슬래시
// 이스케이프 해제(\\t \\n \\r \\b \\f \\v \\. \\\\).
function copyCell(raw: string): string | null {
  if (raw === "\\N") return null;
  return raw.replace(/\\(.)/g, (_m, c: string) => {
    const map: Record<string, string> = {
      t: "\t",
      n: "\n",
      r: "\r",
      b: "\b",
      f: "\f",
      v: "\v",
    };
    return map[c] ?? c;
  });
}

export type RestrictedResetBaseline = {
  protectedRows: ProtectedRow[];
  protectedFingerprint: string;
  deleteRows: ProtectedRow[];
};

// 승인 덤프(pg_dump COPY)를 한 번 파싱해 보호 집합과 승인 삭제 집합을
// 함께 만든다. 이 함수는 pure parser이며 DB mutation 경로가 아니다.
export function loadDumpResetBaseline(
  dumpText: string,
): RestrictedResetBaseline {
  const out: ProtectedRow[] = [];
  const re = /COPY public\.(\w+) \(([^)]+)\) FROM stdin;/g;
  const seed = new Set(SEED_ORDER_IDS);
  const approved = new Set(RESTRICTED_APPROVED_ORDERS);
  const uids = new Set(RESTRICTED_USER_IDS);
  const preserved = new Set(RESTRICTED_PRESERVED_ACTIONS);
  for (const m of dumpText.matchAll(re)) {
    const table = m[1];
    const spec = PROTECTED_SCHEMA[table];
    if (!spec) continue;
    const cols = m[2].split(",").map((c) => c.trim());
    const start = (m.index ?? 0) + m[0].length;
    // COPY 데이터는 '\\.' 단독 줄에서 끝난다.
    let end = dumpText.indexOf("\n\\.", start);
    if (end < 0) end = dumpText.length;
    const body = dumpText.slice(start, end);
    for (const rawLine of body.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) continue;
      const cells = line.split("\t");
      const rec: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const ty = spec.cols[c];
        const cell = copyCell(cells[i] ?? "");
        rec[c] =
          cell === null || ty === undefined
            ? ty === "j" && cell !== null
              ? JSON.parse(cell)
              : cell
            : cell === null
              ? null
              : ty === "t"
                ? cell
                : ty === "i"
                  ? Number(cell)
                  : ty === "b"
                    ? cell === "t"
                    : ty === "j"
                      ? JSON.parse(cell)
                      : canonTs(cell);
      });
      out.push({ src: table, id: String(rec.id), j: rec });
    }
  }
  const cancelActionIds = new Set(
    out
      .filter(
        (r) =>
          r.src === "cancel_requests" &&
          approved.has((r.j as Record<string, unknown>).order_id as string),
      )
      .map((r) => (r.j as Record<string, unknown>).action_request_id as string),
  );
  const isProtected = (r: ProtectedRow) => {
    const j = r.j as Record<string, unknown>;
    if (r.src === "orders") return seed.has(r.id);
    if (
      r.src === "order_items" ||
      r.src === "payments" ||
      r.src === "shipments" ||
      r.src === "cancel_requests"
    ) return seed.has(j.order_id as string);
    if (r.src === "action_requests") return preserved.has(r.id);
    if (r.src === "carts") return uids.has(j.user_id as string);
    if (r.src === "users") return uids.has(r.id);
    return true; // variants·cart_items·products·reviews 전체 보호
  };
  const isDelete = (r: ProtectedRow) => {
    const j = r.j as Record<string, unknown>;
    if (r.src === "orders") return approved.has(r.id);
    if (
      r.src === "order_items" ||
      r.src === "payments" ||
      r.src === "shipments" ||
      r.src === "cancel_requests"
    ) return approved.has(j.order_id as string);
    if (r.src === "action_requests") {
      const result = j.result_json as Record<string, unknown> | null;
      return (
        approved.has(String(result?.order_id ?? "")) ||
        cancelActionIds.has(r.id)
      );
    }
    return false;
  };
  const protectedRows = out.filter(isProtected);
  const deleteRows = out.filter(isDelete);
  return {
    protectedRows,
    protectedFingerprint: protectedFingerprint(protectedRows),
    deleteRows,
  };
}

// 호환 read-only helper: 보호 baseline만 반환한다.
export function loadDumpProtectedRows(dumpText: string): ProtectedRow[] {
  return loadDumpResetBaseline(dumpText).protectedRows;
}

// Read exactly one immutable approved backup buffer, verify its fixed digest,
// then derive both mandatory baselines from those same bytes. The counts are
// part of the reviewed reset boundary; a changed dump fails closed.
function readApprovedResetBaseline(): RestrictedResetBaseline {
  let dump: ReturnType<typeof readFileSync>;
  try {
    dump = readFileSync(RESTRICTED_BACKUP.path);
  } catch {
    throw new Error(
      "승인 백업 파일 부재: " + RESTRICTED_BACKUP.path +
        " — restricted reset은 백업 없이 실행하지 않는다",
    );
  }
  const sha = createHash("sha256").update(dump).digest("hex");
  if (sha !== RESTRICTED_BACKUP.sha256)
    throw new Error("승인 백업 SHA256 불일치 — restricted reset을 중단한다");

  const baseline = loadDumpResetBaseline(dump.toString("utf8"));
  const counts = (rows: ProtectedRow[]) => {
    const result: Record<string, number> = {};
    for (const row of rows) result[row.src] = (result[row.src] ?? 0) + 1;
    return result;
  };
  const matchesCounts = (
    actual: Record<string, number>,
    expected: Record<string, number>,
  ) =>
    JSON.stringify(Object.entries(actual).sort()) ===
    JSON.stringify(Object.entries(expected).sort());

  if (
    !matchesCounts(counts(baseline.protectedRows), {
      orders: 4,
      order_items: 4,
      payments: 4,
      shipments: 3,
      action_requests: 36,
      product_variants: 6,
      carts: 4,
      products: 3,
      reviews: 9,
      users: 4,
    })
  )
    throw new Error("승인 백업 보호 baseline 행 수 불일치 — reset을 중단한다");
  if (
    !matchesCounts(counts(baseline.deleteRows), {
      orders: 13,
      cancel_requests: 2,
      order_items: 14,
      payments: 13,
      shipments: 13,
      action_requests: 15,
    })
  )
    throw new Error("승인 백업 삭제 baseline 행 수 불일치 — reset을 중단한다");
  return baseline;
}

// restricted reset 판정에 필요한 전량 스냅샷. 모든 SELECT는 잠금을 건
// REPEATABLE READ 트랜잭션 안에서 실행해 동일 시점을 본다. /*snap:*/
// 태그는 DB-free 테스트의 라우팅 키다.
export type RestrictedSnap = {
  db: string;
  oid: number;
  orders: { id: string; status: string; total_won: number }[];
  cancels: { id: string; order_id: string; action_request_id: string }[];
  items: { id: string; order_id: string }[];
  payments: { id: string; order_id: string }[];
  shipments: { id: string; order_id: string }[];
  actions: {
    id: string;
    kind: string;
    status: string;
    order_ref: string | null;
  }[];
  variants: { id: string; stock_qty: number; version: number }[];
  carts: { user_id: string; version: number }[];
  cartItemCount: number;
  protected: ProtectedRow[];
  deleteRows: ProtectedRow[];
};

export async function collectSnap(q: Exec): Promise<RestrictedSnap> {
  const [dbRow] = await q.unsafe<{ db: string; oid: number }[]>(
    "/*snap:db*/ SELECT current_database() AS db, (SELECT oid FROM pg_database WHERE datname = current_database()) AS oid",
  );
  const orders = await q.unsafe<RestrictedSnap["orders"]>(
    "/*snap:orders*/ SELECT id, status, total_won FROM orders",
  );
  const cancels = await q.unsafe<RestrictedSnap["cancels"]>(
    "/*snap:cancels*/ SELECT id, order_id, action_request_id FROM cancel_requests",
  );
  const items = await q.unsafe<RestrictedSnap["items"]>(
    "/*snap:items*/ SELECT id, order_id FROM order_items",
  );
  const payments = await q.unsafe<RestrictedSnap["payments"]>(
    "/*snap:payments*/ SELECT id, order_id FROM payments",
  );
  const shipments = await q.unsafe<RestrictedSnap["shipments"]>(
    "/*snap:shipments*/ SELECT id, order_id FROM shipments",
  );
  const actions = await q.unsafe<RestrictedSnap["actions"]>(
    "/*snap:actions*/ SELECT id, kind, status, result_json->>'order_id' AS order_ref FROM action_requests",
  );
  const variants = await q.unsafe<RestrictedSnap["variants"]>(
    "/*snap:variants*/ SELECT id, stock_qty, version FROM product_variants",
  );
  const carts = await q.unsafe<RestrictedSnap["carts"]>(
    "/*snap:carts*/ SELECT user_id, version FROM carts WHERE user_id = ANY($1)",
    [RESTRICTED_USER_IDS],
  );
  const [ci] = await q.unsafe<{ n: number }[]>(
    "/*snap:cart_items*/ SELECT count(*)::int AS n FROM cart_items",
  );
  // 보호 행 전체 내용 — 지문은 행 존재가 아니라 행 전체 내용의 해시다.
  const protectedRows = await q.unsafe<ProtectedRow[]>(
    "/*snap:protected*/ SELECT 'orders' AS src, o.id AS id, to_jsonb(o) AS j FROM orders o WHERE o.id = ANY($1)" +
      " UNION ALL SELECT 'order_items', i.id, to_jsonb(i) FROM order_items i WHERE i.order_id = ANY($2)" +
      " UNION ALL SELECT 'payments', p.id, to_jsonb(p) FROM payments p WHERE p.order_id = ANY($3)" +
      " UNION ALL SELECT 'shipments', s.id, to_jsonb(s) FROM shipments s WHERE s.order_id = ANY($4)" +
      " UNION ALL SELECT 'cancel_requests', x.id, to_jsonb(x) FROM cancel_requests x WHERE x.order_id = ANY($5)" +
      " UNION ALL SELECT 'action_requests', a.id, to_jsonb(a) FROM action_requests a WHERE a.id = ANY($6)" +
      " UNION ALL SELECT 'product_variants', v.id, to_jsonb(v) - 'stock_qty' - 'version' FROM product_variants v" +
      " UNION ALL SELECT 'carts', c.id, to_jsonb(c) - 'version' FROM carts c WHERE c.user_id = ANY($7)" +
      " UNION ALL SELECT 'cart_items', ci.id, to_jsonb(ci) FROM cart_items ci" +
      " UNION ALL SELECT 'products', pr.id, to_jsonb(pr) FROM products pr" +
      " UNION ALL SELECT 'reviews', r.id, to_jsonb(r) FROM reviews r" +
      " UNION ALL SELECT 'users', u.id, to_jsonb(u) FROM users u WHERE u.id = ANY($8)" +
      " ORDER BY src, id",
    [
      SEED_ORDER_IDS,
      SEED_ORDER_IDS,
      SEED_ORDER_IDS,
      SEED_ORDER_IDS,
      SEED_ORDER_IDS,
      RESTRICTED_PRESERVED_ACTIONS,
      RESTRICTED_USER_IDS,
      RESTRICTED_USER_IDS,
    ],
  );
  // 승인 주문 13과 직접종속 57(전체 삭제 대상 70)의 full row metadata. 이 snapshot은
  // lock 이후 mutation 직전에 승인 043 COPY row 집합과 정확히 대조한다.
  const deleteRows = await q.unsafe<ProtectedRow[]>(
    "/*snap:delete*/ SELECT 'orders' AS src, o.id AS id, to_jsonb(o) AS j FROM orders o WHERE o.id = ANY($1)" +
      " UNION ALL SELECT 'order_items', i.id, to_jsonb(i) FROM order_items i WHERE i.order_id = ANY($1)" +
      " UNION ALL SELECT 'payments', p.id, to_jsonb(p) FROM payments p WHERE p.order_id = ANY($1)" +
      " UNION ALL SELECT 'shipments', s.id, to_jsonb(s) FROM shipments s WHERE s.order_id = ANY($1)" +
      " UNION ALL SELECT 'cancel_requests', c.id, to_jsonb(c) FROM cancel_requests c WHERE c.order_id = ANY($1)" +
      " UNION ALL SELECT 'action_requests', a.id, to_jsonb(a) FROM action_requests a WHERE a.result_json->>'order_id' = ANY($1)" +
      " OR a.id IN (SELECT action_request_id FROM cancel_requests WHERE order_id = ANY($1))" +
      " ORDER BY src, id",
    [RESTRICTED_APPROVED_ORDERS],
  );
  return {
    db: dbRow.db,
    oid: dbRow.oid,
    orders,
    cancels,
    items,
    payments,
    shipments,
    actions,
    variants,
    carts,
    cartItemCount: ci.n,
    protected: protectedRows,
    deleteRows,
  };
}

export type RestrictedPlan =
  | { mode: "abort"; reasons: string[] }
  | { mode: "verify" }
  | {
      mode: "remediate";
      orderIds: string[];
      orderDeletes: { id: string; status: string; total: number }[];
      cancelIds: string[];
      linkedActionIds: string[];
      depCounts: { items: number; payments: number; shipments: number };
      variantRestore: {
        id: string;
        stock: number;
        version: number;
        expectStock: number;
        expectVersion: number;
      }[];
      cartRestore: { uid: string; expectVersion: number }[];
    };

export type RestrictedEvalCtx = {
  // 고정 경로의 SHA 검증된 043 buffer에서 entry가 직접 파생한다.
  baseline: RestrictedResetBaseline;
};

// 스냅샷만으로 실행 계획을 판정하는 순수 함수 — DB write와 분리해 검증한다.
function exactRowSetMismatch(
  expected: ProtectedRow[],
  actual: ProtectedRow[],
): string | null {
  const key = (r: ProtectedRow) => r.src + "|" + r.id;
  const normalize = (r: ProtectedRow) =>
    canonJson(normalizeProtectedRow(r.src, r.j));
  const e = new Map(expected.map((r) => [key(r), normalize(r)]));
  const a = new Map(actual.map((r) => [key(r), normalize(r)]));
  if (e.size !== expected.length || a.size !== actual.length)
    return "중복 row key";
  if (e.size !== a.size) return "row 수 " + a.size + " != " + e.size;
  for (const [k, v] of e)
    if (!a.has(k)) return "누락 " + k;
    else if (a.get(k) !== v) return "내용 변경 " + k;
  for (const k of a.keys()) if (!e.has(k)) return "추가 " + k;
  return null;
}

export function evaluateRestrictedReset(
  snap: RestrictedSnap,
  ctx: RestrictedEvalCtx,
): RestrictedPlan {
  const reasons: string[] = [];
  const A = RESTRICTED_APPROVED_ORDERS;
  const aset = new Set(A);
  const sset = new Set(SEED_ORDER_IDS);

  // 대상·최소 불변 — 여기서 실패하면 이후 아무것도 보지 않는다.
  if (snap.db !== TEST_DB)
    reasons.push("대상 DB " + snap.db + " != " + TEST_DB);
  if (snap.oid !== RESTRICTED_TEST_DB_OID)
    reasons.push("DB oid " + snap.oid + " != " + RESTRICTED_TEST_DB_OID);
  if (snap.cartItemCount !== 0)
    reasons.push(
      "cart_items " + snap.cartItemCount + "건 — 임의 삭제 금지, 중단한다",
    );
  if (reasons.length) return { mode: "abort", reasons };

  // seed 주문 지문 — 감사된 내용과 다르면 보호 대상이 바뀐 것이다.
  const orderById = new Map(snap.orders.map((o) => [o.id, o]));
  for (const id of SEED_ORDER_IDS) {
    const o = orderById.get(id);
    const exp = SEED_ORDER_EXPECTED[id];
    if (!o) reasons.push("seed 주문 " + id + " 부재");
    else if (o.status !== exp.status || o.total_won !== exp.total)
      reasons.push(
        "seed 주문 " +
          id +
          " 내용 변경 " +
          o.status +
          "/" +
          o.total_won +
          " != " +
          exp.status +
          "/" +
          exp.total,
      );
  }

  // 알려진 보존 전제는 write 이전에 검증한다 — seed 주문 종속 행 수와
  // seed 주문 취소 요청 부재가 감사 baseline과 다르면 write 0건으로 중단.
  const seedDepOf = <T extends { order_id: string }>(rows: T[]) =>
    rows.filter((r) => sset.has(r.order_id));
  if (seedDepOf(snap.items).length !== SEED_DEP_COUNTS.items)
    reasons.push(
      "seed order_items " +
        seedDepOf(snap.items).length +
        " != " +
        SEED_DEP_COUNTS.items,
    );
  if (seedDepOf(snap.payments).length !== SEED_DEP_COUNTS.payments)
    reasons.push(
      "seed payments " +
        seedDepOf(snap.payments).length +
        " != " +
        SEED_DEP_COUNTS.payments,
    );
  if (seedDepOf(snap.shipments).length !== SEED_DEP_COUNTS.shipments)
    reasons.push(
      "seed shipments " +
        seedDepOf(snap.shipments).length +
        " != " +
        SEED_DEP_COUNTS.shipments,
    );
  if (seedDepOf(snap.cancels).length !== 0)
    reasons.push("seed 주문에 취소 요청 존재 — 미감사 상태, 중단한다");

  // 보존 action ID 집합 — 36개 ID의 존재만 확인한다(내용은 지문이 검증).
  const actionIds = new Set(snap.actions.map((a) => a.id));
  const missingPreserved = RESTRICTED_PRESERVED_ACTIONS.filter(
    (id) => !actionIds.has(id),
  );
  if (missingPreserved.length)
    reasons.push(
      "보존 action " +
        missingPreserved.length +
        "건 부재: " +
        missingPreserved.slice(0, 3).join(","),
    );

  // baseline은 승인 043 buffer에서 필수 파생 — 누락할 수 없다.
  const protectedMismatch = exactRowSetMismatch(
    ctx.baseline.protectedRows,
    snap.protected,
  );
  if (
    protectedMismatch ||
    protectedFingerprint(snap.protected) !== ctx.baseline.protectedFingerprint
  )
    reasons.push(
      "보호 행 내용 지문이 승인 백업 baseline과 불일치 — " +
        (protectedMismatch ?? "fingerprint mismatch"),
    );

  // 승인 주문은 전부 있거나 전부 없어야 한다 — 부분 존재는 미감사 상태다.
  const approvedPresent = snap.orders.filter((o) => aset.has(o.id));
  if (approvedPresent.length > 0 && approvedPresent.length < A.length)
    reasons.push(
      "승인 주문 부분 존재 " + approvedPresent.length + "/13 — 중단한다",
    );
  if (reasons.length) return { mode: "abort", reasons };

  if (approvedPresent.length === A.length) {
    // ── remediate — 승인 삭제 경로 ─────────────────────────────────
    for (const o of approvedPresent)
      if (o.status !== "CONFIRMED")
        reasons.push("승인 주문 " + o.id + " status=" + o.status);
    // 주문 집합 정확성 — seed ∪ approved 외의 주문이 있으면 미감사 상태다.
    const extraOrders = snap.orders
      .filter((o) => !aset.has(o.id) && !sset.has(o.id))
      .map((o) => o.id);
    if (extraOrders.length)
      reasons.push(
        "미감사 주문 " +
          extraOrders.length +
          "건: " +
          extraOrders.slice(0, 3).join(","),
      );
    // 종속 행 — approved 소속은 정확한 건수, 나머지는 전부 seed 소속.
    const depOf = <T extends { order_id: string }>(rows: T[]) =>
      rows.filter((r) => aset.has(r.order_id));
    const dc = depOf(snap.cancels);
    const di = depOf(snap.items);
    const dp = depOf(snap.payments);
    const ds = depOf(snap.shipments);
    const cancelIds = dc.map((c) => c.id).sort();
    const wantCancels = Object.keys(RESTRICTED_CANCEL_ORDER).sort();
    if (JSON.stringify(cancelIds) !== JSON.stringify(wantCancels))
      reasons.push("승인 취소 id 불일치: [" + cancelIds.join(",") + "]");
    for (const c of dc)
      if (RESTRICTED_CANCEL_ORDER[c.id] !== c.order_id)
        reasons.push("취소 " + c.id + "→" + c.order_id + " 매핑 불일치");
    if (di.length !== RESTRICTED_EXPECTED_DEPS.items)
      reasons.push(
        "order_items " + di.length + " != " + RESTRICTED_EXPECTED_DEPS.items,
      );
    if (dp.length !== RESTRICTED_EXPECTED_DEPS.payments)
      reasons.push(
        "payments " + dp.length + " != " + RESTRICTED_EXPECTED_DEPS.payments,
      );
    if (ds.length !== RESTRICTED_EXPECTED_DEPS.shipments)
      reasons.push(
        "shipments " + ds.length + " != " + RESTRICTED_EXPECTED_DEPS.shipments,
      );
    const strayDeps = [
      ...snap.cancels,
      ...snap.items,
      ...snap.payments,
      ...snap.shipments,
    ].filter((r) => !aset.has(r.order_id) && !sset.has(r.order_id));
    if (strayDeps.length)
      reasons.push("미감사 종속 행 " + strayDeps.length + "건");
    // 주문 직접연결 action — 두 종류를 분리 검증한다:
    //   (a) CHECKOUT SUCCEEDED — result_json.order_id ∈ 13과 1:1
    //   (b) 승인 취소의 action_request_id — CANCEL_ORDER SUCCEEDED이며
    //       order_ref도 해당 주문을 가리킨다(CANCEL_ORDER도 result_json에
    //       order_id를 가진다 — 덤프/src/cancellation.ts 대조).
    const actionById = new Map(snap.actions.map((a) => [a.id, a]));
    const cxlActionIds = new Set(dc.map((c) => c.action_request_id));
    const byRef = snap.actions.filter(
      (a) => a.order_ref && aset.has(a.order_ref),
    );
    const checkoutLinked = byRef.filter((a) => !cxlActionIds.has(a.id));
    const badCheckout = checkoutLinked.filter(
      (a) => a.kind !== "CHECKOUT" || a.status !== "SUCCEEDED",
    );
    if (badCheckout.length)
      reasons.push(
        "연결 CHECKOUT action kind/status 불일치 " + badCheckout.length + "건",
      );
    const refSet = new Set(checkoutLinked.map((a) => a.order_ref));
    if (checkoutLinked.length !== A.length || refSet.size !== A.length)
      reasons.push(
        "CHECKOUT 연결이 승인 주문과 1:1이 아니다 " +
          checkoutLinked.length +
          "건/" +
          refSet.size +
          "주문",
      );
    for (const c of dc) {
      const a = actionById.get(c.action_request_id);
      if (!a) {
        reasons.push("취소 " + c.id + "의 action " + c.action_request_id + " 부재");
        continue;
      }
      if (a.kind !== "CANCEL_ORDER" || a.status !== "SUCCEEDED")
        reasons.push(
          "취소 연결 action " + a.id + " " + a.kind + "/" + a.status + " 불일치",
        );
      if (a.order_ref !== c.order_id)
        reasons.push(
          "취소 연결 action " +
            a.id +
            " order_ref " +
            a.order_ref +
            " != " +
            c.order_id,
        );
    }
    const linkedIds = new Set<string>();
    for (const a of byRef) linkedIds.add(a.id);
    for (const c of dc) linkedIds.add(c.action_request_id);
    if (linkedIds.size !== RESTRICTED_EXPECTED_DEPS.linkedActions)
      reasons.push(
        "연결 action " +
          linkedIds.size +
          " != " +
          RESTRICTED_EXPECTED_DEPS.linkedActions,
      );
    // action 전체는 보존36 ∪ 연결15와 정확히 일치 — 새 행이면 중단한다.
    const pset = new Set(RESTRICTED_PRESERVED_ACTIONS);
    const outsider = snap.actions
      .filter((a) => !linkedIds.has(a.id) && !pset.has(a.id))
      .map((a) => a.id);
    if (outsider.length)
      reasons.push(
        "미감사 action " +
          outsider.length +
          "건: " +
          outsider.slice(0, 3).join(","),
      );
    // variant/cart baseline — measured 또는 seed 값만 허용한다.
    if (snap.variants.length !== Object.keys(RESTRICTED_VARIANTS).length)
      reasons.push("variant 수 " + snap.variants.length + " != 6");
    for (const [id, b] of Object.entries(RESTRICTED_VARIANTS)) {
      const v = snap.variants.find((x) => x.id === id);
      if (!v) {
        reasons.push("variant " + id + " 부재");
        continue;
      }
      const okM =
        v.stock_qty === b.measured.stock && v.version === b.measured.version;
      const okS =
        v.stock_qty === b.seed.stock && v.version === b.seed.version;
      if (!okM && !okS)
        reasons.push(
          "variant " +
            id +
            " baseline 불일치 " +
            v.stock_qty +
            "/" +
            v.version,
        );
    }
    if (snap.carts.length !== RESTRICTED_USER_IDS.length)
      reasons.push("fixture cart 수 " + snap.carts.length + " != 4");
    for (const uid of RESTRICTED_USER_IDS) {
      const c = snap.carts.find((x) => x.user_id === uid);
      if (!c) {
        reasons.push("cart " + uid + " 부재");
        continue;
      }
      if (c.version !== 1 && c.version !== RESTRICTED_CART_VERSIONS[uid])
        reasons.push(
          "cart " + uid + " version " + c.version + " baseline 불일치",
        );
    }
    // lock 이후 첫 write 전에 주문 13 + 직접종속 57(전체 70행)을 exact 비교.
    // actor·금액·option·payment/refund·shipment·cancel·action 전체 metadata 포함.
    const deleteMismatch = exactRowSetMismatch(
      ctx.baseline.deleteRows,
      snap.deleteRows,
    );
    if (deleteMismatch)
      reasons.push(
        "삭제 대상 전체 행이 승인 043 baseline과 불일치 — " + deleteMismatch,
      );
    if (reasons.length) return { mode: "abort", reasons };
    const variantRestore = Object.entries(RESTRICTED_VARIANTS)
      .filter(([id, b]) => {
        const v = snap.variants.find((x) => x.id === id)!;
        return v.stock_qty !== b.seed.stock || v.version !== b.seed.version;
      })
      .map(([id, b]) => {
        const v = snap.variants.find((x) => x.id === id)!;
        return {
          id,
          ...b.seed,
          expectStock: v.stock_qty,
          expectVersion: v.version,
        };
      });
    const cartRestore = RESTRICTED_USER_IDS.filter((uid) => {
      const c = snap.carts.find((x) => x.user_id === uid)!;
      return c.version !== 1;
    }).map((uid) => ({
      uid,
      expectVersion: snap.carts.find((x) => x.user_id === uid)!.version,
    }));
    return {
      mode: "remediate",
      orderIds: [...A],
      orderDeletes: approvedPresent.map((o) => ({
        id: o.id,
        status: o.status,
        total: o.total_won,
      })),
      cancelIds,
      linkedActionIds: [...linkedIds],
      depCounts: {
        items: di.length,
        payments: dp.length,
        shipments: ds.length,
      },
      variantRestore,
      cartRestore,
    };
  }

  // ── verify — 승인 13이 없으면 이미 정리 상태여야 한다 ─────────────
  const nonSeedOrders = snap.orders.filter((o) => !sset.has(o.id));
  if (nonSeedOrders.length)
    reasons.push(
      "정리 대상 아닌 비-seed 주문 " +
        nonSeedOrders.length +
        "건: " +
        nonSeedOrders
          .slice(0, 3)
          .map((o) => o.id)
          .join(",") +
        " — 전체 정리는 승인 범위 밖, 중단한다",
    );
  if (snap.cancels.length)
    reasons.push("cancel_requests " + snap.cancels.length + " != 0");
  const strayDeps = [
    ...snap.cancels,
    ...snap.items,
    ...snap.payments,
    ...snap.shipments,
  ].filter((r) => !sset.has(r.order_id));
  if (strayDeps.length)
    reasons.push("비-seed 종속 행 " + strayDeps.length + "건");
  if (snap.variants.length !== Object.keys(RESTRICTED_VARIANTS).length)
    reasons.push("variant 수 " + snap.variants.length + " != 6");
  for (const [id, b] of Object.entries(RESTRICTED_VARIANTS)) {
    const v = snap.variants.find((x) => x.id === id);
    if (!v || v.stock_qty !== b.seed.stock || v.version !== b.seed.version)
      reasons.push(
        "variant " +
          id +
          " seed 값 아님 " +
          (v ? v.stock_qty + "/" + v.version : "부재"),
      );
  }
  for (const uid of RESTRICTED_USER_IDS) {
    const c = snap.carts.find((x) => x.user_id === uid);
    if (!c || c.version !== 1)
      reasons.push("cart " + uid + " version " + (c ? c.version : "부재"));
  }
  const ghosts = snap.actions.filter(
    (a) => a.order_ref && aset.has(a.order_ref),
  );
  if (ghosts.length)
    reasons.push("승인 주문 참조 action 잔존 " + ghosts.length + "건");
  if (reasons.length) return { mode: "abort", reasons };
  return { mode: "verify" };
}

type TxDb = {
  begin: <T>(fn: (q: Exec) => Promise<T>) => Promise<T>;
};

// 실DB용 mutation entry. 백업 게이트는 이 엔트리가 무조건 강제한다 —
// 호출자가 baseline을 생략·교체할 수 없고, 검증한 바이트에서 직접 파생한다.
export async function restrictedE2EReset(db: TxDb): Promise<RestrictedPlan> {
  const baseline = readApprovedResetBaseline();
  return restrictedResetTxn(db, baseline);
}

// Mutation transaction은 모듈 밖으로 노출하지 않는다. 유일한 호출자는
// 고정 승인 dump의 SHA와 baseline을 검증하는 restrictedE2EReset다.
async function restrictedResetTxn(
  db: TxDb,
  baseline: RestrictedResetBaseline,
): Promise<RestrictedPlan> {
  return db.begin(async (q) => {
    // 동시성 방어 — 세 층:
    // (1) REPEATABLE READ: 이 트랜잭션의 모든 SELECT가 하나의 스냅샷을 본다
    //     (READ COMMITTED라면 SELECT마다 다른 시점을 본다).
    // (2) 관련 테이블 SHARE ROW EXCLUSIVE 잠금: reset 동안 다른 세션의
    //     write를 차단해 이 경로가 사실상 sole writer임을 보장하고,
    //     preflight 이후 상태가 바뀌는 창을 막는다.
    // (3) write는 전부 checked-value predicate(고정 prevalue) — 잠금과
    //     별개로, 삭제/수정 대상의 현재 값이 스냅샷과 다르면 RETURNING 0건이
    //     돼 rollback된다.
    await q.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await q.unsafe(
      "LOCK TABLE cancel_requests, action_requests, order_items, payments, shipments, orders, product_variants, carts, cart_items, products, reviews, users IN SHARE ROW EXCLUSIVE MODE",
    );
    const snap = await collectSnap(q);
    const plan = evaluateRestrictedReset(snap, { baseline });
    if (plan.mode === "abort")
      throw new Error(
        "restricted reset abort — write 0건: " + plan.reasons.join(" | "),
      );
    if (plan.mode === "verify") return plan;

    // 보호 행 전체 내용의 pre 지문 — postcheck가 같은 값을 요구한다.
    const preFp = protectedFingerprint(snap.protected);

    const del = async (
      sqlText: string,
      params: unknown[],
      expect: number,
      label: string,
    ) => {
      const rows = await q.unsafe<{ id: string }[]>(sqlText, params);
      if (rows.length !== expect)
        throw new Error(
          label + " 삭제 건수 " + rows.length + " != " + expect + " — rollback",
        );
      return rows.map((r) => r.id);
    };

    // FK 순서: cancel_requests(action_requests·orders 참조) → 연결 action
    // → order_items/payments/shipments(orders 참조) → orders.
    // 삭제 대상은 승인 집합과 정확히 일치해야 한다.
    const delCancels = await del(
      "DELETE FROM cancel_requests WHERE id = ANY($1) AND order_id = ANY($2) RETURNING id",
      [plan.cancelIds, plan.orderIds],
      plan.cancelIds.length,
      "cancel_requests",
    );
    if (JSON.stringify(delCancels.sort()) !== JSON.stringify(plan.cancelIds))
      throw new Error("삭제된 취소 id가 승인 집합과 다르다 — rollback");
    await del(
      "DELETE FROM action_requests WHERE id = ANY($1) RETURNING id",
      [plan.linkedActionIds],
      plan.linkedActionIds.length,
      "action_requests",
    );
    await del(
      "DELETE FROM order_items WHERE order_id = ANY($1) RETURNING id",
      [plan.orderIds],
      plan.depCounts.items,
      "order_items",
    );
    await del(
      "DELETE FROM payments WHERE order_id = ANY($1) RETURNING id",
      [plan.orderIds],
      plan.depCounts.payments,
      "payments",
    );
    await del(
      "DELETE FROM shipments WHERE order_id = ANY($1) RETURNING id",
      [plan.orderIds],
      plan.depCounts.shipments,
      "shipments",
    );
    // 주문 — 행별 checked-value predicate(고정 prevalue: status·total).
    for (const o of plan.orderDeletes) {
      const rows = await q.unsafe<{ id: string }[]>(
        "DELETE FROM orders WHERE id = $1 AND status = $2 AND total_won = $3 RETURNING id",
        [o.id, o.status, o.total],
      );
      if (rows.length !== 1)
        throw new Error(
          "order " + o.id + " 상태가 preflight와 다르다 — rollback",
        );
    }
    // whitelist fixture 복원 — measured 값 predicate로 현재 값을 확인하며
    // 쓴다. preflight 이후 값이 바뀌었으면 RETURNING 0건 → rollback.
    for (const vr of plan.variantRestore) {
      const rows = await q.unsafe<{ id: string }[]>(
        "UPDATE product_variants SET stock_qty = $2, version = $3 WHERE id = $1 AND stock_qty = $4 AND version = $5 RETURNING id",
        [vr.id, vr.stock, vr.version, vr.expectStock, vr.expectVersion],
      );
      if (rows.length !== 1)
        throw new Error(
          "variant " + vr.id + " baseline이 preflight와 다르다 — rollback",
        );
    }
    for (const cu of plan.cartRestore) {
      const rows = await q.unsafe<{ id: string }[]>(
        "UPDATE carts SET version = 1 WHERE user_id = $1 AND version = $2 RETURNING id",
        [cu.uid, cu.expectVersion],
      );
      if (rows.length !== 1)
        throw new Error(
          "cart " + cu.uid + " baseline이 preflight와 다르다 — rollback",
        );
    }

    // postcheck — 같은 트랜잭션에서:
    // (a) 구조 재평가가 verify를 만족하는지
    // (b) 보호 행 전체 내용 지문이 pre와 동일한지(삭제 대상 외 행이
    //     우리 write로 바뀌지 않았는지) 확인한다. 실패 시 전부 rollback.
    const post = await collectSnap(q);
    const postPlan = evaluateRestrictedReset(post, { baseline });
    if (postPlan.mode !== "verify")
      throw new Error(
        "restricted reset postcheck 실패 — rollback: " +
          (postPlan.mode === "abort"
            ? postPlan.reasons.join(" | ")
            : postPlan.mode),
      );
    if (protectedFingerprint(post.protected) !== preFp)
      throw new Error(
        "restricted reset postcheck — 보호 행 내용이 pre와 다르다, rollback",
      );
    return plan;
  });
}

// playwright global-setup 진입점. 기존 setupTestDb(4)+cleanUserData의
// broad upsert·전체 비-seed 삭제를 대체하는 승인 한정 경로다.
export async function setupRestrictedE2EDb(): Promise<void> {
  // 대상 실측 — commerce_test가 아니면 어떤 write도 없다.
  await assertUrlTargetsTestDb(TEST_DB_URL);
  // seed 파일과 하드코딩 baseline의 집합 일치 — seed가 바뀌면 재감사 필요.
  const seedIds = assertSeedIds(
    loadSeedOrderIds(readFileSync("db/seeds/scenarios.json", "utf8")),
  );
  if ([...seedIds].sort().join(",") !== [...SEED_ORDER_IDS].sort().join(","))
    throw new Error(
      "scenarios.json seed 주문 집합이 baseline과 다르다 — restricted 재감사 필요",
    );
  // 스키마는 사전 조회로만 — 불충족이면 migrate 승인이 없으므로 중단한다.
  const check = postgres(TEST_DB_URL, { max: 1 });
  try {
    if (!(await schemaSatisfied(check as unknown as Exec, 4)))
      throw new Error(
        "스키마 불충족 — migrate 승인 없이 restricted reset을 중단한다",
      );
  } finally {
    await check.end().catch(() => {});
  }
  const db = postgres(TEST_DB_URL, { max: 1 });
  try {
    const plan = await restrictedE2EReset(db as unknown as TxDb);
    if (plan.mode === "remediate")
      console.log(
        "restricted reset: 승인 13주문+직접종속 삭제·fixture 복원 완료",
      );
    else console.log("restricted reset: verify — 이미 정리 상태");
  } finally {
    await db.end().catch(() => {});
  }
}
