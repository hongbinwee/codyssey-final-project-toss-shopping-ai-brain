import type {BrainTrace,MemoryRepository,Preference,RankingResult,RetrieverPort,ShoppingContext} from './contracts.ts';
import type {PersistentConversations} from './persistent-store.ts';
import {rankProducts} from './personalization.ts';
export interface ShoppingIntent {query:string;context:ShoppingContext}
export interface IntentPort {extract(userMessage:string,knownPreferences:Preference[]):Promise<ShoppingIntent>}
export interface ResearchResult {conversationId:string;messageId:string;ranking:RankingResult;trace:{memoryMs:number;intentMs:number;retrievalMs:number;rankMs:number;totalMs:number}}
export interface ResearchDeps {conversations:Pick<PersistentConversations,'assertOwned'|'appendUserMessage'>;memory:MemoryRepository;retriever:RetrieverPort;intent:IntentPort}
/** Read-only on Commerce. Production live graph must use this as its research node, not bypass eligibility. */
export async function researchTurn(req:BrainTrace & {userMessage:string;clientActionId:string},deps:ResearchDeps):Promise<ResearchResult>{
 const t0=performance.now();
 if(!req.actorUserId||!req.conversationId||!req.requestId||!req.userMessage?.trim())throw new Error('invalid authenticated research request');
 await deps.conversations.assertOwned(req.actorUserId,req.conversationId);
 const messageId=await deps.conversations.appendUserMessage(req.actorUserId,req.conversationId,req.clientActionId,req.userMessage);
 const t1=performance.now();
 const remembered=await deps.memory.list(req.actorUserId);
 if(remembered.some(p=>p.userId!==req.actorUserId))throw new Error('cross-tenant memory response');
 const t2=performance.now();
 const extracted=await deps.intent.extract(req.userMessage,remembered);
 if(!extracted||!extracted.query?.trim()||extracted.query.length>250)throw new Error('invalid query plan');
 const c=extracted.context;
 if(!c||!Array.isArray(c.requiredConditions)||c.requiredConditions.some(x=>typeof x!=='string'||!x.trim())||
   c.requiredConditions.length>12||typeof c.currentPreferences!=='object'||c.currentPreferences===null||
   (c.maxTotalWon!==null&&(!Number.isSafeInteger(c.maxTotalWon)||c.maxTotalWon<0)))throw new Error('invalid structured intent');
 const t3=performance.now();
 const fetched=await deps.retriever.search({query:extracted.query,maxTotalWon:c.maxTotalWon,requiredConditions:c.requiredConditions});
 if(!fetched||!Array.isArray(fetched.candidates)||!Array.isArray(fetched.evidence)||fetched.candidates.length>100||fetched.evidence.length>2500)
    throw new Error('invalid retrieval result');
 const t4=performance.now();
 const ranking=rankProducts(fetched.candidates,fetched.evidence,c,remembered);
 const t5=performance.now();
 return {conversationId:req.conversationId,messageId,ranking,trace:{memoryMs:t2-t1,intentMs:t3-t2,retrievalMs:t4-t3,rankMs:t5-t4,totalMs:t5-t0}};
}
