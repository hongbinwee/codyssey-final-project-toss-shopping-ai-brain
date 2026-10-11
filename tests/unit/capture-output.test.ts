import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserveCaptureOutput } from "../helpers/capture-output.ts";

test("capture output reservation: an existing run directory fails before consumer side effects", async () => {
  const temp = mkdtempSync(join(tmpdir(), "capture-reserve-"));
  try {
    const root = join(temp, "runs");
    const existing = join(root, "run-fixed");
    mkdirSync(existing, { recursive: true });
    const sentinels = ["impl.png", "facts.json", "facts-progress.json"];
    for (const name of sentinels) writeFileSync(join(existing, name), "preserve:" + name);
    let cartMutations = 0;
    let captures = 0;
    await assert.rejects(async () => {
      const out = await reserveCaptureOutput(root, "fixed");
      cartMutations++;
      captures++;
      return out;
    }, /EEXIST|already exists|capture output/i);
    assert.equal(cartMutations, 0);
    assert.equal(captures, 0);
    for (const name of sentinels)
      assert.equal(readFileSync(join(existing, name), "utf8"), "preserve:" + name);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("capture output reservation: concurrent claim of the same run path has exactly one winner", async () => {
  const temp = mkdtempSync(join(tmpdir(), "capture-reserve-race-"));
  try {
    const root = join(temp, "runs");
    const results = await Promise.allSettled([
      reserveCaptureOutput(root, "same-run"),
      reserveCaptureOutput(root, "same-run"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const winner = results.find((r) => r.status === "fulfilled");
    assert.ok(winner && winner.status === "fulfilled");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("capture output reservation: unrelated prior evidence directories are untouched", async () => {
  const temp = mkdtempSync(join(tmpdir(), "capture-reserve-evidence-"));
  try {
    const root = join(temp, "shots", "06a");
    for (const name of ["pmqa040", "pmqa043", "pmqa044"]) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "facts.json"), "approved:" + name);
      writeFileSync(join(dir, "approved.png"), "png:" + name);
    }
    const out = await reserveCaptureOutput(join(root, "pmqa040-runs"), "new-run");
    assert.equal(out.replace(/[\\/]+$/, ""), join(root, "pmqa040-runs", "run-new-run"));
    for (const name of ["pmqa040", "pmqa043", "pmqa044"]) {
      assert.equal(readFileSync(join(root, name, "facts.json"), "utf8"), "approved:" + name);
      assert.equal(readFileSync(join(root, name, "approved.png"), "utf8"), "png:" + name);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
