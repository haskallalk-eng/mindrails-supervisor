import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor, detectStuck } from '../dist/core.js';
import { MockProvider, JevProvider } from '../dist/providers.js';
const input = { task:'Prepare release',currentResult:'[done:a] [done:b]',requirements:[{id:'a',description:'readme'},{id:'b',description:'tests'}],evidence:'synthetic evidence' };
const good = {requirements:{a:1,b:1},taskSatisfied:1,evidenceSufficient:1,contradictions:0};
const provider = s => ({mode:'mock',evaluate:async()=>s});
test('mock complete and incomplete markers are visibly mock',async()=>{
  const s=new Supervisor(new MockProvider());
  assert.equal((await s.check(input)).decision,'finish');
  const r=await s.check({...input,currentResult:'[done:a]'});
  assert.equal(r.decision,'continue'); assert.deepEqual(r.requirementIds,['b']); assert.equal(r.provider,'mock');
});
for (const [label,change] of [['empty',{requirements:[]}],['duplicate',{requirements:[input.requirements[0],input.requirements[0]]}],['oversize',{task:'x'.repeat(8001)}],['unknown field',{secret:'x'}]]) test(`reject ${label}`,async()=>{
  await assert.rejects(()=>new Supervisor(new MockProvider()).check({...input,...change}));
});
for (const [label,s] of [['weak requirement',{...good,requirements:{a:1,b:.89}}],['no evidence',{...good,evidenceSufficient:.89}],['contradiction',{...good,contradictions:.11}],['task incomplete',{...good,taskSatisfied:.89}]]) test(label,async()=>assert.equal((await new Supervisor(provider(s)).check(input)).decision,'continue'));
for (const s of [{...good,requirements:{a:1}}, {...good,requirements:{a:1,b:NaN}}, {...good,contradictions:2}, {...good,requirements:{a:1,b:1,c:1}}]) test('malformed signal cannot finish',async()=>assert.equal((await new Supervisor(provider(s)).check(input)).decision,'review'));
test('host checks fail and unknown prevent provider call',async()=>{
  let calls=0; const p={mode:'mock',evaluate:async()=>{calls++;return good;}};
  for(const status of ['fail','unknown']) assert.equal((await new Supervisor(p).check({...input,trustedChecks:[{id:'build',status}]})).decision,'review');
  assert.equal(calls,0);
});
test('attempt budget is reserved before concurrent awaits',async()=>{
  const s=new Supervisor(provider(good),{maxCalls:1,maxInputBytes:10000,timeoutMs:100,threshold:.9});
  const results=await Promise.all([s.check(input),s.check(input)]);
  assert.equal(results.filter(r=>r.decision==='finish').length,1);
  assert.deepEqual(results[1].reasons,['BUDGET_EXHAUSTED']);
});
test('byte budget blocks calls',async()=>assert.deepEqual((await new Supervisor(provider(good),{maxCalls:10,maxInputBytes:1,timeoutMs:100,threshold:.9}).check(input)).reasons,['BUDGET_EXHAUSTED']));
test('missing supplied evidence vetoes even perfect provider signals',async()=>{
  const {evidence,...without}=input;
  assert.deepEqual((await new Supervisor(provider(good)).check(without)).reasons,['SUPPLIED_EVIDENCE_MISSING']);
});
test('threshold boundaries and provenance',async()=>{
  const r=await new Supervisor(provider({...good,requirements:{a:.9,b:.9},taskSatisfied:.9,evidenceSufficient:.9,contradictions:.1})).check(input);
  assert.equal(r.decision,'finish');assert.equal(r.synthetic,true);assert.equal(r.policyVersion,'0.1.1');
});
test('wire body limited before transport and total normalized input bounded',async()=>{
  let calls=0;
  const p=new JevProvider('synthetic-test-key',async()=>{calls++;return new Response(JSON.stringify(wire));});
  const huge={...input,requirements:Array.from({length:20},(_,i)=>({id:String(i),description:'x'.repeat(8000)}))};
  await assert.rejects(()=>p.evaluate(huge,new AbortController().signal));assert.equal(calls,0);
  await assert.rejects(()=>new Supervisor(provider(good)).check(huge));
});
test('timeout aborts transport even if provider ignores cancellation',async()=>{
  let signal; const p={mode:'mock',evaluate:(_,s)=>{signal=s;return new Promise(()=>{});}};
  const result=await new Supervisor(p,{maxCalls:1,maxInputBytes:10000,timeoutMs:10,threshold:.9}).check(input);
  assert.deepEqual(result.reasons,['PROVIDER_TIMEOUT']); assert.ok(signal.aborted);
});
test('raw provider errors never leak',async()=>{
  const result=await new Supervisor({mode:'jev',evaluate:async()=>{throw Error('PRIVATE_KEY');}}).check(input);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_KEY')); assert.equal(result.decision,'review');
});
const step={action:'search',input:'q',result:'same',progress:false};
test('repetition only across three trailing unchanged steps',()=>{
  assert.equal(detectStuck({steps:[step,step,step]}).stuck,true);
  for(const steps of [[],[step,step],[step,step,{...step,progress:true}],[step,step,{...step,result:'new'}]]) assert.equal(detectStuck({steps}).stuck,false);
  assert.throws(()=>detectStuck({steps:Array(51).fill(step)}));
});
test('detects alternating and three-step trailing cycles',()=>{
  const a={...step,action:'a'},b={...step,action:'b'},c={...step,action:'c'};
  const alternating=detectStuck({steps:[a,b,a,b,a,b]});
  assert.equal(alternating.stuck,true);assert.equal(alternating.cycleLength,2);assert.deepEqual(alternating.matchedIndices,[0,1,2,3,4,5]);
  const three=detectStuck({steps:[a,b,c,a,b,c,a,b,c]});
  assert.equal(three.stuck,true);assert.equal(three.cycleLength,3);assert.equal(three.repetitionCount,3);
});
test('bounded repeat grace expires and cannot hide progress changes',()=>{
  assert.equal(detectStuck({steps:[step,step,step],allowedExtraRepetitions:2}).stuck,false);
  assert.equal(detectStuck({steps:[step,step,step,step,step],allowedExtraRepetitions:2}).stuck,true);
  assert.throws(()=>detectStuck({steps:[step,step,step],allowedExtraRepetitions:3}));
});
test('old progress does not hide a later stuck suffix',()=>{
  assert.equal(detectStuck({steps:[{...step,progress:true},step,step,step]}).stuck,true);
  const a={...step,action:'a'},b={...step,action:'b'};
  assert.equal(detectStuck({steps:[{...a,progress:true},b,a,b,a,b,a,b]}).stuck,true);
});
test('mock accepts evidence supplied per requirement',async()=>{
  const perRequirement={...input,evidence:undefined,requirements:input.requirements.map(r=>({...r,evidence:`synthetic ${r.id}`}))};
  assert.equal((await new Supervisor(new MockProvider()).check(perRequirement)).decision,'finish');
});
const wire={model:'jev-1.13.0',answers:Object.fromEntries(['r0','r1','task','evidence','contradictions'].map(k=>[k,{type:'noul',noul:k==='contradictions'?0:1}])),usage:{input_tokens:10,output_tokens:10}};
test('Jev contract with fake transport, fixed URL and internal IDs',async()=>{
  let request;
  const p=new JevProvider('synthetic-test-key',async(url,options)=>{request={url,options};return new Response(JSON.stringify(wire));});
  assert.equal((await new Supervisor(p).check(input)).decision,'finish');
  assert.equal(request.url,'https://api.typesafe.ai/v1/systemone'); assert.equal(request.options.redirect,'error');
  const body=JSON.parse(request.options.body); assert.ok(body.questions.r0); assert.equal(body.questions.a,undefined);
});
test('Jev usage is exposed separately from semantic signals',async()=>{
  const p=new JevProvider('synthetic-test-key',async()=>new Response(JSON.stringify(wire)));
  const result=await new Supervisor(p).check(input);
  assert.deepEqual(result.providerUsage,{inputTokens:10,outputTokens:10});
  assert.equal('usage' in result.modelSignals,false);
});
test('Jev Vercel route pins the official compatibility endpoint and alias',async()=>{
  let request;
  const gatewayWire={...wire,model:'typesafe-ai/jev'};
  const p=new JevProvider('synthetic-test-key',async(url,options)=>{request={url,options};return new Response(JSON.stringify(gatewayWire));},'vercel-ai-gateway');
  const result=await new Supervisor(p).check(input);
  assert.equal(result.decision,'finish'); assert.equal(result.model,'typesafe-ai/jev');
  assert.equal(request.url,'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  assert.equal(JSON.parse(request.options.body).model,'typesafe-ai/jev');
});
test('Jev rejects an unknown route at runtime',()=>assert.throws(()=>new JevProvider('synthetic-test-key',fetch,'unknown'),/INVALID_JEV_ROUTE/));
for(const status of [401,429,500,529]) test(`Jev HTTP ${status} fails closed without raw body`,async()=>{
  let calls=0; const p=new JevProvider('synthetic-test-key',async()=>{calls++;return new Response('PRIVATE_KEY',{status});});
  const r=await new Supervisor(p).check(input); assert.equal(r.decision,'review');assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('PRIVATE_KEY'));
});
for(const body of ['not json',JSON.stringify({...wire,answers:{}}),'x'.repeat(64001),JSON.stringify({...wire,model:'unverified-model'})]) test('Jev malformed or oversized body fails closed',async()=>{
  const p=new JevProvider('synthetic-test-key',async()=>new Response(body)); assert.equal((await new Supervisor(p).check(input)).decision,'review');
});
