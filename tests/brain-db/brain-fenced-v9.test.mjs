import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {postgresTurnLock} from "../../src/brain/turn-lock.ts";
import {FencedTurns} from "../../src/brain/fenced-turns.ts";

const url=process.env.BRAIN_DATABASE_URL;
const valid=()=>{if(!url||new URL(url).pathname!=="/brain_ci")throw Error("disposable brain_ci required");};
const intent=(message,mem,previous)=>{
  if(message==="first")return {query:"monitor",queryMode:"SET",budgetMode:"SET",
    requirementsMode:"REPLACE",context:{maxTotalWon:500000,requiredConditions:["FHD"],currentPreferences:{}}};
  if(message==="next")return {query:"monitor",queryMode:"KEEP",budgetMode:"SET",
    requirementsMode:"KEEP",context:{maxTotalWon:300000,requiredConditions:[],currentPreferences:{}}};
  if(message==="audio")return {query:"headphones",queryMode:"SET",budgetMode:"CLEAR",
    requirementsMode:"CLEAR",preferencesMode:"CLEAR",
    context:{maxTotalWon:null,requiredConditions:[],currentPreferences:{}}};
  throw Error("unexpected message "+message);
};

test("fenced v9 publishes only completed per-generation graph states; replay and restart preserve plan",async()=>{
  valid();
  const db=postgres(url,{max:4}),lockDb=postgres(url,{max:2});
  let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  try{
    await saver.setup();
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const memory=new PersistentPreferences(store);
    const fence=new FencedTurns(store);
    const thread=await conversations.create("v9-owner");
    let retrievals=0;
    const deps={conversations,memory,intent:{extract:async(...args)=>intent(...args)},
      retriever:{search:async()=>{retrievals++;return {candidates:[],evidence:[]};}}};
    const graphFactory=()=>createPersistentResearchGraph(deps,saver,postgresTurnLock(lockDb,db),fence);
    let graph=graphFactory();
    const call=(action,userMessage)=>graph.invoke({actorUserId:"v9-owner",conversationId:thread.id,
      requestId:crypto.randomUUID(),clientActionId:action,userMessage});
    const first=await call("one","first");
    assert.equal(first.shoppingPlan.maxTotalWon,500000);
    assert.deepEqual(first.shoppingPlan.requiredConditions,["FHD"]);
    assert.equal(first.shoppingPlan.revision,1);
    const pointer=await fence.latest(thread.id);
    assert.ok(pointer?.threadId);
    assert.notEqual(pointer.threadId,thread.id,"checkpoint must live on private generation thread");
    const second=await call("two","next");
    assert.equal(second.shoppingPlan.maxTotalWon,300000);
    assert.deepEqual(second.shoppingPlan.requiredConditions,["FHD"]);
    assert.equal(second.shoppingPlan.revision,2);
    const latest=await fence.latest(thread.id);
    assert.notEqual(latest.threadId,pointer.threadId);
    assert.equal(latest.result.clientActionId,"two");
    assert.equal((await graph.getOwnedState("v9-owner",thread.id)).values.shoppingPlan.revision,2);
    await assert.rejects(()=>graph.getOwnedState("wrong-tenant",thread.id),/not owned/);
    const replay=await call("two","next");
    assert.equal(replay.messageId,second.messageId);
    assert.equal(retrievals,2);
    await assert.rejects(()=>call("two","audio"),/duplicate action conflict/);
    await saver.end();
    saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
    await saver.setup();
    graph=graphFactory();
    const third=await call("three","audio");
    assert.equal(third.shoppingPlan.query,"headphones");
    assert.equal(third.shoppingPlan.maxTotalWon,null);
    assert.deepEqual(third.shoppingPlan.requiredConditions,[]);
    assert.equal(third.shoppingPlan.revision,3);
    assert.equal((await graph.getOwnedState("v9-owner",thread.id)).values.researchResult.clientActionId,"three");
    const messages=await db.unsafe("SELECT count(*)::int AS n FROM shopping_brain.messages WHERE conversation_id=$1",[thread.id]);
    assert.equal(messages[0].n,3);
  }finally{await Promise.allSettled([saver.end(),lockDb.end(),db.end()]);}
});

test("fenced v9 rejects a stale generation after takeover and retains newer canonical receipt",async()=>{
  valid();
  const db=postgres(url,{max:3});
  try{
    const store=brainDatabaseFromPostgres(db);
    const conversations=new PersistentConversations(store);
    const thread=await conversations.create("v9-stale-owner");
    const fence=new FencedTurns(store);
    const base={actorUserId:"v9-stale-owner",conversationId:thread.id};
    const a={...base,clientActionId:"old",userMessage:"first"};
    const b={...base,clientActionId:"new",userMessage:"next"};
    const old=await fence.claim(a);
    assert.equal(old.kind,"run");
    const newer=await fence.claim(b);
    assert.equal(newer.kind,"run");
    assert.ok(BigInt(newer.generation)>BigInt(old.generation));
    const result=(req)=>({conversationId:thread.id,messageId:crypto.randomUUID(),
      clientActionId:req.clientActionId,ranking:{evaluatedCount:0,ranked:[],referenceOnly:[]},
      shoppingPlan:{query:"monitor",maxTotalWon:500000,requiredConditions:[],
        currentPreferences:{},revision:1},
      explanation:{kind:"NO_MATCH",text:"No evidence",citations:[]},
      trace:{memoryMs:0,intentMs:0,retrievalMs:0,rankMs:0,totalMs:0}});
    await assert.rejects(()=>fence.publish(a,old,result(a)),/stale turn generation/);
    await fence.publish(b,newer,result(b));
    assert.equal((await fence.latest(thread.id)).result.clientActionId,"new");
    const pending=await db.unsafe("SELECT status FROM shopping_brain.turn_receipts WHERE conversation_id=$1 AND client_action_id='old'",[thread.id]);
    assert.equal(pending[0].status,"PENDING");
  }finally{await db.end();}
});
