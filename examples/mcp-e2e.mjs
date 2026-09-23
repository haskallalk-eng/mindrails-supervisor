import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp'],env:{MINDRAILS_PROVIDER:'mock',MINDRAILS_MAX_CALLS:'2'},stderr:'pipe'});
const client=new Client({name:'mindrails-e2e-scenarios',version:'0.2.0'});
const scenarios=[];
async function run(name,expected,call){
  try {const actual=await call();assert.deepEqual(actual,expected);scenarios.push({name,expected,actual,pass:true});}
  catch(error){scenarios.push({name,expected,actual:error.message,pass:false});}
}
const requirement={id:'tested',description:'A test result is supplied'};
try {
  await client.connect(transport);
  await run('tool discovery',['check_completion','detect_stuck'],async()=>(await client.listTools()).tools.map(t=>t.name).sort());
  await run('premature completion','continue',async()=>(await client.callTool({name:'check_completion',arguments:{task:'Ship tested code',currentResult:'Done',requirements:[requirement],evidence:'Synthetic fixture'}})).structuredContent.decision);
  await run('missing evidence veto without provider call','continue',async()=>(await client.callTool({name:'check_completion',arguments:{task:'Ship tested code',currentResult:'[done:tested]',requirements:[requirement]}})).structuredContent.decision);
  await run('declared failed check','review',async()=>(await client.callTool({name:'check_completion',arguments:{task:'Ship tested code',currentResult:'[done:tested]',requirements:[requirement],evidence:'Synthetic fixture',trustedChecks:[{id:'tests',status:'fail'}]}})).structuredContent.decision);
  await run('complete synthetic fixture','finish',async()=>(await client.callTool({name:'check_completion',arguments:{task:'Ship tested code',currentResult:'[done:tested]',requirements:[requirement],evidence:'Synthetic fixture'}})).structuredContent.decision);
  await run('process call budget exhausted','review',async()=>(await client.callTool({name:'check_completion',arguments:{task:'Ship tested code',currentResult:'[done:tested]',requirements:[requirement],evidence:'Synthetic fixture'}})).structuredContent.decision);
  const a={action:'inspect',input:'a',result:'unchanged',progress:false},b={...a,input:'b'};
  await run('alternating loop','review',async()=>(await client.callTool({name:'detect_stuck',arguments:{steps:[a,b,a,b,a,b]}})).structuredContent.decision);
  await run('bounded repeat grace','continue',async()=>(await client.callTool({name:'detect_stuck',arguments:{steps:[a,a,a],allowedExtraRepetitions:2}})).structuredContent.decision);
  await run('repeat grace exhaustion','review',async()=>(await client.callTool({name:'detect_stuck',arguments:{steps:[a,a,a,a,a],allowedExtraRepetitions:2}})).structuredContent.decision);
  await run('invalid completion input',true,async()=>(await client.callTool({name:'check_completion',arguments:{task:'x',currentResult:'y',requirements:[]}})).isError===true);
} finally {await client.close();}
const failed=scenarios.filter(s=>!s.pass).length;
console.log(JSON.stringify({kind:'implementation-evidence',transport:'official-mcp-client-stdio',provider:'synthetic-markers-v1',semanticModelEffect:'not_run',passed:scenarios.length-failed,failed,scenarios},null,2));
if(failed) process.exitCode=1;
