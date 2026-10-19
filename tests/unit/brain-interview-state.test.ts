import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrainInterviewState, type InterviewEntry } from "../../src/web/brain-interview-state.ts";

const reply=(query:string,maxTotalWon:number|null,attributePreferences:string[]=[]):NonNullable<InterviewEntry["reply"]>=>({
 intent_kind:"SHOPPING_SEARCH",
 shopping_plan:{query,maxTotalWon,attributePreferences},
});
const turn=(text:string,query:string,maxTotalWon:number|null,attributePreferences:string[]=[]):InterviewEntry=>({
 text,reply:reply(query,maxTotalWon,attributePreferences),
});

test("a no-digit follow-up uses the saved budget and does not repeat the budget question",()=>{
 const state=resolveBrainInterviewState([
  turn("에센스 추천해줘","에센스",null),
  turn("에센스 2만원대에서 찾아줘. 이 가격대를 유지해줘.","에센스",29999),
  turn("에센스에서 보습을 중요하게 생각해요. 이전 예산 범위는 유지하고 추천해줘.","에센스",29999),
 ],false);
 assert.deepEqual(state,{showBudgetQuestion:false,showEssencePurposeQuestion:false});
});

test("explicit no-budget answer is remembered from this transcript",()=>{
 const state=resolveBrainInterviewState([
  turn("에센스 추천해줘","에센스",null),
  turn("에센스 예산은 상관없어요.","에센스",null),
 ],false);
 assert.deepEqual(state,{showBudgetQuestion:false,showEssencePurposeQuestion:true});
});

test("explicit no-purpose answer is not repeated when the plan has no attribute preference",()=>{
 const state=resolveBrainInterviewState([
  turn("에센스 추천해줘","에센스",null),
  turn("에센스 2만원대에서 찾아줘.","에센스",29999),
  turn("에센스의 기능 선호는 상관없어요. 이전 예산 범위는 유지해줘.","에센스",29999),
 ],false);
 assert.deepEqual(state,{showBudgetQuestion:false,showEssencePurposeQuestion:false});
});

test("new query and new conversation do not inherit local interview answers",()=>{
 const changedQuery=resolveBrainInterviewState([
  turn("에센스 추천해줘","에센스",null),
  turn("에센스 예산은 상관없어요.","에센스",null),
  turn("선크림도 추천해줘","선크림",null),
 ],false);
 assert.deepEqual(changedQuery,{showBudgetQuestion:true,showEssencePurposeQuestion:false});
 const newConversation=resolveBrainInterviewState([turn("에센스 추천해줘","에센스",null)],false);
 assert.deepEqual(newConversation,{showBudgetQuestion:true,showEssencePurposeQuestion:false});
});

test("purpose question requires a known budget and no current attribute preference",()=>{
 const unknownBudget=resolveBrainInterviewState([turn("에센스 보습도 보고 싶어요","에센스",null)],false);
 assert.deepEqual(unknownBudget,{showBudgetQuestion:true,showEssencePurposeQuestion:false});
 const attributeKnown=resolveBrainInterviewState([turn("에센스 2만원대 추천","에센스",29999,["hydration"])],false);
 assert.deepEqual(attributeKnown,{showBudgetQuestion:false,showEssencePurposeQuestion:false});
});

test("latest follow-up plan overrides initial search budget and completed purpose",()=>{
 const followup=turn("에센스 보습을 중요하게 생각해요","에센스",29999,["moisturizing"]);
 followup.reply!.intent_kind="SHOPPING_FOLLOWUP";
 assert.deepEqual(resolveBrainInterviewState([turn("에센스 사고 싶어","에센스",null),followup],false),
  {showBudgetQuestion:false,showEssencePurposeQuestion:false});
});
test("returning to an earlier query does not reuse answers from an earlier task",()=>{
 assert.deepEqual(resolveBrainInterviewState([
  turn("에센스 예산은 상관없어요","에센스",null),
  turn("선크림 추천","선크림",null),
  turn("에센스 다시 추천","에센스",null),
 ],false),{showBudgetQuestion:true,showEssencePurposeQuestion:false});
});
test("a conversation reply and a pending turn never reshow stale questions",()=>{
 assert.deepEqual(resolveBrainInterviewState([turn("에센스","에센스",null),{text:"고마워",reply:{intent_kind:"SOCIAL",shopping_plan:null}}],false),{showBudgetQuestion:false,showEssencePurposeQuestion:false});
 assert.deepEqual(resolveBrainInterviewState([turn("에센스","에센스",null)],true),{showBudgetQuestion:false,showEssencePurposeQuestion:false});
});
