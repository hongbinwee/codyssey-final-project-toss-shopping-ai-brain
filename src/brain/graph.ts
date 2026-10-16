import {Annotation,StateGraph,START,END} from "@langchain/langgraph";
import type {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import type {BrainTrace,EvidenceRecord} from "./contracts.ts";
import type {PreparedTurn,ResearchDeps,ResearchResult} from "./read-flow.ts";
import {prepareTurn,resolveTurnPlan,retrieveTurn} from "./read-flow.ts";
import type {ShoppingPlan} from "./shopping-plan.ts";
import {buildGroundedExplanation} from "./grounded-response.ts";
import type {BrainGraphPort} from "./api.ts";

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
 deps:ResearchDeps,checkpointer:PostgresSaver
):BrainGraphPort {
 const compiled=new StateGraph(State)
   .addNode("prepare",async state=>({
     prepared:await prepareTurn(state.request,deps)
   }))
   .addNode("plan",async state=>({
     shoppingPlan:await resolveTurnPlan(state.request,state.prepared,state.shoppingPlan??null,deps)
   }))
   .addNode("retrieve",async state=>{
     const fetched=await retrieveTurn(state.request,state.prepared,state.shoppingPlan,deps);
     return {researchResult:fetched.result,evidence:fetched.evidence};
   })
   .addNode("respond",async state=>({
     researchResult:{
       ...state.researchResult,
       explanation:buildGroundedExplanation(state.researchResult.ranking,
         state.evidence,state.shoppingPlan)
     }
   }))
   .addEdge(START,"prepare")
   .addEdge("prepare","plan")
   .addEdge("plan","retrieve")
   .addEdge("retrieve","respond")
   .addEdge("respond",END)
   .compile({checkpointer});
 // One-process consistency only; for multiple nodes use distributed locking.
 const active=new Set<string>();
 return {
   async invoke(input:GraphRequest){
     await deps.conversations.assertOwned(input.actorUserId,input.conversationId);
     if(active.has(input.conversationId))throw new Error("conversation busy");
     active.add(input.conversationId);
     try{
       const config={configurable:{thread_id:input.conversationId}};
       const prior=await compiled.getState(config);
       const request=prior.values?.request as GraphRequest|undefined;
       const completed=prior.values?.researchResult as ResearchResult|undefined;
       if(request?.clientActionId===input.clientActionId){
         if(request.actorUserId!==input.actorUserId||request.userMessage!==input.userMessage)
           throw new Error("duplicate action conflict");
         if(completed?.conversationId===input.conversationId)return completed;
       }
       const run=await compiled.invoke({request:input},config);
       if(!run.researchResult||run.researchResult.conversationId!==input.conversationId)
         throw new Error("invalid graph result");
       return run.researchResult;
     }finally{active.delete(input.conversationId);}
   },
   async getOwnedState(actorUserId:string,conversationId:string){
     await deps.conversations.assertOwned(actorUserId,conversationId);
     const snapshot=await compiled.getState({configurable:{thread_id:conversationId}});
     return {values:snapshot.values as unknown as Record<string,unknown>};
   }
 };
}
