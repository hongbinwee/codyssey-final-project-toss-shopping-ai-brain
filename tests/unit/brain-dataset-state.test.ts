import test from 'node:test';
import assert from 'node:assert/strict';
import {currentDatasetResult} from '../../src/brain/dataset-state.ts';
import type {ResearchResult} from '../../src/brain/read-flow.ts';
test('dataset transition preserves plan and immutable history while stripping old evidence',()=>{
 const old={datasetVersion:'old',shoppingPlan:{query:'cream',revision:3},ranking:{ranked:[{candidate:{productId:'old'}}],referenceOnly:[],rejected:[]},explanation:{kind:'VERIFIED_CANDIDATES',text:'old facts',items:[{}]}} as unknown as ResearchResult;
 const safe=currentDatasetResult(old,'new');assert.equal(safe.shoppingPlan,old.shoppingPlan);assert.equal(safe.ranking.ranked.length,0);assert.equal(safe.explanation?.kind,'CONVERSATION');assert.equal(old.ranking.ranked.length,1);
 assert.equal(currentDatasetResult(old,'old'),old);
 assert.equal(currentDatasetResult({...old,datasetVersion:undefined},'new').ranking.ranked.length,0);
});
