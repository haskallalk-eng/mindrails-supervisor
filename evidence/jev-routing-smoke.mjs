// Explicit paid smoke test; stores only synthetic tasks, decisions and marker results.
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readCodexRoutingState } from '../dist/codex-catalog.js';
import { routeModel } from '../dist/model-router.js';
import { executionArgs } from '../dist/jev.js';
const tasks=[
  'Antworte ausschließlich mit JEV_ROUTING_OK. Verwende keine Tools und ändere keine Dateien.',
  'Implement a typical paginated REST endpoint with input validation and integration tests in an existing application.',
  'Diagnose a rare distributed consistency failure involving leader election, clock skew and concurrent writes. Derive the safety invariant and prove that the proposed protocol change preserves it.'
];
if(!process.argv.includes('--execute')){console.log(JSON.stringify({mode:'dry-run',jevCalls:3,codexExecutions:1,tasks},null,2));process.exit(0);}
if(process.env.MINDRAILS_ALLOW_PAID_JEV!=='I_UNDERSTAND_THIS_MAY_COST_MONEY'||!process.env.AI_GATEWAY_API_KEY)throw new Error('PAID_TEST_NOT_ENABLED');
const binary=process.env.JEV_CODEX_BIN??'codex';
const {models}=await readCodexRoutingState(binary);
const baseline=models.find(m=>m.isDefault)?.model??models[0].model;
const results=[];
for(const task of tasks){const started=Date.now();const decision=await routeModel({task,models,baseline,key:process.env.AI_GATEWAY_API_KEY});results.push({task,decision,latencyMs:Date.now()-started});}
const selected=models.find(m=>m.model===results[0].decision.model);
const args=executionArgs(selected,{ephemeral:true});
const run=spawnSync(binary,args,{input:tasks[0],encoding:'utf8',windowsHide:true,timeout:60000,env:{...process.env,MINDRAILS_JEV_AUTO_REVIEW:'0'}});
const events=(run.stdout??'').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
const answer=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').map(e=>e.item.text).join('\n');
const evidence={timestamp:new Date().toISOString(),mode:'live',models:models.map(m=>m.model),results,execution:{requestedModel:selected.model,args,exitCode:run.status,answer,passed:run.status===0&&answer.trim()==='JEV_ROUTING_OK'},limitations:'Synthetic smoke test. CLI receives the selected model explicitly; this does not measure model-selection quality or integrate the native composer.'};
await mkdir(new URL('./results/',import.meta.url),{recursive:true});
await writeFile(new URL('./results/jev-routing-smoke-2026-09-24.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(!evidence.execution.passed||results.some(r=>r.decision.source!=='jev'))process.exitCode=1;
