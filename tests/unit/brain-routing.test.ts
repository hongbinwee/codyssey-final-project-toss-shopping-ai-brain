import test from "node:test";
import assert from "node:assert/strict";
import {MemorySaver} from "@langchain/langgraph";
import {createPersistentResearchGraph} from "../../src/brain/graph.ts";
const routing=import("../../src/brain/routing.ts").catch(()=>null);
const previous={query:"수분크림",maxTotalWon:50000,requiredConditions:["무향"],currentPreferences:{},revision:3};

test("greeting, help, CS and uncertainty route without confusing mixed shopping input",async()=>{
 const m=await routing;assert.ok(m,"routing implementation missing");
 for(const [message,kind] of [["안녕?","GREETING"],["고마워","SOCIAL"],["뭘 할 수 있어?","CAPABILITY"],
  ["안녕, 수분크림 추천해 줘","SHOPPING_SEARCH"],["주문 취소해줘","CS_REQUEST"],["도와줘","UNCERTAIN"]])
  assert.equal(m.routeBrainMessage(message).kind,kind,message);
 assert.equal(m.routeBrainMessage("그럼 예산은 3만원 이하로",previous).kind,"SHOPPING_FOLLOWUP");
 assert.equal(m.routeBrainMessage("리뷰 장단점 비교해줘",previous).kind,"REVIEW_COMPARE");
});

test("social turns persist and replay through Graph without changing shopping plan or calling search/LLM",async()=>{
 const m=await routing;assert.ok(m);
 let messages=0,searches=0,intents=0,answers=0;
 const deps={route:m.routeBrainMessage,conversations:{async assertOwned(actor:string,id:string){
  if(actor!=="actor-one"||id!=="conversation-one")throw Error("not owned");
 },async appendUserMessage(){return "message-"+(++messages);}},memory:{async list(){return [];}},
 intent:{async extract(){intents++;return {query:"수분크림",context:{maxTotalWon:50000,requiredConditions:[],currentPreferences:{}}};}},
 retriever:{async search(){searches++;return {candidates:[],evidence:[]};}}};
 const saver=new MemorySaver();
 const graph=createPersistentResearchGraph(deps as never,saver as never,undefined,undefined,async()=>{
  answers++;return {kind:"NO_MATCH",text:"없음",items:[],limitations:[]};});
 const invoke=(message:string,key:string)=>graph.invoke({actorUserId:"actor-one",conversationId:"conversation-one",requestId:key,clientActionId:key,userMessage:message});
 const greeting=await invoke("안녕?","a");assert.equal(greeting.explanation?.kind,"CONVERSATION");
 assert.equal(greeting.shoppingPlan,undefined);assert.deepEqual([intents,searches,answers],[0,0,0]);
 await invoke("수분크림 추천해줘","b");
 const social=await invoke("고마워","c");assert.equal(social.shoppingPlan?.revision,1);
 assert.equal(social.shoppingPlan?.maxTotalWon,50000);assert.deepEqual([intents,searches,answers],[1,1,1]);
 assert.equal((await invoke("고마워","c")).messageId,social.messageId);assert.equal(messages,3);
 await assert.rejects(()=>graph.invoke({actorUserId:"actor-two",conversationId:"conversation-one",requestId:"d",clientActionId:"d",userMessage:"안녕"}),/owned/);
 const restored=createPersistentResearchGraph(deps as never,saver as never);
 const state=await restored.getOwnedState("actor-one","conversation-one");assert.ok(state.values?.researchResult);
});
