import type {BrainTrace,EvidenceRecord,MemoryRepository,Preference,RankingResult,RetrieverPort} from "./contracts.ts";
import type {PersistentConversations} from "./persistent-store.ts";
import {rankProducts} from "./personalization.ts";
import type {PlanExtraction,ShoppingPlan} from "./shopping-plan.ts";
import {resolveShoppingPlan} from "./shopping-plan.ts";
import type {GroundedExplanation} from "./grounded-response.ts";
import type {BrainRoute,BrainIntentKind} from "./routing.ts";

export type ShoppingIntent=PlanExtraction & {attributeSources?:Record<string,string>};
export interface IntentPort {
 extract(userMessage:string,knownPreferences:Preference[],previous?:ShoppingPlan):Promise<ShoppingIntent>
}
export interface ResearchResult {
 conversationId:string;messageId:string;clientActionId?:string;ranking:RankingResult;
 shoppingPlan?:ShoppingPlan;
 explanation?:GroundedExplanation;
 intentKind?:BrainIntentKind;
 trace:{memoryMs:number;intentMs:number;retrievalMs:number;rankMs:number;totalMs:number;[key:string]:number}
}
export interface ResearchDeps {
 conversations:Pick<PersistentConversations,"assertOwned"|"appendUserMessage">;
 memory:MemoryRepository;retriever:RetrieverPort;intent:IntentPort;
 route?:(message:string,previous?:ShoppingPlan)=>BrainRoute;
 fastResponses?:boolean;
}
export interface PreparedTurn {
 messageId:string;memories:Preference[];startedAt:number;memoryMs:number
}
export interface RetrievedTurn {
 result:ResearchResult;evidence:EvidenceRecord[]
}
type Request=BrainTrace & {userMessage:string;clientActionId:string};

function isConditionOnlySyntheticReference(
 blocked:RankingResult["rejected"][number],
 requiredConditions:string[],
 evidence:EvidenceRecord[],
):boolean {
 const candidate=blocked.candidate;
 if(candidate.commerceVerified!==true||candidate.sourceKind!=="SYNTHETIC"||
    typeof candidate.datasetVersion!=="string"||!candidate.datasetVersion||
    requiredConditions.length===0||blocked.reasons.length===0||
    !blocked.reasons.every(reason=>reason.startsWith("unverified_required_condition:")))return false;

 const byId=new Map<string,EvidenceRecord>(),duplicates=new Set<string>();
 for(const row of evidence){if(byId.has(row.id))duplicates.add(row.id);byId.set(row.id,row);}
 for(const condition of requiredConditions){
   const ids=candidate.conditions[condition]??[];
   if(!Array.isArray(ids))return false;
   for(const id of ids){
     const row=byId.get(id);
     if(duplicates.has(id)||!row||row.productId!==candidate.productId||
        (row.variantId!==null&&row.variantId!==candidate.variantId)||
        (row.kind==="REVIEW"&&row.sourceKind!=="REAL"))return false;
   }
 }
 return true;
}

export async function prepareTurn(req:Request,deps:ResearchDeps):Promise<PreparedTurn>{
 const t0=performance.now();
 if(!req.actorUserId||!req.conversationId||!req.requestId||!req.userMessage?.trim()||!req.clientActionId)
   throw new Error("invalid authenticated research request");
 await deps.conversations.assertOwned(req.actorUserId,req.conversationId);
 const messageId=await deps.conversations.appendUserMessage(req.actorUserId,req.conversationId,req.clientActionId,req.userMessage);
 const memories=await deps.memory.list(req.actorUserId);
 if(memories.some(m=>m.userId!==req.actorUserId))throw new Error("cross-tenant memory response");
 return {messageId,memories,startedAt:t0,memoryMs:performance.now()-t0};
}
export async function resolveTurnPlan(req:Request,prepared:PreparedTurn,previous:ShoppingPlan|null|undefined,deps:ResearchDeps):Promise<ShoppingPlan>{
 const intent=await deps.intent.extract(req.userMessage,prepared.memories,previous??undefined);
 const plan=resolveShoppingPlan(previous,intent);
 if(!plan.query||plan.query.length>200)throw new Error("invalid shopping plan");
 return plan;
}
export async function retrieveTurn(req:Request,prepared:PreparedTurn,plan:ShoppingPlan,deps:ResearchDeps):Promise<RetrievedTurn>{
 const retrievalStart=performance.now();
 const fetched=await deps.retriever.search({query:plan.query,maxTotalWon:plan.maxTotalWon,
   requiredConditions:plan.requiredConditions,requestId:req.requestId,originalQuestion:req.userMessage,
   ...(plan.category?{category:plan.category}:{})});
 if(!fetched||!Array.isArray(fetched.candidates)||!Array.isArray(fetched.evidence)||
    fetched.candidates.length>100||fetched.evidence.length>2500)throw new Error("invalid retrieval result");
 const retrievalMs=performance.now()-retrievalStart;
 const rankedAt=performance.now();
 const ranking=rankProducts(fetched.candidates,fetched.evidence,plan,prepared.memories);
 const conditionOnlyReferences=ranking.rejected.filter(item=>
   isConditionOnlySyntheticReference(item,plan.requiredConditions,fetched.evidence));
 if(conditionOnlyReferences.length){
   const moved=new Set(conditionOnlyReferences);
   ranking.rejected=ranking.rejected.filter(item=>!moved.has(item));
   ranking.referenceOnly.push(...conditionOnlyReferences);
 }
 const rankMs=performance.now()-rankedAt;
 return {
   result:{conversationId:req.conversationId,messageId:prepared.messageId,clientActionId:req.clientActionId,ranking,
     shoppingPlan:plan,trace:{...fetched.trace,memoryMs:prepared.memoryMs,
       intentMs:Math.max(0,retrievalStart-prepared.startedAt-prepared.memoryMs),
       retrievalMs,rankMs,totalMs:performance.now()-prepared.startedAt}},
   evidence:fetched.evidence
 };
}
/** Legacy independent research path remains for unit tests and adapter consumers. */
export async function researchTurn(req:Request,deps:ResearchDeps):Promise<ResearchResult>{
 const prepared=await prepareTurn(req,deps);
 const plan=await resolveTurnPlan(req,prepared,null,deps);
 return (await retrieveTurn(req,prepared,plan,deps)).result;
}
