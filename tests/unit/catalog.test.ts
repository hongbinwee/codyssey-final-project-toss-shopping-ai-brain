import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { specsMatch, variantAvailability } from "../../src/catalog.ts";
import { canonicalJson, payloadHash } from "../../src/actions.ts";

describe("availability derivation", () => {
  test("product+variant active & stock>0 -> AVAILABLE", () => {
    assert.equal(variantAvailability(true, true, 3), "AVAILABLE");
    assert.equal(variantAvailability(true, true, 0), "SOLD_OUT");
    assert.equal(variantAvailability(true, false, 5), "UNAVAILABLE");
    assert.equal(variantAvailability(false, true, 5), "UNAVAILABLE");
  });
});

describe("required specs matching", () => {
  const eff = { size: "24인치", resolution: "FHD", refresh_rate: "75Hz", panel: "IPS" };
  test("matches subset", () => {
    assert.ok(specsMatch({ size: "24인치" }, eff));
    assert.ok(specsMatch({ size: "24인치", panel: "IPS" }, eff));
    assert.ok(!specsMatch({ size: "27인치" }, eff));
    assert.ok(!specsMatch({ refresh_rate: "144Hz" }, eff));
    assert.ok(specsMatch({}, eff));
  });
});

describe("payload canonicalization", () => {
  test("key order does not change hash", () => {
    assert.equal(
      payloadHash({ a: 1, b: { c: 2, d: 3 } }),
      payloadHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
    assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }));
    assert.equal(canonicalJson({ x: [1, 2] }), canonicalJson({ x: [1, 2] }));
  });
});

