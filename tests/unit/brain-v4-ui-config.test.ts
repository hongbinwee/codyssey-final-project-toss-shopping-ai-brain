import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { createElement, isValidElement } from "react";
import type { MouseEvent, MouseEventHandler, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transpileModule, JsxEmit, ModuleKind } from "typescript";

// Keep server import DB-free and prevent config.ts from reading a local .env.
const moduleHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/config.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export const config = {
          port: 3000, sessionSecret: "unit-test", llmBaseUrl: "https://example.invalid",
          llmApiKey: "", llmModel: "unit-test", llmReasoningEffort: "low",
          llmApiTimeoutMs: 1000, testUserCodes: {}, llmProvider: "stub"
        };`,
      };
    }
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext },
      }).outputText,
    };
  },
});

const { brainRagConnectionFromEnv, start } = await import("../../src/server.ts");
const { signSession } = await import("../../src/session.ts");
const { BrainRanking } = await import("../../src/web/components/BrainPreview.tsx");
const commerceState = await import("../../src/web/components/CommerceState.tsx");
const detailResume = await import("../../src/web/detail-resume.ts");
moduleHook.deregister();

function ragConfig(env: Record<string, string | undefined>) {
  assert.equal(typeof brainRagConnectionFromEnv, "function");
  if (typeof brainRagConnectionFromEnv !== "function") return undefined;
  return brainRagConnectionFromEnv(env);
}

function renderRanking(ranking: Parameters<typeof BrainRanking>[0]["ranking"]) {
  assert.equal(typeof BrainRanking, "function");
  if (typeof BrainRanking !== "function") return "";
  return renderToStaticMarkup(createElement(BrainRanking, {
    ranking,
    onOpenProduct: () => {},
  }));
}

test("test catalog notice identifies simulated prices and explicitly excludes purchase",()=>{
 const Notice=(commerceState as unknown as {CatalogNotice?:()=>ReactElement}).CatalogNotice;
 assert.equal(typeof Notice,"function");if(!Notice)return;
 const html=renderToStaticMarkup(createElement(Notice));
 assert.match(html,/검증 중인 데이터셋 테스트/);
 assert.match(html,/가격·재고·옵션은 시연용/);
 assert.match(html,/주문·결제할 수 없/);
});

test("read-only catalog server wires the selected schema and blocks writes before reaching business services",async()=>{
 let handler:Function|undefined;let readOnly=false;let queryCount=0;
 const db={unsafe:async(query:string)=>{
   queryCount++;
   if(query.includes('FROM pg_roles'))return [{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false,read_only:'on'}];
   assert.match(query,/FROM test_items\./);return [];
 },end:async()=>{}};
 await start(0,{env:{COMMERCE_CATALOG_SOURCE:'test_items',DATABASE_URL:'postgres://unit:fixture@127.0.0.1/toss',HOST:'127.0.0.1'},
   ensureDevDb:async()=>'',connectDb:((_url:string,options?:{readOnly?:boolean})=>{readOnly=options?.readOnly===true;return db;}) as never,
   build:(async()=>({})) as never,createServer:((listener:Function)=>{handler=listener;return {
     listen:(...args:unknown[])=>{(args.at(-1) as Function)();},on:()=>{}};}) as never});
 assert.equal(readOnly,true);assert.ok(handler);
 const invoke=async(method:string,url:string)=>{
   let status=0;let body='';
   await handler!({method,url,headers:{cookie:'session='+encodeURIComponent(signSession('fixture-user','unit-test'))}},
    {writeHead:(code:number)=>{status=code;},end:(value:string)=>{body=value;},headersSent:false});
   return {status,body:JSON.parse(body)};
 };
 const products=await invoke('GET','/api/products');assert.equal(products.status,200);
 assert.equal(products.body.data.catalog_context.source,'test_items');
 const before=queryCount;
 for(const path of ['/api/cart/items','/api/checkout/confirm','/api/orders/o/cancel','/api/agent/turn']){
   const result=await invoke('POST',path);assert.equal(result.status,403);
   assert.equal(result.body.error.code,'READ_ONLY_CATALOG');
 }
 assert.equal(queryCount,before,'blocked routes must not reach any DB-backed business service');
});

function findButton(node: ReactNode): ReactElement<{
  children?: ReactNode;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{
    children?: ReactNode;
    onClick?: MouseEventHandler<HTMLButtonElement>;
  }>;
  return element.type === "button" ? element : findButton(element.props.children);
}

test("omitted RAG contract keeps the existing brain-rag-v1 config", () => {
  assert.deepEqual(ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/v1/search",
    BRAIN_RAG_AUDIT_ID: "legacy-audit",
  }), {
    endpoint: "https://rag.example.invalid/v1/search",
    auditId: "legacy-audit",
    token: undefined,
    contract: "brain-rag-v1",
    datasetVersion: undefined,
    category: "beauty",
  });
});

test("v4 config forwards the exact deployment version and requires one", () => {
  const version = "dataset-v4-exact-unit-fixture";
  assert.deepEqual(ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/v4/search",
    BRAIN_RAG_CONTRACT: "v4",
    BRAIN_RAG_DATASET_VERSION: version,
    BRAIN_RAG_CATEGORY: "beauty",
    BRAIN_RAG_TOKEN: "unit-token",
  }), {
    endpoint: "https://rag.example.invalid/v4/search",
    auditId: "",
    token: "unit-token",
    contract: "v4",
    datasetVersion: version,
    category: "beauty",
  });
  assert.throws(() => ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/v4/search",
    BRAIN_RAG_CONTRACT: "v4",
    BRAIN_RAG_DATASET_VERSION: " ",
  }), /BRAIN_RAG_DATASET_VERSION/);
  assert.throws(() => ragConfig({
    BRAIN_RAG_URL: "https://rag.example.invalid/search",
    BRAIN_RAG_CONTRACT: "v5",
  }), /BRAIN_RAG_CONTRACT/);
});

test("verified synthetic ranked candidates retain simulation provenance without exposing internal IDs", () => {
  const html = renderRanking({
    ranked: [{ candidate: {
      productId: "synthetic-product", productName: "합성 뷰티 상품", variantId: "variant-1",
      unitPriceWon: 12000, shippingFeeWon: 3000, sourceKind: "SYNTHETIC",
      datasetVersion: "dataset-v4-exact-unit-fixture", commerceVerified: true,
    }, score: 1, evidenceCoverage: 1 }],
    referenceOnly: [], rejected: [], evaluatedCount: 1,
  });
  assert.ok(html.includes("합성"));
  assert.ok(html.includes("시연"));
  assert.ok(html.includes("상품 보기"));
  assert.ok(!html.includes("variant-1"));
  assert.ok(!html.includes("추천 적격성을 확인한 상품이 없어요"));
});

test("unverified v4 synthetic reference candidates have no product link", () => {
  const html = renderRanking({
    ranked: [],
    referenceOnly: [{ candidate: {
      productId: "synthetic-product", productName: "합성 뷰티 상품", variantId: "variant-1",
      sourceKind: "SYNTHETIC", datasetVersion: "dataset-v4-exact-unit-fixture",
      commerceVerified: false,
    }, reasons: ["실제 리뷰 표본 부족"] }],
    rejected: [], evaluatedCount: 1,
  });
  assert.ok(html.includes("합성"));
  assert.ok(html.includes("상품 확인 전"));
  assert.ok(!/<button[^>]*>상품 보기<\/button>/.test(html));
});

test("legacy reference-only candidates keep their existing text-only display", () => {
  const html = renderRanking({
    ranked: [],
    referenceOnly: [{ candidate: {
      productId: "legacy-product", productName: "기존 후보", variantId: "legacy-variant",
    }, reasons: ["검증 표본 부족"] }],
    rejected: [], evaluatedCount: 1,
  });
  assert.ok(html.includes("기존 후보"));
  assert.ok(html.includes("참고"));
  assert.ok(!html.includes("v4 합성 데이터"));
  assert.ok(!html.includes("Commerce 상품 확인 전"));
  assert.ok(!html.includes("상품 보기"));
});

test("Brain reference option shows and forwards the exact product and variant IDs", () => {
  const ranking: Parameters<typeof BrainRanking>[0]["ranking"] = {
    ranked: [],
    referenceOnly: [{
      candidate: { productId: "p-beauty", productName: "뷰티 상품", variantId: "v-option-b", sourceKind: "SYNTHETIC", commerceVerified: true },
      reasons: ["합성 리뷰 참고 전용"],
    }],
    rejected: [],
    evaluatedCount: 1,
  };
  let opened: [string, string?] | undefined;
  const tree = BrainRanking({
    ranking,
    onOpenProduct: (productId, variantId) => { opened = [productId, variantId]; },
  });
  const html = renderToStaticMarkup(createElement(BrainRanking, {
    ranking,
    onOpenProduct: () => {},
  }));
  const button = findButton(tree);
  assert.ok(button);
  button?.props.onClick?.({} as MouseEvent<HTMLButtonElement>);
  assert.deepEqual(opened, ["p-beauty", "v-option-b"]);
  assert.ok(!html.includes("v-option-b"));
});

test("requested product variant selects only an available exact match; ordinary entry keeps the first available", () => {
  const resolveRequestedVariant = (detailResume as unknown as {
    resolveInitialVariant?: (
      variants: { variant_id: string; availability: string }[],
      requestedVariantId?: string,
    ) => { variantId: string | null; unavailable: boolean };
  }).resolveInitialVariant;
  assert.equal(typeof resolveRequestedVariant, "function");
  if (!resolveRequestedVariant) return;

  const variants = [
    { variant_id: "v-option-a", availability: "AVAILABLE" },
    { variant_id: "v-option-b", availability: "AVAILABLE" },
    { variant_id: "v-option-c", availability: "SOLD_OUT" },
  ];
  assert.deepEqual(resolveRequestedVariant(variants, "v-option-b"), { variantId: "v-option-b", unavailable: false });
  assert.deepEqual(resolveRequestedVariant(variants, "v-deleted"), { variantId: null, unavailable: true });
  assert.deepEqual(resolveRequestedVariant(variants, "v-option-c"), { variantId: null, unavailable: true });
  assert.deepEqual(resolveRequestedVariant(variants), { variantId: "v-option-a", unavailable: false });
});
