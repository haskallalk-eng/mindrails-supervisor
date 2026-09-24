import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceTriage } from '../dist/triage.js';
import { JevProvider, MockProvider } from '../dist/providers.js';

const input={task:'Summarize the report',instructions:'Use the supplied report only',turns:[{role:'user',content:'Please summarize.'}],toolCalls:[],finalMessage:'The report says revenue increased.'};
const labels=(task='complete',user='no_feedback',health='healthy')=>{
  const make=(options,choice)=>({choice,confidence:.95,probabilities:Object.fromEntries(options.map(x=>[x,x===choice?.95:.025]))});
  return {
    task_outcome:make(['complete','incomplete','uncertain'],task),
    user_outcome:make(['satisfied','dissatisfied','no_feedback'],user),
    run_health:make(['healthy','expectation_gap','overt_failure','silent_failure'],health),
  };
};
const provider=(result)=>({mode:'jev',model:'typesafe-ai/jev',evaluateTrace:async()=>result});

test('synthetic trace fixture yields an advisory recommendation',async()=>{
  const result=await new TraceTriage(new MockProvider()).evaluate(input);
  assert.equal(result.recommendation,'AUTO_CLOSE'); assert.equal(result.synthetic,true); assert.deepEqual(result.reasons,['TRACE_COMPLETE_NO_USER_FEEDBACK']);
});
test('explicit action permission violation routes immediately without calling provider',async()=>{
  let calls=0; const p={mode:'jev',evaluateTrace:async()=>{calls++;return labels();}};
  const result=await new TraceTriage(p).evaluate({...input,actions:[{name:'send_email',permitted:false,performed:true}]});
  assert.equal(result.recommendation,'ROUTE_PAGE_ON_CALL'); assert.equal(calls,0);
});
for(const [health,expected] of [['silent_failure','PRIORITY_REVIEW'],['overt_failure','FILE_ISSUE'],['expectation_gap','HUMAN_REVIEW']]) test(`${health} maps to ${expected}`,async()=>{
  assert.equal((await new TraceTriage(provider(labels('complete','no_feedback',health))).evaluate(input)).recommendation,expected);
});
test('dissatisfied user or incomplete work requires review',async()=>{
  assert.equal((await new TraceTriage(provider(labels('complete','dissatisfied'))).evaluate(input)).recommendation,'HUMAN_REVIEW');
  assert.equal((await new TraceTriage(provider(labels('incomplete'))).evaluate(input)).recommendation,'HUMAN_REVIEW');
});
test('uncertainty and weak confidence require review',async()=>{
  const uncertain=labels('uncertain');
  assert.equal((await new TraceTriage(provider(uncertain)).evaluate(input)).recommendation,'HUMAN_REVIEW');
  const weak=labels(); weak.run_health.confidence=.6;
  assert.equal((await new TraceTriage(provider(weak)).evaluate(input)).recommendation,'HUMAN_REVIEW');
});
test('malformed probabilities fail closed',async()=>{
  const malformed=labels(); malformed.task_outcome.probabilities.complete=.3;
  const result=await new TraceTriage(provider(malformed)).evaluate(input);
  assert.equal(result.recommendation,'HUMAN_REVIEW'); assert.deepEqual(result.reasons,['INVALID_PROVIDER_RESPONSE']);
});
test('oversized and unexpected input is rejected before provider evaluation',async()=>{
  let calls=0; const triage=new TraceTriage({mode:'jev',evaluateTrace:async()=>{calls++;return labels();}});
  await assert.rejects(()=>triage.evaluate({...input,unexpected:true}));
  await assert.rejects(()=>triage.evaluate({...input,finalMessage:'x'.repeat(25000)}));
  assert.equal(calls,0);
});

test('Jev choice contract uses the fixed Vercel route, exact questions and reports usage',async()=>{
  let request;
  const choices=labels();
  const answers=Object.fromEntries(Object.entries(choices).map(([id,value])=>[id,{type:'choice',...value}]));
  const wire={model:'typesafe-ai/jev',answers,usage:{input_tokens:91,output_tokens:12}};
  const result=await new TraceTriage(new JevProvider('synthetic-test-key',async(url,options)=>{request={url,options};return new Response(JSON.stringify(wire));},'vercel-ai-gateway')).evaluate(input);
  assert.equal(request.url,'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  const body=JSON.parse(request.options.body); assert.deepEqual(Object.keys(body.questions).sort(),['run_health','task_outcome','user_outcome']);
  assert.match(body.questions.task_outcome.instructions,/untrusted data/);
  assert.equal(result.recommendation,'AUTO_CLOSE'); assert.deepEqual(result.providerUsage,{inputTokens:91,outputTokens:12});
});
test('Jev wrong model or incomplete answers fail closed',async()=>{
  const choices=labels(), answers=Object.fromEntries(Object.entries(choices).map(([id,value])=>[id,{type:'choice',...value}]));
  for(const wire of [{model:'other',answers,usage:{input_tokens:1,output_tokens:1}},{model:'typesafe-ai/jev',answers:{},usage:{input_tokens:1,output_tokens:1}}]) {
    const result=await new TraceTriage(new JevProvider('synthetic-test-key',async()=>new Response(JSON.stringify(wire)),'vercel-ai-gateway')).evaluate(input);
    assert.equal(result.recommendation,'HUMAN_REVIEW'); assert.ok(['PROVIDER_FAILURE','INVALID_PROVIDER_RESPONSE'].includes(result.reasons[0]));
  }
});
