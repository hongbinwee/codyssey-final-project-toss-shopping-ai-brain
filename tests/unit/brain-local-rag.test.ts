import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const MODEL="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
const VERSION="test_items:sha256=0123456789abcdef:products=3:reviews=2";
const modulePromise=import("../../src/brain/local-rag.ts").catch(()=>null);
const vector=(x:number,y=0)=>Array.from({length:384},(_,i)=>i===0?x:i===1?y:0);
function chunk(input:{id:string;productId:string;type:"review"|"product";text:string;embedding:number[];category?:string;sourceId?:string;metadata?:Record<string,unknown>;version?:string}){
 const review=input.type==="review";
 return {category:input.category??"beauty",chunk_id:input.id,chunk_key:`key-${input.id}`,
   chunker_version:"source-evidence-token-v2:max_tokens=96",dataset_version:input.version??VERSION,
   embedding:input.embedding,embedding_model:MODEL,embedding_text:input.text,evidence_text:input.text,
   end_offset:input.text.length,product_id:input.productId,run_id:"fixture",source_field:review?"body":"description",
   source_id:input.sourceId??`source-${input.id}`,source_type:input.type,source_version:null,start_offset:0,
   source_metadata:input.metadata??(review?{rating:5,synthetic:true,variant_id:`v-${input.productId}`,
     source_kind:"SYNTHETIC",source_ref:"https://example.invalid/review",timestamp:"2026-01-01"}:
     {synthetic:null,source_kind:null,source_table:"products"})};
}
const baseChunks=[
 chunk({id:"c-p1-review",productId:"p1",type:"review",text:"무선 헤드폰 착용감이 편해서 좋아요",embedding:vector(1,.05),sourceId:"r-p1"}),
 chunk({id:"c-p1-product",productId:"p1",type:"product",text:"상품 설명 데이터",embedding:vector(.8,.6),sourceId:"product-p1"}),
 chunk({id:"c-p2-review",productId:"p2",type:"review",text:"Bluetooth wireless headset is comfortable",embedding:vector(.6,.8),sourceId:"r-p2"}),
 chunk({id:"c-p3-audio",productId:"p3",type:"review",text:"무선 헤드폰 추천",embedding:vector(.95,.02),category:"audio",sourceId:"r-p3"})
];
const baseProducts=["p1","p2","p3"].map(productId=>({product_id:productId,
 category:productId==="p3"?"audio":"beauty",dataset_version:VERSION,
 product_payload:{title:`상품 ${productId}`,category:productId==="p3"?"audio":"beauty",source_id:`catalog-${productId}`}}));
const request=(extra:Record<string,unknown>={})=>({request_id:"req-1",original_question:"무선 헤드폰 추천해 주세요",
 query:"무선 헤드폰",category:"beauty",filters:{},required_conditions:[],preferences:[],top_k:5,...extra});

async function withSearch<T>(run:(ctx:{search:(body:unknown)=>Promise<any>;stats:any;queries:string[]})=>Promise<T>,
 chunks=baseChunks,products=baseProducts,encode:(query:string)=>Promise<number[]>=async()=>vector(1,.05)){
 const dataDir=await mkdtemp(join(tmpdir(),"codyssey-local-rag-"));
 try{
   await writeFile(join(dataDir,"evidence_chunks.jsonl"),chunks.map(row=>JSON.stringify(row)).join("\n")+"\n");
   await writeFile(join(dataDir,"indexed_products.jsonl"),products.map(row=>JSON.stringify(row)).join("\n")+"\n");
   const mod=await modulePromise;
   assert.equal(typeof mod?.createLocalRagSearch,"function","createLocalRagSearch is not implemented");
   const queries:string[]=[];
   const local=await mod!.createLocalRagSearch({dataDir,embedQuery:async(query:string)=>{queries.push(query);return encode(query);}});
   return await run({search:local.search,stats:local.stats,queries});
 }finally{await rm(dataDir,{recursive:true,force:true});}
}

test("local RAG returns exact v4 shape, combines Korean BM25 and cosine RRF, and emits only synthetic review sources",async()=>{
 await withSearch(async({search,stats,queries})=>{
   const result=await search(request());
   assert.equal(result.dataset_version,VERSION);
   assert.deepEqual(result.items.map((x:any)=>x.product_id),["p1","p2"]);
   assert.ok(result.items[0].rrf_score>result.items[1].rrf_score);
   assert.deepEqual(queries,["무선 헤드폰"]);
   assert.equal(result.items[0].evidence.length,1);
   const citation=result.items[0].evidence[0];
   assert.deepEqual({product_id:citation.product_id,chunk_id:citation.chunk_id,source_type:citation.source_type,
     source_id:citation.source_id,source_version:citation.source_version,evidence_text:citation.evidence_text},
     {product_id:"p1",chunk_id:"c-p1-review",source_type:"review",source_id:"r-p1",source_version:null,
       evidence_text:"무선 헤드폰 착용감이 편해서 좋아요"});
   assert.equal(citation.source_metadata.source_kind,"SYNTHETIC");
   assert.equal(citation.source_metadata.synthetic,true);
   assert.equal(result.items.some((x:any)=>x.evidence.some((e:any)=>e.source_type==="product")),false);
   assert.equal(stats.chunkCount,4);
   assert.equal(stats.productCount,3);
   assert.equal(stats.vectorDimensions,384);
   assert.equal(stats.embeddingModel,MODEL);
   assert.match(stats.evidenceSha256,/^[a-f0-9]{64}$/);
 });
});

test("evidence bodies allow line breaks and tabs while rejecting unsafe control characters",async()=>{
 const multiline=chunk({id:"c-multiline",productId:"p1",type:"review",text:"첫 줄\n둘째 줄\t확인",
   embedding:vector(1),sourceId:"r-multiline"});
 await withSearch(async({search})=>{
   const result=await search(request());
   assert.equal(result.items[0].evidence[0].evidence_text,"첫 줄\n둘째 줄\t확인");
 },[multiline],[baseProducts[0]]);
 const unsafe=chunk({id:"c-unsafe",productId:"p1",type:"review",text:"첫 줄\u0000둘째 줄",
   embedding:vector(1),sourceId:"r-unsafe"});
 await assert.rejects(()=>withSearch(async()=>undefined,[unsafe],[baseProducts[0]]),/invalid or incompatible evidence chunk/);
});

test("English terms contribute BM25 ranking and the query encoder receives the text once",async()=>{
 await withSearch(async({search,queries})=>{
   const result=await search(request({query:"Bluetooth wireless",original_question:"Bluetooth headset",required_conditions:["comfortable"]}));
   assert.equal(queries[0],"Bluetooth wireless comfortable");
   assert.equal(result.items[0].product_id,"p2");
 });
});

test("unsupported filters, preferences, profile switches, and top_k above five are rejected",async()=>{
 await withSearch(async({search})=>{
   await assert.rejects(()=>search(request({filters:{brand:"example"}})),/unsupported.*filter/i);
   await assert.rejects(()=>search(request({preferences:["quiet"]})),/unsupported.*preference/i);
   await assert.rejects(()=>search(request({top_k:6})),/top_k/i);
   await assert.rejects(()=>search({...request(),profile:"other_profile"}),/unsupported.*field/i);
 });
});

test("retrieval output is bounded by top_k and five unique source IDs per product",async()=>{
 const chunks=Array.from({length:8},(_,i)=>chunk({id:`c-${i}`,productId:"p1",type:"review",
   text:"무선 헤드폰 사용감이 좋아요",embedding:vector(1,.05),sourceId:i===7?"r-0":`r-${i}`}));
 await withSearch(async({search})=>{
   const result=await search(request({top_k:1}));
   assert.equal(result.items.length,1);
   assert.equal(result.items[0].evidence.length,5);
   assert.equal(new Set(result.items[0].evidence.map((e:any)=>e.source_id)).size,5);
 },chunks,[baseProducts[0]]);
});

test("mixed dataset versions and incomplete product mappings fail closed during load",async()=>{
 const mixed=[...baseChunks.slice(0,2),chunk({id:"bad-version",productId:"p1",type:"review",text:"좋아요",
   embedding:vector(1),version:"other-version"})];
 await assert.rejects(()=>withSearch(async()=>undefined,mixed,baseProducts),/dataset version/i);
 await assert.rejects(()=>withSearch(async()=>undefined,baseChunks,[baseProducts[0]]),/product mapping/i);
});

test("query embedding must match the stored finite 384-dimensional vector contract",async()=>{
 await withSearch(async({search})=>{
   await assert.rejects(()=>search(request()),/384.*dimension|embedding.*dimension/i);
 },baseChunks,baseProducts,async()=>[1,2,3]);
 await assert.rejects(()=>withSearch(async()=>undefined,
   [chunk({id:"bad-vector",productId:"p1",type:"review",text:"무선 헤드폰",embedding:[1,2,3]})],
   [baseProducts[0]]),/384.*dimension|embedding.*dimension/i);
});

test("indexed category is applied and raw source metadata is not reconstructed",async()=>{
 await withSearch(async({search})=>{
   const result=await search(request());
   assert.equal(result.items.some((x:any)=>x.product_id==="p3"),false);
   assert.deepEqual(result.items[0].evidence[0].source_metadata,baseChunks[0].source_metadata);
 });
});
