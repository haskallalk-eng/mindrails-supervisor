import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { modelSchema, type RoutingModel } from './model-router.js';

export async function readCodexRoutingState(binary: string, threadId?: string): Promise<{models: RoutingModel[]; context?: unknown; currentModel?: string}> {
  const child=spawn(binary,['app-server','--stdio'],{stdio:['pipe','pipe','ignore'],windowsHide:true});
  let id=0;
  const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  const fail=()=>{for(const p of pending.values())p.reject(new Error('CODEX_CATALOG_UNAVAILABLE'));pending.clear();};
  child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{const msg=JSON.parse(line);const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(new Error('CODEX_RPC_FAILED')):p.resolve(msg.result);}}catch{fail();}});
  const call=(method:string,params:object)=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});
  const timer=setTimeout(()=>{fail();child.kill();},20000);
  try {
    await call('initialize',{clientInfo:{name:'jev_router',version:'0.1.0'}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const models:RoutingModel[]=[];let cursor:string|null=null;let pages=0;
    do {
      const page=await call('model/list',{includeHidden:false,limit:100,...(cursor?{cursor}:{})});
      for(const entry of page.data) { if(entry.hidden)continue; const parsed=modelSchema.safeParse(entry);if(parsed.success)models.push(parsed.data); }
      cursor=page.nextCursor;
      if(++pages>10)throw new Error('INVALID_MODEL_CATALOG');
    } while(cursor);
    if(!models.length)throw new Error('NO_GPT6_MODELS_AVAILABLE');
    if(!threadId)return {models};
    const {thread}=await call('thread/read',{threadId,includeTurns:true});
    if(thread.status?.type==='active' || thread.turns?.some((t:any)=>t.status==='inProgress')) throw new Error('THREAD_ALREADY_RUNNING');
    // Only visible history; internal reasoning is never forwarded to Jev.
    const context=(thread.turns??[]).map((t:any)=>({status:t.status,items:(t.items??[]).filter((i:any)=>['userMessage','agentMessage','commandExecution','fileChange','mcpToolCall'].includes(i.type))}));
    return {models,context};
  } finally {clearTimeout(timer);lines.close();child.kill();}
}
