import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";

const modelId="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
const dimensions=384,rrfConstant=60,maxEvidencePerProduct=5;
type JsonObject=Record<string,unknown>;
type EmbedQuery=(query:string)=>Promise<readonly number[]>;
interface Chunk {
 product_id:string;chunk_id:string;source_type:string;source_id:string;source_version:unknown;
 category:string;evidence_text:string;embedding_text:string;dataset_version:string;embedding_model:string;
 source_metadata:JsonObject;embedding:Float32Array;norm:number;terms:Map<string,number>;length:number
}
interface IndexedProduct {category:string}
interface SearchRequest {
 request_id:string;original_question:string;query:string;category:string;filters:Record<string,unknown>;
 required_conditions:string[];preferences:unknown[];top_k:number
}
export interface LocalRagStats {
 datasetVersion:string;embeddingModel:string;vectorDimensions:number;chunkCount:number;productCount:number;
 syntheticReviewChunkCount:number;sourceTypeCounts:Record<string,number>;
 evidenceSha256:string;indexedProductsSha256:string
}
function object(value:unknown):value is JsonObject{return !!value&&typeof value==="object"&&!Array.isArray(value);}
function text(value:unknown,max:number):value is string{
 return typeof value==="string"&&value.length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
}
function bodyText(value:unknown,max:number):value is string{
 return typeof value==="string"&&value.length>0&&value.length<=max&&
   !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
}
function parseJsonl(buffer:Buffer,name:string):JsonObject[]{
 const rows:JsonObject[]=[];
 for(const [index,line] of buffer.toString("utf8").split(/\r?\n/).entries()){
   if(!line.trim())continue;
   try{const value:unknown=JSON.parse(line);if(!object(value))throw new Error();rows.push(value);}
   catch{throw new Error(`invalid JSONL in ${name} at row ${index+1}`);}
 }
 return rows;
}
/** English uses lowercase alphanumeric tokens; Korean syllable runs use adjacent bigrams. */
function tokenize(value:string):string[]{
 const runs=value.match(/[A-Za-z0-9]+|[가-힣]+/g)??[],result:string[]=[];
 for(const run of runs){
   if(/^[가-힣]+$/.test(run)){
     const syllables=Array.from(run);
     if(syllables.length===1)result.push(run);
     else for(let i=0;i<syllables.length-1;i++)result.push(syllables[i]+syllables[i+1]);
   }else result.push(run.toLowerCase());
 }
 return result;
}
function frequencies(terms:string[]):Map<string,number>{
 const result=new Map<string,number>();for(const term of terms)result.set(term,(result.get(term)??0)+1);return result;
}
function recordToChunk(row:JsonObject,index:number,version:string,seen:Set<string>):Chunk{
 const id=row.chunk_id,productId=row.product_id,sourceId=row.source_id,category=row.category,
   sourceType=row.source_type,meta=row.source_metadata,embedding=row.embedding;
 if(row.dataset_version!==version)throw new Error(`evidence dataset version mismatch at row ${index+1}`);
 if(row.embedding_model!==modelId)throw new Error(`evidence embedding model mismatch at row ${index+1}`);
 if(!Array.isArray(embedding)||embedding.length!==dimensions||
    !embedding.every(x=>typeof x==="number"&&Number.isFinite(x)))
   throw new Error(`evidence embedding must be a finite ${dimensions}-dimensional vector at row ${index+1}`);
 if(!text(id,128)||!text(productId,128)||!text(sourceId,128)||!text(category,80)||
   !text(sourceType,80)||!bodyText(row.evidence_text,5000)||!bodyText(row.embedding_text,20000)||
   !object(meta))
   throw new Error(`invalid or incompatible evidence chunk at row ${index+1}`);
 if(seen.has(id))throw new Error("duplicate evidence chunk ID");
 seen.add(id);
 const vector=Float32Array.from(embedding as number[]);
 let normSquared=0;for(const value of vector)normSquared+=value*value;
 const norm=Math.sqrt(normSquared);if(!Number.isFinite(norm)||norm===0)throw new Error("invalid zero evidence vector");
 const terms=tokenize(row.embedding_text);
 return {product_id:productId,chunk_id:id,source_type:sourceType,source_id:sourceId,
   source_version:row.source_version,category,evidence_text:row.evidence_text,embedding_text:row.embedding_text,
   dataset_version:version,embedding_model:modelId,source_metadata:meta,embedding:vector,norm,
   terms:frequencies(terms),length:terms.length};
}
function requestOf(value:unknown):SearchRequest{
 if(!object(value))throw new Error("invalid local RAG request");
 const allowed=new Set(["request_id","original_question","query","category","filters","required_conditions","preferences","top_k"]);
 if(Object.keys(value).some(key=>!allowed.has(key)))throw new Error("unsupported local RAG request field");
 if(!text(value.request_id,128)||!text(value.original_question,3000)||!text(value.query,250)||
   !text(value.category,80)||!object(value.filters)||!Array.isArray(value.required_conditions)||
   value.required_conditions.length>25||!value.required_conditions.every(x=>text(x,128))||
   !Array.isArray(value.preferences)||!Number.isSafeInteger(value.top_k)||
   (value.top_k as number)<1||(value.top_k as number)>5)
   throw new Error("invalid local RAG request shape or top_k");
 if(Object.keys(value.filters).length)throw new Error("unsupported local RAG filter");
 if(value.preferences.length)throw new Error("unsupported local RAG preference");
 return value as unknown as SearchRequest;
}
function bm25(docs:Chunk[],queryTerms:string[]):Map<string,number>{
 const result=new Map<string,number>();if(!docs.length||!queryTerms.length)return result;
 const avgLength=docs.reduce((sum,d)=>sum+d.length,0)/docs.length||1;
 const documentFrequency=new Map<string,number>();
 for(const doc of docs)for(const term of new Set(doc.terms.keys()))documentFrequency.set(term,(documentFrequency.get(term)??0)+1);
 const k1=1.2,b=.75,n=docs.length;
 for(const doc of docs){
   let score=0;
   for(const term of new Set(queryTerms)){
     const tf=doc.terms.get(term)??0,df=documentFrequency.get(term)??0;
     if(!tf||!df)continue;
     const idf=Math.log(1+(n-df+.5)/(df+.5));
     score+=idf*tf*(k1+1)/(tf+k1*(1-b+b*doc.length/avgLength));
   }
   if(score>0)result.set(doc.chunk_id,score);
 }
 return result;
}
function cosine(query:readonly number[],queryNorm:number,doc:Chunk):number{
 let dot=0;for(let i=0;i<dimensions;i++)dot+=query[i]*doc.embedding[i];return dot/(queryNorm*doc.norm);
}
function ranked(scores:Map<string,number>,docs:Chunk[]):Map<string,number>{
 const byId=new Map(docs.map(doc=>[doc.chunk_id,doc]));
 return new Map([...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))
   .map(([id],index)=>[id,index+1]));
}
function syntheticReview(chunk:Chunk):boolean{
 return chunk.source_type==="review"&&chunk.source_metadata.source_kind==="SYNTHETIC"&&
   chunk.source_metadata.synthetic===true&&text(chunk.source_metadata.variant_id,128);
}

export async function createLocalRagSearch(options:{dataDir:string;embedQuery:EmbedQuery}):Promise<{
 search:(body:unknown)=>Promise<{dataset_version:string;items:{product_id:string;rrf_score:number;evidence:JsonObject[]}[]}>;
 stats:LocalRagStats
}>{
 if(!text(options.dataDir,2048)||typeof options.embedQuery!=="function")throw new Error("invalid local RAG options");
 const evidencePath=join(options.dataDir,"evidence_chunks.jsonl"),productsPath=join(options.dataDir,"indexed_products.jsonl");
 const [evidenceBuffer,productsBuffer]=await Promise.all([readFile(evidencePath),readFile(productsPath)]);
 const chunkRows=parseJsonl(evidenceBuffer,"evidence_chunks.jsonl"),productRows=parseJsonl(productsBuffer,"indexed_products.jsonl");
 const versions=new Set(chunkRows.map(row=>row.dataset_version));
 if(versions.size!==1||!text([...versions][0],128))throw new Error("evidence dataset version missing or inconsistent");
 const datasetVersion=[...versions][0] as string;
 const products=new Map<string,IndexedProduct>();
 for(const [index,row] of productRows.entries()){
   if(!text(row.product_id,128)||!text(row.category,80)||row.dataset_version!==datasetVersion||!object(row.product_payload))
     throw new Error(`invalid indexed product at row ${index+1}`);
   if(products.has(row.product_id))throw new Error("duplicate indexed product ID");
   products.set(row.product_id,{category:row.category});
 }
 if(!products.size||chunkRows.some(row=>!products.has(row.product_id as string)))
   throw new Error("evidence product mapping is incomplete");
 const seenChunks=new Set<string>(),chunks=chunkRows.map((row,index)=>recordToChunk(row,index,datasetVersion,seenChunks));
 const sourceTypeCounts:Record<string,number>={};
 for(const chunk of chunks)sourceTypeCounts[chunk.source_type]=(sourceTypeCounts[chunk.source_type]??0)+1;
 const stats:LocalRagStats={datasetVersion,embeddingModel:modelId,vectorDimensions:dimensions,
   chunkCount:chunks.length,productCount:products.size,
   syntheticReviewChunkCount:chunks.filter(syntheticReview).length,sourceTypeCounts,
   evidenceSha256:createHash("sha256").update(evidenceBuffer).digest("hex"),
   indexedProductsSha256:createHash("sha256").update(productsBuffer).digest("hex")};

 return {stats,async search(input){
   const body=requestOf(input),docs=chunks.filter(chunk=>chunk.category===body.category&&
     products.get(chunk.product_id)?.category===body.category);
   if(!docs.length)return {dataset_version:datasetVersion,items:[]};
   const embedText=[body.query,...body.required_conditions].join(" ");
   const queryVector=await options.embedQuery(embedText);
   if(!Array.isArray(queryVector)||queryVector.length!==dimensions||
     !queryVector.every(value=>typeof value==="number"&&Number.isFinite(value)))
     throw new Error("query embedding must have 384 finite dimensions");
   let queryNormSquared=0;for(const value of queryVector)queryNormSquared+=value*value;
   const queryNorm=Math.sqrt(queryNormSquared);if(!Number.isFinite(queryNorm)||queryNorm===0)throw new Error("query embedding has zero norm");
   const bm25Scores=bm25(docs,tokenize([body.query,body.original_question,...body.required_conditions].join(" ")));
   const vectorScores=new Map(docs.map(doc=>[doc.chunk_id,cosine(queryVector,queryNorm,doc)]));
   const bm25Ranks=ranked(bm25Scores,docs),vectorRanks=ranked(vectorScores,docs);
   const byChunk=new Map(docs.map(doc=>[doc.chunk_id,doc]));
   const scores=new Map<string,number>();
   for(const doc of docs){
     const lexicalRank=bm25Ranks.get(doc.chunk_id),vectorRank=vectorRanks.get(doc.chunk_id);
     scores.set(doc.chunk_id,(lexicalRank?1/(rrfConstant+lexicalRank):0)+1/(rrfConstant+(vectorRank??docs.length)));
   }
   const groups=new Map<string,{score:number;hits:Chunk[]}>();
   for(const [chunkId,score] of scores){
     const chunk=byChunk.get(chunkId)!;let group=groups.get(chunk.product_id);
     if(!group){group={score,hits:[]};groups.set(chunk.product_id,group);}
     group.score=Math.max(group.score,score);group.hits.push(chunk);
   }
   const ordered=[...groups].sort((a,b)=>b[1].score-a[1].score||a[0].localeCompare(b[0]));
   const usedSourceIds=new Set<string>(),items:{product_id:string;rrf_score:number;evidence:JsonObject[]}[]=[];
   for(const [productId,group] of ordered){
     const evidence:JsonObject[]=[];
     const reviewHits=group.hits.filter(syntheticReview).sort((a,b)=>(scores.get(b.chunk_id)??0)-(scores.get(a.chunk_id)??0)||a.chunk_id.localeCompare(b.chunk_id));
     for(const chunk of reviewHits){
       if(usedSourceIds.has(chunk.source_id))continue;
       usedSourceIds.add(chunk.source_id);
       evidence.push({product_id:chunk.product_id,chunk_id:chunk.chunk_id,source_type:chunk.source_type,
         source_id:chunk.source_id,source_version:chunk.source_version,evidence_text:chunk.evidence_text,
         source_metadata:chunk.source_metadata});
       if(evidence.length===maxEvidencePerProduct)break;
     }
     if(evidence.length)items.push({product_id:productId,rrf_score:group.score,evidence});
     if(items.length===body.top_k)break;
   }
   return {dataset_version:datasetVersion,items};
 }};
}
