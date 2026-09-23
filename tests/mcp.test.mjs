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
