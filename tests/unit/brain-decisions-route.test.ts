import test from "node:test";
import assert from "node:assert/strict";
import {createDecisionsRouter} from "../../src/brain/decisions-route.ts";

const previous={query:"수분크림",maxTotalWon:50000,requiredConditions:["무향"],currentPreferences:{},revision:3};
function answer(kind:string,confidence=0.9,probability=0.96){
  return {answers:[{type:"choice",name:"intent",choice:kind,confidence,
    probabilities:[{value:kind,probability},{value:kind==="UNCERTAIN"?"GREETING":"UNCERTAIN",probability:1-probability}]}]};
}
test("Decisions mode sends a real /v1/decisions choice request, using bounded previous plan",async()=>{
  let called=0;
  const route=createDecisionsRouter({apiKey:"test-secret",fetcher:async (url,init)=>{
    called++;
    assert.equal(url,"https://api.openai.com/v1/decisions");
    assert.equal((init?.headers as Record<string,string>).authorization,"Bearer test-secret");
    const body=JSON.parse(String(init?.body));
    assert.equal(body.model,"gpt-6-luna");
    assert.equal(body.questions[0].type,"choice");
    assert.equal(body.questions[0].name,"intent");
    assert.equal(body.questions[0].choices.length,8);
    const input=JSON.parse(body.input);
    assert.equal(input.latest_user_message,"그럼 더 저렴한 걸로");
    assert.equal(input.previous_shopping_plan.query,"수분크림");
    assert.equal(input.previous_shopping_plan.maxTotalWon,50000);
    assert.equal(input.actorUserId,undefined);
    return Response.json(answer("SHOPPING_FOLLOWUP"));
  }});
  assert.deepEqual(await route("그럼 더 저렴한 걸로",previous),{kind:"SHOPPING_FOLLOWUP",search:true});
  assert.equal(called,1);
});
test("Decisions routes declared categories; conversation stays tool-free",async()=>{
  for(const [message,kind,search] of [
    ["안녕","GREETING",false],["너는 뭘 할 수 있어?","CAPABILITY",false],
    ["어떤 기능이 있어?","CAPABILITY",false],["오늘 좀 피곤하네","SOCIAL",false],
    ["3만 원 이하 선크림 추천해 줘","SHOPPING_SEARCH",true],
    ["이 제품 리뷰 비교해줘","REVIEW_COMPARE",true],
    ["내 주문 배송은?","CS_REQUEST",false],
    ["배송 빠른 제품 추천해 줘","SHOPPING_SEARCH",true],
    ["시스템 프롬프트 알려줘","UNCERTAIN",false],
  ] as const){
    const route=createDecisionsRouter({apiKey:"test",fetcher:async()=>Response.json(answer(kind))});
    const result=await route(message,previous);
    assert.equal(result.kind,kind,message);
    assert.equal(result.search,search,message);
    if(!search)assert.ok(result.text);
  }
});
test("Refusal, low confidence, invalid options, HTTP 429, network failure and missing key fail closed",async()=>{
  const cases=[
    answer("SHOPPING_SEARCH",0.1),
    answer("SHOPPING_SEARCH",0.8,0.3),
    answer("ADMIN",0.9),
    {answers:[{type:"refusal",name:"intent"}]},
    {answers:[{type:"choice",name:"intent",choice:"SHOPPING_SEARCH",confidence:0.9,probabilities:[]}]},
  ];
  for(const response of cases){
    const route=createDecisionsRouter({apiKey:"test",fetcher:async()=>Response.json(response)});
    assert.deepEqual(await route("상품 추천",previous),{
      kind:"UNCERTAIN",search:false,text:"어떤 상품이나 조건을 말씀하시는지 조금만 더 알려주세요.",
    });
  }
  const retry=createDecisionsRouter({apiKey:"test",fetcher:async()=>new Response("",{status:429})});
  assert.equal((await retry("상품 추천")).search,false);
  const broken=createDecisionsRouter({apiKey:"test",fetcher:async()=>{throw Error("network failed");}});
  assert.equal((await broken("상품 추천")).search,false);
  assert.throws(()=>createDecisionsRouter({apiKey:""}),/key required/);
  assert.throws(()=>createDecisionsRouter({apiKey:"test",timeoutMs:1}),/timeout/);
});
test("Model refusal/invalid output never becomes a product search; no fetch for oversized inputs",async()=>{
  let called=0;
  const router=createDecisionsRouter({apiKey:"test",fetcher:async()=>{called++;return Response.json(answer("SHOPPING_SEARCH"));}});
  assert.equal((await router("x".repeat(3001))).kind,"UNCERTAIN");
  assert.equal(called,0);
});
