import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recoveryAdvice, recoveryQuestions } from '../dist/recovery.js';
import { traceQuestions, modelFitChoices } from '../dist/trace.js';
import { TraceTriage } from '../dist/triage.js';
import { formatRecoveryAdvice } from '../plugins/jev-chat-review/hooks/review-copy.mjs';

const label=(criteria,choice)=>({choice,confidence:.95,probabilities:Object.fromEntries(Object.keys(criteria).map(key=>[key,key===choice?.96:.04/(Object.keys(criteria).length-1)]))});
const diagnosis=(progress,blocker,next_step)=>Object.fromEntries(Object.entries({progress,blocker,next_step}).map(([id,value])=>[id,label(recoveryQuestions[id],value)]));
const labels=Object.fromEntries(Object.entries({task_outcome:'incomplete',user_outcome:'no_feedback',run_health:'overt_failure'}).map(([id,value])=>[id,label(traceQuestions[id],value)]));

test('recovery development probe defaults to a bounded dry run without credentials',()=>{
  const result=spawnSync(process.execPath,['evidence/jev-recovery-suite.mjs'],{encoding:'utf8',env:{...process.env,AI_GATEWAY_API_KEY:'',MINDRAILS_ALLOW_PAID_JEV:''}});
  assert.equal(result.status,0);
  const report=JSON.parse(result.stdout);
  assert.equal(report.mode,'dry-run');
  assert.equal(report.cases.length,8);
  assert.equal(report.maxRequests,8);
  assert.equal(report.automaticRetries,0);
});

for(const [blocker,action] of [['missing_information','ask_question'],['environment','fix_environment'],['ineffective_approach','change_approach'],['verification_gap','verify_result'],['requirement_mismatch','realign']]) {
  test(`supported ${blocker} produces an actionable, static recovery prompt`,()=>{
    const result=recoveryAdvice(diagnosis('stalled',blocker,action),labels);
    assert.equal(result.action,action);
    assert.equal(result.status,'supported');
    assert.ok(result.suggestedPrompt.length>40);
    assert.match(formatRecoveryAdvice(result),/Vorschlag zum Übernehmen/);
  });
}
test('productive repeated work and completed work do not emit interventions',()=>{
  const healthy={...labels,task_outcome:label(traceQuestions.task_outcome,'complete'),run_health:label(traceQuestions.run_health,'healthy')};
  for(const progress of ['advancing','complete']) {
    const result=recoveryAdvice(diagnosis(progress,'none','continue'),healthy);
    assert.equal(result.action,'none');
    assert.equal(formatRecoveryAdvice(result),'');
  }
});
test('conflicting causes, completion claims and actions abstain without a follow-up prompt',()=>{
  for(const signals of [diagnosis('stalled','environment','change_approach'),diagnosis('complete','environment','fix_environment'),diagnosis('stalled','none','continue'),diagnosis('complete','none','continue')]) {
    const result=recoveryAdvice(signals,labels);
    assert.equal(result.reason,'CONFLICTING_JUDGMENTS');
    assert.equal(result.action,'review');
    assert.equal(result.suggestedPrompt,undefined);
  }
});
test('high selected probability alone cannot bypass low confidence',()=>{
  const signals=diagnosis('stalled','environment','fix_environment');
  signals.blocker.confidence=.4;
  assert.equal(recoveryAdvice(signals,labels).reason,'LOW_CONFIDENCE');
});
test('invalid, missing and foreign probability keys fail closed',()=>{
  const signals=diagnosis('stalled','environment','fix_environment');
  for(const broken of [{...signals,next_step:undefined},{...signals,blocker:{...signals.blocker,probabilities:{...signals.blocker.probabilities,unknown:.9}}},{...signals,blocker:{...signals.blocker,choice:'arbitrary command'}}]) {
    assert.throws(()=>recoveryAdvice(broken,labels),/INVALID_PROVIDER_RESPONSE/);
  }
});
test('an environment blocker suppresses a conflicting model upgrade in the actual triage result',async()=>{
  const result=await new TraceTriage({mode:'jev',evaluateTrace:async()=>({...labels,recovery:diagnosis('stalled','environment','fix_environment'),model_fit:label(modelFitChoices,'try_more_capable')})}).evaluate({task:'Run checks',instructions:'Use existing tests',turns:[{role:'user',content:'Run checks'}],toolCalls:[{name:'test',arguments:'test',result:'Missing runtime executable'}],finalMessage:'Tests cannot start.',telemetry:{currentModel:'test-model'}});
  assert.equal(result.recoveryAdvice.action,'fix_environment');
  assert.equal(result.modelRecommendation.action,'uncertain');
  assert.ok(result.modelRecommendation.basis[0].includes('Voraussetzung'));
});

test('a supported intervention cannot coexist with an automatic completion recommendation',async()=>{
  const result=await new TraceTriage({mode:'jev',evaluateTrace:async()=>({...labels,task_outcome:label(traceQuestions.task_outcome,'complete'),run_health:label(traceQuestions.run_health,'healthy'),recovery:diagnosis('stalled','environment','fix_environment')})}).evaluate({task:'Check the service',instructions:'Check it',turns:[],toolCalls:[],finalMessage:'Done'});
  assert.equal(result.recommendation,'HUMAN_REVIEW');
  assert.deepEqual(result.reasons,['RECOVERY_NEEDED']);
});
