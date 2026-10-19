import test from "node:test";
import assert from "node:assert/strict";
import { ok } from "../../src/contracts.ts";
import * as rag from "../../src/brain/rag-adapter.ts";
import * as catalog from "../../src/catalog.ts";
import { retrieveTurn } from "../../src/brain/read-flow.ts";

const DATASET_VERSION = "fixture-v4-version";
const REVIEW_BODY = "피부가 편안하고 보습이 오래 유지됩니다.";
const EVIDENCE_TEXT = "보습이 오래 유지됩니다.";

function v4Response() {
  return {
    dataset_version: DATASET_VERSION,
    items: [{
      product_id: "p-v4-1",
      rrf_score: 0.987,
      evidence: [{
        source_id: "r-v4-1",
        evidence_text: EVIDENCE_TEXT,
        source_metadata: {
          variant_id: "v-v4-1",
          source_kind: "SYNTHETIC",
          synthetic: true,
        },
      }],
    }],
  };
}

function productDetail(productId = "p-v4-1", variantId = "v-v4-1") {
  return ok({
    product: {
      id: productId, name: "Commerce product", brand: "Brand", category: "beauty",
      description: "", images: [], specs: {}, active: true, version: 3,
      availability: "AVAILABLE" as const,
    },
    variants: [{
      variant_id: variantId, option_values: {}, effective_specs: {},
      unit_price_won: 39_900, stock_qty: 4, availability: "AVAILABLE" as const, version: 2,
    }],
    shipping_fee_won: 3_000,
  }, "trace");
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: "r-v4-1", product_id: "p-v4-1", variant_id: "v-v4-1",
    rating: 5, body: REVIEW_BODY, source_kind: "SYNTHETIC",
    source_ref: "fixture-v4-review", written_at: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

test("source-only v4 parser preserves configured dataset and synthetic evidence metadata", () => {
  const parse = (rag as unknown as {
    parseV4Response?: (raw: unknown, expectedVersion: string) => {
      datasetVersion: string;
      items: Array<{ productId: string; rrfScore: number; evidence: Array<{
        sourceId: string; evidenceText: string; variantId: string;
        sourceKind: string; synthetic: boolean;
      }> }>;
    };
  }).parseV4Response;
  assert.equal(typeof parse, "function");
  if (!parse) return;

  const parsed = parse(v4Response(), DATASET_VERSION);
  assert.equal(parsed.datasetVersion, DATASET_VERSION);
  assert.equal(parsed.items[0].productId, "p-v4-1");
  assert.equal(parsed.items[0].rrfScore, 0.987);
  assert.deepEqual(parsed.items[0].evidence[0], {
    sourceId: "r-v4-1",
    evidenceText: EVIDENCE_TEXT,
    variantId: "v-v4-1",
    sourceKind: "SYNTHETIC",
    synthetic: true,
  });
});

test("v4 dataset and source-class isolation rejects other versions and real review records", () => {
  const parse = (rag as unknown as {
    parseV4Response?: (raw: unknown, expectedVersion: string) => unknown;
  }).parseV4Response;
  assert.equal(typeof parse, "function");
  if (!parse) return;

  assert.throws(() => parse({ ...v4Response(), dataset_version: "other-version" }, DATASET_VERSION), /version/i);
  const realSource = v4Response();
  realSource.items[0].evidence[0].source_metadata.source_kind = "REAL";
  realSource.items[0].evidence[0].source_metadata.synthetic = false;
  assert.throws(() => parse(realSource, DATASET_VERSION), /synthetic/i);
});

test("v4 live mixed chunks keep synthetic reviews and skip product-description chunks", () => {
  const response=v4Response();
  const review=response.items[0].evidence[0];
  const scopedReview={...review,product_id:"p-v4-1",source_type:"review",source_version:DATASET_VERSION};
  const productChunk={product_id:"p-v4-1",source_type:"product",source_id:"p-v4-1",
    source_version:DATASET_VERSION,evidence_text:"상품 설명",source_metadata:{}};
  const parsed=rag.parseV4Response({...response,items:[{...response.items[0],
    evidence:[productChunk,scopedReview,productChunk]}]},DATASET_VERSION);
  assert.equal(parsed.items[0].evidence.length,1);
  assert.equal(parsed.items[0].evidence[0].sourceId,"r-v4-1");
  const productOnly=rag.parseV4Response({...response,items:[{...response.items[0],
    evidence:[productChunk]}]},DATASET_VERSION);
  assert.deepEqual(productOnly.items[0].evidence,[]);
});

test("v4 live review scope rejects cross-product and cross-version evidence", () => {
  const response=v4Response();
  for(const override of [{product_id:"other-product"},{source_version:"other-version"}]){
    const review={...response.items[0].evidence[0],product_id:"p-v4-1",
      source_type:"review",source_version:DATASET_VERSION,...override};
    assert.throws(()=>rag.parseV4Response({...response,items:[{...response.items[0],
      evidence:[review]}]},DATASET_VERSION),/scope|version/i);
  }
});

test("unknown source_version is not confused with the verified dataset envelope",()=>{
 const response=v4Response();
 const withUnknown={...response,items:[{...response.items[0],evidence:[{...response.items[0].evidence[0],source_version:null}]}]};
 assert.equal(rag.parseV4Response(withUnknown,DATASET_VERSION).items[0].evidence[0].sourceId,"r-v4-1");
 assert.throws(()=>rag.parseV4Response({...withUnknown,dataset_version:"other"},DATASET_VERSION),/version/);
});

test("read flow forwards the trace id and unmodified question separately from the intent query", async () => {
  let observed: Record<string, unknown> | undefined;
  await retrieveTurn(
    {
      actorUserId: "user-1",
      conversationId: "00000000-0000-4000-8000-000000000001",
      requestId: "trace-request-42",
      userMessage: "원문 질문: 민감 피부용 보습 크림을 찾아줘",
      clientActionId: "action-1",
    },
    { messageId: "message-1", memories: [], startedAt: performance.now(), memoryMs: 0 } as never,
    { query: "보습 크림", maxTotalWon: null, requiredConditions: [], currentPreferences: {}, revision: 1 },
    {
      retriever: {
        search: async (input: Record<string, unknown>) => {
          observed = input;
          return { candidates: [], evidence: [] };
        },
      },
    } as never,
  );

  assert.equal(observed?.requestId, "trace-request-42");
  assert.equal(observed?.originalQuestion, "원문 질문: 민감 피부용 보습 크림을 찾아줘");
  assert.equal(observed?.query, "보습 크림");
});

test("read-flow exposes only condition-unverified synthetic references and keeps budget failures rejected", async () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    productName: "Commerce product", productId: "p-v4-1", variantId: "v-v4-1",
    unitPriceWon: 39_900, shippingFeeWon: 3_000, rating: null, ratingScale: null,
    wholeReviewCount: null, wholeReviewCountVerified: false, conditions: {}, facets: {},
    sourceKind: "SYNTHETIC", datasetVersion: DATASET_VERSION, commerceVerified: true,
    ...overrides,
  });
  const run = async (item: Record<string, unknown>, evidence: Array<Record<string, unknown>> = [], maxTotalWon: number | null = null) =>
    retrieveTurn(
      {
        actorUserId: "user-1", conversationId: "00000000-0000-4000-8000-000000000001",
        requestId: "trace-request-42", userMessage: "민감 피부용 보습 크림", clientActionId: "action-1",
      },
      { messageId: "message-1", memories: [], startedAt: performance.now(), memoryMs: 0 } as never,
      { query: "보습 크림", maxTotalWon, requiredConditions: ["민감성 피부"], currentPreferences: {}, revision: 1 },
      { retriever: { search: async () => ({ candidates: [item], evidence }) } } as never,
    );

  const conditionOnly = await run(candidate());
  assert.equal(conditionOnly.result.ranking.ranked.length, 0);
  assert.deepEqual(conditionOnly.result.ranking.referenceOnly.map((row) => row.candidate.productId), ["p-v4-1"]);
  assert.deepEqual(conditionOnly.result.ranking.referenceOnly[0].reasons, ["unverified_required_condition:민감성 피부"]);
  assert.deepEqual(conditionOnly.result.ranking.rejected, []);

  const overBudget = await run(candidate({ unitPriceWon: 120_000 }), [], 100_000);
  assert.equal(overBudget.result.ranking.ranked.length, 0);
  assert.deepEqual(overBudget.result.ranking.referenceOnly, []);
  assert.deepEqual(overBudget.result.ranking.rejected[0].reasons, [
    "over_total_budget", "unverified_required_condition:민감성 피부",
  ]);

  const crossProductCondition = await run(
    candidate({ conditions: { "민감성 피부": ["cross-product-evidence"] } }),
    [{ id: "cross-product-evidence", productId: "another-product", variantId: null, kind: "SPEC" }],
  );
  assert.deepEqual(crossProductCondition.result.ranking.referenceOnly, []);
  assert.deepEqual(crossProductCondition.result.ranking.rejected[0].reasons, [
    "unverified_required_condition:민감성 피부",
  ]);
});

test("v4 request follows the fixed contract and only verified Commerce data becomes a candidate", async () => {
  let requestBody: Record<string, unknown> | undefined;
  let commerceCalls = 0;
  let reviewCalls = 0;
  const factory = (rag as unknown as { verifiedRagRetriever: (...args: unknown[]) => {
    search(input: Record<string, unknown>): Promise<{ candidates: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>> }>;
  } }).verifiedRagRetriever;
  let retriever: ReturnType<typeof factory> | undefined;
  assert.doesNotThrow(() => {
    retriever = factory(
      {
        endpoint: "http://127.0.0.1:7888/rag",
        contract: "v4",
        datasetVersion: DATASET_VERSION,
        category: "beauty",
        timeoutMs: 1_000,
      },
      async ({ product_id }: { product_id: string }) => {
        commerceCalls++;
        return productDetail(product_id);
      },
      async (_url: unknown, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(v4Response()), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
      async ({ product_id, review_ids }: { product_id: string; review_ids: string[] }) => {
        reviewCalls++;
        assert.equal(product_id, "p-v4-1");
        assert.deepEqual(review_ids, ["r-v4-1"]);
        return [review()];
      },
    );
  });
  assert.ok(retriever);

  const result = await retriever!.search({
    requestId: "trace-request-42",
    originalQuestion: "원문 질문: 민감 피부용 보습 크림을 찾아줘",
    query: "보습 크림",
    maxTotalWon: 100_000,
    requiredConditions: [],
  });

  assert.deepEqual(requestBody, {
    request_id: "trace-request-42",
    original_question: "원문 질문: 민감 피부용 보습 크림을 찾아줘",
    query: "보습 크림",
    category: "beauty",
    filters: {},
    required_conditions: [],
    preferences: [],
    top_k: 5,
  });
  assert.equal(Object.hasOwn(requestBody!, "profile"), false);
  assert.equal(commerceCalls, 1);
  assert.equal(reviewCalls, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].unitPriceWon, 39_900);
  assert.equal(result.candidates[0].shippingFeeWon, 3_000);
  assert.equal(result.candidates[0].rating, null);
  assert.equal(result.candidates[0].wholeReviewCount, null);
  assert.equal(result.candidates[0].wholeReviewCountVerified, false);
  assert.equal(result.candidates[0].sourceKind, "SYNTHETIC");
  assert.equal(result.candidates[0].datasetVersion, DATASET_VERSION);
  assert.deepEqual(result.candidates[0].facets, {});
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].id, "r-v4-1");
  assert.equal(result.evidence[0].sourceId, "r-v4-1");
  assert.equal(result.evidence[0].text, EVIDENCE_TEXT);
  assert.equal(result.evidence[0].verified, true);
  assert.equal(result.evidence[0].sourceKind, "SYNTHETIC");
  assert.equal(result.evidence[0].datasetVersion, DATASET_VERSION);
});

test("getReviewsByIds scopes parameterized lookup to the exact product and review IDs", async () => {
  const getReviewsByIds = (catalog as unknown as {
    getReviewsByIds?: (input: { product_id: string; review_ids: string[] }, db?: unknown) => Promise<Array<Record<string, unknown>>>;
  }).getReviewsByIds;
  assert.equal(typeof getReviewsByIds, "function");
  if (!getReviewsByIds) return;

  let query = "";
  let params: unknown[] = [];
  const rows = await getReviewsByIds({
    product_id: "p-v4-1",
    review_ids: ["r-v4-1"],
  }, {
    unsafe: async (sql: string, args: unknown[]) => {
      query = sql;
      params = args;
      return [review()];
    },
  });

  assert.match(query, /WHERE product_id\s*=\s*\$1\s+AND id\s*=\s*ANY\(\$2\)/i);
  assert.deepEqual(params, ["p-v4-1", ["r-v4-1"]]);
  assert.equal(rows[0].id, "r-v4-1");
  assert.equal(rows[0].product_id, "p-v4-1");
});


function makeV4Retriever({
  payload = v4Response(),
  getProduct = async ({ product_id }: { product_id: string }) => productDetail(product_id),
  reviewLookup = async () => [review()],
  fetcher,
  timeoutMs = 1_000,
  datasetVersion = DATASET_VERSION,
}: {
  payload?: unknown;
  getProduct?: (input: { product_id: string }) => Promise<unknown>;
  reviewLookup?: (input: { product_id: string; review_ids: string[] }) => Promise<unknown[]>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  datasetVersion?: string;
} = {}) {
  const factory = (rag as unknown as {
    verifiedRagRetriever: (...args: unknown[]) => {
      search(input: Record<string, unknown>): Promise<{ candidates: Array<Record<string, unknown>>; evidence: Array<Record<string, unknown>> }>;
    };
  }).verifiedRagRetriever;
  return factory(
    {
      endpoint: "http://127.0.0.1:7888/rag",
      contract: "v4",
      datasetVersion,
      category: "beauty",
      timeoutMs,
    },
    getProduct,
    fetcher ?? (async () => new Response(JSON.stringify(payload), { status: 200 })),
    reviewLookup,
  );
}

const searchInput = {
  requestId: "trace-request-42",
  originalQuestion: "원문 질문",
  query: "보습 크림",
  maxTotalWon: null,
  requiredConditions: [],
};

test("v4 parser rejects another version and duplicate product or source IDs but accepts zero items", () => {
  const parse = (rag as unknown as {
    parseV4Response?: (raw: unknown, expectedVersion: string) => { items: unknown[] };
  }).parseV4Response;
  assert.equal(typeof parse, "function");
  if (!parse) return;

  assert.throws(() => parse({ ...v4Response(), dataset_version: "other-version" }, DATASET_VERSION), /version/i);

  const duplicateProduct = v4Response();
  duplicateProduct.items.push(structuredClone(duplicateProduct.items[0]));
  assert.throws(() => parse(duplicateProduct, DATASET_VERSION), /duplicate/i);

  const duplicateSource = v4Response();
  duplicateSource.items[0].evidence.push(structuredClone(duplicateSource.items[0].evidence[0]));
  assert.throws(() => parse(duplicateSource, DATASET_VERSION), /duplicate/i);

  assert.deepEqual(parse({ dataset_version: DATASET_VERSION, items: [] }, DATASET_VERSION).items, []);
});

test("v4 requires an exact configured version and ReviewLookup", () => {
  const factory = (rag as unknown as { verifiedRagRetriever: (...args: unknown[]) => unknown }).verifiedRagRetriever;
  assert.throws(() => factory({
    endpoint: "http://127.0.0.1:7888/rag",
    contract: "v4",
    category: "beauty",
  }, async () => productDetail(), async () => new Response("{}"), async () => [review()]), /dataset.?version/i);

  assert.throws(() => factory({
    endpoint: "http://127.0.0.1:7888/rag",
    contract: "v4",
    datasetVersion: DATASET_VERSION,
    category: "beauty",
  }, async () => productDetail(), async () => new Response("{}")), /ReviewLookup/i);
});

test("unmapped products and unavailable or mismatched variants contribute no candidate or evidence", async () => {
  const missingProduct = makeV4Retriever({
    getProduct: async () => ({ ok: false, error: { code: "NOT_FOUND" } }),
  });
  const noProduct = await missingProduct.search(searchInput);
  assert.deepEqual(noProduct.candidates, []);
  assert.deepEqual(noProduct.evidence, []);

  const wrongProduct = makeV4Retriever({
    getProduct: async () => productDetail("another-product", "v-v4-1"),
  });
  const crossProduct = await wrongProduct.search(searchInput);
  assert.deepEqual(crossProduct.candidates, []);
  assert.deepEqual(crossProduct.evidence, []);

  const noVariant = makeV4Retriever({
    getProduct: async () => productDetail("p-v4-1", "another-variant"),
  });
  const crossVariant = await noVariant.search(searchInput);
  assert.deepEqual(crossVariant.candidates, []);
  assert.deepEqual(crossVariant.evidence, []);

  const soldOut = makeV4Retriever({
    getProduct: async () => {
      const got = productDetail();
      if (got.ok) got.data.variants[0].stock_qty = 0;
      return got;
    },
  });
  const unavailable = await soldOut.search(searchInput);
  assert.deepEqual(unavailable.candidates, []);
  assert.deepEqual(unavailable.evidence, []);
});

test("review ID, product, variant, source, and forged-text mismatches fail closed", async () => {
  const mismatches = [
    review({ id: "different-review" }),
    review({ product_id: "different-product" }),
    review({ variant_id: "different-variant" }),
    review({ source_kind: "REAL" }),
    review({ body: "본문에 없는 조작된 문장입니다." }),
  ];
  for (const badReview of mismatches) {
    const retriever = makeV4Retriever({
      reviewLookup: async () => [badReview],
    });
    await assert.rejects(() => retriever.search(searchInput), /review|evidence|source|text/i);
  }
});

test("empty v4 result is normal and does not call Commerce or review lookup", async () => {
  let commerceCalls = 0;
  let reviewCalls = 0;
  const retriever = makeV4Retriever({
    payload: { dataset_version: DATASET_VERSION, items: [] },
    getProduct: async () => { commerceCalls++; return productDetail(); },
    reviewLookup: async () => { reviewCalls++; return [review()]; },
  });
  const result = await retriever.search(searchInput);
  assert.deepEqual(result, { candidates: [], evidence: [] });
  assert.equal(commerceCalls, 0);
  assert.equal(reviewCalls, 0);
});

test("v4 timeout aborts the injected fetch without making a network request", async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const retriever = makeV4Retriever({ timeoutMs: 100, fetcher });
  await assert.rejects(() => retriever.search(searchInput), { name: "TimeoutError" });
});

test("getReviewsByIds rejects more than its bounded ID batch before querying", async () => {
  const getReviewsByIds = (catalog as unknown as {
    getReviewsByIds?: (input: { product_id: string; review_ids: string[] }, db?: unknown) => Promise<unknown[]>;
  }).getReviewsByIds;
  assert.equal(typeof getReviewsByIds, "function");
  if (!getReviewsByIds) return;

  let queried = false;
  await assert.rejects(() => getReviewsByIds({
    product_id: "p-v4-1",
    review_ids: Array.from({ length: 301 }, (_, i) => "r-" + i),
  }, { unsafe: async () => { queried = true; return []; } }), /limit|maximum/i);
  assert.equal(queried, false);
});
