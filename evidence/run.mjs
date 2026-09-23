import { readFileSync } from 'node:fs';
import { Supervisor, detectStuck } from '../dist/core.js';

const step=(action='build',result='same error',progress=false)=>({action,input:'same task',result,progress});
const a=step(),b=step('search','same advice'),c=step('edit','same patch'),d=step('test','same failure');
// Labels and cases were fixed in the independent v0.1 review before v0.2 results were read.
const traceCases=[
  {id:'unchanged-build-error',label:true,steps:[a,a,a]},
  {id:'retry-search-cycle',label:true,steps:[a,b,a,b,a,b]},
  {id:'edit-test-search-cycle',label:true,steps:[a,b,c,a,b,c,a,b,c]},
  {id:'four-stage-cycle-outside-scope',label:true,steps:[a,b,c,d,a,b,c,d,a,b,c,d]},
  {id:'same-error-with-timestamps',label:true,steps:[step('build','12:00 error E1'),step('build','12:01 error E1'),step('build','12:02 error E1')]},
  {id:'legitimate-running-job-poll',label:false,steps:[step('poll','running'),step('poll','running'),step('poll','running')]},
  {id:'scheduled-health-observations',label:false,steps:[step('health','healthy'),step('health','healthy'),step('health','healthy')]},
  {id:'result-change',label:false,steps:[a,a,step('build','different result')]},
  {id:'reported-progress',label:false,steps:[a,a,{...a,progress:true}]},
  {id:'two-errors-allow-retry',label:false,steps:[a,a]},
  {id:'empty-trace',label:false,steps:[]},
  {id:'distinct-useful-steps',label:false,steps:[a,b,c]},
];
const traceRows=traceCases.map(x=>{
  const output=detectStuck({steps:x.steps});
  return {id:x.id,labelRequiresIntervention:x.label,decision:output.decision,cycleLength:output.cycleLength,detected:output.stuck};
});
function confusion(rows){return rows.reduce((r,x)=>{const key=x.detected?(x.labelRequiresIntervention?'truePositive':'falsePositive'):(x.labelRequiresIntervention?'falseNegative':'trueNegative');r[key]++;return r;},{truePositive:0,falsePositive:0,falseNegative:0,trueNegative:0});}

const high={requirements:{a:.99,b:.99},taskSatisfied:.99,evidenceSufficient:.99,contradictions:.01};
const policyCases=[
  {id:'complete',expected:'finish',signals:high,checks:[{id:'tests',status:'pass'}]},
  {id:'one-missing-requirement',expected:'continue',signals:{...high,requirements:{a:.99,b:.5}}},
  {id:'weak-evidence',expected:'continue',signals:{...high,evidenceSufficient:.5}},
  {id:'contradiction',expected:'continue',signals:{...high,contradictions:.8}},
  {id:'failed-host-check',expected:'review',signals:high,checks:[{id:'tests',status:'fail'}]},
  {id:'unknown-host-check',expected:'review',signals:high,checks:[{id:'tests',status:'unknown'}]},
];
const policyRows=[];
for(const fixture of policyCases){
  const provider={mode:'mock',evaluate:async()=>fixture.signals};
  const input={task:'Prepare a verified release',currentResult:'Candidate result',requirements:[{id:'a',description:'Document use'},{id:'b',description:'Pass checks'}],evidence:'Predeclared policy fixture',...(fixture.checks?{trustedChecks:fixture.checks}:{})};
  const actual=(await new Supervisor(provider).check(input)).decision;
  const selfReport='finish';
  const hostChecks=fixture.checks?.some(x=>x.status!=='pass')?'review':'finish';
  policyRows.push({id:fixture.id,expected:fixture.expected,selfReport,hostChecks,supervisor:actual});
}
const accuracy=key=>policyRows.filter(row=>row[key]===row.expected).length;
const liveGateway=JSON.parse(readFileSync(new URL('./results/jev-live-vercel-2026-09-23.json',import.meta.url),'utf8'));
const report={
  generatedAt:new Date().toISOString(),
  scope:'Reproducible implementation and deterministic-policy evidence. Hand-labeled fixtures; not real traffic, Jev accuracy, calibration, latency, cost savings, or business impact.',
  traceDetection:{beforeV010:{truePositive:1,falsePositive:2,falseNegative:4,trueNegative:5},candidateDefault:confusion(traceRows),configuredGraceExamples:[
    {id:'poll-three-with-two-cycle-grace',decision:detectStuck({steps:[step('poll','running'),step('poll','running'),step('poll','running')],allowedExtraRepetitions:2}).decision},
    {id:'poll-five-exhausts-two-cycle-grace',decision:detectStuck({steps:Array(5).fill(step('poll','running')),allowedExtraRepetitions:2}).decision},
  ],rows:traceRows,limits:['The before/after confusion matrices use the same unchanged inputs; default v0.2 still flags identical polling and health traces.','Cycles longer than three steps remain outside scope.','Timestamp or otherwise changing result strings are not normalized.','Repeat allowance is a separate caller-declared grace of at most two extra cycles; it does not prove polling is legitimate.']},
  completionPolicy:{baselines:{selfReport:'Always accept the agent completion claim.',hostChecks:'Review declared fail/unknown checks; otherwise finish. No semantic signals.'},correctOfSix:{selfReport:accuracy('selfReport'),hostChecks:accuracy('hostChecks'),supervisor:accuracy('supervisor')},rows:policyRows,limits:['Signals are fixed fixtures, not Jev outputs. This isolates policy composition only.','Host check statuses and evidence remain caller supplied and unauthenticated.']},
  semanticModelEffect:{status:'run_once',nativeTypeSafeStatus:'not_run_registration_unavailable',route:liveGateway.route,model:liveGateway.model,fixtureHash:liveGateway.fixtureHash,report:'evidence/results/jev-live-vercel-2026-09-23.json',requests:liveGateway.requests,correctOfTwelve:liveGateway.outcomes.correct,alwaysContinueCorrectOfTwelve:liveGateway.rows.filter(row=>row.expected==='continue').length,allDecisionsContinue:liveGateway.rows.every(row=>row.actual==='continue'),falseFinish:liveGateway.outcomes.falseFinish,falseContinue:liveGateway.outcomes.falseContinue,providerErrors:liveGateway.outcomes.providerErrors,inputTokens:liveGateway.inputTokens,estimatedKnownInputCostUsd:liveGateway.estimatedKnownInputCostUsd,limits:['One frozen synthetic suite is not calibration or production accuracy evidence.','The gateway alias does not establish the native Jev version.','All decisions were continue, so the observed score equals an always-continue baseline and this configuration is not recommended as an automated stop gate.']},
};
console.log(JSON.stringify(report,null,2));
