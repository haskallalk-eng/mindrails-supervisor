import test from 'node:test';
import assert from 'node:assert/strict';
import { routeModel, selectMaximum } from '../dist/model-router.js';
import { executionArgs } from '../dist/jev.js';
const models=['astra','sol','luna'].map(tier=>({model:`gpt-6-${tier}`,description:tier,defaultReasoningEffort:'medium'}));
const probabilities={'gpt-6-astra':0.2,'gpt-6-sol':0.3,'gpt-6-luna':0.5};
const input={task:'Explain a variable.',models,baseline:'gpt-6-astra',key:'test-key'};
const response=(p=probabilities,choice='gpt-6-luna')=>new Response(JSON.stringify({model:'typesafe-ai/jev',answers:{next_model:{type:'choice',confidence:0.2,choice,probabilities:p}},usage:{input_tokens:100,output_tokens:20}}));
test('highest model probability wins even with low confidence, before dispatch',async()=>{
  const result=await routeModel(input,async()=>response());
  assert.equal(result.model,'gpt-6-luna');assert.equal(result.source,'jev');
  const args=executionArgs(models.find(m=>m.model===result.model),{});
  assert.equal(args[args.indexOf('--model')+1],'gpt-6-luna');
  assert.equal(args.at(-1),'-');assert.ok(args.includes('read-only'));
});
test('ties retain baseline; near ties still use exact maximum',()=>{
  assert.equal(selectMaximum({'gpt-6-astra':0.5,'gpt-6-sol':0.5,'gpt-6-luna':0},models,'gpt-6-sol'),'gpt-6-sol');
  assert.equal(selectMaximum({'gpt-6-astra':0.49999,'gpt-6-sol':0.50001,'gpt-6-luna':0},models,'gpt-6-astra'),'gpt-6-sol');
});
test('invalid, foreign, incomplete and mismatched distributions preserve baseline',async()=>{
  for(const [p,choice] of [[{'other':1},'other'],[{'gpt-6-astra':0.2,'gpt-6-sol':0.2,'gpt-6-luna':0.2},'gpt-6-luna'],[probabilities,'gpt-6-astra']]){
    const result=await routeModel(input,async()=>response(p,choice));assert.equal(result.source,'baseline');assert.equal(result.probabilities,null);
  }
});
test('missing key, HTTP error and timeout preserve baseline without retry',async()=>{
  let calls=0;
  const request=async()=>{calls++;return new Response('',{status:429});};
  assert.equal((await routeModel({...input,key:''},request)).reason,'JEV_KEY_MISSING');assert.equal(calls,0);
  assert.equal((await routeModel(input,request)).reason,'JEV_HTTP_429');assert.equal(calls,1);
  assert.equal((await routeModel(input,async()=>{throw new Error('timeout');})).source,'baseline');
});
test('oversized context is not silently truncated or sent',async()=>{
  let calls=0;const result=await routeModel({...input,context:'x'.repeat(65000)},async()=>{calls++;return response();});
  assert.equal(calls,0);assert.equal(result.reason,'ROUTING_CONTEXT_TOO_LARGE');
});
test('context redaction keeps valid JSON; original task is unchanged',async()=>{
  const original={...input,task:'password=private123',context:{password:'private456',text:'Bearer abcdef123456'}};
  await routeModel(original,async(url,options)=>{const body=JSON.parse(options.body);assert.equal(body.state.context.password,'[REDACTED]');assert.ok(!options.body.includes('private'));assert.ok(options.signal);return response();});
  assert.equal(original.task,'password=private123');
});
test('resume targets explicit conversation with compatible effort and no shell prompt',()=>{
  const args=executionArgs(models[0],{threadId:'test-session',write:true});
  assert.ok(args.includes('workspace-write'));assert.equal(args[args.indexOf('resume')+1],'test-session');
  assert.ok(args.includes('model_reasoning_effort="medium"'));assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
