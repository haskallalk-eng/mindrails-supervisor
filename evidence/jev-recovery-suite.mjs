import { createHash } from 'node:crypto';
import { TraceTriage } from '../dist/triage.js';
import { JevProvider } from '../dist/providers.js';

// Small synthetic development probe, not a production benchmark or held-out validation.
const cases = [
  {id:'access-blocked',expected:'fix_environment',task:'Read the deployment status.',turns:['Please check the deployment.','The service returns access denied with the configured account. Retrying does not change the denial.'],tools:[['deployment_status','project demo','403 permission denied'],['deployment_status','project demo','403 permission denied']],final:'I cannot read the status because this account lacks access.'},
  {id:'missing-user-decision',expected:'ask_question',task:'Book a meeting at my preferred time.',turns:['Book a meeting tomorrow at my preferred time.','There is no preferred time in the conversation, profile, or available calendar. Several times are free.'],tools:[],final:'The user must choose a time before I can proceed.'},
  {id:'failed-approach',expected:'change_approach',task:'Fix the parser test failure.',turns:['Fix the parser.','I tried the same regex replacement three times. Each test still fails identically. Inputs and prerequisites are available. I have not inspected the failing case or considered another hypothesis.'],tools:[['test','parser','Expected nested object; received truncated value.'],['test','parser','Expected nested object; received truncated value.'],['test','parser','Expected nested object; received truncated value.']],final:'The same regex patch keeps failing. The parser is not fixed.'},
  {id:'unverified-success',expected:'verify_result',task:'Fix the bug and run the regression test before claiming it works.',turns:['Fix the bug and run its regression test.','I edited the function but did not run or inspect the regression test.'],tools:[['edit','function','Saved successfully.']],final:'The bug is fixed and everything works.'},
  {id:'missed-requirement',expected:'realign',task:'Provide a German setup guide for Windows.',turns:['Provide a German setup guide for Windows.','Here is an English guide for Linux.'],tools:[],final:'Run sudo apt install, then edit .bashrc. The Windows guide is complete.'},
  {id:'productive-repetition',expected:'none',task:'Fix all three failing tests.',turns:['Fix all three tests.','Each run follows a different targeted fix. The failing count decreased from three to two to one. I am now investigating the final failure.'],tools:[['test','suite','3 tests failed'],['test','suite','2 tests failed'],['test','suite','1 test failed']],final:'Two failures are fixed and verified. The last failure is identified; I am working on it.'},
  {id:'verified-complete',expected:'none',task:'Fix the parser and pass its regression test.',turns:['Fix the parser and run the regression test.','I fixed the nested-object parser case.','Thanks, this is exactly what I needed.'],tools:[['test','parser regression','PASS: nested object and existing parser cases; exit code 0']],final:'The parser fix is complete; the regression and existing parser cases pass.'},
  {id:'insufficient-evidence',expected:'review',task:'Investigate an unspecified issue.',turns:['Something is wrong.'],tools:[],final:'No error, target, actions, or results are available in the supplied trace.'},
];
const fixtureHash=createHash('sha256').update(JSON.stringify(cases)).digest('hex');
if(cases.length>8) throw new Error('FIXTURE_REQUEST_LIMIT_EXCEEDED');
if(!process.argv.includes('--execute')) {
  console.log(JSON.stringify({mode:'dry-run',fixtureHash,maxRequests:8,automaticRetries:0,cases},null,2));
  process.exit(0);
}
if(process.env.MINDRAILS_ALLOW_PAID_JEV!=='I_UNDERSTAND_THIS_MAY_COST_MONEY') throw new Error('LIVE_JEV_COST_ACK_REQUIRED');
if(!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY_REQUIRED');
const rows=[];
for(const fixture of cases) {
  const input={task:fixture.task,instructions:'Evaluate the current task against the actual supplied evidence.',turns:fixture.turns.map((content,i)=>({role:i===0||(fixture.id==='verified-complete'&&i===2)?'user':'assistant',content})),toolCalls:fixture.tools.map(([name,args,result])=>({name,arguments:args,result})),finalMessage:fixture.final,telemetry:{currentModel:'unspecified-coding-model'}};
  if(Buffer.byteLength(JSON.stringify(input))>5000) throw new Error('FIXTURE_TOO_LARGE');
  const start=performance.now();
  const result=await new TraceTriage(new JevProvider(process.env.AI_GATEWAY_API_KEY,fetch,'vercel-ai-gateway'),{maxCalls:1,timeoutMs:10000}).evaluate(input);
  rows.push({id:fixture.id,expected:fixture.expected,actual:result.recoveryAdvice?.action??null,correct:result.recoveryAdvice?.action===fixture.expected,elapsedMs:Math.round(performance.now()-start),result});
  if(!result.recoveryAdvice) break;
}
console.log(JSON.stringify({
  kind:'synthetic-recovery-development-probe', recordedAt:new Date().toISOString(), fixtureHash,
  model:'typesafe-ai/jev', scheduled:cases.length, attempted:rows.length,
  correct:rows.filter(row=>row.correct).length, automaticRetries:0,
  inputTokens:rows.reduce((sum,row)=>sum+(row.result.providerUsage?.inputTokens??0),0),
  outputTokens:rows.reduce((sum,row)=>sum+(row.result.providerUsage?.outputTokens??0),0),
  unknownUsageRequests:rows.filter(row=>!row.result.providerUsage).length,
  limitations:[
    'Eight hand-authored synthetic cases do not establish real-world accuracy or savings.',
    'Initial confidence thresholds are not calibrated on user traffic.',
    'The gateway alias does not identify the native model revision.',
  ], rows,
},null,2));
