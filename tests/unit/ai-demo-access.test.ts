import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAiDemoGate} from '../../src/ai-demo-access.ts';
test('demo allows one concurrent turn per user and bounds total billing requests',()=>{
  const gate=createAiDemoGate(2,2);
  const first=gate.take('a'); assert.equal(first.ok,true);
  assert.deepEqual(gate.take('a'),{ok:false,code:'AI_DEMO_BUSY'});
  if(first.ok){first.release();first.release();}
  const second=gate.take('b');assert.equal(second.ok,true);
  if(second.ok)second.release();
  assert.deepEqual(gate.take('c'),{ok:false,code:'AI_DEMO_LIMIT'});
});
test('demo user quota cannot be bypassed by completing turns',()=>{
  const gate=createAiDemoGate(20,1);const t=gate.take('a');if(t.ok)t.release();
  assert.deepEqual(gate.take('a'),{ok:false,code:'AI_DEMO_LIMIT'});
});
