import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
const cfg={projectId:'mci2-worker-test',databaseURL:'https://mci2-worker-test-default-rtdb.firebaseio.com',authDomain:'mci2-worker-test.firebaseapp.com',apiKey:'fixture-public'};
const env={FIREBASE_PROJECT_ID:cfg.projectId,FIREBASE_WEB_CONFIG:JSON.stringify(cfg),ANTHROPIC_API_KEY:'fixture-only'};
const req=(path,options)=>new Request('https://mci2.visanu81.workers.dev'+path,options);
let privateKey,jwk;
before(async()=>{const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);privateKey=pair.privateKey;jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'fixture'};});
async function token(){const now=Math.floor(Date.now()/1000),b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const data=b({alg:'RS256',kid:'fixture'})+'.'+b({aud:cfg.projectId,iss:'https://securetoken.google.com/'+cfg.projectId,sub:'fixture-uid',iat:now,exp:now+3600,mci_env:'test'});return data+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey,new TextEncoder().encode(data))).toString('base64url');}
test('missing config fails closed',async()=>assert.equal((await worker.fetch(req('/api/auth/config'),{})).status,503));
test('production config rejected',async()=>assert.equal((await worker.fetch(req('/api/auth/config'),{...env,FIREBASE_WEB_CONFIG:JSON.stringify({...cfg,projectId:'disester-f3669'})})).status,503));
test('public config exposes no server credentials',async()=>{const r=await worker.fetch(req('/api/auth/config'),env);assert.equal(r.status,200);assert.deepEqual(await r.json(),{firebase:cfg});assert.equal(r.headers.get('cache-control'),'no-store');});
test('login not configured never grants access',async()=>assert.equal((await worker.fetch(req('/api/auth/login',{method:'POST',body:'{}'}),env)).status,503));
test('OCR requires a bearer token',async()=>assert.equal((await worker.fetch(req('/api/ocr',{method:'POST',body:'{}'}),env)).status,401));
for(const [label,grant,status,ocrCount] of [['revoked',{active:false,environment:'test',role:'normal',agencyId:'a',expiresAt:Date.now()+3600000},403,0],['read only',{active:true,environment:'test',role:'observer',agencyId:'a',expiresAt:Date.now()+3600000},403,0],['approved',{active:true,environment:'test',role:'normal',agencyId:'a',expiresAt:Date.now()+3600000},200,1]]){
 test('OCR '+label,async()=>{
  let calls=0;const original=globalThis.fetch;
  globalThis.fetch=async url=>{const u=String(url);if(u.includes('/jwk/'))return new Response(JSON.stringify({keys:[jwk]}));if(u.startsWith(cfg.databaseURL+'/access/'))return new Response(JSON.stringify(grant));if(u==='https://api.anthropic.com/v1/messages'){calls++;return new Response(JSON.stringify({content:[{type:'text',text:'{}'}],model:'fixture'}));}throw Error('unexpected request');};
  try{const r=await worker.fetch(req('/api/ocr',{method:'POST',headers:{Authorization:'Bearer '+await token(),'Content-Type':'application/json'},body:JSON.stringify({image:'fixture-base64',mediaType:'image/png'})}),env);assert.equal(r.status,status);assert.equal(calls,ocrCount);}finally{globalThis.fetch=original;}
 });
}
