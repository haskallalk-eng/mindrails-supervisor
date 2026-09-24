import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { TraceTriage } from '../dist/triage.js';

// Replay recorded provider answers. No network, no regenerated answers, no accuracy claim.
const path=new URL('./results/jev-recovery-2026-09-24.json',import.meta.url);
const raw=await readFile(path,'utf8');
const saved=JSON.parse(raw.replace(/^\uFEFF/,''));
const rows=[];
for(const row of saved.rows) {
  const labels=row.result.labels;
  const result=await new TraceTriage({mode:'jev',model:saved.model,evaluateTrace:async()=>labels}).evaluate({task:row.id,instructions:'Replay policy only.',turns:[],toolCalls:[],finalMessage:'Recorded judgments; no new model inference.',telemetry:{currentModel:row.result.modelRecommendation?.currentModel??'unspecified-coding-model'}});
  rows.push({id:row.id,originalSemanticExpected:row.expected,previousAction:row.actual,action:result.recoveryAdvice?.action,status:result.recoveryAdvice?.status,reason:result.recoveryAdvice?.reason,modelAction:result.modelRecommendation?.action,modelDecisionBasis:result.modelRecommendation?.decisionBasis,triage:result.recommendation});
}
console.log(JSON.stringify({kind:'recorded-jev-policy-replay',sourceHash:createHash('sha256').update(raw).digest('hex'),recordedAt:new Date().toISOString(),policyVersion:'agent-trace-triage-v2',apiCalls:0,rows,limitations:['Reuses the first eight synthetic development cases; this is policy regression evidence, not a fresh or held-out Jev evaluation.','Original expected semantic actions are preserved. A no-op fallback does not mean an unresolved case was solved.']},null,2));
