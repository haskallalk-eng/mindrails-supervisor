#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { readCodexRoutingState } from './codex-catalog.js';
import { routeModel, type RoutingModel } from './model-router.js';
import { describeContext } from './routing-context.js';
import { resolveCodexBinary } from './codex-app-server.js';

export function gatewayKey():string|undefined {
  if(process.env.AI_GATEWAY_API_KEY)return process.env.AI_GATEWAY_API_KEY;
  if(process.platform==='win32'&&!process.env.JEV_NO_USER_KEY)try {
    // Only the explicitly configured gateway key; never enumerate other credentials.
    return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Environment]::GetEnvironmentVariable('AI_GATEWAY_API_KEY','User')"],{encoding:'utf8',timeout:3000,windowsHide:true,stdio:['ignore','pipe','ignore']}).trim()||undefined;
  }catch{}
  return undefined;
}

export function executionArgs(model: RoutingModel, options: {threadId?:string;write?:boolean;ephemeral?:boolean}): string[] {
  return ['-a','never','-s',options.write?'workspace-write':'read-only','exec',...(options.threadId?['resume',options.threadId]:[]),
    '--model',model.model,'-c',`model_reasoning_effort="${model.defaultReasoningEffort}"`,'--json',...(options.ephemeral?['--ephemeral']:[]),'-'];
}

async function execute(binary:string,args:string[],task:string):Promise<{threadId?:string;ok:boolean}> {
  return new Promise((resolve,reject)=>{
    // stdin carries the unchanged task, never a shell command or an argument.
    const child=spawn(binary,args,{stdio:['pipe','pipe','inherit'],windowsHide:true,env:{...process.env,RUST_LOG:process.env.RUST_LOG??'error',MINDRAILS_JEV_AUTO_REVIEW:'0'}});
    let threadId:string|undefined;let failed=false;
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{try{const event=JSON.parse(line);
      if(event.type==='thread.started')threadId=event.thread_id;
      if(event.type==='item.completed'&&event.item?.type==='agent_message')console.log(event.item.text);
      if(event.type==='turn.failed'||event.type==='error'){failed=true;console.error('Codex meldet einen Fehler:',event.error?.message??event.message??'Ausführung fehlgeschlagen');}
    }catch{console.error('Nicht lesbares Codex-Ereignis.');failed=true;}});
    const interrupt=()=>child.kill();process.once('SIGINT',interrupt);
    child.on('error',reject);child.stdin.on('error',()=>{failed=true;});
    child.on('close',code=>{process.removeListener('SIGINT',interrupt);lines.close();resolve({threadId,ok:code===0&&!failed});});
    child.stdin.end(task);
  });
}

async function main() {
  const args=process.argv.slice(2);
  if(args.includes('--help')){console.log('Jev – GPT-6-Auswahl vor jeder Aufgabe\njev [--workspace-write] [--resume UUID] [--ephemeral] ["Aufgabe"]\nOhne Aufgabe: interaktiver Chat. Standard: nur lesen. --workspace-write erlaubt Projektänderungen; keine zusätzlichen Freigaben.\nJev sendet Aufgabe und sichtbaren Verlauf an Vercel/TypeSafe; kann kosten. Codex nutzt deine bestehende Anmeldung.\nEigener lokaler Startweg, keine automatische Umschaltung im Codex-Chatfenster. Seitenfeld: jev-panel --help.');return;}
  const resumeAt=args.indexOf('--resume');let threadId:string|undefined;
  if(resumeAt>=0){threadId=args[resumeAt+1];if(!threadId||!/^[-a-f0-9]{36}$/i.test(threadId))throw new Error('INVALID_THREAD_ID');args.splice(resumeAt,2);}
  const write=args.includes('--workspace-write'),ephemeral=args.includes('--ephemeral');
  const rest=args.filter(a=>!['--workspace-write','--ephemeral'].includes(a));
  if(rest.length>1||rest.some(a=>a.startsWith('--'))||ephemeral&&threadId)throw new Error('INVALID_ARGUMENTS');
  const binary=resolveCodexBinary();
  const key=gatewayKey();
  let currentModel:string|undefined;
  const run=async(task:string)=>{
    const state=await readCodexRoutingState(binary,threadId);
    const baseline=state.models.find(m=>m.model===(currentModel??state.currentModel))??state.models.find(m=>m.isDefault)??state.models[0]!;
    if(state.contextStats)console.error(`Kontext: ${describeContext(state.contextStats)}`);
    const decision=await routeModel({task,context:state.context,models:state.models,baseline:baseline.model,key});
    console.error(decision.source==='jev'
      ? `Jev: ${Object.entries(decision.probabilities!).map(([m,p])=>`${m.replace('gpt-6-','')} ${(p*100).toFixed(1)} %`).join(' · ')} → ${decision.model}`
      : `Jev nicht verfügbar (${decision.reason}); Basis bleibt ${decision.model}.`);
    const selected=state.models.find(m=>m.model===decision.model)!;
    const result=await execute(binary,executionArgs(selected,{threadId,write,ephemeral}),task);
    currentModel=decision.model;
    if(!ephemeral)threadId=result.threadId??threadId;
    if(threadId)console.error(`Fortsetzen: jev --resume ${threadId}${write?' --workspace-write':''}`);
    if(!result.ok)process.exitCode=1;
  };
  if(rest[0]){await run(rest[0]);return;}
  if(!process.stdin.isTTY){let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>1_000_000)throw new Error('TASK_TOO_LARGE');}if(!input.trim())throw new Error('EMPTY_TASK');await run(input);return;}
  console.log('Jev bereit. Jede Aufgabe wird vor dem Start geroutet. /exit beendet.');
  const prompt=createPrompt({input:process.stdin,output:process.stdout});
  try {while(true){const task=await prompt.question('\nDu: ');if(task.trim()==='/exit')break;if(task.trim())await run(task);}}finally{prompt.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)main().catch(()=>{console.error('Jev konnte die Aufgabe nicht starten. Prüfe Codex-Anmeldung, Modellzugriff und Argumente. Es wurde kein automatischer Neuversuch gestartet.');process.exitCode=1;});
