import type {ProductDetail,ReviewItem,ToolResult} from "../contracts.ts";
import type {Aspect,EvidenceRecord,GroundedFacet,ProductCandidate,RetrieverPort} from "./contracts.ts";

/**
 * Read-only RAG integration boundary. RAG supplies candidate/evidence references,
 * but price, shipping and current sellability MUST come from Commerce.
 * "wholeReviewCountVerified" is computed from a pre-approved ETL audit ID, never
 * trusted as a raw boolean returned by a model, client, or remote search service.
 */
export interface RagConnection {
  endpoint:string;
  mode?:"remote"|"local";
  dataDir?:string;
  pythonPath?:string;
  modelRevision?:string;
  modelCache?:string;
  manifestPath?:string;
  auditId?:string;
  token?:string;
  timeoutMs?:number;
  contract?:"brain-rag-v1"|"v4";
  datasetVersion?:string;
  category?:string;
}

export type LocalRagSearch=(body:Record<string,unknown>)=>Promise<unknown>;
/** In-process transport only. Output still passes the same bounded v4/Commerce checks. */
export function localRagFetcher(search:LocalRagSearch):typeof fetch{
  return async (_target,init)=>{
    if(init?.method!=="POST"||typeof init.body!=="string"||init.body.length>16000)
      throw new Error("invalid local RAG request");
    const signal=init.signal;
    signal?.throwIfAborted();
    const body:unknown=JSON.parse(init.body);
    if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("invalid local RAG body");
    let abort:(()=>void)|undefined;
    try{
      const operation=Promise.resolve().then(()=>search(body as Record<string,unknown>));
      const result=await Promise.race([operation,new Promise<never>((_resolve,reject)=>{
        abort=()=>reject(new Error("local RAG request aborted"));
        signal?.addEventListener("abort",abort,{once:true});
        if(signal?.aborted)abort();
      })]);
      return new Response(JSON.stringify(result),{status:200,headers:{"content-type":"application/json"}});
    }finally{if(abort)signal?.removeEventListener("abort",abort);}
  };
}
type ProductLookup=(input:{product_id:string})=>Promise<ToolResult<ProductDetail>>;
export type ReviewLookup=(input:{product_id:string;review_ids:string[]})=>Promise<ReviewItem[]>;

interface ParsedV4Evidence {
  sourceId:string;
  evidenceText:string;
  variantId:string;
  sourceKind:"REAL"|"SYNTHETIC";
  synthetic:boolean;
}
interface ParsedV4Item {productId:string;rrfScore:number;evidence:ParsedV4Evidence[]}
interface ParsedV4Response {datasetVersion:string;items:ParsedV4Item[]}

function obj(v:unknown):Record<string,unknown>|null {
  return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
}
function text(v:unknown,max=160):v is string {
  return typeof v==="string"&&v.length>0&&v.length<=max&&!/[\u0000-\u001f]/.test(v);
}
function score(v:unknown):v is number{return typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=1;}
function whole(v:unknown):v is number {return typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;}
const maxResponseBytes=400_000;
const pickRecord=(v:unknown):GroundedFacet|undefined=>{
  const x=obj(v);
  if(!x||!score(x.score)||!Array.isArray(x.evidenceIds)||x.evidenceIds.length===0||
    x.evidenceIds.length>25||!x.evidenceIds.every(id=>text(id,128)))return;
  return {score:x.score,evidenceIds:x.evidenceIds as string[]};
};

/** Parse only the versioned RAG payload; all product and review facts are checked separately. */
export function parseV4Response(raw:unknown,expectedVersion:string):ParsedV4Response {
  const r=obj(raw);
  if(!text(expectedVersion,128)||!r||r.dataset_version!==expectedVersion||
     !Array.isArray(r.items)||r.items.length>5)
    throw new Error("RAG v4 dataset version or response shape mismatch");
  const seenProducts=new Set<string>(),seenSources=new Set<string>();
  let evidenceCount=0;
  const items:ParsedV4Item[]=r.items.map(value=>{
    const item=obj(value);
    if(!item||!text(item.product_id,128)||typeof item.rrf_score!=="number"||
       !Number.isFinite(item.rrf_score)||item.rrf_score<0||!Array.isArray(item.evidence)||
       seenProducts.has(item.product_id))
      throw new Error("invalid or duplicate RAG v4 product item");
    seenProducts.add(item.product_id);
    evidenceCount+=item.evidence.length;
    if(evidenceCount>300)throw new Error("RAG v4 evidence limit");
    const evidence:ParsedV4Evidence[]=item.evidence.flatMap(rawEvidence=>{
      const entry=obj(rawEvidence),metadata=obj(entry?.source_metadata);
      if(!entry||(entry.product_id!==undefined&&entry.product_id!==item.product_id)||
         (entry.source_version!==undefined&&entry.source_version!==null&&entry.source_version!==expectedVersion))
        throw new Error("RAG v4 evidence scope or version mismatch");
      // The live index also returns product-description chunks. They are not
      // verified review evidence and must not be passed to the review lookup.
      if(entry.source_type==="product")return [];
      if(entry.source_type!==undefined&&entry.source_type!=="review")
        throw new Error("invalid RAG v4 evidence source type");
      const sourceKind=metadata?.source_kind;
      const synthetic=metadata?.synthetic;
      const excerpt=entry?.evidence_text;
      if(!entry||!text(entry.source_id,128)||seenSources.has(entry.source_id)||
         typeof excerpt!=="string"||excerpt.length===0||excerpt.length>5000||excerpt.includes("\u0000")||
         !metadata||!text(metadata.variant_id,128)||
         sourceKind!=="SYNTHETIC"||synthetic!==true)
        throw new Error("invalid, duplicate, or non-synthetic RAG v4 review evidence");
      seenSources.add(entry.source_id);
      return [{sourceId:entry.source_id,evidenceText:excerpt,variantId:metadata.variant_id,
        sourceKind,synthetic}];
    });
    return {productId:item.product_id,rrfScore:item.rrf_score,evidence};
  });
  return {datasetVersion:expectedVersion,items};
}

function validV4ReviewRows(
  rows:unknown,
  productId:string,
  requested:readonly ParsedV4Evidence[],
):Map<string,ReviewItem> {
  if(!Array.isArray(rows))throw new Error("invalid Commerce review lookup response");
  const expected=new Map(requested.map(e=>[e.sourceId,e]));
  const found=new Map<string,ReviewItem>();
  for(const raw of rows){
    const row=obj(raw);
    if(!row||!text(row.id,128)||!text(row.product_id,128)||
       (row.variant_id!==null&&!text(row.variant_id,128))||
       typeof row.body!=="string"||
       (row.source_kind!=="REAL"&&row.source_kind!=="SYNTHETIC")||
       typeof row.rating!=="number"||!Number.isFinite(row.rating)||
       typeof row.source_ref!=="string"||typeof row.written_at!=="string")
      throw new Error("invalid Commerce review source");
    const expectedEvidence=expected.get(row.id);
    if(!expectedEvidence||found.has(row.id)||row.product_id!==productId||
       row.variant_id!==expectedEvidence.variantId||row.source_kind!==expectedEvidence.sourceKind||
       expectedEvidence.synthetic!==(row.source_kind==="SYNTHETIC")||
       !row.body.includes(expectedEvidence.evidenceText))
      throw new Error("RAG review source or excerpt mismatch");
    found.set(row.id,row as unknown as ReviewItem);
  }
  return found;
}

async function retrieveV4(
  connection:RagConnection,
  input:Parameters<RetrieverPort["search"]>[0],
  target:URL,
  timeout:number,
  getProduct:ProductLookup,
  fetcher:typeof fetch,
  reviewLookup:ReviewLookup,
):Promise<{candidates:ProductCandidate[];evidence:EvidenceRecord[];trace?:Record<string,number>}> {
  if(!text(input.requestId,128)||!text(input.originalQuestion,3000)||
     !text(input.query,250)||!Array.isArray(input.requiredConditions)||
     input.requiredConditions.length>25||!input.requiredConditions.every(x=>text(x,128)))
    throw new Error("invalid RAG v4 request");
  const category=connection.category??"beauty";
  if(!text(category,80))throw new Error("invalid RAG v4 category");
  if(input.category&&input.category!==category)return {candidates:[],evidence:[]};
  const response=await fetcher(target.toString(),{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(timeout),
    headers:{"content-type":"application/json",...(connection.token?{authorization:"Bearer "+connection.token}:{})},
    body:JSON.stringify({request_id:input.requestId,original_question:input.originalQuestion,
      query:input.query,category,filters:{},required_conditions:input.requiredConditions,
      preferences:[],top_k:5})
  });
  const rawResponse=await boundedJson(response);
  const parsed=parseV4Response(rawResponse,connection.datasetVersion!);
  const candidates:ProductCandidate[]=[],evidence:EvidenceRecord[]=[];
  for(const item of parsed.items){
    const got=await getProduct({product_id:item.productId});
    if(!got.ok||got.data.product.id!==item.productId||!got.data.product.active)continue;
    const eligible=item.evidence.filter(e=>got.data.variants.some(v=>
      v.variant_id===e.variantId&&v.availability==="AVAILABLE"&&v.stock_qty>0));
    if(eligible.length===0)continue;
    const reviews=validV4ReviewRows(
      await reviewLookup({product_id:item.productId,review_ids:eligible.map(e=>e.sourceId)}),
      item.productId,eligible,
    );
    const byVariant=new Map<string,ParsedV4Evidence[]>();
    for(const entry of eligible){
      const group=byVariant.get(entry.variantId)??[];
      group.push(entry);byVariant.set(entry.variantId,group);
      const source=reviews.get(entry.sourceId);
      if(source)evidence.push({id:source.id,productId:source.product_id,variantId:source.variant_id,
        kind:"REVIEW",sourceKind:source.source_kind,sourceRef:source.source_ref,
        text:entry.evidenceText,sourceId:entry.sourceId,verified:true,datasetVersion:parsed.datasetVersion});
    }
    for(const [variantId,entries] of byVariant){
      const variant=got.data.variants.find(v=>v.variant_id===variantId);
      if(!variant||variant.availability!=="AVAILABLE"||variant.stock_qty<=0)continue;
      const hasSynthetic=entries.some(e=>e.synthetic);
      const hasVerifiedSource=entries.some(e=>reviews.has(e.sourceId));
      candidates.push({productName:got.data.product.name,productId:item.productId,variantId,
        unitPriceWon:variant.unit_price_won,shippingFeeWon:got.data.shipping_fee_won,
        rating:null,ratingScale:null,wholeReviewCount:null,wholeReviewCountVerified:false,
        conditions:{},facets:{},sourceKind:hasSynthetic?"SYNTHETIC":hasVerifiedSource?"REAL":undefined,
        datasetVersion:parsed.datasetVersion,commerceVerified:true,
        ...(got.data.catalog_context?.is_simulated?{isSimulated:true}:{})});
    }
  }
  if(candidates.length>100)throw new Error("RAG v4 candidate limit");
  const trace:Record<string,number>={};
  // Only the in-process transport supplies stage measurements; never trust remote timings.
  if(connection.mode==="local"){
    const measured=obj(obj(rawResponse)?.search_trace);
    for(const key of ["embeddingMs","bm25Ms","vectorMs","fusionMs","bm25HitCount","vectorScannedCount","fusedProductCount"]){
      const value=measured?.[key];
      if(typeof value==="number"&&Number.isFinite(value)&&value>=0)trace[key]=value;
    }
    trace.verifiedCandidateCount=candidates.length;trace.verifiedReviewCount=evidence.length;
  }
  return {candidates,evidence,...(Object.keys(trace).length?{trace}:{})};
}
export function validateRagEndpoint(endpoint:string):URL {
  let u:URL;
  try{u=new URL(endpoint);}catch{throw new Error("invalid RAG endpoint URL");}
  const local=["localhost","127.0.0.1","[::1]"].includes(u.hostname);
  if((u.protocol!=="https:"&&!(local&&u.protocol==="http:"))||!u.hostname||
     u.username||u.password||u.hash||u.search)
    throw new Error("RAG endpoint must use HTTPS (HTTP loopback only)");
  return u;
}
async function boundedJson(response:Response):Promise<unknown>{
  if(!response.ok)throw new Error("RAG unavailable");
  const body=response.body;
  if(!body)throw new Error("RAG body absent");
  const reader=body.getReader(),parts:Uint8Array[]=[];
  let size=0;
  try{
    for(;;){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.length;
      if(size>maxResponseBytes)throw new Error("RAG response too large");
      parts.push(part.value);
    }
  }finally{reader.releaseLock();}
  const combined=new Uint8Array(size);let offset=0;
  for(const p of parts){combined.set(p,offset);offset+=p.length;}
  try{return JSON.parse(new TextDecoder().decode(combined));}
  catch{throw new Error("RAG response must be JSON");}
}
function parseEvidence(rows:unknown):EvidenceRecord[]{
  if(!Array.isArray(rows)||rows.length>300)throw new Error("RAG evidence limit");
  const result:EvidenceRecord[]=[],seen=new Set<string>();
  for(const raw of rows){
    const r=obj(raw);if(!r||!text(r.id,128)||!text(r.productId,128)||
      (r.variantId!==null&&!text(r.variantId,128))||
      (r.kind!=="SPEC"&&r.kind!=="REVIEW")||
      (r.kind==="REVIEW"&&(r.sourceKind!=="REAL"||!text(r.sourceRef,500)))||
      seen.has(r.id))throw new Error("invalid or duplicate RAG evidence");
    seen.add(r.id);
    result.push({id:r.id,productId:r.productId,variantId:r.variantId as string|null,
      kind:r.kind,sourceKind:r.sourceKind==="REAL"?"REAL":undefined,
      sourceRef:typeof r.sourceRef==="string"?r.sourceRef:undefined});
  }
  return result;
}
function parseCandidates(rows:unknown):Record<string,unknown>[] {
  if(!Array.isArray(rows)||rows.length>30)throw new Error("RAG candidate limit");
  const seen=new Set<string>();
  return rows.map(raw=>{
    const r=obj(raw);
    if(!r||!text(r.productId,128)||!text(r.variantId,128))throw new Error("invalid Commerce ID mapping");
    const key=JSON.stringify([r.productId,r.variantId]);
    if(seen.has(key))throw new Error("duplicate RAG candidate");
    seen.add(key);
    return r;
  });
}
export function verifiedRagRetriever(
  connection:RagConnection,
  getProduct:ProductLookup,
  fetcher:typeof fetch=fetch,
  reviewLookup?:ReviewLookup,
):RetrieverPort {
  if(connection.mode==="local"&&fetcher===fetch)
    throw new Error("local RAG requires an injected in-process transport");
  const target=validateRagEndpoint(connection.endpoint);
  const contract=connection.contract??"brain-rag-v1";
  if(contract==="brain-rag-v1"&&!text(connection.auditId,128))
    throw new Error("RAG audited dataset ID required");
  if(contract==="v4"&&!text(connection.datasetVersion,128))
    throw new Error("RAG dataset version required");
  if(contract==="v4"&&!reviewLookup)throw new Error("RAG v4 ReviewLookup required");
  const timeout=connection.timeoutMs??8000;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>20000)throw new Error("invalid RAG timeout");
  return {async search(input){
    if(contract==="v4")return retrieveV4(connection,input,target,timeout,getProduct,fetcher,reviewLookup!);
    if(!text(input.query,250))throw new Error("invalid RAG query");
    const response=await fetcher(target.toString(),{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(timeout),
      headers:{"content-type":"application/json",...(connection.token?{authorization:"Bearer "+connection.token}:{})},
      body:JSON.stringify({version:"brain-rag-v1",query:input.query,
        maxTotalWon:input.maxTotalWon,requiredConditions:input.requiredConditions})
    });
    const raw=obj(await boundedJson(response));
    if(!raw||raw.version!=="brain-rag-v1")throw new Error("RAG contract version mismatch");
    const evidence=parseEvidence(raw.evidence),candidateRows=parseCandidates(raw.candidates);
    const evidenceById=new Map(evidence.map(e=>[e.id,e]));
    const byProduct=new Map<string,ProductDetail|null>();
    const candidates:ProductCandidate[]=[];
    for(const row of candidateRows){
      const productId=row.productId as string,variantId=row.variantId as string;
      if(!byProduct.has(productId)){
        const got=await getProduct({product_id:productId});
        byProduct.set(productId,got.ok?got.data:null);
      }
      const verified=byProduct.get(productId);
      if(!verified||verified.product.id!==productId||!verified.product.active)continue;
      const variant=verified.variants.find(v=>v.variant_id===variantId);
      if(!variant||variant.availability!=="AVAILABLE"||variant.stock_qty<=0)continue;
      const rawFacets=obj(row.facets)??{},facets:ProductCandidate["facets"]={};
      if(Object.keys(rawFacets).length>25)throw Error("RAG facet limit");
      for(const aspect of Object.keys(rawFacets)){
        if(!/^[a-z][a-z0-9_]{0,79}$/.test(aspect))throw Error("invalid RAG facet identifier");
        const f=pickRecord(rawFacets[aspect]);if(f)facets[aspect]=f;
      }
      // A retrieved claim must cite evidence for this exact Commerce product
      // and, when variant-scoped, for this exact variant. Never borrow another
      // candidate's review or a stale variant's specification.
      const checkIds=(ids:readonly string[])=>{
        for(const id of ids){
          const ev=evidenceById.get(id);
          if(!ev||ev.productId!==productId||(ev.variantId!==null&&ev.variantId!==variantId))
            throw new Error("RAG cross-product evidence mismatch");
        }
      };
      for(const facet of Object.values(facets))if(facet)checkIds(facet.evidenceIds);
      const conditions:Record<string,string[]>={};
      const rawConditions=obj(row.conditions);
      if(rawConditions){
        for(const [k,v] of Object.entries(rawConditions)){
          if(text(k,80)&&Array.isArray(v)&&v.length<=25&&v.every(x=>text(x,128))){
            checkIds(v as string[]);
            conditions[k]=v as string[];
          }
        }
      }
      const audited=row.reviewCountAuditId===connection.auditId&&
        text(row.sourceProductId,128)&&whole(row.wholeReviewCount)&&
        typeof row.rating==="number"&&Number.isFinite(row.rating)&&
        row.rating>=1&&row.rating<=5&&row.ratingScale===5;
      candidates.push({
        productName:verified.product.name,productId,variantId,unitPriceWon:variant.unit_price_won,
        shippingFeeWon:verified.shipping_fee_won,
        rating:typeof row.rating==="number"&&Number.isFinite(row.rating)?row.rating:null,
        ratingScale:row.ratingScale===5?5:null,
        wholeReviewCount:whole(row.wholeReviewCount)?row.wholeReviewCount:null,
        wholeReviewCountVerified:!!audited,conditions,facets
      });
    }
    return {candidates,evidence};
  }};
}
