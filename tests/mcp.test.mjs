import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync } from 'node:child_process';
test('official MCP client initializes, lists and invokes both tools',async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp'],env:{MINDRAILS_PROVIDER:'mock'},stderr:'pipe'});
  let stderr=''; transport.stderr?.on('data',d=>stderr+=d);
  const client=new Client({name:'integration-test',version:'0.1.0'});
  try {
    await client.connect(transport);
    const tools=await client.listTools(); assert.deepEqual(tools.tools.map(t=>t.name).sort(),['check_completion','detect_stuck']);
    const result=await client.callTool({name:'check_completion',arguments:{task:'Document release',currentResult:'[done:docs]',requirements:[{id:'docs',description:'Docs'}],evidence:'synthetic'}});
    assert.equal(result.structuredContent.decision,'finish'); assert.equal(result.structuredContent.provider,'mock');
    const stuck=await client.callTool({name:'detect_stuck',arguments:{steps:[]}});assert.equal(stuck.structuredContent.stuck,false);
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
  const report=JSON.parse(out);assert.equal(report.transport,'official-mcp-client-stdio');assert.equal(report.passed,10);assert.equal(report.failed,0);
});
test('live Jev suite is dry-run by default with frozen bounded fixtures',()=>{
  const report=JSON.parse(execFileSync(process.execPath,['evidence/jev-live-suite.mjs'],{encoding:'utf8'}));
  assert.equal(report.mode,'dry-run');assert.equal(report.cases.length,12);assert.equal(report.maxRequests,12);
  assert.equal(report.fixtureHash,'11511c299e8b43a3c53fa9b2efaa6eb3dd6d227e68106feb476760146c146f2d');
  assert.ok(report.conservativeHardMaximumUsd<0.1);
});
