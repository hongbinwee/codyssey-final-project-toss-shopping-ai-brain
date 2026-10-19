import test from 'node:test';
import assert from 'node:assert/strict';
import {subcatOf} from '../../src/web/display-meta.ts';
import type {ProductSummary} from '../../src/contracts.ts';
const product=(specs:Record<string,string>,category='beauty')=>({product_id:'arbitrary-new-id',category,matched_variants:[{effective_specs:specs}]} as ProductSummary);
test('new source sub_category drives the four beauty subcategories without fixture IDs',()=>{
 for(const [id,label]of [['sun','선케어'],['skincare','스킨케어'],['cleansing','클렌징'],['makeup','메이크업']]){
  const p=product({sub_category:label});assert.equal(subcatOf('beauty',id)!.matches(p),true,id);
  for(const other of ['sun','skincare','cleansing','makeup'].filter(x=>x!==id))assert.equal(subcatOf('beauty',other)!.matches(p),false);
 }
});
test('type fallback and source category paths are accepted, not guessed from product names',()=>{
 assert.equal(subcatOf('beauty','skincare')!.matches(product({type:'스킨케어'})),true);
 assert.equal(subcatOf('beauty','makeup')!.matches(product({sub_category:'뷰티 > 메이크업 > 아이라이너'})),true);
 assert.equal(subcatOf('beauty','sun')!.matches(product({type:'선케어'},'food')),false);
 assert.equal(subcatOf('beauty','sun')!.matches({...product({}),name:'선케어 크림'}),false);
});
test('legacy source taxonomy and supported specification fallbacks remain compatible',()=>{
 assert.equal(subcatOf('beauty','skincare')!.matches(product({'원본 목록 세부 카테고리':'스킨케어'})),true);
 assert.equal(subcatOf('beauty','sun')!.matches(product({spf:'50'})),true);
 assert.equal(subcatOf('beauty','cleansing')!.matches(product({cleanser_type:'foam'})),true);
});
