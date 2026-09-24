import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceTriage } from '../dist/triage.js';
import { JevProvider, MockProvider } from '../dist/providers.js';
import { modelFitChoices } from '../dist/trace.js';
import { recoveryQuestions } from '../dist/recovery.js';

const wireRecovery=Object.fromEntries(Object.entries(recoveryQuestions).map(([id,criteria])=>{
  const choice={progress:'complete',blocker:'none',next_step:'continue'}[id];
  return [`recovery_${id}`,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(criteria).map(option=>[option,option===choice?1:0]))}];
}));

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
test('full-context model advice recommends a capability change separately from task triage',async()=>{
  const telemetry={currentModel:'codex-balanced',toolCount:9,repeatedActions:0,latestUsage:{inputTokens:190000,cachedInputTokens:150000,outputTokens:900,reasoningOutputTokens:300,totalTokens:191200,contextWindow:200000},rateLimits:{primaryUsedPercent:70,secondaryUsedPercent:42}};
  const modelFit={choice:'try_more_capable',confidence:.92,probabilities:Object.fromEntries(Object.keys(modelFitChoices).map(key=>[key,key==='try_more_capable'?.92:.0267]))};
  const result=await new TraceTriage(provider({...labels(),model_fit:modelFit})).evaluate({...input,turns:[...input.turns,{role:'assistant',content:'Retrying the same failed implementation.'}],telemetry});
  assert.equal(result.recommendation,'AUTO_CLOSE');
  assert.equal(result.modelRecommendation.action,'try_more_capable');
  assert.equal(result.modelRecommendation.currentModel,'codex-balanced');
  assert.ok(result.modelRecommendation.basis.some(item=>item.includes('96%')));
});
test('model advice fails closed to uncertain when confidence is low',async()=>{
  const telemetry={currentModel:'codex-balanced'};
  const modelFit={choice:'try_faster',confidence:.4,probabilities:{keep_current:.1,try_more_capable:.2,try_faster:.4,uncertain:.3}};
  const result=await new TraceTriage(provider({...labels(),model_fit:modelFit})).evaluate({...input,telemetry});
  assert.equal(result.modelRecommendation.action,'uncertain');
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
  const wire={model:'typesafe-ai/jev',answers:{...answers,...wireRecovery},usage:{input_tokens:91,output_tokens:12}};
  const result=await new TraceTriage(new JevProvider('synthetic-test-key',async(url,options)=>{request={url,options};return new Response(JSON.stringify(wire));},'vercel-ai-gateway')).evaluate(input);
  assert.equal(request.url,'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  const body=JSON.parse(request.options.body); assert.deepEqual(Object.keys(body.questions).sort(),['recovery_blocker','recovery_next_step','recovery_progress','run_health','task_outcome','user_outcome']);
  assert.match(body.questions.task_outcome.instructions,/untrusted data/);
  assert.equal(result.recommendation,'AUTO_CLOSE'); assert.deepEqual(result.providerUsage,{inputTokens:91,outputTokens:12});
  assert.equal(result.recoveryAdvice.action,'none');
  assert.equal(result.recoveryAdvice.signals.blocker.choice,'none');
});
test('Jev evaluates model fit using full trace and Codex telemetry in the same request',async()=>{
  let request;
  const choices=labels();
  const modelFit={choice:'keep_current',confidence:.91,probabilities:{keep_current:.91,try_more_capable:.03,try_faster:.03,uncertain:.03}};
  const answers={...Object.fromEntries(Object.entries(choices).map(([id,value])=>[id,{type:'choice',...value}])),...wireRecovery,model_fit:{type:'choice',...modelFit}};
  const telemetry={currentModel:'codex-balanced',toolCount:4,repeatedActions:0,latestUsage:{inputTokens:70000,cachedInputTokens:50000,outputTokens:400,reasoningOutputTokens:100,totalTokens:70500,contextWindow:200000},rateLimits:{primaryUsedPercent:35,secondaryUsedPercent:20}};
  const result=await new TraceTriage(new JevProvider('synthetic-test-key',async(url,options)=>{request={url,options};return new Response(JSON.stringify({model:'typesafe-ai/jev',answers,usage:{input_tokens:1600,output_tokens:80}}));},'vercel-ai-gateway')).evaluate({...input,telemetry});
  const body=JSON.parse(request.options.body);
  assert.ok(body.state.turns.some(turn=>turn.content==='Please summarize.'));
  assert.equal(body.state.telemetry.latestUsage.totalTokens,70500);
  assert.ok(body.questions.model_fit);
  assert.match(body.questions.model_fit.instructions,/entire ordered transcript/);
  assert.equal(result.modelRecommendation.action,'keep_current');
});
test('Jev wrong model or incomplete answers fail closed',async()=>{
  const choices=labels(), answers=Object.fromEntries(Object.entries(choices).map(([id,value])=>[id,{type:'choice',...value}]));
  for(const wire of [{model:'other',answers,usage:{input_tokens:1,output_tokens:1}},{model:'typesafe-ai/jev',answers:{},usage:{input_tokens:1,output_tokens:1}}]) {
    const result=await new TraceTriage(new JevProvider('synthetic-test-key',async()=>new Response(JSON.stringify(wire)),'vercel-ai-gateway')).evaluate(input);
    assert.equal(result.recommendation,'HUMAN_REVIEW'); assert.ok(['PROVIDER_FAILURE','INVALID_PROVIDER_RESPONSE'].includes(result.reasons[0]));
  }
});
