import fs from 'node:fs';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import worker from '../worker.js';import {initializeApp,deleteApp} from 'firebase/app';import * as authSDK from 'firebase/auth';import * as dbSDK from 'firebase/database';import {createSessionController} from '../secure-session.js';
const require=createRequire(import.meta.url);const {requireAuth}=require('firebase-tools/lib/requireAuth');const cliAuth=require('firebase-tools/lib/auth');const {Client}=require('firebase-tools/lib/apiv2');
if(process.env.MCI_LIVE_TEST_PROJECT!=='mci2-secure-visanu81')throw Error('Explicit isolated-test-project opt-in required');
const project='mci2-secure-visanu81',config=JSON.parse(fs.readFileSync('security/firebase-web-config.json'));
const env={...JSON.parse(fs.readFileSync('wrangler.mci2.jsonc')).vars,...JSON.parse(fs.readFileSync('.tmp/auth-setup/worker-secrets.json')),AUTH_RATE_LIMIT:{limit:async()=>({success:true})}};
assert.equal(env.FIREBASE_PROJECT_ID,project);assert.equal(env.MCI_CODE_STORE,'database');
const remote=process.env.MCI_LIVE_WORKER_URL;
if(remote && !(new URL(remote).origin===remote && new URL(remote).protocol==='https:' && /^[a-f0-9]{8}-mci2[.]visanu81[.]workers[.]dev$/.test(new URL(remote).hostname)))throw Error('Only an isolated mci2 version URL is allowed');
const bootstrap=JSON.parse(fs.readFileSync('.tmp/auth-setup/test-entry-codes.json')).codes.find(x=>x.role==='admin').code;
const tag='managed-'+crypto.randomUUID(),path='mci2/incidents/'+tag,users=[],uids=new Set(),createdCodes=[],apps=[];let checks=0,controller;
function pass(label){checks++;console.log('PASS '+label);}
async function api(path,body,user){const request=new Request((remote||env.PUBLIC_ORIGIN)+path,{method:body===undefined?'GET':'POST',headers:{Origin:env.PUBLIC_ORIGIN,...(remote?{}:{'CF-Connecting-IP':'192.0.2.10'}),'Content-Type':'application/json',...(user?{Authorization:'Bearer '+await user.getIdToken()}:{})},body:body===undefined?undefined:JSON.stringify(body)});return remote?fetch(request):worker.fetch(request,env);}
async function exchange(token){const uid=JSON.parse(Buffer.from(token.split('.')[1],'base64url')).uid;uids.add(uid);const app=initializeApp(config,crypto.randomUUID());apps.push(app);const auth=authSDK.initializeAuth(app,{persistence:authSDK.inMemoryPersistence});await authSDK.signInWithCustomToken(auth,token);users.push(auth.currentUser);return {auth,db:dbSDK.getDatabase(app),user:auth.currentUser};}
async function login(code){const r=await api('/api/auth/login',{code});assert.equal(r.status,200,'login HTTP '+r.status);return exchange((await r.json()).token);}
async function waitFor(fn){const until=Date.now()+10000;while(Date.now()<until){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('realtime change timed out');}
async function read(p,user,method='GET',body){const url=new URL(config.databaseURL+'/'+p+'.json');url.searchParams.set('auth',await user.getIdToken());return fetch(url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}
let cleanupErrors=[];
try{
 const oldResponse=await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/api/auth/login',{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'CF-Connecting-IP':'192.0.2.10','Content-Type':'application/json'},body:JSON.stringify({code:bootstrap})}),{...env,MCI_CODE_STORE:undefined});
 assert.equal(oldResponse.status,200);const legacy=await exchange((await oldResponse.json()).token);
 assert([401,403].includes((await read('access/'+legacy.user.uid,legacy.user)).status));pass('legacy candidate token cannot access managed database');
 const admin=await login(bootstrap);pass('managed bootstrap admin login');
 const listing=await api('/api/admin/codes',undefined,admin.user);assert.equal(listing.status,200);assert(!JSON.stringify(await listing.json()).includes('codeHash'));pass('authenticated metadata list');
 const cr=await api('/api/admin/codes',{action:'create',agencyId:tag,agencyName:'가상 검증 관서',role:'normal',days:1},admin.user);assert.equal(cr.status,200);const code=await cr.json();createdCodes.push(code.id);pass('admin creates server-generated code');
 const normal=await login(code.code);pass('newly issued code logs in');
 assert.equal((await api('/api/admin/codes',undefined,normal.user)).status,403);pass('normal cannot manage codes');
 assert((await read(path,normal.user,'PUT',{agencyId:tag,createdByUid:normal.user.uid,title:'가상 재난',startedAt:Date.now()-1000})).ok);pass('managed session creates incident');
 const hqr=await api('/api/admin/codes',{action:'create',agencyId:'validation_hq',agencyName:'가상 본부',role:'hq',days:1},admin.user);assert.equal(hqr.status,200);const hqc=await hqr.json();createdCodes.push(hqc.id);const hq=await login(hqc.code);
 assert((await read(path,hq.user)).ok);assert([401,403].includes((await read(path,hq.user,'PATCH',{title:'forbidden'})).status));pass('HQ reads other agency but cannot edit');
 assert.equal((await api('/api/admin/codes',undefined,hq.user)).status,403);pass('HQ cannot administer codes');
 const dr=await api('/api/auth/display',{incidentId:tag},normal.user);assert.equal(dr.status,200);const display=await exchange((await dr.json()).token);pass('delegated display custom token exchange');
 assert.notEqual(display.user.uid,normal.user.uid);assert.equal(normal.auth.currentUser.uid,normal.user.uid);pass('display auth leaves parent identity intact');
 assert((await read(path,display.user)).ok);assert([401,403].includes((await read(path,display.user,'PATCH',{title:'forbidden'})).status));pass('display reads assigned incident and cannot write');
 const q=new URL(config.databaseURL+'/mci2/incidents.json');q.searchParams.set('auth',await display.user.getIdToken());q.searchParams.set('orderBy',JSON.stringify('agencyId'));q.searchParams.set('equalTo',JSON.stringify(tag));assert([401,403].includes((await fetch(q)).status));pass('scoped display cannot enumerate agency incidents');
 const peer=await login(code.code);assert.notEqual(peer.user.uid,normal.user.uid);
 const cardPath=path+'/mciCasualties/concurrent';
 assert((await read(cardPath,normal.user,'PUT',{createdByUid:normal.user.uid,updatedByUid:normal.user.uid,timestamp:Date.now(),name:'가상 동시입력',triage:'urgent',notes:'before'})).ok);
 const edits=await Promise.all([read(cardPath,normal.user,'PATCH',{notes:'현장 메모',updatedByUid:normal.user.uid}),read(cardPath,peer.user,'PATCH',{hospital:'가상 병원',updatedByUid:peer.user.uid})]);assert(edits.every(r=>r.ok));
 const merged=await (await read(cardPath,normal.user)).json();assert.equal(merged.notes,'현장 메모');assert.equal(merged.hospital,'가상 병원');pass('two independent logins preserve concurrent changes to different card fields');
 assert((await read(cardPath,normal.user,'PATCH',{notes:'first',updatedByUid:normal.user.uid})).ok);assert((await read(cardPath,peer.user,'PATCH',{notes:'last',updatedByUid:peer.user.uid})).ok);assert.equal((await (await read(cardPath,normal.user)).json()).notes,'last');pass('same-field writes are last-write-wins (documented limitation)');
 const closing=await api('/api/admin/close',{incidentId:tag},admin.user);assert.equal(closing.status,200);pass('server closes and archives isolated incident');
 const closed=await (await read(path,admin.user)).json();assert(closed.closure && closed.closedAt);assert.equal(closed.title,'가상 재난');
 const savedArchive=await read('mci2/archives/close-'+closed.closure.id,admin.user);assert(savedArchive.ok);assert.equal((await savedArchive.json()).sourceIncidentId,tag);pass('closed original and archive both retained');
 assert([401,403].includes((await read(path,admin.user,'PATCH',{title:'forbidden'})).status));assert([401,403].includes((await read(path,normal.user,'PATCH',{title:'forbidden'})).status));pass('closed incident rejects both admin and normal direct writes');
 assert.equal((await api('/api/admin/close',{incidentId:tag},admin.user)).status,200);pass('duplicate close is idempotent');
 controller=createSessionController({auth:normal.auth,db:normal.db,sdk:{...authSDK,...dbSDK},onChange:()=>{}});controller.start();await waitFor(()=>controller.current());
 const revoke=await api('/api/admin/codes',{action:'revoke',id:code.id},admin.user);assert.equal(revoke.status,200);pass('administrator revokes issued code');
 await waitFor(()=>controller.current()===null);pass('code revocation immediately clears subscribed session');
 assert.equal((await api('/api/auth/login',{code:code.code})).status,401);pass('revoked code cannot log in');
 assert([401,403].includes((await read(path,normal.user)).status));assert([401,403].includes((await read(path,display.user)).status));pass('revoked code blocks parent and delegated display');
}catch(e){console.error('FAIL '+e.message);process.exitCode=1;}
finally{
 controller?.stop();for(const user of users)try{await authSDK.deleteUser(user);}catch{cleanupErrors.push('auth');}
 for(const app of apps){dbSDK.goOffline(dbSDK.getDatabase(app));await deleteApp(app);}
 await requireAuth({project,...cliAuth.getGlobalDefaultAccount()});const cli=new Client({urlPrefix:config.databaseURL});
 let closureArchive;
 try{const own=await cli.get('/'+path+'.json');if(own.body?.closure?.id)closureArchive='mci2/archives/close-'+own.body.closure.id;}catch{cleanupErrors.push('closure-lookup');}
 for(const p of [...(closureArchive?[closureArchive]:[]),path,...[...uids].map(x=>'access/'+x),...createdCodes.map(x=>'serverCodes/'+x)])try{await cli.delete('/'+p+'.json');}catch{cleanupErrors.push(p);}
 const result={project,remote:remote||null,checks,passed:!process.exitCode,cleanupErrors,at:new Date().toISOString()};fs.writeFileSync(remote?'.tmp/auth-setup/managed-edge-result.json':'.tmp/auth-setup/managed-validation-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(cleanupErrors.length)process.exitCode=1;
}
