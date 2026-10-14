import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PMQA079_DATABASES,
  PMQA079_RO_TABLES,
  buildReadOnlyPsqlInput,
  buildPsqlArgs,
  resolveDockerTarget,
  readDatabaseSnapshot,
  compareWithPreflight,
  loadPinnedPreflight,
  type SnapshotExec,
  type PsqlSnapshot,
} from "../../scripts/pmqa079-ro-snapshot.ts";

function fakeSnapshot(db: string): PsqlSnapshot {
  return {
    identity: { db, oid: db === "commerce" ? 16384 : 16516, role: "commerce", owner: "commerce" },
    defaultReadOnly: "on",
    transactionReadOnly: "on",
    tables: Object.fromEntries(PMQA079_RO_TABLES.map((name) => [name, { count: 2, hash: "a".repeat(32) }])),
    writers: [],
    unreadableActive: [],
  };
}

test("fixed snapshot SQL uses one read-only transaction and only the two approved databases", () => {
  assert.deepEqual(PMQA079_DATABASES, ["commerce", "commerce_test"]);
  assert.deepEqual(PMQA079_RO_TABLES, [
    "users", "products", "product_variants", "reviews", "carts", "cart_items",
    "action_requests", "orders", "order_items", "payments", "shipments",
    "cancel_requests", "_migrations",
  ]);
  const sql = buildReadOnlyPsqlInput();
  assert.match(sql, /^SET SESSION default_transaction_read_only=on;\s*BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
  assert.doesNotMatch(sql, /ALTER SYSTEM|ALTER DATABASE/i, "persistent database settings are out of scope");
  assert.match(sql, /current_database\(\)/);
  assert.match(sql, /current_setting\('default_transaction_read_only'\)/);
  assert.match(sql, /current_setting\('transaction_read_only'\)/);
  assert.match(sql, /string_agg\(md5\(to_jsonb\(x\)::text\), '' ORDER BY md5\(to_jsonb\(x\)::text\)\)/);
  assert.match(sql, /pg_stat_activity/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.equal((sql.match(/'kind','table'/g) ?? []).length, 13);
});

test("readDatabaseSnapshot uses the injected runner and parses the fixed JSON-lines contract", async () => {
  const expected = fakeSnapshot("commerce");
  const exec: SnapshotExec = async (db, input) => {
    assert.equal(db, "commerce");
    assert.match(input, /^SET SESSION default_transaction_read_only=on;\s*BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
    const lines = [
      { kind: "identity", ...expected.identity },
      { kind: "settings", defaultReadOnly: "on", transactionReadOnly: "on" },
      ...Object.entries(expected.tables).map(([name, value]) => ({ kind: "table", name, ...value })),
      { kind: "writers", pids: [] },
      { kind: "unreadable", pids: [] },
    ];
    return { code: 0, stdout: lines.map((line) => JSON.stringify(line)).join("\n") };
  };
  assert.deepEqual(await readDatabaseSnapshot("commerce", exec), expected);
});

test("readDatabaseSnapshot fails closed on writer sessions or incomplete output", async () => {
  const expected = fakeSnapshot("commerce");
  const output = [
    { kind: "identity", ...expected.identity },
    { kind: "settings", defaultReadOnly: "on", transactionReadOnly: "on" },
    ...Object.entries(expected.tables).map(([name, value]) => ({ kind: "table", name, ...value })),
    { kind: "writers", pids: [123] },
    { kind: "unreadable", pids: [] },
  ].map((line) => JSON.stringify(line)).join("\n");
  await assert.rejects(readDatabaseSnapshot("commerce", async () => ({ code: 0, stdout: output })), /writer/i);
  await assert.rejects(readDatabaseSnapshot("commerce", async () => ({ code: 0, stdout: "" })), /snapshot/i);
});

test("preflight comparison requires identity and every table count/hash to match", () => {
  const expected = fakeSnapshot("commerce");
  const baseline = {
    identity: { ...expected.identity, pass: true },
    snapshot: {
      db: "commerce",
      oid: 16384,
      tables: Object.fromEntries(Object.entries(expected.tables).map(([name, row]) => [name, { n: row.count, h: row.hash }])),
      pass: true,
    },
    pass: true,
  };
  assert.deepEqual(compareWithPreflight(expected, baseline), []);
  const changed = { ...expected, tables: { ...expected.tables, orders: { count: 3, hash: "b".repeat(32) } } };
  assert.ok(compareWithPreflight(changed, baseline).some((reason) => reason.includes("orders")));
  assert.ok(compareWithPreflight({ ...expected, identity: { ...expected.identity, owner: "other" } }, baseline).some((reason) => reason.includes("owner")));
});

test("pinned preflight JSON accepts an exact read-only fake snapshot for both protected databases", () => {
  const preflight = loadPinnedPreflight();
  for (const db of PMQA079_DATABASES) {
    const baseline = preflight.databases[db];
    const live: PsqlSnapshot = {
      identity: {
        db: baseline.identity.db,
        oid: baseline.identity.oid,
        role: baseline.identity.role,
        owner: baseline.identity.owner,
      },
      defaultReadOnly: "on",
      transactionReadOnly: "on",
      tables: Object.fromEntries(
        Object.entries(baseline.snapshot.tables).map(([name, row]) => [name, { count: row.n, hash: row.h }]),
      ),
      writers: [],
      unreadableActive: [],
    };
    assert.deepEqual(compareWithPreflight(live, baseline), [], db);
  }
});

test("Docker target resolution rejects target override keys before any Docker command", async () => {
  let calls = 0;
  const secretLookingValue = "do-not-echo-this-context-value";
  await assert.rejects(
    resolveDockerTarget(async () => {
      calls++;
      return { code: 0, stdout: "desktop-linux\n" };
    }, { DOCKER_CONTEXT: secretLookingValue }),
    (error: unknown) => {
      assert.match(String(error), /DOCKER_CONTEXT/);
      assert.doesNotMatch(String(error), new RegExp(secretLookingValue));
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("Docker target is pinned by the existing container metadata before direct exec", async () => {
  const seen: string[][] = [];
  const target = await resolveDockerTarget(async (args) => {
    seen.push(args);
    if (args[0] === "context" && args[1] === "show")
      return { code: 0, stdout: "desktop-linux\n" };
    return {
      code: 0,
      stdout: "6f8801d712351c30cbf5e509079ade7f9b3ce0665485530246eb2c0686eb166b|sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24|true|volume|codyssey_final_pgdata|/var/lib/postgresql/data\n",
    };
  }, {});
  assert.deepEqual(target, { context: "desktop-linux" });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].slice(0, 2), ["--context", "desktop-linux"]);
  assert.match(seen[1].join(" "), /6f8801d712351c30cbf5e509079ade7f9b3ce0665485530246eb2c0686eb166b/);
  assert.deepEqual(buildPsqlArgs("desktop-linux", "commerce"), [
    "--context", "desktop-linux", "exec", "-i",
    "6f8801d712351c30cbf5e509079ade7f9b3ce0665485530246eb2c0686eb166b",
    "psql", "-X", "-q", "-t", "-A", "-w", "-v", "ON_ERROR_STOP=1",
    "-U", "commerce", "-d", "commerce",
  ]);
});
