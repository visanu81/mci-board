import http from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('index.html',root),'utf8');
const core=html.slice(html.indexOf('const OUTBOX_KEY ='),html.indexOf('// 미전송 배지('));
let records={},revision=0,mutations=0,hold=false,unavailable=false,pending=[];
const page=`<!doctype html><meta charset="utf-8"><title>MCI two-tab verification</title>
<h1>MCI 실제 탭 검증 · 가상 데이터 전용</h1><p>앱 소스의 미전송함과 전송 모듈, 브라우저 기본 Web Locks/localStorage 사용. Firebase는 로컬 모형입니다.</p>
<button id="reset">Reset fixture</button><button id="burst">Queue 40 cards</button><button id="replay">Replay queue</button><button id="hold">Hold responses</button><button id="release">Release responses</button><button id="one">Queue one card</button><button id="read">Read shared card</button><button id="edit">Queue note edit</button><button id="offline">Simulate unavailable network</button><button id="online">Restore network</button><button id="refresh">Refresh report</button><pre id="report"></pre>
<script type="module">
import {mayReplay,sendBoundOperation} from '/secure-session.js';
const firebaseConfig={projectId:'mci2-browser-fixture',databaseURL:location.origin};
const secureIdentity={uid:'fixture-user',agencyId:'fixture',active:true,environment:'test',role:'normal',expiresAt:Date.now()+3600000};
const auth={currentUser:{uid:secureIdentity.uid,getIdToken:async()=>'local-fixture'}};
const POPOUT_DISPLAY=false,authReady=Promise.resolve();
const tabId=crypto.randomUUID();let message='Ready',base=null;
function updateOutboxBadge(){render();}
${core}
async function render(){
 const server=await fetch('/report').then(r=>r.json());
 const queue=JSON.parse(localStorage.getItem(OUTBOX_KEY)||'{"ops":{}}');
 const ops=Object.values(queue.ops);
 document.getElementById('report').textContent=JSON.stringify({message,locks:!!navigator.locks,total:ops.length,uniqueSequences:new Set(ops.map(o=>o.seq)).size,conflicts:ops.filter(o=>o.errorCode==='write_conflict').length,statuses:ops.reduce((a,o)=>(a[o.status]=(a[o.status]||0)+1,a),{}),server},null,2);
}
const bind=(id,run)=>document.getElementById(id).onclick=async()=>{try{await run();}catch(e){message=e.message;}await render();};
const enqueue=(id)=>outboxEnqueue({kind:'casualty',method:'set',path:'mci2/incidents/test/casualties/'+id,payload:{name:'TEST',notes:'before',createdByUid:secureIdentity.uid,timestamp:Date.now()}});
bind('reset',async()=>{await _outboxLock('send',()=>_outboxLock('store',()=>localStorage.removeItem(OUTBOX_KEY)));await fetch('/reset',{method:'POST'});message='Reset';});
bind('burst',async()=>{await Promise.all(Array.from({length:40},(_,i)=>enqueue(tabId+'-'+i)));message='40 cards queued';});
bind('one',async()=>{await enqueue('shared');message='One card queued';});
bind('replay',async()=>{await replayOutbox({manual:true});message='Replay finished';});
bind('hold',async()=>{await fetch('/hold',{method:'POST'});message='Responses held';});
bind('release',async()=>{await fetch('/release',{method:'POST'});message='Responses released';});
bind('read',async()=>{base=await fetch('/mci2/incidents/test/casualties/shared.json').then(r=>r.json());message='Snapshot read: '+base?.notes;});
bind('edit',async()=>{if(!base)throw Error('Read snapshot first');await outboxEnqueue({kind:'casualty',method:'update',path:'mci2/incidents/test/casualties/shared',expected:{notes:base.notes},payload:{notes:tabId}});message='Note edit queued';});
bind('offline',async()=>{await fetch('/offline',{method:'POST'});message='Simulated network unavailable';});
bind('online',async()=>{await fetch('/online',{method:'POST'});message='Network restored';});
bind('refresh',async()=>{});await render();
</script>`;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');let body='';for await(const part of req)body+=part;
 res.setHeader('Cache-Control','no-store');
 const json=(value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
 if(url.pathname==='/') {res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(page);}
 if(url.pathname==='/secure-session.js'){res.setHeader('Content-Type','text/javascript');return res.end(await readFile(new URL('secure-session.js',root)));}
 if(url.pathname==='/report')return json({records:Object.keys(records).length,mutations,held:pending.length,hold,unavailable,shared:records['/mci2/incidents/test/casualties/shared.json']||null});
 if(req.method==='POST' && url.pathname==='/reset'){records={};mutations=0;revision++;return json({ok:true});}
 if(req.method==='POST' && url.pathname==='/offline'){unavailable=true;return json({ok:true});}
 if(req.method==='POST' && url.pathname==='/online'){unavailable=false;return json({ok:true});}
 if(req.method==='POST' && url.pathname==='/hold'){hold=true;return json({ok:true});}
 if(req.method==='POST' && url.pathname==='/release'){hold=false;for(const send of pending.splice(0))send();return json({ok:true});}
 if(!/^\/mci2\/incidents\/test\/casualties\/[\w-]+\.json$/.test(url.pathname))return json({error:'fixture route only'},404);
 if(unavailable)return json({error:'simulated network unavailable'},503);
 const etag='"'+revision+'"';
 if(req.method==='GET'){res.setHeader('ETag',etag);return json(records[url.pathname]||null);}
 if(req.headers['if-match']!==etag)return json({error:'stale'},412);
 if(req.method==='PUT'){records[url.pathname]=JSON.parse(body);revision++;mutations++;if(hold){pending.push(()=>json({ok:true}));return;}return json({ok:true});}
 return json({error:'unsupported'},405);
});
server.listen(8792,'127.0.0.1',()=>console.log('MCI browser fixture http://127.0.0.1:8792 — no external services'));
