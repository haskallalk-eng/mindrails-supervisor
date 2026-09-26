// Side-panel UI served by `jev-panel`. Self-contained: no external scripts or fonts.
export const PANEL_HTML = String.raw`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev Seitenfeld</title>
<style>
:root{--bg:#fbfbfa;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#3a5bd9;--accent-soft:#e8edfc;--ok:#1f7a4a;--warn:#9a6200;--err:#b3261e;--code:#f3f2ee}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1f1f1d;--text:#ecebe6;--muted:#9c9b95;--line:#33322f;--accent:#8ea4ff;--accent-soft:#252c47;--ok:#5fc48c;--warn:#e0a73a;--err:#ff8a80;--code:#2a2926}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
header{padding:10px 14px;border-bottom:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;gap:6px}
.row{display:flex;gap:8px;align-items:center}.grow{flex:1;min-width:0}
h1{font-size:15px;margin:0;font-weight:650}.title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font-size:12.5px}
.pill{font-size:12px;padding:2px 9px;border-radius:99px;background:var(--code);color:var(--muted);white-space:nowrap}
.pill.run{background:var(--accent-soft);color:var(--accent)}.pill.err{color:var(--err)}.pill.warn{color:var(--warn)}
select,button,textarea,input{font:inherit;color:inherit}
select{max-width:100%;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font-size:12.5px}
button{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover:not(:disabled){border-color:var(--accent)}button:disabled{opacity:.45;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
main{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.msg{white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.user{align-self:flex-end;max-width:88%;background:var(--accent-soft);padding:7px 11px;border-radius:12px 12px 3px 12px}
.agent{padding:2px 0}.hist{opacity:.62}.hist-label{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card{border:1px solid var(--line);background:var(--panel);border-radius:9px;padding:9px 11px;font-size:13px}
.card .head{font-weight:600;margin-bottom:6px}
.bar{display:grid;grid-template-columns:52px 1fr 48px;gap:8px;align-items:center;margin:3px 0;font-variant-numeric:tabular-nums}
.bar .track{height:7px;background:var(--code);border-radius:4px;overflow:hidden}.bar .fill{height:100%;background:var(--muted)}
.bar.win{font-weight:650}.bar.win .fill{background:var(--accent)}.bar span:last-child{text-align:right}
.note{font-size:12px;color:var(--muted);margin-top:6px}
.sys{font-size:12.5px;color:var(--muted)}.sys.err{color:var(--err)}.sys.warn{color:var(--warn)}.sys.ok{color:var(--ok)}
details{font-size:12.5px;color:var(--muted)}code,pre{font-family:ui-monospace,Consolas,monospace;font-size:12px}
pre{background:var(--code);padding:6px 8px;border-radius:6px;overflow-x:auto;margin:4px 0;white-space:pre-wrap}
footer{border-top:1px solid var(--line);background:var(--panel);padding:10px 14px}
textarea{width:100%;min-height:64px;max-height:40vh;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--bg)}
textarea:focus{outline:2px solid var(--accent-soft);border-color:var(--accent)}
.hint{font-size:11.5px;color:var(--muted)}
.tabs{display:flex;gap:4px}.tab{border:none;background:none;padding:3px 10px;border-radius:99px;color:var(--muted)}.tab.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
.view{display:flex;flex-direction:column;flex:1;min-height:0}.view[hidden]{display:none}
#ask main{gap:12px}.field{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted)}
.field select,.field input{width:100%;padding:6px 8px;font-size:13.5px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text)}
.yes{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
</style></head><body>
<header>
  <div class="row"><h1>Jev</h1><div class="tabs"><button class="tab on" id="tabRun">Ausführen</button><button class="tab" id="tabAsk">Fragen</button></div><div class="grow"></div><span class="pill" id="status">verbinde …</span></div>
  <div class="row runOnly"><div class="grow title" id="title">–</div></div>
  <div class="row runOnly"><select id="threads" class="grow" aria-label="Gespräch"></select><button id="fork" hidden title="Verlauf in ein neues Gespräch kopieren und dort fortsetzen">Abzweig</button></div>
</header>
<div class="view" id="run"><main id="log" aria-live="polite"></main>
<footer>
  <textarea id="input" placeholder="Nachricht an Codex – Jev wählt vorher das Modell" aria-label="Nachricht"></textarea>
  <div class="row" style="margin-top:6px"><span class="hint grow" id="hint">Enter sendet · Umschalt+Enter neue Zeile</span><button id="stop" hidden>Stopp</button><button id="send" class="primary">Senden</button></div>
</footer></div>
<div class="view" id="ask" hidden><main>
  <div class="sys">Jev liest den gewählten Chat und bewertet ihn. Jev schreibt keinen Freitext: Er beantwortet feste Fragen (Fortschritt, Hindernis, nächster Schritt) und deine Ja/Nein-Frage mit Wahrscheinlichkeiten. Es wird nichts ausgeführt.</div>
  <label class="field">Chat<select id="source"></select></label>
  <label class="field">Deine Ja/Nein-Frage (optional)<input id="question" maxlength="500" placeholder="z. B. Sind die Tests am Ende grün?"></label>
  <div class="row"><span class="hint grow">Ein Jev-Aufruf pro Klick, kann Kosten verursachen.</span><button id="askBtn" class="primary">Jev fragen</button></div>
  <div id="answer" style="display:flex;flex-direction:column;gap:10px"></div>
</main></div>
<script>
const token=new URLSearchParams(location.search).get('t')||'';
const $=id=>document.getElementById(id);
const log=$('log'),input=$('input'),send=$('send'),stop=$('stop'),statusEl=$('status'),threads=$('threads'),forkBtn=$('fork');
let busy=false,lastSeq=0,streaming=null,lastSent='',threadId=null;
const api=(path,body)=>fetch(path,{method:body?'POST':'GET',headers:{'x-jev-token':token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||r.status),{status:r.status});return j;});
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
const add=node=>{const near=log.scrollHeight-log.scrollTop-log.clientHeight<80;log.appendChild(node);if(near)log.scrollTop=log.scrollHeight;return node;};
const sys=(text,cls='')=>add(el('div','sys '+cls,text));
const tier=m=>(m||'').replace('gpt-6-','').replace(/^./,c=>c.toUpperCase());
function setStatus(text,cls=''){statusEl.textContent=text;statusEl.className='pill '+cls;}
function setBusy(b){busy=b;send.disabled=b;input.disabled=false;stop.hidden=!b;if(!b)setStatus('Bereit');}
function renderText(node,text){node.textContent='';const parts=text.split(/\x60\x60\x60[^\n]*\n?/);parts.forEach((p,i)=>{if(!p)return;node.appendChild(i%2?el('pre',null,p):document.createTextNode(p));});}
function decisionCard(e){
  const c=el('div','card');
  if(e.source==='jev'&&e.probabilities){
    c.appendChild(el('div','head','Jev → '+tier(e.model)));
    for(const [m,p] of Object.entries(e.probabilities).sort((a,b)=>b[1]-a[1])){
      const r=el('div','bar'+(m===e.model?' win':''));r.appendChild(el('span',null,tier(m)));
      const t=el('div','track'),f=el('div','fill');f.style.width=(p*100).toFixed(1)+'%';t.appendChild(f);r.appendChild(t);
      r.appendChild(el('span',null,(p*100).toFixed(1)+' %'));c.appendChild(r);
    }
    c.appendChild(el('div','note','Gestartet mit '+e.model+' · Reasoning '+e.effort+' · höchste Wahrscheinlichkeit gewinnt. Relative Eignung laut Jev, keine gemessene Erfolgsquote.'));
  } else {
    c.appendChild(el('div','head','Jev nicht verfügbar → Basismodell '+tier(e.model)));
    c.appendChild(el('div','note','Grund: '+(e.reason||'unbekannt')+'. Keine Wahrscheinlichkeiten erfunden, kein Neuversuch. Gestartet mit '+e.model+' · Reasoning '+e.effort+'.'));
  }
  return c;
}
function handle(e){
  if(e.seq){if(e.seq<=lastSeq)return;lastSeq=e.seq;}
  switch(e.type){
    case 'history':{log.textContent='';if(e.turns.length){add(el('div','hist-label',e.turns.length<e.total?'Bisheriger Verlauf – letzte '+e.turns.length+' von '+e.total+' Turns':'Bisheriger Verlauf'));for(const t of e.turns){if(t.user)add(el('div','msg user hist',t.user));if(t.agent){const a=add(el('div','msg agent hist'));renderText(a,t.agent);}else if(t.status&&t.status!=='completed')add(el('div','sys hist',t.status==='failed'?'(fehlgeschlagen, keine Antwort)':'('+t.status+')'));}}else add(el('div','hist-label','Noch kein Verlauf'));break;}
    case 'user':add(el('div','msg user',e.text));break;
    case 'phase':setStatus(e.message,'run');break;
    case 'context':sys('Kontext für Jev: '+e.description);break;
    case 'decision':add(decisionCard(e));break;
    case 'thread':threadId=e.threadId;if(e.title)$('title').textContent=e.title;if(e.created){sys(e.forkedFrom?'Abzweig erstellt: '+e.threadId+' (Kopie des Verlaufs von '+e.forkedFrom+'). Weitere Nachrichten gehen dorthin.':'Neues Gespräch '+e.threadId+' angelegt.','ok');loadThreads();}break;
    case 'delta':if(!streaming||streaming.dataset.id!==e.itemId){streaming=add(el('div','msg agent'));streaming.dataset.id=e.itemId;streaming.dataset.raw='';}streaming.dataset.raw+=e.text;renderText(streaming,streaming.dataset.raw);log.scrollTop=log.scrollHeight;break;
    case 'agent':{let n=[...log.querySelectorAll('.agent')].find(x=>x.dataset.id===e.itemId);if(!n){n=add(el('div','msg agent'));n.dataset.id=e.itemId;}renderText(n,e.text);streaming=null;break;}
    case 'command':{const d=add(el('details'));d.appendChild(el('summary',null,(e.exitCode===0?'✓ ':'✗ ')+'Befehl'+(e.exitCode!=null?' (Exit '+e.exitCode+')':' ('+e.status+')')));d.appendChild(el('pre',null,e.command));break;}
    case 'files':sys('Dateien geändert: '+e.paths.join(', '));break;
    case 'tool':sys('Werkzeug: '+e.name+' ('+e.status+')');break;
    case 'approval':{const c=add(el('div','card'));c.appendChild(el('div','head',e.kind==='command'?'Codex bittet um Freigabe für einen Befehl':'Codex bittet um Freigabe für Dateiänderungen'));if(e.command)c.appendChild(el('pre',null,String(e.command)));if(e.reason)c.appendChild(el('div','note',e.reason));if(e.grantRoot)c.appendChild(el('div','note','Schreibzugriff unter: '+e.grantRoot));const r=el('div','row');r.style.marginTop='6px';const ok=el('button','primary','Einmal erlauben'),no=el('button',null,'Ablehnen');r.append(ok,no);c.appendChild(r);c.dataset.req=e.requestId;const decide=d=>{ok.disabled=no.disabled=true;api('/api/approval',{requestId:e.requestId,decision:d}).catch(()=>{});};ok.onclick=()=>decide('accept');no.onclick=()=>decide('decline');setStatus('wartet auf Freigabe','warn');break;}
    case 'approvalResolved':{const c=[...log.querySelectorAll('.card')].find(x=>x.dataset.req===e.requestId);if(c){c.querySelectorAll('button').forEach(b=>b.disabled=true);c.appendChild(el('div','note',e.decision==='accept'?'Erlaubt.':'Abgelehnt.'));}break;}
    case 'turn':sys(e.status==='completed'?'Fertig · '+tier(e.model)+(e.durationMs?' · '+(e.durationMs/1000).toFixed(0)+' s':''):({failed:'Fehlgeschlagen',interrupted:'Abgebrochen'}[e.status]||e.status)+(e.error?': '+e.error:'')+' · kein automatischer Neuversuch',e.status==='completed'?'ok':'err');break;
    case 'blocked':sys(e.message,'warn');setStatus('blockiert','warn');if(e.reason==='CODEX_WRITER_ACTIVE')forkBtn.hidden=false;if(!input.value)input.value=lastSent;break;
    case 'error':sys(e.message,'err');setStatus('Fehler','err');break;
    case 'notice':sys(e.message,'warn');break;
    case 'busy':setBusy(true);break;
    case 'idle':setBusy(false);break;
  }
}
async function loadThreads(){
  try{const s=await api('/api/threads');threads.textContent='';
    const neu=el('option',null,'＋ Neues Gespräch');neu.value='';threads.appendChild(neu);
    let found=false;for(const t of s.threads){const o=el('option',null,(t.name||t.preview||t.id).slice(0,70));o.value=t.id;if(t.id===s.current){o.selected=true;found=true;}threads.appendChild(o);}
    if(s.current&&!found){const o=el('option',null,s.current);o.value=s.current;o.selected=true;threads.appendChild(o);}
    if(!s.current)neu.selected=true;
  }catch(e){sys('Gesprächsliste nicht lesbar: '+e.message,'err');}
}
threads.onchange=async()=>{if(busy){sys('Während einer Ausführung nicht wechselbar.','warn');await loadThreads();return;}forkBtn.hidden=true;try{await api('/api/thread',{threadId:threads.value||null});}catch(e){sys('Wechsel fehlgeschlagen: '+e.message,'err');}};
forkBtn.onclick=async()=>{if(!confirm('Der sichtbare Verlauf wird in ein NEUES Gespräch kopiert; das Original bleibt unverändert und erhält diese Nachrichten nicht. Fortfahren?'))return;forkBtn.disabled=true;try{await api('/api/fork',{});forkBtn.hidden=true;}catch(e){sys('Abzweig fehlgeschlagen: '+e.message,'err');}forkBtn.disabled=false;};
async function submit(){
  const text=input.value;if(!text.trim()||busy)return;
  setBusy(true);lastSent=text;input.value='';forkBtn.hidden=true;
  try{await api('/api/send',{text,clientMessageId:crypto.randomUUID()});}
  catch(e){setBusy(false);input.value=text;sys(e.status===409?'Es läuft bereits eine Ausführung in diesem Gespräch – nicht erneut gesendet.':'Senden fehlgeschlagen: '+e.message,'err');}
}
send.onclick=submit;stop.onclick=()=>api('/api/stop',{}).catch(()=>{});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();submit();}});
function connect(){
  const es=new EventSource('/api/events?t='+encodeURIComponent(token)+'&after='+lastSeq);
  es.onmessage=m=>{try{handle(JSON.parse(m.data));}catch{}};
  es.onerror=()=>{setStatus('Verbindung getrennt','err');es.close();setTimeout(connect,2000);};
}
let labels=null;
function showView(ask){$('run').hidden=ask;$('ask').hidden=!ask;$('tabRun').classList.toggle('on',!ask);$('tabAsk').classList.toggle('on',ask);document.querySelectorAll('.runOnly').forEach(n=>n.hidden=ask);if(ask&&!$('source').options.length)loadSources();try{localStorage.setItem('jevTab',ask?'ask':'run')}catch{}}
$('tabRun').onclick=()=>showView(false);$('tabAsk').onclick=()=>showView(true);
async function loadSources(){const sel=$('source');sel.textContent='';sel.appendChild(el('option',null,'lade …'));
  try{const s=await api('/api/sources');labels=s.labels;sel.textContent='';
    for(const [name,list] of [['Claude Code',s.claude],['Codex',s.codex]]){const g=document.createElement('optgroup');g.label=name;for(const c of list){const o=el('option',null,c.title.slice(0,70)+' · '+new Date(c.updatedAt).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}));o.value=c.kind+':'+c.id;g.appendChild(o);}sel.appendChild(g);}
  }catch(e){sel.textContent='';sel.appendChild(el('option',null,'Chats nicht lesbar: '+e.message));}}
function judgmentCard(title,j,map){const c=el('div','card');c.appendChild(el('div','head',title+': '+(map[j.choice]||j.choice)));
  for(const [k,p] of Object.entries(j.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,3)){const r=el('div','bar'+(k===j.choice?' win':''));r.style.gridTemplateColumns='150px 1fr 48px';r.appendChild(el('span',null,map[k]||k));const t=el('div','track'),f=el('div','fill');f.style.width=(p*100).toFixed(1)+'%';t.appendChild(f);r.appendChild(t);r.appendChild(el('span',null,(p*100).toFixed(0)+' %'));c.appendChild(r);}
  return c;}
$('askBtn').onclick=async()=>{const v=$('source').value;if(!v||!v.includes(':'))return;const [kind,id]=v.split(':');const out=$('answer');out.textContent='';const btn=$('askBtn');btn.disabled=true;setStatus('Jev liest den Chat …','run');
  try{const r=await api('/api/inspect',{kind,id,question:$('question').value||null});
    if(r.description)out.appendChild(el('div','sys','Gelesen: '+r.description));
    if(!r.ok){out.appendChild(el('div','sys err','Jev konnte nicht antworten ('+r.reason+'). Keine Werte erfunden, kein Neuversuch.'));}
    else{if(r.question){const c=el('div','card');c.appendChild(el('div','head','„'+r.question.text+'“'));c.appendChild(el('div','yes',(r.question.yes*100).toFixed(0)+' % ja'));c.appendChild(el('div','note',r.question.yes>0.65?'Jev hält „ja“ für wahrscheinlich.':r.question.yes<0.35?'Jev hält „nein“ für wahrscheinlich.':'Jev ist unsicher – der Chat zeigt es nicht eindeutig.'));out.appendChild(c);}
      out.appendChild(judgmentCard('Fortschritt',r.progress,labels.progress));out.appendChild(judgmentCard('Hindernis',r.blocker,labels.blocker));out.appendChild(judgmentCard('Nächster Schritt',r.next_step,labels.next_step));
      out.appendChild(el('div','note','Jev-Einschätzungen sind Wahrscheinlichkeiten, keine geprüften Fakten. Verbrauch: '+r.usage.input_tokens+' Eingabe-Tokens.'));}
  }catch(e){out.appendChild(el('div','sys err',e.status===409?'Es läuft bereits eine Jev-Frage.':'Fehler: '+e.message));}
  btn.disabled=false;setStatus(busy?'arbeitet …':'Bereit',busy?'run':'');};
try{if(localStorage.getItem('jevTab')==='ask')showView(true)}catch{}
api('/api/state').then(s=>{threadId=s.threadId;$('title').textContent=s.title||(s.threadId?s.threadId:'Neues Gespräch')+' · '+s.cwd;$('hint').textContent=(s.write?'Projektänderungen erlaubt':'Nur lesen (neue Gespräche)')+' · Enter sendet · Umschalt+Enter neue Zeile';setBusy(s.busy);loadThreads();connect();}).catch(()=>{setStatus('Kein Zugriff','err');sys('Token fehlt oder ist ungültig. Öffne die vom Startbefehl ausgegebene Adresse.','err');});
</script></body></html>`;
