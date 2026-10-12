// PMQA-056 최종검수 ③ — qa-run 사용자 인자 검증 순수 함수 단위 테스트.
// 실제 reserve/spawn·DB·PW 없이 checkArgs의 허용/거부 계약만 검증한다:
// - 정상 4키는 단일 실행 계획
// - 인자 없음은 전체 4키 경로(빈 run → every([])=true 조용한 PASS 불가)
// - constructor/toString 등 상속 키·알 수 없는 키·추가 인자는 거부
import assert from "node:assert/strict";
import test from "node:test";
import { checkArgs } from "../../scripts/pmqa056-qa-run.ts";

test("인자 없음 — 4개 커맨드 전체 실행 계획 (빈 run 불가)", () => {
  const p = checkArgs([]);
  assert.equal(p.ok, true);
  if (p.ok)
    assert.deepEqual(p.run, ["unit-focused", "unit", "check", "build"]);
});

test("정상 키 4개는 각각 단일 실행 계획", () => {
  for (const key of ["unit-focused", "unit", "check", "build"] as const) {
    const p = checkArgs([key]);
    assert.equal(p.ok, true, key);
    if (p.ok) assert.deepEqual(p.run, [key]);
  }
});

test("상속 프로퍼티 키는 거부 — `in` 연산자 허용 회귀 방지", () => {
  for (const key of [
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "__proto__",
  ]) {
    const p = checkArgs([key]);
    assert.equal(p.ok, false, key);
    if (!p.ok) assert.match(p.reason, /허용 커맨드 아님/);
  }
});

test("알 수 없는 키·변형 키는 거부", () => {
  assert.equal(checkArgs(["unknown-key"]).ok, false);
  assert.equal(checkArgs(["unit "]).ok, false); // 공백 포함 변형
  assert.equal(checkArgs(["UNIT"]).ok, false); // 대소문자 변형
  assert.equal(checkArgs([""]).ok, false); // 빈 문자열
});

test("추가 인자는 정상 키와 함께여도 거부", () => {
  assert.equal(checkArgs(["unit", "extra"]).ok, false);
  assert.equal(checkArgs(["unit", "check"]).ok, false); // 정상 키 2개도 거부
  assert.equal(checkArgs(["unit-focused", "--grep", "x"]).ok, false);
  for (const bad of [
    checkArgs(["unit", "extra"]),
    checkArgs(["check", "check"]),
  ]) {
    if (!bad.ok) assert.match(bad.reason, /추가 인자 불가/);
    else assert.fail("거부되어야 함");
  }
});
