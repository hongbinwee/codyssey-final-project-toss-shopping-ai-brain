import {Annotation,StateGraph,START,END} from "@langchain/langgraph";
import type {BrainTrace} from "./contracts.ts";
import type {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import type {ResearchDeps,ResearchResult} from "./read-flow.ts";
import {researchTurn} from "./read-flow.ts";
import type {BrainGraphPort} from "./api.ts";

export type GraphRequest=BrainTrace & {clientActionId:string;userMessage:string};
/** Checkpoint saves active task state, not canonical long-term preferences. */
const State=Annotation.Root({
 request:Annotation<GraphRequest>(),
 researchResult:Annotation<ResearchResult>()
});
/**
 * Thread IDs are never accepted as authorization. Always validate conversation
 * ownership BEFORE invoking or reading the saved checkpoint.
 */
export function createPersistentResearchGraph(
 deps:ResearchDeps,
 checkpointer:PostgresSaver,
):BrainGraphPort {
 const compiled=new StateGraph(State)
   .addNode("research",async (state)=>({researchResult:await researchTurn(state.request,deps)}))
   .addEdge(START,"research").addEdge("research",END)
   .compile({checkpointer});
 // Single-process guard for conflicting concurrent writes to the same thread.
 // Multi-instance deployment requires a distributed lease before enablement.
 const active=new Set<string>();
 return {
  async invoke(input:GraphRequest){
   await deps.conversations.assertOwned(input.actorUserId,input.conversationId);
   if(active.has(input.conversationId))throw new Error("conversation busy");
   active.add(input.conversationId);
   try{
    const run=await compiled.invoke({request:input},{configurable:{thread_id:input.conversationId}});
    if(!run.researchResult||run.researchResult.conversationId!==input.conversationId)
      throw new Error("invalid graph result");
    return run.researchResult;
   }finally{active.delete(input.conversationId);}
  },
  async getOwnedState(actorUserId:string,conversationId:string){
   await deps.conversations.assertOwned(actorUserId,conversationId);
   const snap=await compiled.getState({configurable:{thread_id:conversationId}});
   return {values:snap.values as unknown as Record<string,unknown>};
  }
 };
}
