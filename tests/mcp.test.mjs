import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync } from 'node:child_process';
test('official MCP client initializes, lists and invokes all tools',async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp'],env:{MINDRAILS_PROVIDER:'mock'},stderr:'pipe'});
  let stderr=''; transport.stderr?.on('data',d=>stderr+=d);
  const client=new Client({name:'integration-test',version:'0.1.0'});
  try {
    await client.connect(transport);
    const tools=await client.listTools(); assert.deepEqual(tools.tools.map(t=>t.name).sort(),['check_completion','detect_stuck','open_codex_chats','triage_agent_run']);
    const overview=await client.callTool({name:'open_codex_chats',arguments:{}});assert.equal(overview.structuredContent.apiCallsForMonitoring,0);
    const result=await client.callTool({name:'check_completion',arguments:{task:'Document release',currentResult:'[done:docs]',requirements:[{id:'docs',description:'Docs'}],evidence:'synthetic'}});
    assert.equal(result.structuredContent.decision,'finish'); assert.equal(result.structuredContent.provider,'mock');
    const stuck=await client.callTool({name:'detect_stuck',arguments:{steps:[]}});assert.equal(stuck.structuredContent.stuck,false);
    const triage=await client.callTool({name:'triage_agent_run',arguments:{task:'Answer a question',instructions:'Use supplied context',turns:[],toolCalls:[],finalMessage:'[mock:complete] Here is the result.'}});
    assert.equal(triage.structuredContent.recommendation,'AUTO_CLOSE'); assert.equal(triage.structuredContent.synthetic,true);
    const invalid=await client.callTool({name:'check_completion',arguments:{task:'x',currentResult:'y',requirements:[]}});assert.equal(invalid.isError,true);
  } finally {await client.close();}
  assert.equal(stderr,'');
});
test('CLI demo runs with no credentials',()=>{
  const out=execFileSync(process.execPath,['dist/cli.js','demo'],{encoding:'utf8',env:{...process.env,MINDRAILS_PROVIDER:'mock',TYPESAFE_API_KEY:''}});
  assert.match(out,/SYNTHETIC MOCK DEMO/); assert.match(out,/3\/5 markers → CONTINUE/);assert.match(out,/5\/5 markers → FINISH/);
});
test('CLI and MCP require explicit provider outside demo',()=>{
  assert.throws(()=>execFileSync(process.execPath,['dist/cli.js','check','examples/check.json'],{stdio:'pipe',env:{...process.env,MINDRAILS_PROVIDER:''}}),error=>{
    assert.match(error.stderr.toString(),/MINDRAILS_PROVIDER_REQUIRED/);return true;
  });
});
test('realistic MCP scenario runner passes',()=>{
  const out=execFileSync(process.execPath,['examples/mcp-e2e.mjs'],{encoding:'utf8'});
  const report=JSON.parse(out);assert.equal(report.transport,'official-mcp-client-stdio');assert.equal(report.passed,12);assert.equal(report.failed,0);
});
test('live Jev suite is dry-run by default with frozen bounded fixtures',()=>{
  const report=JSON.parse(execFileSync(process.execPath,['evidence/jev-live-suite.mjs'],{encoding:'utf8'}));
  assert.equal(report.mode,'dry-run');assert.equal(report.cases.length,12);assert.equal(report.maxRequests,12);
  assert.equal(report.fixtureHash,'1dfa67a890aa42d4c5fb904fbcd8889e9fdcda5c919f77902acaea2c0d651eb0');
  assert.ok(report.conservativeHardMaximumUsd<0.1);
});
test('held-out Jev suite is frozen and dry-run by default',()=>{
  const report=JSON.parse(execFileSync(process.execPath,['evidence/jev-heldout-suite.mjs'],{encoding:'utf8'}));
  assert.equal(report.mode,'dry-run'); assert.equal(report.cases.length,8); assert.equal(report.maxRequests,8);
  assert.equal(report.fixtureHash,'6ffef656ca2c9a11b66d23a4326782c1b889bc61053f6ba5ffbb26ae09e01178'); assert.ok(report.conservativeHardMaximumUsd<0.05);
});
