// scripts/migrations-manifest.ts의 순수 검증 — DB 없이 매니페스트 등록·
// phase 인자·계획 분기를 회귀한다 [PMQA-070].
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PHASE_MIGRATIONS, MAX_PHASE, requiredMigrations, parsePhaseArg,
  planMigrations,
} from "../../scripts/migrations-manifest.ts";

const BASE = [
  "001_catalog_cart_actions.sql",
  "002_orders_payments_shipments.sql",
  "003_cancel_requests.sql",
];
const WISH = "004_wishlist_items.sql";

describe("migrations-manifest — phase 등록·계획", () => {
  test("requiredMigrations: 001~003은 phase<=4, 004는 opt-in phase6에서만", () => {
    assert.deepEqual(requiredMigrations(4), BASE);
    assert.ok(!requiredMigrations(4).includes(WISH));
    assert.deepEqual(requiredMigrations(6), [...BASE, WISH]);
    // 신규 phase 추가 시 이 단정과 기대 집합을 함께 갱신한다.
    assert.equal(MAX_PHASE, 6);
  });

  test("parsePhaseArg: 0..MAX_PHASE 정수만 허용한다", () => {
    assert.equal(parsePhaseArg(undefined), 0);   // 인자 없음 = 기본 phase 0
    assert.equal(parsePhaseArg("0"), 0);
    assert.equal(parsePhaseArg("4"), 4);
    assert.equal(parsePhaseArg("6"), 6);
    assert.equal(parsePhaseArg("7"), null);      // 미등록 상위 phase
    assert.equal(parsePhaseArg("-1"), null);     // 음수
    assert.equal(parsePhaseArg("2.5"), null);    // 비정수
    assert.equal(parsePhaseArg("abc"), null);    // NaN
    // ""는 Number()로 0이 된다 — --phase= 빈값은 phase 0으로 해석돼
    // 아무 migration도 적용하지 않는다(보수적) [관찰된 현재 동작].
    assert.equal(parsePhaseArg(""), 0);
  });

  test("planMigrations: 미적용 대상 apply / 등록 상위 skip / 미등록 unknown", () => {
    const files = [...BASE, WISH, "999_orphan.sql"];
    const applied = new Set([BASE[0]]);
    const p4 = planMigrations(files, applied, 4);
    assert.deepEqual(p4.apply, [BASE[1], BASE[2]]);
    assert.deepEqual(p4.skip, [WISH]);              // 등록 상위 — 이번 대상 아님
    assert.deepEqual(p4.unknown, ["999_orphan.sql"]); // fail closed 대상
    const p6 = planMigrations(files, applied, 6);
    assert.deepEqual(p6.apply, [BASE[1], BASE[2], WISH]);
    assert.deepEqual(p6.skip, []);
    // 이미 적용된 파일은 재실행하지 않는다
    const done = planMigrations(files, new Set(files), 6);
    assert.deepEqual(done.apply, []);
    assert.deepEqual(done.skip, []);
    assert.deepEqual(done.unknown, []);
  });

  test("디스크의 모든 NNN_*.sql이 phase에 등록돼 있다 (등록 누락 방지)", () => {
    const dir = fileURLToPath(new URL("../../db/migrations", import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort();
    const registered = Object.values(PHASE_MIGRATIONS).flat().sort();
    for (const f of files)
      assert.ok(registered.includes(f), "migration has no phase mapping: " + f);
    // 등록 집합과 실제 파일 집합이 정확히 일치한다 — 유령 등록도 잡는다
    assert.deepEqual(registered, files);
  });
});
