import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {PostgresSaver} from "@langchain/langgraph-checkpoint-postgres";
import {brainDatabaseFromPostgres} from "../../src/brain/pg-adapter.ts";
import {PersistentConversations,PersistentPreferences} from "../../src/brain/persistent-store.ts";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
import {createBrainApi} from "../../src/brain/api.ts";

const url=process.env.BRAIN_DATABASE_URL;
test("isolated real PostgreSQL persists preferences and LangGraph checkpoints across restarts",async()=>{
 if(!url||!new URL(url).pathname.startsWith("/brain_"))throw new Error("AI-only brain_* DB required");
 const sql=postgres(url,{max:5});
 let saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
 try {
  const [db]=await sql.unsafe("SELECT current_database() AS name");
  assert.match(db.name,/^brain_/);
  const storage=brainDatabaseFromPostgres(sql);
  const threads=new PersistentConversations(storage),memory=new PersistentPreferences(storage);
  const a=await threads.create("user-a"),b=await threads.create("user-b");
  await assert.rejects(()=>threads.assertOwned("user-b",a.id),/not owned/);
  const first=await threads.appendUserMessage("user-a",a.id,"preference-1","가성비를 선호해");
  assert.equal(await threads.appendUserMessage("user-a",a.id,"preference-1","가성비를 선호해"),first);
  await assert.rejects(()=>threads.appendUserMessage("user-a",a.id,"preference-1","수정된 요청"),/conflict/);
  await assert.rejects(()=>threads.proposePreference({actorUserId:"user-b",conversationId:a.id,sourceMessageId:first,key:"price_priority",value:"value"}),/not owned/);
  const proof=await threads.proposePreference({actorUserId:"user-a",conversationId:a.id,sourceMessageId:first,key:"price_priority",value:"value"});
  const [x,y]=await Promise.allSettled([threads.confirmPreference("user-a",proof),threads.confirmPreference("user-a",proof)]);
  assert.equal([x,y].filter(v=>v.status==="fulfilled").length,1,"approval must be consumed once even under concurrent requests");
  assert.equal((await memory.list("user-a"))[0].value,"value");
  assert.equal((await memory.list("user-b")).length,0);

  const ev=[];
  const candidates=[];
  for(const [id,price,perf,eye] of [["a",105000,.45,.45],["b",395000,.95,.9]]){
    const prod="p-"+id;
    const facts={};
    for(const [facet,score] of [["performance",perf],["eye_comfort",eye],["noise",.6]]){
      const eid=facet+"-"+id;
      ev.push({id:eid,productId:prod,variantId:"v-"+id,kind:"REVIEW",sourceKind:"REAL",sourceRef:"CI-only synthetic fixture"});
      facts[facet]={score,evidenceIds:[eid]};
    }
    candidates.push({productId:prod,variantId:"v-"+id,unitPriceWon:price,shippingFeeWon:5000,
      rating:4.4,ratingScale:5,wholeReviewCount:20,wholeReviewCountVerified:true,conditions:{},facets:facts});
  }
  const deps={
    conversations:threads,memory,
    intent:{extract:async()=>({query:"monitor",context:{maxTotalWon:500000,requiredConditions:[],currentPreferences:{}}})},
    retriever:{search:async()=>({candidates,evidence:ev})}
  };
  await saver.setup();
  let graph=createPersistentResearchGraph(deps,saver);
  const api=createBrainApi({conversations:threads,preferences:memory,graph});
  const getState=await api("GET",`/api/brain/conversations/${a.id}/state`,"user-b",{});
  assert.equal(getState.status,404);
  const t1=await api("POST",`/api/brain/conversations/${a.id}/turn`,"user-a",{user_message:"내 조건으로 추천",client_action_id:"turn-1"});
  assert.equal(t1.status,200,JSON.stringify(t1.body));
  assert.equal(t1.body.data.ranking.ranked[0].candidate.productId,"p-a","stored value preference must affect ranking");
  const second=await threads.appendUserMessage("user-a",a.id,"preference-2","성능이 우선이야");
  const p2=await threads.proposePreference({actorUserId:"user-a",conversationId:a.id,sourceMessageId:second,key:"price_priority",value:"performance"});
  await threads.confirmPreference("user-a",p2);
  const t2=await api("POST",`/api/brain/conversations/${a.id}/turn`,"user-a",{user_message:"같은 모니터 다시 추천",client_action_id:"turn-2"});
  assert.equal(t2.status,200);
  assert.equal(t2.body.data.ranking.ranked[0].candidate.productId,"p-b","new memory must change ranking");
  const stored=await graph.getOwnedState("user-a",a.id);
  assert.equal(stored.values.researchResult.messageId,t2.body.data.message_id);
  await assert.rejects(()=>graph.getOwnedState("user-b",a.id),/not owned/);
  await saver.end();
  saver=PostgresSaver.fromConnString(url,{schema:"shopping_brain"});
  await saver.setup();
  graph=createPersistentResearchGraph(deps,saver);
  const recovered=await graph.getOwnedState("user-a",a.id);
  assert.equal(recovered.values.researchResult.messageId,t2.body.data.message_id,"Postgres checkpoint survives saver reinitialization");
  const del=await api("DELETE","/api/brain/preferences/price_priority","user-a",{});
  assert.equal(del.status,200);
  assert.equal((await memory.list("user-a")).length,0);
  await threads.assertOwned("user-b",b.id);
 } finally {
  await Promise.allSettled([saver.end(),sql.end()]);
 }
});
