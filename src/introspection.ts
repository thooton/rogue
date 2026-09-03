import { createServer, type Server } from "node:http";
import type { AgentProfile } from "./personas.js";
import { redactedJson } from "./redaction.js";

export interface IntrospectionSnapshot {
  systemPrompt: string;
  messages: unknown[];
  /** Older messages left out of this snapshot; they remain in durable state. */
  earlierMessages?: number;
  events: unknown[];
  compactions?: unknown[];
  error?: string;
  running: boolean;
  route?: string;
}

export interface IntrospectionServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}


// Both themes ship: the viewer is often left open next to a terminal all day.
const DARK_TOKENS = `color-scheme:dark;--bg:#0b0d12;--surface:#12161e;--sunken:#0e1219;--line:#242b38;--line-soft:#1b212c;--text:#e8edf5;--muted:#8d99ab;--accent:#9d8cff;--accent-soft:#9d8cff26;--user:#63a6ff;--user-soft:#63a6ff1f;--ok:#46c78d;--danger:#ff7d85;--shadow:0 1px 2px #0006,0 14px 34px #0000004d`;

const DASHBOARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rogue transcript</title><style>
*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:light;--bg:#f6f7f9;--surface:#fff;--sunken:#f7f8fa;--line:#e4e8ee;--line-soft:#eef1f5;--text:#151920;--muted:#69737f;--accent:#5b4ddb;--accent-soft:#5b4ddb14;--user:#1668d8;--user-soft:#1668d80f;--ok:#12855a;--danger:#c8323f;--shadow:0 1px 2px #101a2b0d,0 10px 30px #101a2b0f;--radius:14px}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK_TOKENS}}}
:root[data-theme=dark]{${DARK_TOKENS}}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
input,textarea,form{display:none}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:12px max(20px,calc(50% - 460px));background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.identity{min-width:0;flex:1}
.identity .name{font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.identity .meta{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avatar{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font-weight:650;font-size:14px;color:#fff;background:linear-gradient(140deg,var(--accent),color-mix(in srgb,var(--accent) 55%,var(--user)));box-shadow:var(--shadow)}
.avatar.you{background:linear-gradient(140deg,var(--user),color-mix(in srgb,var(--user) 60%,var(--accent)));font-size:9px;letter-spacing:.06em}
.avatar.sys{background:none;border:1px dashed var(--line);color:var(--muted);font-size:13px;box-shadow:none}
.badge{flex:none;display:inline-flex;align-items:center;gap:7px;padding:4px 11px 4px 9px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--muted);background:var(--sunken)}
.badge .dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}
.badge.live{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,var(--line))}
.badge.live .dot{background:var(--ok);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 50%,transparent)}50%{opacity:.65;box-shadow:0 0 0 5px transparent}}
.ghost{flex:none;background:none;border:1px solid var(--line);color:var(--muted);border-radius:999px;width:32px;height:32px;font-size:14px;cursor:pointer;transition:color .15s,border-color .15s}
.ghost:hover{color:var(--text);border-color:var(--muted)}
main{max-width:920px;margin:0 auto;padding:22px 20px 30vh}
.alert{display:flex;gap:10px;padding:12px 14px;margin-bottom:18px;border-radius:10px;border:1px solid color-mix(in srgb,var(--danger) 40%,var(--line));background:color-mix(in srgb,var(--danger) 8%,var(--surface));color:var(--danger);font-size:14px}
.turn{display:grid;grid-template-columns:36px minmax(0,1fr);gap:14px;margin:22px 0}
.turn .head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
.turn .who{font-weight:600;font-size:14px;letter-spacing:-.01em}
.when{color:var(--muted);font-size:12px}
.prose{white-space:pre-wrap;overflow-wrap:anywhere}
.prose+.prose{margin-top:10px}
.turn.you .prose{background:var(--user-soft);border:1px solid color-mix(in srgb,var(--user) 20%,var(--line-soft));border-radius:var(--radius);padding:11px 14px}
.row{border:1px solid var(--line);border-radius:10px;background:var(--surface);margin:8px 0;overflow:hidden;box-shadow:var(--shadow)}
.row summary{display:flex;align-items:center;gap:9px;padding:9px 12px;cursor:pointer;list-style:none;font-size:13.5px;color:var(--text)}
.row summary::-webkit-details-marker{display:none}
.row summary::before{content:"";flex:none;width:5px;height:5px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);transition:transform .18s ease;margin-right:1px}
.row[open]>summary::before{transform:rotate(45deg)}
.row summary:hover{background:var(--sunken)}
.row .dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--muted)}
.row.running .dot{background:var(--accent);animation:pulse 1.6s ease-in-out infinite}
.row.done .dot{background:var(--ok)}
.row.failed .dot{background:var(--danger)}
.row.failed{border-color:color-mix(in srgb,var(--danger) 35%,var(--line))}
.row .label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .tag{flex:none;margin-left:auto;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.row.failed .tag{color:var(--danger)}
.row.think .label{font-style:italic;color:var(--muted)}
.dumps{border-top:1px solid var(--line-soft);background:var(--sunken)}
.dump-title{padding:10px 14px 0;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
pre.dump{margin:0;padding:10px 14px 14px;max-height:26em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted);font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.divider{display:flex;align-items:center;gap:14px;margin:30px 0 22px;color:var(--muted);font-size:11px;letter-spacing:.1em;text-transform:uppercase}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line)}
.empty{text-align:center;color:var(--muted);padding:72px 10px}
.raw{margin-top:34px;background:none;box-shadow:none;border-style:dashed}
.jump{position:fixed;left:50%;bottom:24px;transform:translate(-50%,16px);opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;background:var(--surface);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:8px 16px;font-size:13px;cursor:pointer;box-shadow:var(--shadow)}
.jump.show{opacity:1;transform:translate(-50%,0);pointer-events:auto}
</style></head>
<body>
<header class="topbar">
 <div class="avatar" id="mark">R</div>
 <div class="identity"><div class="name" id="identity">Rogue transcript</div><div class="meta" id="meta">read-only viewer</div></div>
 <span class="badge" id="state"><span class="dot"></span><span id="state-text">connecting</span></span>
 <button class="ghost" id="theme" title="Switch theme" aria-label="Switch theme">◐</button>
</header>
<main id="messages"></main>
<button class="jump" id="jump">Jump to latest ↓</button>
<script>
const toolLabels={
read:a=>'Reading '+(a.path||'a file'),bash:a=>'Running terminal command: '+String(a.command||'').slice(0,100),edit:a=>'Editing '+(a.path||'a file'),write:a=>'Writing '+(a.path||'a file'),grep:a=>'Searching files for '+(a.pattern||'text'),find:a=>'Finding '+(a.pattern||'files'),ls:a=>'Listing '+(a.path||'the working directory'),powershell:a=>'Running PowerShell command: '+String(a.command||'').slice(0,100),
add_nostr_relay:a=>'Connecting to relay '+(a.url||''),read_nostr_messages:a=>'Reading Rogue Network messages',publish_nostr_message:a=>'Publishing a Rogue Network message',nostr_identity:a=>'Checking the agent network identity',list_nostr_relays:a=>'Reviewing configured relays',remember:a=>'Saving a durable '+(a.category||'')+' memory',recall:a=>'Reviewing durable memory',create_initiative:a=>'Creating initiative: '+(a.title||''),list_initiatives:a=>'Reviewing initiatives',update_initiative:a=>'Updating initiative '+(a.id||''),draft_network_message:a=>'Drafting a '+(a.audience||'network')+' message',list_network_drafts:a=>'Reviewing network drafts',credential_status:a=>'Checking provider credentials',list_model_providers:a=>'Reviewing model providers',list_models:a=>'Browsing '+(a.provider||'provider')+' models'+(a.query?' matching '+a.query:''),configure_model_provider:a=>'Configuring model provider '+(a.provider||''),disable_model_provider:a=>'Disabling model provider '+(a.provider||''),set_api_key:a=>'Securely configuring provider credentials',remove_credential:a=>'Removing provider credentials',list_personas:a=>'Reviewing persona templates',create_persona:a=>'Creating persona template: '+(a.label||'')};
const byId=id=>document.getElementById(id);
function make(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node}
function contentText(content){if(typeof content==='string')return content;if(!Array.isArray(content))return content==null?'':JSON.stringify(content,null,2);return content.map(x=>x&&x.type==='text'?x.text:'').filter(Boolean).join('\\n')}
function friendlyTool(name,args){const fn=toolLabels[name];if(fn)return fn(args||{}).trim();return 'Running '+String(name||'tool').replaceAll('_',' ')}
function ago(timestamp){if(!timestamp)return '';const seconds=(Date.now()-timestamp)/1000;if(seconds<45)return 'just now';if(seconds<3600)return Math.round(seconds/60)+'m ago';if(seconds<86400)return Math.round(seconds/3600)+'h ago';return new Date(timestamp).toLocaleDateString()}
function tokens(count){return Number(count||0).toLocaleString()+' tokens'}
function when(timestamp){const node=make('time','when',ago(timestamp));if(timestamp)node.title=new Date(timestamp).toLocaleString();return node}
// Every row is a labeled expandable: a one-line summary plus titled detail sections.
function row(state,key,label,tag,sections){
 const box=make('details','row '+state);box.dataset.key=key;
 const head=make('summary');
 if(state==='running'||state==='done'||state==='failed')head.append(make('span','dot'));
 head.append(make('span','label',label));
 if(tag)head.append(make('span','tag',tag));
 const dumps=make('div','dumps');
 for(const [title,text] of sections){if(title)dumps.append(make('div','dump-title',title));dumps.append(make('pre','dump',text))}
 box.append(head,dumps);return box;
}
function turn(kind,initials,name,timestamp){
 const article=make('article','turn '+kind);
 const main=make('div','main'),head=make('div','head');
 head.append(make('span','who',name),when(timestamp));main.append(head);
 article.append(make('div','avatar '+kind,initials),main);article.main=main;return article;
}
function rawText(d){return 'SYSTEM PROMPT\\n'+(d.systemPrompt||'')+'\\n\\nMESSAGES\\n'+JSON.stringify(d.messages||[],null,2)+'\\n\\nEVENTS\\n'+JSON.stringify(d.events||[],null,2)}
function render(d){
 const open=new Set([...document.querySelectorAll('details[open]')].map(x=>x.dataset.key));
 const stick=atBottom();
 const name=d.profile.name,initial=(name||'R').trim().charAt(0).toUpperCase();
 byId('identity').textContent=name;byId('mark').textContent=initial;
 byId('meta').textContent=[d.profile.country,d.profile.personaLabel,d.route,'read-only'].filter(Boolean).join(' · ');
 byId('state').className='badge'+(d.running?' live':'');byId('state-text').textContent=d.running?'working':'idle';
 const root=byId('messages');root.replaceChildren();
 if(d.error)root.append(make('div','alert',d.error));
 root.append(row('','system-prompt','Complete immutable system prompt','identity',[[null,d.systemPrompt||'System prompt unavailable.']]));
 if(d.earlierMessages)root.append(make('div','divider',d.earlierMessages+' earlier messages · kept in session-transcript.jsonl'));
 const results=new Map();
 for(const m of d.messages||[])if(m&&m.role==='toolResult')results.set(m.toolCallId,m);
 let visible=0;
 for(const m of d.messages||[]){
  if(!m||m.role==='toolResult')continue;
  visible+=1;
  if(m.role==='user'){
   const text=contentText(m.content),wake=text.match(/^Autonomous wakeup #([0-9]+), please continue$/);
   // A bare wakeup is scaffolding, not conversation: show it as a chapter rule.
   if(wake){root.append(make('div','divider','Wakeup #'+wake[1]+(m.timestamp?' · '+ago(m.timestamp):'')));continue}
   const box=turn('you','YOU','You',m.timestamp);box.main.append(make('div','prose',text));root.append(box);continue;
  }
  if(m.role==='assistant'){
   const box=turn('assistant',initial,name,m.timestamp),seq=(m.timestamp||'')+'-';
   let index=0;
   for(const block of m.content||[]){
    index+=1;
    if(block.type==='text'&&block.text)box.main.append(make('div','prose',block.text));
    else if(block.type==='thinking'&&block.thinking)box.main.append(row('think','thinking-'+seq+index,'Reasoning','',[[null,block.thinking]]));
    else if(block.type==='toolCall'){
     const result=results.get(block.id),failed=result&&result.isError;
     const sections=[['Arguments',JSON.stringify(block.arguments||{},null,2)]];
     if(result)sections.push([failed?'Error':'Result',contentText(result.content)]);
     box.main.append(row(failed?'failed':result?'done':'running','tool-'+block.id,friendlyTool(block.name,block.arguments),failed?'failed':result?'done':'running',sections));
    }
    else box.main.append(row('','detail-'+seq+index,'Technical detail','',[[null,JSON.stringify(block,null,2)]]));
   }
   root.append(box);continue;
  }
  if(m.role==='compactionSummary'){
   root.append(make('div','divider','Context compacted · '+tokens(m.tokensBefore)));
   root.append(row('done','compaction-'+m.timestamp,'Summary of the earlier conversation','kept',[[null,m.summary]]));continue;
  }
  const box=turn('sys','·',String(m.role||'Event'),m.timestamp);box.main.append(make('div','prose',contentText(m.content)||JSON.stringify(m,null,2)));root.append(box);
 }
 for(const c of d.compactions||[])root.append(row('done','compaction-record-'+c.createdAt,'Compacted '+c.summarizedMessages+' messages at '+tokens(c.tokensBefore),'context',[[null,'Threshold: '+tokens(c.thresholdTokens)+'\\nRetained messages: '+c.retainedMessages]]));
 if(!visible)root.append(make('div','empty','No transcript yet. This page follows the agent as it works.'));
 // The raw dump can be megabytes, so it is only serialized while it is open.
 const raw=row('','raw','Raw transcript and event stream','json',[[null,'']]);
 raw.classList.add('raw');
 const pre=raw.querySelector('.dump'),fill=()=>{pre.textContent=raw.open?rawText(latest):''};
 raw.addEventListener('toggle',fill);root.append(raw);
 for(const node of document.querySelectorAll('details'))if(open.has(node.dataset.key))node.open=true;
 fill();
 if(stick)window.scrollTo(0,document.documentElement.scrollHeight);
 trackScroll();
}
const atBottom=()=>window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-90;
const trackScroll=()=>byId('jump').classList.toggle('show',!atBottom());
let latest=null,lastPayload='';
async function refresh(){
 let payload;
 try{payload=await (await fetch('/api/transcript',{cache:'no-store'})).text()}
 catch(error){byId('state').className='badge';byId('state-text').textContent='disconnected';return}
 if(payload===lastPayload)return;
 lastPayload=payload;latest=JSON.parse(payload);render(latest);
}
byId('jump').addEventListener('click',()=>window.scrollTo(0,document.documentElement.scrollHeight));
byId('theme').addEventListener('click',()=>{
 const dark=matchMedia('(prefers-color-scheme:dark)').matches;
 const next=(document.documentElement.dataset.theme||(dark?'dark':'light'))==='dark'?'light':'dark';
 document.documentElement.dataset.theme=next;localStorage.setItem('rogue-theme',next);
});
addEventListener('scroll',trackScroll,{passive:true});
const saved=localStorage.getItem('rogue-theme');if(saved)document.documentElement.dataset.theme=saved;
refresh();setInterval(refresh,1500)
</script></body></html>`;

export async function startIntrospectionServer(options: {
  profile: AgentProfile;
  getSnapshot: () => IntrospectionSnapshot;
  host?: string;
}): Promise<IntrospectionServer> {
  const host = options.host ?? "127.0.0.1";
  const server: Server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json" });
      response.end(JSON.stringify({ error: "read-only" }));
      return;
    }
    if (request.url === "/api/transcript") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(redactedJson({ profile: options.profile, ...options.getSnapshot() }));
    } else if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : DASHBOARD);
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine introspection server address.");
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
