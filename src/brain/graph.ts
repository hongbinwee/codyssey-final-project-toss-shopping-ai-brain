import {Annotation,StateGraph,START,END} from "@langchain/langgraph";
import {AsyncLocalStorage} from "node:async_hooks";
import type {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import type {BrainTrace,EvidenceRecord} from "./contracts.ts";
import type {PreparedTurn,ResearchDeps,ResearchResult} from "./read-flow.ts";
import {prepareTurn,resolveTurnPlan,retrieveTurn} from "./read-flow.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import {buildGroundedExplanation} from "./grounded-response.ts";
import type {BrainGraphPort} from "./api.ts";
import type {TurnLock,TurnLease} from "./turn-lock.ts";

export type GraphRequest=BrainTrace & {clientActionId:string;userMessage:string};
const State=Annotation.Root({
 request:Annotation<GraphRequest>(),
 prepared:Annotation<PreparedTurn>(),
 shoppingPlan:Annotation<ShoppingPlan>(),
 evidence:Annotation<EvidenceRecord[]>(),
 researchResult:Annotation<ResearchResult>()
});
/**
 * Four explicit phases, each with a persisted checkpoint. Only a server-owned
 * conversation may invoke/read this graph. RAG/Commerce actions stay read-only.
 * Long-term preferences are re-read every turn, never stored as the authority
 * in a previous checkpoint.
 */
export function createPersistentResearchGraph(
 deps:ResearchDeps,checkpointer:PostgresSaver,turnLock?:TurnLock
):BrainGraphPort {
 // Context is per invocation, not per compiled graph: different conversations
 // may run concurrently without sharing lock ownership.
 const activeLease=new AsyncLocalStorage<TurnLease>();
 const verify=async()=>{await activeLease.getStore()?.assertHeld();};
 const compiled=new StateGraph(State)
   .addNode("prepare",async state=>{
     const prepared=await prepareTurn(state.request,deps);
     await verify();
     return {prepared};
   })
   .addNode("plan",async state=>{
     const shoppingPlan=await resolveTurnPlan(state.request,state.prepared,
       state.researchResult?.explanation ? state.researchResult.shoppingPlan : null,deps);
     await verify();
     return {shoppingPlan};
   })
   .addNode("retrieve",async state=>{
     const fetched=await retrieveTurn(state.request,state.prepared,state.shoppingPlan,deps);
     // A lost advisory session must not let stale RAG data finish this node.
     await verify();
     return {researchResult:fetched.result,evidence:fetched.evidence};
   })
   .addNode("respond",async state=>{
     const researchResult={
       ...state.researchResult,
       explanation:buildGroundedExplanation(state.researchResult.ranking,
         state.evidence,state.shoppingPlan)
     };
     await verify();
     return {researchResult};
   })
   .addEdge(START,"prepare")
   .addEdge("prepare","plan")
   .addEdge("plan","retrieve")
   .addEdge("retrieve","respond")
   .addEdge("respond",END)
   .compile({checkpointer});
 // One-process deduplication ONLY; production multi-replica requires a DB lock.
 // The map is scoped to one compiled graph instance and never authorizes a user.
 const inFlight=new Map<string,{actorUserId:string;clientActionId:string;userMessage:string;promise:Promise<ResearchResult>}>();
 return {
   async invoke(input:GraphRequest){
     await deps.conversations.assertOwned(input.actorUserId,input.conversationId);
     const pending=inFlight.get(input.conversationId);
     if(pending){
       if(pending.actorUserId===input.actorUserId&&
          pending.clientActionId===input.clientActionId&&pending.userMessage===input.userMessage)
         return pending.promise;
       if(pending.clientActionId===input.clientActionId)
         throw new Error("duplicate action conflict");
       throw new Error("conversation busy");
     }
     const task=(async()=>{
       // A reserved AI-DB session lock spans checkpoint read through final write.
       // Existing isolated tests without turnLock remain single-process only.
       const lease=turnLock?await turnLock.tryAcquire(input.conversationId):null;
       if(turnLock&&!lease)throw new Error("conversation busy");
       const execute=async()=>{

       const config={configurable:{thread_id:input.conversationId}};
       const prior=await compiled.getState(config);
       await verify();
       const request=prior.values?.request as GraphRequest|undefined;
       const completed=prior.values?.researchResult as ResearchResult|undefined;
       if(request?.clientActionId===input.clientActionId){
         if(request.actorUserId!==input.actorUserId||request.userMessage!==input.userMessage)
           throw new Error("duplicate action conflict");
         if(completed?.conversationId===input.conversationId&&
           completed.clientActionId===input.clientActionId&&completed.explanation)return completed;
       }
       const run=await compiled.invoke({request:input},config);
       await verify();
       if(!run.researchResult||run.researchResult.conversationId!==input.conversationId||
           run.researchResult.clientActionId!==input.clientActionId||!run.researchResult.explanation)
         throw new Error("invalid graph result");
       return run.researchResult;
       };
       try{
         return lease?await activeLease.run(lease,execute):await execute();
       }finally{if(lease)await lease.release();}
     })();
     inFlight.set(input.conversationId,{
       actorUserId:input.actorUserId,clientActionId:input.clientActionId,
       userMessage:input.userMessage,promise:task
     });
     try{return await task;}
     finally{inFlight.delete(input.conversationId);}
   },
   async getOwnedState(actorUserId:string,conversationId:string){
     await deps.conversations.assertOwned(actorUserId,conversationId);
     const snapshot=await compiled.getState({configurable:{thread_id:conversationId}});
     return {values:snapshot.values as unknown as Record<string,unknown>};
   }
 };
}
