// The Jev app window: projects and conversations on the left, the conversation in the middle.
// All text from chats is set with textContent (never parsed as HTML).
export const APP_HTML = String.raw`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev</title>
<style>
:root{--bg:#f6f6f4;--panel:#ffffff;--side:#efeeea;--ink:#1d1d1b;--mute:#6b6a66;--line:#dddbd4;--accent:#c96442;--claude:#c96442;--codex:#1f7a5c;--warn:#b7791f;--bad:#c53030;--chip:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1a;--panel:#232321;--side:#161615;--ink:#ecebe6;--mute:#9b9a94;--line:#34332f;--chip:#2c2b28}}
*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden}
body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--ink);display:grid;grid-template-columns:290px 1fr}
aside{background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;padding:14px 16px 8px}.logo{width:30px;height:30px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700}
.brand b{font-size:16px}.status{padding:0 16px 10px;font-size:12px;color:var(--mute)}
.status span{display:inline-block;margin-right:10px}.ok{color:var(--codex)}.no{color:var(--bad)}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:6px 10px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:default}
.new{margin:0 12px 10px}.new button{width:100%}
.list{padding:0 8px 12px}.group{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:12px 8px 4px}
.item{padding:7px 10px;border-radius:8px;cursor:pointer;display:flex;flex-direction:column;gap:1px}.item:hover{background:var(--chip)}.item.active{background:var(--panel);box-shadow:0 0 0 1px var(--line)}
.item small{color:var(--mute);font-size:11px}.item .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
details.chats{padding:0 8px}details.chats summary{cursor:pointer;color:var(--mute);font-size:12px;padding:8px}
main{display:flex;flex-direction:column;min-width:0;min-height:0}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:15px;margin:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}header .path{color:var(--mute);font-size:12px;max-width:45%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl}
select,textarea,input{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 8px}
#log{flex:1;overflow:auto;padding:18px 0}.msg{max-width:860px;margin:0 auto 14px;padding:0 20px}
.bubble{border-radius:12px;padding:10px 14px;white-space:pre-wrap;word-wrap:break-word}
.user .bubble{background:var(--chip);margin-left:80px}
.who{font-size:12px;color:var(--mute);margin-bottom:3px;display:flex;gap:6px;align-items:center}
.tag{font-size:11px;border-radius:999px;padding:1px 8px;color:#fff}.tag.claude{background:var(--claude)}.tag.codex{background:var(--codex)}
.note .bubble{color:var(--mute);font-size:13px;padding:4px 14px;border-left:3px solid var(--line);border-radius:0}
.route{max-width:860px;margin:0 auto 10px;padding:0 20px;font-size:12px;color:var(--mute)}
pre{background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;white-space:pre;font:12.5px/1.45 Consolas,monospace}
details.act{font-size:12px;color:var(--mute);margin-top:4px}details.act li{font-family:Consolas,monospace;font-size:11.5px}
.approval{max-width:860px;margin:0 auto 14px;padding:0 20px}.approval div.card{border:1px solid var(--warn);border-radius:12px;padding:10px 14px;background:var(--panel)}
.approval code{display:block;margin:6px 0;white-space:pre-wrap;font:12px Consolas,monospace}
footer{border-top:1px solid var(--line);background:var(--panel);padding:10px 20px 14px}
.composer{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:8px}
.composer textarea{width:100%;min-height:64px;max-height:260px;resize:vertical}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1}.phase{font-size:12px;color:var(--mute)}
.empty{max-width:560px;margin:12vh auto;text-align:center;color:var(--mute)}.empty h2{color:var(--ink);font-weight:600}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);width:min(520px,92vw)}dialog label{display:block;margin:10px 0 4px;font-size:12px;color:var(--mute)}dialog input{width:100%}
@media (max-width:760px){body{grid-template-columns:1fr}aside{display:none}.user .bubble{margin-left:20px}}
</style></head><body>
<aside>
  <div class="brand"><div class="logo">J</div><b>Jev</b></div>
  <div class="status" id="status">Prüfe Claude Code und Codex …</div>
  <div class="new"><button class="primary" id="newBtn">+ Neues Gespräch</button></div>
  <div class="list" id="list"></div>
  <details class="chats" id="chats"><summary>Bestehende Chats aus Claude und Codex</summary><div id="chatList" class="list"></div></details>
</aside>
<main>
  <header><h1 id="title">Jev</h1><span class="path" id="path"></span>
    <select id="access" title="Was die Agenten dürfen"><option value="read">Nur lesen</option><option value="write">Darf Dateien ändern</option></select></header>
  <div id="log"><div class="empty"><h2>Ein Chat für Claude und Codex</h2><p>Schreib einfach los. Jev wählt für jede Aufgabe das passende Modell und den Effort – und wechselt zwischen Claude Code und Codex, wenn es sich lohnt. Der ganze Verlauf geht dabei mit.</p></div></div>
  <footer><div class="composer">
    <textarea id="text" placeholder="Nachricht … (Strg+Enter sendet)"></textarea>
    <div class="row"><select id="model"><option value="">Jev entscheidet</option></select><select id="effort" hidden></select>
      <span class="phase grow" id="phase"></span><button id="stop" hidden>Anhalten</button><button class="primary" id="send">Senden</button></div>
  </div></footer>
</main>
<dialog id="dlg"><form method="dialog"><b>Neues Gespräch</b>
  <label for="cwd">Projektordner (dort arbeiten die Agenten)</label><input id="cwd">
  <label for="acc">Rechte</label><select id="acc"><option value="read">Nur lesen</option><option value="write">Darf Dateien ändern (Befehle fragen trotzdem)</option></select>
  <div class="row" style="margin-top:14px;justify-content:flex-end"><button value="cancel">Abbrechen</button><button class="primary" id="create" value="ok">Anlegen</button></div></form></dialog>
<script>
const T=new URLSearchParams(location.search).get('t');
const $=id=>document.getElementById(id);
const api=async(path,body)=>{const r=await fetch(path,{method:body?'POST':'GET',headers:{'x-jev-token':T,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j};
let S={models:[],conversations:[]},cur=null,streamEl=null,streamText='';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
const base=p=>String(p||'').split(/[\\/]/).filter(Boolean).pop()||p;
const agentName=a=>a==='codex'?'Codex':'Claude';
const label=id=>(S.models.find(m=>m.id===id)||{}).label||id;
const EFF={low:'Niedrig',medium:'Mittel',high:'Hoch',xhigh:'Extra hoch',max:'Max',ultra:'Ultra',minimal:'Minimal',none:'Keins'};
function rich(text){const box=el('div','bubble');const parts=String(text).split(/\x60\x60\x60[^\n]*\n?/);parts.forEach((p,i)=>{if(i%2){box.appendChild(el('pre',null,p.replace(/\n$/,'')))}else if(p)box.appendChild(document.createTextNode(p))});return box}
function renderMsg(m){const w=el('div','msg '+m.role);
  if(m.role==='assistant'){const who=el('div','who');who.appendChild(el('span','tag '+(m.agent||'claude'),agentName(m.agent)));who.appendChild(el('span',null,[label(m.model),EFF[m.effort]||m.effort].filter(Boolean).join(' · ')));w.appendChild(who)}
  if(m.role==='user'){const who=el('div','who');who.style.justifyContent='flex-end';who.textContent='Du';w.appendChild(who)}
  w.appendChild(rich(m.text));
  if(m.activity&&m.activity.length){const d=el('details','act');d.appendChild(el('summary',null,m.activity.length+(m.activity.length===1?' Schritt':' Schritte')+' (Befehle, Dateien)'));const ul=el('ul');m.activity.forEach(a=>ul.appendChild(el('li',null,a)));d.appendChild(ul);w.appendChild(d)}
  return w}
function scroll(){const l=$('log');l.scrollTop=l.scrollHeight}
async function refresh(force){S=await api('/api/state'+(force?'?refresh=1':''));
  const st=$('status');st.textContent='';for(const a of ['claude','codex']){const s=el('span',S.available[a]?'ok':'no',(S.available[a]?'● ':'○ ')+agentName(a)+(S.available[a]?' bereit':' nicht bereit'));s.title=(S.available.reasons||{})[a]||'';st.appendChild(s)}
  const list=$('list');list.textContent='';const groups={};for(const c of S.conversations)(groups[c.cwd]=groups[c.cwd]||[]).push(c);
  if(!S.conversations.length)list.appendChild(el('div','group','Noch keine Gespräche'));
  for(const [cwd,cs] of Object.entries(groups)){const g=el('div','group',base(cwd));g.title=cwd;list.appendChild(g);for(const c of cs){const it=el('div','item'+(cur&&cur.id===c.id?' active':''));it.appendChild(el('span','t',c.title));it.appendChild(el('small',null,(c.busy?'arbeitet … · ':'')+(c.last?agentName(c.last.agent)+' · '+label(c.last.model):'neu')));it.onclick=()=>open(c.id);list.appendChild(it)}}
  const sel=$('model'),v=sel.value;while(sel.children.length>1)sel.lastChild.remove();for(const a of ['claude','codex']){const og=document.createElement('optgroup');og.label=agentName(a);for(const m of S.models.filter(m=>m.agent===a))og.appendChild(Object.assign(document.createElement('option'),{value:m.id,textContent:m.label}));if(og.children.length)sel.appendChild(og)}sel.value=v;effortOptions()}
function effortOptions(){const m=S.models.find(x=>x.id===$('model').value),e=$('effort');e.textContent='';e.hidden=!m||!m.efforts.length;if(m)for(const x of m.efforts)e.appendChild(Object.assign(document.createElement('option'),{value:x,textContent:EFF[x]||x}));if(m&&m.efforts.includes('medium'))e.value='medium'}
$('model').onchange=effortOptions;
async function open(id){cur=await api('/api/conversation?id='+id);$('title').textContent=cur.title;$('path').textContent=cur.cwd;$('access').value=cur.access;const log=$('log');log.textContent='';for(const m of cur.messages)log.appendChild(renderMsg(m));busy(cur.busy);scroll();refresh()}
function busy(b){$('send').disabled=b;$('stop').hidden=!b;if(!b)$('phase').textContent=''}
async function send(){const text=$('text').value;if(!text.trim())return;if(!cur){await newConv(true);if(!cur)return}
  $('text').value='';busy(true);try{await api('/api/send',{id:cur.id,text,model:$('model').value||null,effort:$('model').value?$('effort').value:null})}catch(e){busy(false);$('phase').textContent='Nicht gesendet: '+e.message}}
$('send').onclick=send;$('text').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send()}};
$('stop').onclick=()=>cur&&api('/api/stop',{id:cur.id});
$('access').onchange=async()=>{if(cur)try{await api('/api/access',{id:cur.id,access:$('access').value})}catch(e){$('access').value=cur.access}};
function newConv(){return new Promise(done=>{$('cwd').value=(cur&&cur.cwd)||S.defaultCwd||'';$('acc').value='read';const d=$('dlg');d.onclose=async()=>{if(d.returnValue==='ok'){try{const c=await api('/api/conversation',{cwd:$('cwd').value,access:$('acc').value});await open(c.id)}catch(e){alert('Ordner nicht gefunden: '+$('cwd').value)}}done()};d.returnValue='';d.showModal()})}
$('newBtn').onclick=()=>newConv();
$('chats').ontoggle=async()=>{if(!$('chats').open)return;const box=$('chatList');box.textContent='Lade … (Codex braucht ein paar Sekunden)';try{const r=await api('/api/chats');box.textContent='';for(const c of [...r.claude,...r.codex].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,30)){const it=el('div','item');it.appendChild(el('span','t',c.title));it.appendChild(el('small',null,agentName(c.kind)+' · '+base(c.cwd||'')+' · in Jev fortsetzen'));it.onclick=async()=>{if(!confirm('„'+c.title+'“ als neues Jev-Gespräch fortsetzen? Der Verlauf wird übernommen, der Original-Chat bleibt unverändert.'))return;const x=await api('/api/import',{kind:c.kind,id:c.id,title:c.title,cwd:c.cwd});await open(x.id)};box.appendChild(it)}}catch(e){box.textContent='Nicht lesbar: '+e.message}};
const es=new EventSource('/api/events?t='+T);
es.onmessage=ev=>{const e=JSON.parse(ev.data);if(e.type==='idle'||e.type==='user')refresh();if(!cur||e.conversationId!==cur.id)return;const log=$('log');
  if(e.type==='user'){log.appendChild(renderMsg(e.message));$('title').textContent=e.title||cur.title}
  else if(e.type==='phase')$('phase').textContent=e.text;
  else if(e.type==='route'){log.appendChild(el('div','route','→ '+e.line+(e.carried?' · '+e.carried+' Nachrichten Verlauf übergeben':'')+(e.why&&e.source==='keep'&&/nicht/.test(e.why)?' · '+e.why:'')))}
  else if(e.type==='delta'){if(!streamEl){streamEl=el('div','msg assistant');streamEl.appendChild(el('div','bubble'));log.appendChild(streamEl);streamText=''}streamText+=e.text;streamEl.firstChild.textContent=streamText}
  else if(e.type==='activity')$('phase').textContent=e.line;
  else if(e.type==='notice')log.appendChild(renderMsg({role:'note',text:e.text}));
  else if(e.type==='approval'){const w=el('div','approval');w.id='ap-'+e.requestId;const c=el('div','card');c.appendChild(el('b',null,e.title));if(e.detail)c.appendChild(el('code',null,e.detail));const row=el('div','row');const ok=el('button','primary','Erlauben'),no=el('button',null,'Ablehnen');ok.onclick=()=>api('/api/approval',{requestId:e.requestId,decision:'accept'});no.onclick=()=>api('/api/approval',{requestId:e.requestId,decision:'decline'});row.append(ok,no);c.appendChild(row);w.appendChild(c);log.appendChild(w)}
  else if(e.type==='approvalResolved'){const w=$('ap-'+e.requestId);if(w){w.querySelector('.row').replaceWith(el('div','phase',e.decision==='accept'?'Erlaubt':'Abgelehnt'))}}
  else if(e.type==='assistant'){if(streamEl){streamEl.remove();streamEl=null}log.appendChild(renderMsg(e.message))}
  else if(e.type==='note'){if(streamEl){streamEl.remove();streamEl=null}log.appendChild(renderMsg(e.message))}
  else if(e.type==='idle'){busy(false)}
  scroll()};
refresh(true).then(()=>{if(S.conversations[0])open(S.conversations[0].id)});
</script></body></html>`;
