import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

// Real React component and browser; only HTTP/data/model boundaries are fixtures.
// No service credentials, DB, existing Preview process, or real model calls.
test('chat sends immediately, retries the same action, separates conversations and confirms memory', {timeout:60000}, async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrainPreview} from './src/web/components/BrainPreview.tsx';createRoot(document.getElementById('root')).render(<BrainPreview onClose={()=>{}} onOpenProduct={()=>{}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  const requests=[];let release, fail=true, saved=false;const creations=[];let loseCreation=true;
  const response=(conversation,text)=>({conversation_id:conversation,message_id:'33333333-3333-4333-8333-333333333333',read_only:true,shopping_plan:{query:text,maxTotalWon:20000,requiredConditions:[],revision:1},ranking:{ranked:[],referenceOnly:[],rejected:[],evaluatedCount:0},explanation:{text:'조건을 확인했어요.',kind:'NO_MATCH',items:[],limitations:[]},trace:{totalMs:7}});
  await page.route('http://127.0.0.1:39191/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   const ok=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
   if(p==='/')return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/bundle.js"></script>'});
   if(p==='/bundle.js')return route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0].text});
   if(p==='/api/brain/history')return ok({conversationId:a,entries:[]});
   if(p==='/api/brain/conversations'&&route.request().method()==='GET')return ok({conversations:[{id:b,title:'이전 대화',createdAt:'2026-10-18'},{id:a,title:'첫 대화',createdAt:'2026-10-19'}]});
   if(p==='/api/brain/conversations'){
    creations.push(route.request().postDataJSON());
    if(loseCreation){loseCreation=false;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'NETWORK',message:'lost response'}})});}
    return ok({id:b});
   }
   if(p.endsWith('/history'))return ok({conversationId:b,entries:[{text:'이전 질문',reply:response(b,'이전 질문')}]});
   if(p.endsWith('/turn')){
    const body=route.request().postDataJSON();requests.push(body);
    if(requests.length===1)await new Promise(resolve=>{release=resolve;});
    if(fail){fail=false;return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'MODEL_TIMEOUT',message:'internal'}})});}
    return ok(response(p.includes(a)?a:b,body.user_message));
   }
   if(p==='/api/brain/preferences/proposals')return ok({proposal_id:'proposal'});
   if(p==='/api/brain/preferences/confirm'){saved=true;return ok({key:'price_priority',value:'value',updatedAt:'2026-10-19'});}
   if(p==='/api/brain/preferences')return ok(saved?[{key:'price_priority',value:'value',updatedAt:'2026-10-19'}]:[]);
   throw Error('unexpected fixture path '+p);
  });
  await page.goto('http://127.0.0.1:39191/');
  page.setDefaultTimeout(5000);
  const input=page.getByPlaceholder('쇼핑 조건을 입력하세요');
  await input.fill('2만원 이하 상품');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await page.locator('.msg.user').getByText('2만원 이하 상품',{exact:true}).waitFor();
  assert.equal(await input.inputValue(),'');
  assert.equal(await page.getByRole('button',{name:'새 대화 시작'}).isDisabled(),true);
  release();
  await page.getByRole('button',{name:'다시 시도',exact:true}).click();
  await page.getByText('조건을 확인했어요.',{exact:true}).waitFor();
  assert.equal(requests.length,2);assert.equal(requests[0].client_action_id,requests[1].client_action_id);
  assert.equal(await page.locator('.msg.user').count(),1);
  await input.fill('다른 예산으로 수정');
  await page.getByRole('button',{name:'보내기',exact:true}).click();
  await page.locator('.msg.user').getByText('다른 예산으로 수정',{exact:true}).waitFor();
  await page.getByRole('button',{name:'선호 저장 요청',exact:true}).waitFor();
  assert.notEqual(requests[1].client_action_id,requests[2].client_action_id,'edited questions are independent actions');
  await page.getByRole('button',{name:'선호 저장 요청',exact:true}).click();
  await page.getByRole('button',{name:'이 선호를 기억하도록 확인',exact:true}).click();
  await page.getByRole('status').filter({hasText:'저장했어요'}).waitFor();
  assert.equal(saved,true);assert.equal(await page.getByText('가성비 중심',{exact:true}).count()>0,true);
  await page.getByRole('button',{name:'새 대화 시작',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'대화를 열지 못했어요'}).waitFor();
  assert.equal(await page.locator('.msg.user').count(),2,'failed creation leaves current conversation intact');
  await page.getByRole('button',{name:'새 대화 시작',exact:true}).click();
  await page.getByRole('status').filter({hasText:'새 대화를 시작했어요'}).waitFor();
  assert.equal(typeof creations[0].client_action_id,'string');
  assert.equal(creations[0].client_action_id,creations[1].client_action_id,'lost creation responses reuse creation identity');
  assert.equal(await page.locator('.msg.user').count(),0);
  assert.equal(await page.getByText('저장된 장기 선호',{exact:true}).count(),1);
  await page.getByLabel('이전 대화').selectOption(b);
  await page.locator('.msg.user').getByText('이전 질문',{exact:true}).waitFor();
  assert.equal(await page.getByText('Brain Graph 처리 시간',{exact:false}).count(),0);
 }finally{await browser.close();}
});
