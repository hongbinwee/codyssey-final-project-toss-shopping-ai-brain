// tests/helpers/isolated-prepare.ts의 DB-free 단위 검증 [PMQA-051-A].
// 실제 PostgreSQL 없이 mock client로 경계를 실증한다 — 실PG 원자 롤백·
// 통합 실행 증거는 아니다(실DB 검증은 별도 승인, NOT_RUN 유지).
//   gate 거부(연결/소유권): attempted write 0건을 단정한다.
//   통과 후 중간 실패(migration/seed): attempted query는 발행됐어도
//   mock ROLLBACK + COMMIT 0건·실패 이후 query 0건을 단정한다 — 이것은
//   호출 순서·범위의 계약 증거이지 실DB 롤백 보증이 아니다.
//   seedBase 정합성: baseline(65161f5)의 원본 base for-loop를 one-off
//   tmp stub으로 실행해 얻은 ordered {query,params} transcript의
//   count·sha256을 아래 GOLDEN_CASES에 inline 고정 — git·HEAD·외부
//   golden 파일 비의존, repo fixture JSON(db/seeds/*.json) 의존.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ISOLATED_MIGRATIONS,
  prepareIsolatedDb,
  type SqlClient,
} from "../helpers/isolated-prepare.ts";
import { seedBase, type SeedExec } from "../../scripts/base-seed.ts";
import { requiredMigrations } from "../../scripts/migrations-manifest.ts";

const CONTRACT = {
  dbUrl: "postgres://commerce:commerce@localhost:5432/scratch_0123456789abcdef",
  dbName: "scratch_0123456789abcdef",
  dbOid: 70001,
  dbOwner: 10,
  runId: "11111111-2222-3333-4444-555555555555",
};

const FULL_ENV = {
  SCRATCH_DB_TESTS: "1",
  ISOLATED_STRICT: "1",
  ISOLATED_DB_URL: CONTRACT.dbUrl,
  ISOLATED_DB_NAME: CONTRACT.dbName,
  ISOLATED_DB_OID: String(CONTRACT.dbOid),
  ISOLATED_DB_OWNER: String(CONTRACT.dbOwner),
  ISOLATED_RUN_ID: CONTRACT.runId,
  DATABASE_URL: CONTRACT.dbUrl,
};

type Rec = { q: string; p?: unknown[]; inTxn: boolean };

// mock client — BEGIN/COMMIT/ROLLBACK/END와 모든 query(+txn 내부 여부)를
// 기록한다. identity/marker/migrationShas/failOn으로 경계 시나리오를 만든다.
function makeClient(
  opts: {
    identity?: Record<string, unknown>;
    marker?: Record<string, unknown>[];
    migrationShas?: Record<string, string>;
    failOn?: (q: string) => boolean;
  } = {},
) {
  const queries: Rec[] = [];
  const events: string[] = [];
  let inTxn = false;
  const runQuery = async (q: string, p?: unknown[]) => {
    queries.push({ q, p, inTxn });
    if (opts.failOn?.(q)) throw new Error("injected failure");
    if (q.includes("current_database()"))
      return [
        opts.identity ?? {
          d: CONTRACT.dbName,
          oid: CONTRACT.dbOid,
          owner: CONTRACT.dbOwner,
        },
      ];
    if (q.includes("_scratch_owner"))
      return opts.marker ?? [{ run_id: CONTRACT.runId }];
    if (q.startsWith("SELECT sha256 FROM _migrations")) {
      const sha = opts.migrationShas?.[p?.[0] as string];
      return sha ? [{ sha256: sha }] : [];
    }
    if (q.includes("to_regclass")) return [{ r: "public.cancel_requests" }];
    return [];
  };
  const client = {
    queries,
    events,
    // txn 밖 경로 — prepareIsolatedDb는 이 경로를 쓰지 않아야 한다.
    unsafe: (q: string, p?: unknown[]) => runQuery(q, p),
    begin: async <T>(fn: (q: { unsafe: (q: string, p?: unknown[]) => Promise<never> }) => Promise<T>) => {
      events.push("BEGIN");
      inTxn = true;
      try {
        const r = await fn({
          unsafe: (q: string, p?: unknown[]) =>
            runQuery(q, p) as Promise<never>,
        });
        inTxn = false;
        events.push("COMMIT");
        return r;
      } catch (e) {
        inTxn = false;
        events.push("ROLLBACK");
        throw e;
      }
    },
    end: async () => {
      events.push("END");
    },
  } as unknown as SqlClient & { queries: Rec[]; events: string[] };
  let connectCalls = 0;
  let connectUrl: string | undefined;
  const connect = (url: string, _opts?: { max?: number }) => {
    connectCalls++;
    connectUrl = url;
    return client;
  };
  return {
    client,
    connect,
    get connectCalls() {
      return connectCalls;
    },
    get connectUrl() {
      return connectUrl;
    },
  };
}

describe("prepareIsolatedDb — 연결 게이트", () => {
  test("opt-in 없음 — connect 0건으로 즉시 거부", async () => {
    const m = makeClient();
    await assert.rejects(
      prepareIsolatedDb({ ...FULL_ENV, SCRATCH_DB_TESTS: "0" }, { connect: m.connect }),
      /opt-in/,
    );
    assert.equal(m.connectCalls, 0);
    assert.equal(m.client.queries.length, 0);
  });

  test("strict 없음 — connect 0건으로 거부", async () => {
    const m = makeClient();
    const { ISOLATED_STRICT: _dropped, ...env } = FULL_ENV;
    await assert.rejects(
      prepareIsolatedDb(env, { connect: m.connect }),
      /strict/,
    );
    assert.equal(m.connectCalls, 0);
  });

  test("계약 부분 누락 — connect 0건으로 거부", async () => {
    const m = makeClient();
    await assert.rejects(
      prepareIsolatedDb(
        {
          SCRATCH_DB_TESTS: "1",
          ISOLATED_STRICT: "1",
          ISOLATED_DB_URL: CONTRACT.dbUrl,
          ISOLATED_DB_NAME: CONTRACT.dbName,
        },
        { connect: m.connect },
      ),
      /부분 누락/,
    );
    assert.equal(m.connectCalls, 0);
  });

  test("보호 DB 이름 — connect 0건으로 거부", async () => {
    const m = makeClient();
    await assert.rejects(
      prepareIsolatedDb(
        {
          ...FULL_ENV,
          ISOLATED_DB_URL: "postgres://commerce:commerce@localhost:5432/commerce",
          ISOLATED_DB_NAME: "commerce",
        },
        { connect: m.connect },
      ),
      /허용되지 않는 DB 이름/,
    );
    assert.equal(m.connectCalls, 0);
  });

  test("source DATABASE_URL 불일치 — connect 0건으로 거부", async () => {
    const m = makeClient();
    await assert.rejects(
      prepareIsolatedDb(
        { ...FULL_ENV, DATABASE_URL: "postgres://x@localhost:1/other" },
        { connect: m.connect },
      ),
      /DATABASE_URL이 계약과 다름/,
    );
    assert.equal(m.connectCalls, 0);
  });
});

describe("prepareIsolatedDb — 소유권 게이트", () => {
  const cases: [string, Parameters<typeof makeClient>[0]][] = [
    [
      "name 불일치",
      {
        identity: {
          d: "scratch_eeeeeeeeeeeeeeee",
          oid: CONTRACT.dbOid,
          owner: CONTRACT.dbOwner,
        },
      },
    ],
    [
      "OID 불일치",
      {
        identity: { d: CONTRACT.dbName, oid: 424242, owner: CONTRACT.dbOwner },
      },
    ],
    [
      "owner 불일치",
      {
        identity: { d: CONTRACT.dbName, oid: CONTRACT.dbOid, owner: 424242 },
      },
    ],
    [
      "marker 불일치",
      {
        marker: [{ run_id: "99999999-9999-9999-9999-999999999999" }],
      },
    ],
    [
      "marker 행 수 != 1",
      {
        marker: [
          { run_id: CONTRACT.runId },
          { run_id: CONTRACT.runId },
        ],
      },
    ],
  ];
  for (const [label, o] of cases) {
    test(label + " — write 0건 + rollback", async () => {
      const m = makeClient(o);
      await assert.rejects(
        prepareIsolatedDb(FULL_ENV, { connect: m.connect }),
        /소유권|불일치|행 수/,
      );
      assert.deepEqual(m.client.events, ["BEGIN", "ROLLBACK", "END"]);
      const writes = m.client.queries.filter((r) =>
        /\b(CREATE|INSERT|DELETE|UPDATE)\b/.test(r.q),
      );
      assert.equal(writes.length, 0, "guard 실패 후 write: " + writes[0]?.q);
    });
  }
});

describe("prepareIsolatedDb — 성공 경로", () => {
  test("모든 write가 하나의 트랜잭션 안 — commit 정확히 1회", async () => {
    const m = makeClient();
    const r = await prepareIsolatedDb(FULL_ENV, { connect: m.connect });
    assert.equal(r.ok, true);
    assert.equal(r.dbName, CONTRACT.dbName);
    assert.equal(m.connectUrl, CONTRACT.dbUrl);
    assert.deepEqual(m.client.events, ["BEGIN", "COMMIT", "END"]);
    // txn 밖으로 실행된 query는 0건.
    for (const rec of m.client.queries)
      assert.equal(rec.inTxn, true, "txn 밖 query: " + rec.q.slice(0, 80));
    // guard 전 write 0건 — 첫 두 query는 소유권 실측 SELECT뿐.
    assert.ok(m.client.queries[0].q.includes("current_database()"));
    assert.ok(m.client.queries[1].q.includes("_scratch_owner"));
    for (const rec of m.client.queries.slice(0, 2))
      assert.equal(
        /\b(CREATE|INSERT|DELETE|UPDATE)\b/.test(rec.q),
        false,
        "guard 전 write: " + rec.q,
      );
    // _migrations CREATE도 guard 이후 txn 안에서 실행된다.
    const migCreate = m.client.queries.findIndex((rec) =>
      rec.q.includes("CREATE TABLE IF NOT EXISTS _migrations"),
    );
    assert.ok(migCreate > 1);
    // seeded 파일은 phase<=4 fixture 전부.
    assert.deepEqual(r.seededFiles, [
      "users.json",
      "catalog.json",
      "reviews.json",
      "scenarios.json",
    ]);
    assert.equal(r.migrations.length, ISOLATED_MIGRATIONS.length);
  });

  test("canonical migration 3개 — 실제 파일 body와 sha256이 그대로", async () => {
    const m = makeClient();
    await prepareIsolatedDb(FULL_ENV, { connect: m.connect });
    for (const f of ISOLATED_MIGRATIONS) {
      const body = readFileSync("db/migrations/" + f, "utf8");
      const sha = createHash("sha256").update(body).digest("hex");
      assert.ok(
        m.client.queries.some((rec) => rec.q === body),
        f + " 본문이 그대로 실행되지 않음",
      );
      const rec = m.client.queries.find(
        (x) => x.q.includes("INSERT INTO _migrations") && x.p?.[0] === f,
      );
      assert.ok(rec, f + " _migrations 기록 없음");
      assert.equal(rec.p?.[1], sha, f + " sha 불일치");
    }
  });

  test("phase 6만 canonical 004 wishlist migration을 포함한다", async () => {
    const m = makeClient();
    const r = await prepareIsolatedDb(FULL_ENV, { connect: m.connect }, { phase: 6 });
    const expected = requiredMigrations(6);
    assert.deepEqual(r.migrations.map((x) => x.name), expected);
    assert.ok(expected.includes("004_wishlist_items.sql"));
    const body = readFileSync("db/migrations/004_wishlist_items.sql", "utf8");
    assert.ok(m.client.queries.some((rec) => rec.q === body));
    assert.deepEqual(r.seededFiles, [
      "users.json",
      "catalog.json",
      "reviews.json",
      "scenarios.json",
    ]);
  });

  test("주입 seed reader는 owned guard 뒤 같은 트랜잭션에서 실행된다", async () => {
    const m = makeClient();
    const reads: string[] = [];
    const readerSawGuardedTxn: boolean[] = [];
    const seedRead = (f: string): unknown => {
      reads.push(f);
      readerSawGuardedTxn.push(
        m.client.events.includes("BEGIN") &&
          !m.client.events.includes("COMMIT") &&
          m.client.queries[0]?.q.includes("current_database()") === true &&
          m.client.queries[1]?.q.includes("_scratch_owner") === true &&
          m.client.queries[0]?.inTxn === true &&
          m.client.queries[1]?.inTxn === true,
      );
      if (f === "catalog.json")
        return {
          products: [{
            id: "p-d-preview",
            name: "Preview Demo",
            brand: "Demo",
            category: "digital",
            description: "preview seed reader test",
            image_urls: [],
            specs: {},
          }],
          variants: [{
            id: "v-d-preview",
            product_id: "p-d-preview",
            option_values: {},
            spec_overrides: {},
            unit_price_won: 1000,
            stock_qty: 1,
          }],
        };
      if (f === "reviews.json")
        return [{
          id: "r-d-preview",
          product_id: "p-d-preview",
          variant_id: "v-d-preview",
          rating: 5,
          body: "preview review",
          source_kind: "SYNTHETIC",
          source_ref: "unit",
          written_at: "2026-10-14T00:00:00.000Z",
        }];
      if (f === "scenarios.json") return { orders: [] };
      return [];
    };
    const r = await prepareIsolatedDb(
      FULL_ENV,
      { connect: m.connect, seedRead },
      { phase: 6 },
    );

    assert.equal(r.ok, true);
    assert.deepEqual(reads, ["users.json", "catalog.json", "reviews.json", "scenarios.json"]);
    assert.ok(readerSawGuardedTxn.every(Boolean));
    assert.ok(m.client.queries.every((q) => q.inTxn));
    assert.ok(m.client.queries.some((q) => q.q.startsWith("INSERT INTO products") && q.p?.[0] === "p-d-preview"));
    assert.ok(m.client.queries.some((q) => q.q.startsWith("INSERT INTO reviews") && q.p?.[0] === "r-d-preview"));
  });

  test("지원하지 않는 phase는 DB 연결 전 거부한다", async () => {
    const m = makeClient();
    await assert.rejects(
      prepareIsolatedDb(FULL_ENV, { connect: m.connect }, { phase: 5 } as never),
      /phase는 4.*또는 6/,
    );
    assert.equal(m.connectCalls, 0);
    assert.equal(m.client.queries.length, 0);
  });

  test("기존 _migrations 행의 sha가 같으면 재적용하지 않는다", async () => {
    const applied: Record<string, string> = {};
    for (const f of ISOLATED_MIGRATIONS)
      applied[f] = createHash("sha256")
        .update(readFileSync("db/migrations/" + f, "utf8"))
        .digest("hex");
    const m = makeClient({ migrationShas: applied });
    await prepareIsolatedDb(FULL_ENV, { connect: m.connect });
    // DDL 본문 재실행 0건 — 세 파일 본문이 query로 나타나지 않아야 한다.
    for (const f of ISOLATED_MIGRATIONS) {
      const body = readFileSync("db/migrations/" + f, "utf8");
      assert.equal(
        m.client.queries.some((rec) => rec.q === body),
        false,
        f + " 재적용됨",
      );
    }
  });

  test("base fixture 의미 보존 — 실제 seed JSON 파라미터와 일치", async () => {
    const m = makeClient();
    await prepareIsolatedDb(FULL_ENV, { connect: m.connect });
    const catalog = JSON.parse(
      readFileSync("db/seeds/catalog.json", "utf8"),
    ) as {
      products: { id: string; name: string }[];
      variants: {
        id: string;
        product_id: string;
        unit_price_won: number;
        stock_qty: number;
      }[];
    };
    const scenarios = JSON.parse(
      readFileSync("db/seeds/scenarios.json", "utf8"),
    ) as {
      orders: {
        id: string;
        total_won: number;
        payment?: { paid_amount_won: number };
        shipment?: { status: string };
      }[];
    };
    // p-a 상품·variant upsert — 파라미터가 fixture와 동일하고 version=1 리셋 유지.
    const pa = catalog.products.find((p) => p.id === "p-a")!;
    const pRec = m.client.queries.find(
      (r) => r.q.includes("INSERT INTO products") && r.p?.[0] === "p-a",
    );
    assert.ok(pRec);
    assert.equal(pRec.p?.[1], pa.name);
    const v = catalog.variants.find((x) => x.product_id === "p-a")!;
    const vRec = m.client.queries.find(
      (r) => r.q.includes("INSERT INTO product_variants") && r.p?.[0] === v.id,
    );
    assert.ok(vRec);
    assert.equal(vRec.p?.[4], v.unit_price_won);
    assert.equal(vRec.p?.[5], v.stock_qty);
    assert.ok(vRec.q.includes("version=1"));
    // 시나리오 주문 — ord-* ID·금액·version=1·cancelled_at NULL·결제/배송 행.
    const o = scenarios.orders[0];
    const oRec = m.client.queries.find(
      (r) => r.q.includes("INSERT INTO orders") && r.p?.[0] === o.id,
    );
    assert.ok(oRec, "주문 " + o.id + " seed 누락");
    assert.equal(oRec.p?.[5], o.total_won);
    assert.ok(oRec.q.includes("version, cancelled_at"));
    assert.ok(
      m.client.queries.some(
        (r) =>
          r.q.includes("DELETE FROM cancel_requests") && r.p?.[0] === o.id,
      ),
    );
    if (o.payment)
      assert.ok(
        m.client.queries.some(
          (r) => r.q.includes("INSERT INTO payments") && r.p?.[0] === o.id + "-pay",
        ),
      );
    if (o.shipment)
      assert.ok(
        m.client.queries.some(
          (r) => r.q.includes("INSERT INTO shipments") && r.p?.[0] === o.id + "-ship",
        ),
      );
  });

  test("진입 후 env 변조 — 이미 materialize된 계약 대상을 유지", async () => {
    const env = { ...FULL_ENV };
    const m = makeClient();
    const inner = m.connect;
    const connect = (url: string, opts?: { max?: number }) => {
      const c = inner(url, opts);
      // connect 이후 source env를 변조해도 계약은 진입 시점 사본이다.
      env.ISOLATED_DB_NAME = "scratch_ffffffffffffffff";
      env.ISOLATED_DB_URL =
        "postgres://commerce:commerce@localhost:5432/scratch_ffffffffffffffff";
      return c;
    };
    const r = await prepareIsolatedDb(env, { connect });
    assert.equal(r.dbName, CONTRACT.dbName);
    assert.equal(m.connectUrl, CONTRACT.dbUrl);
  });
});

describe("prepareIsolatedDb — 실패·원자성 경계", () => {
  test("기존 _migrations sha 불일치 — throw + rollback + 이후 query 0건", async () => {
    const m = makeClient({
      migrationShas: {
        "002_orders_payments_shipments.sql": "deadbeefdeadbeef",
      },
    });
    await assert.rejects(
      prepareIsolatedDb(FULL_ENV, { connect: m.connect }),
      /migration changed/,
    );
    assert.deepEqual(m.client.events, ["BEGIN", "ROLLBACK", "END"]);
    // 002 SELECT 직후 throw — 실패 이후 실행된 query는 0건.
    const idx = m.client.queries.findIndex(
      (r) =>
        r.q.startsWith("SELECT sha256 FROM _migrations") &&
        r.p?.[0] === "002_orders_payments_shipments.sql",
    );
    assert.ok(idx >= 0);
    assert.equal(m.client.queries.length - 1, idx);
  });

  test("seed 중간 실패 — rollback + commit 0건 + 실패 지점이 마지막 query", async () => {
    const m = makeClient({
      failOn: (q) => q.includes("INSERT INTO payments"),
    });
    await assert.rejects(
      prepareIsolatedDb(FULL_ENV, { connect: m.connect }),
      /injected failure/,
    );
    assert.deepEqual(m.client.events, ["BEGIN", "ROLLBACK", "END"]);
    const idx = m.client.queries.findIndex((r) =>
      r.q.includes("INSERT INTO payments"),
    );
    assert.ok(idx >= 0);
    assert.equal(m.client.queries.length - 1, idx);
  });

  test("migration 본문 실행 실패 — rollback + 실패 DDL이 마지막 query + DROP/cleanup 0건", async () => {
    const body2 = readFileSync(
      "db/migrations/002_orders_payments_shipments.sql",
      "utf8",
    );
    const m = makeClient({ failOn: (q) => q === body2 });
    await assert.rejects(
      prepareIsolatedDb(FULL_ENV, { connect: m.connect }),
      /injected failure/,
    );
    assert.deepEqual(m.client.events, ["BEGIN", "ROLLBACK", "END"]);
    assert.equal(m.client.queries.at(-1)!.q, body2);
    const all = m.client.queries.map((r) => r.q).join("\n");
    assert.equal(/DROP\s+(DATABASE|TABLE)/i.test(all), false);
  });

  test("migration 파일 부재 — 고유 temp cwd로만 격리 검증, 실 repo 파일 불변", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "iso-prep-"));
    try {
      // 001/002만 배치해 003 부재 상황을 만든다 — 실 repo 파일은 건드리지 않는다.
      mkdirSync(join(tmp, "db", "migrations"), { recursive: true });
      for (const f of ISOLATED_MIGRATIONS.slice(0, 2))
        copyFileSync(
          join("db", "migrations", f),
          join(tmp, "db", "migrations", f),
        );
      const repoFile = join(
        process.cwd(),
        "db",
        "migrations",
        "003_cancel_requests.sql",
      );
      const shaOf = () =>
        createHash("sha256").update(readFileSync(repoFile)).digest("hex");
      const before = shaOf();
      const orig = process.cwd();
      const m = makeClient();
      try {
        process.chdir(tmp);
        await assert.rejects(
          prepareIsolatedDb(FULL_ENV, { connect: m.connect }),
          /migration 파일 부재: 003/,
        );
      } finally {
        process.chdir(orig);
      }
      assert.equal(process.cwd(), orig);
      assert.deepEqual(m.client.events, ["BEGIN", "ROLLBACK", "END"]);
      // 실패 지점 = 002의 _migrations INSERT까지 — 003 query는 0건.
      const last = m.client.queries.at(-1)!;
      assert.ok(
        last.q.includes("INSERT INTO _migrations") &&
          last.p?.[0] === "002_orders_payments_shipments.sql",
      );
      const all = m.client.queries.map((r) => r.q).join("\n");
      assert.equal(/DROP\s+(DATABASE|TABLE)/i.test(all), false);
      assert.equal(shaOf(), before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// baseline(65161f57fb0f038907ab5757b0c3125113a5c2cf:scripts/seed.ts)의
// 원본 base for-loop를 one-off tmp stub(unsafe=전 query+params 기록·
// read=실제 db/seeds·to_regclass 분기)으로 실행해 얻은 transcript의
// count·sha256을 inline 고정한 정본 — git·HEAD·외부 golden 파일 비의존.
// 한계 [Luna MINOR-Q051]: JSON.stringify는 null/undefined·비유한수를
// 동일하게 직렬화하므로 Golden은 현재 fixture/SQL/params 값 검증이며
// 모든 형변조 검출을 보장하지 않는다 — 09 전 검증 품질 후속으로 이관.
const GOLDEN_CASES: Record<string, { count: number; sha256: string }> = {
  phase0_cancelPresent: { count: 0, sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  phase0_cancelAbsent: { count: 0, sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
  phase1_cancelPresent: { count: 22, sha256: "b45b5457dabfd279efc08ae3eea8e0537b368e7a3f85c9fe6282d3b8179e5eaa" },
  phase1_cancelAbsent: { count: 22, sha256: "b45b5457dabfd279efc08ae3eea8e0537b368e7a3f85c9fe6282d3b8179e5eaa" },
  phase3_cancelPresent: { count: 45, sha256: "6b89593e31b9b6b1966ffb2ca72ad036ef2cfe4f871feeffbe423867289fe604" },
  phase3_cancelAbsent: { count: 41, sha256: "2674a565cfe989cb6d3f29a957fcbe12cf6a50891bef7afb3b7d8cdcbe84380e" },
  phase4_cancelPresent: { count: 45, sha256: "6b89593e31b9b6b1966ffb2ca72ad036ef2cfe4f871feeffbe423867289fe604" },
  phase4_cancelAbsent: { count: 41, sha256: "2674a565cfe989cb6d3f29a957fcbe12cf6a50891bef7afb3b7d8cdcbe84380e" },
};

// baseline stub과 같은 기록 규약: {q, p}를 순서대로 쌓고 to_regclass만
// cancel 테이블 유무로 응답을 분기한다 — transcript 직렬화가 golden과
// 같은 형태가 되도록 한다.
function recordingExec(cancelPresent: boolean) {
  const transcript: { q: string; p: unknown }[] = [];
  return {
    transcript,
    unsafe: async (q: string, p?: unknown[]) => {
      transcript.push({ q, p: p ?? null });
      if (q.includes("to_regclass"))
        return [{ r: cancelPresent ? "public.cancel_requests" : null }];
      return [];
    },
  };
}

describe("seedBase golden — baseline ordered SQL+params와 동일", () => {
  for (const phase of [0, 1, 3, 4]) {
    for (const cancelPresent of [true, false]) {
      const key =
        "phase" + phase + (cancelPresent ? "_cancelPresent" : "_cancelAbsent");
      test(key, async () => {
        const ex = recordingExec(cancelPresent);
        await seedBase(ex as unknown as SeedExec, phase);
        const sha = createHash("sha256")
          .update(JSON.stringify(ex.transcript))
          .digest("hex");
        const g = GOLDEN_CASES[key];
        assert.equal(ex.transcript.length, g.count, key + " count");
        assert.equal(sha, g.sha256, key + " sha256");
      });
    }
  }

  test("seed.ts는 seedBase에 위임하고 base SQL을 다시 내장하지 않는다", () => {
    const seedSrc = readFileSync("scripts/seed.ts", "utf8");
    assert.ok(seedSrc.includes("seedBase("));
    assert.equal(seedSrc.includes("INSERT INTO users"), false);
    assert.equal(seedSrc.includes("INSERT INTO orders"), false);
    assert.equal(seedSrc.includes("INSERT INTO payments"), false);
  });
});
