import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomBytes,createHmac,createSign} from 'node:crypto';
import {initializeApp,deleteApp} from 'firebase/app';
import * as authSDK from 'firebase/auth';
import * as dbSDK from 'firebase/database';
import {handleAgencyLogin} from '../security/agency-login.mjs';
import {createSessionController} from '../secure-session.js';

// Explicit opt-in; never use the production or shared legacy database.
const project='mci2-secure-visanu81';
if(process.env.MCI_LIVE_TEST_PROJECT!==project)throw Error('Explicit isolated-test-project opt-in required');
const cfg=JSON.parse(fs.readFileSync('security/firebase-web-config.json','utf8'));
assert.equal(cfg.projectId,project);
assert.equal(cfg.databaseURL,'https://mci2-secure-visanu81-default-rtdb.asia-southeast1.firebasedatabase.app');
const sa=JSON.parse(fs.readFileSync('.tmp/auth-setup/service-account.json','utf8'));
assert.equal(sa.project_id,project);
const pepper=randomBytes(32).toString('base64url');
const codes=Array.from({length:3},()=>randomBytes(24).toString('base64url'));
const records=codes.map((code,i)=>({codeHash:createHmac('sha256',pepper).update(code).digest('base64url'),agencyId:i===2?'validation_b':'validation_a',agencyName:'검증 전용 가상 관서',role:i===1?'observer':'normal',active:true,expiresAt:Date.now()+600000}));
const env={FIREBASE_SERVICE_ACCOUNT:JSON.stringify(sa),FIREBASE_PROJECT_ID:project,FIREBASE_DATABASE_URL:cfg.databaseURL,PUBLIC_ORIGIN:'https://mci2.visanu81.workers.dev',MCI_CODE_PEPPER:pepper,MCI_LOGIN_RECORDS:JSON.stringify(records),AUTH_RATE_LIMIT:{limit:async()=>({success:true})}};
const run='validation-'+randomBytes(8).toString('hex');
const incidentPath='mci2/incidents/'+run;
const apps=[],sessions=[],uids=new Set(),users=new Set();
let adminToken,checks=0,cleanupErrors=[];
function pass(label){checks++;console.log('PASS '+label);}
async function waitFor(fn,label){const until=Date.now()+15000;while(Date.now()<until){if(fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+label);}
async function administrative(path,method='GET',data){
 assert(path===incidentPath || [...uids].some(uid=>path==='access/'+uid));
 const r=await fetch(cfg.databaseURL+'/'+path+'.json',{method,headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(12000)});
 assert.equal(r.ok,true,'admin operation HTTP '+r.status);return r.json();
}
async function client(path,user,method='GET',data){const url=new URL(cfg.databaseURL+'/'+path+'.json');if(user)url.searchParams.set('auth',await user.getIdToken());return fetch(url,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(12000)});}
async function loginFetch(_url,options){
 const request=new Request(env.PUBLIC_ORIGIN+'/api/auth/login',{...options,headers:{...options.headers,Origin:env.PUBLIC_ORIGIN,'CF-Connecting-IP':'192.0.2.1'}});
 const r=await handleAgencyLogin(request,env);
 if(r.ok){const body=await r.clone().json();const claim=JSON.parse(Buffer.from(body.token.split('.')[1],'base64url'));uids.add(claim.uid);}
 return r;
}
try{
 const now=Math.floor(Date.now()/1000);
 const part=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const input=part({alg:'RS256',typ:'JWT'})+'.'+part({iss:sa.client_email,scope:'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+300});
 const assertion=input+'.'+createSign('RSA-SHA256').update(input).sign(sa.private_key,'base64url');
 const oauth=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
 assert(oauth.ok,'service account OAuth failed');adminToken=(await oauth.json()).access_token;
 pass('service account OAuth');
 const invalid=await loginFetch('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'incorrect-validation-code'})});assert.equal(invalid.status,401);pass('invalid code rejected');
 for(let i=0;i<3;i++){
  const app=initializeApp(cfg,run+'-'+i);apps.push(app);
  const auth=authSDK.initializeAuth(app,{persistence:authSDK.inMemoryPersistence});
  const db=dbSDK.getDatabase(app);
  const controller=createSessionController({auth,db,sdk:{...authSDK,...dbSDK},onChange:()=>{},fetcher:loginFetch});
  sessions.push({auth,db,controller});controller.start();
  await controller.login(codes[i]);users.add(auth.currentUser);await waitFor(()=>controller.current(),'server grant');
  assert.equal(controller.current().agencyId,records[i].agencyId);
  assert.equal(controller.current().role,records[i].role);
 }
 pass('three real custom-token logins and realtime grant subscriptions');
 const [a,reader,b]=sessions;const user=a.auth.currentUser;
 const incident={agencyId:'validation_a',createdByUid:user.uid,title:'자동 검증용 가상 재난',startedAt:Date.now()-1000};
 assert((await client(incidentPath,user,'PUT',incident)).ok);pass('own agency incident created');
 const cardPath=incidentPath+'/mciCasualties/test-card';
 const card={name:'가상 환자',triage:'urgent',createdByUid:user.uid,updatedByUid:user.uid,timestamp:Date.now()-1000,rr:0,cardPhoto:'SYNTHETIC',notes:'original'};
 assert((await client(cardPath,user,'PUT',card)).ok);pass('synthetic card created');
 assert((await client(cardPath,user,'PATCH',{notes:'updated',updatedByUid:user.uid})).ok);
 const saved=await (await client(cardPath,user)).json();assert.equal(saved.rr,0);assert.equal(saved.cardPhoto,'SYNTHETIC');assert.equal(saved.notes,'updated');pass('card edit preserves zero and photo');
 assert((await client(cardPath,reader.auth.currentUser)).ok);pass('observer can read own agency');
 for(const [label,path,who,method,data] of [
 ['observer write denied',cardPath,reader.auth.currentUser,'PATCH',{notes:'forbidden',updatedByUid:reader.auth.currentUser.uid}],
 ['foreign agency read denied',cardPath,b.auth.currentUser,'GET'],
 ['unauthenticated read denied',cardPath,null,'GET'],
 ['grant self-promotion denied','access/'+user.uid,user,'PATCH',{role:'admin'}]
 ]){const r=await client(path,who,method,data);assert([401,403].includes(r.status),label+' HTTP '+r.status);pass(label);}
 await administrative('access/'+user.uid,'PATCH',{active:false});
 await waitFor(()=>a.controller.current()===null,'realtime revocation');pass('realtime grant revocation clears session');
 assert([401,403].includes((await client(cardPath,user,'PATCH',{notes:'after revoke',updatedByUid:user.uid})).status));pass('revoked token cannot write');
 await a.controller.login(codes[0]);users.add(a.auth.currentUser);await waitFor(()=>a.controller.current(),'new session');
 assert.notEqual(a.auth.currentUser.uid,user.uid);pass('relogin gets independent session');
 await administrative('access/'+a.auth.currentUser.uid,'PATCH',{expiresAt:Date.now()+1200});
 await waitFor(()=>a.controller.current()===null,'expiry');pass('live grant expiry clears session');
 assert([401,403].includes((await client(cardPath,a.auth.currentUser)).status));pass('expired grant cannot read');
}catch(e){console.error('FAIL '+e.message);process.exitCode=1;}
finally{
 for(const s of sessions){s.controller.stop();if(s.auth.currentUser)users.add(s.auth.currentUser);dbSDK.goOffline(s.db);}
 for(const user of users)try{await authSDK.deleteUser(user);}catch{cleanupErrors.push('temporary Auth user');}
 if(adminToken){for(const path of [incidentPath,...[...uids].map(uid=>'access/'+uid)])try{await administrative(path,'DELETE');}catch{cleanupErrors.push(path);}}
 for(const app of apps)await deleteApp(app);
 const result={project,checks,passed:!process.exitCode,cleanupComplete:cleanupErrors.length===0,cleanupErrors,at:new Date().toISOString()};
 fs.writeFileSync('.tmp/auth-setup/live-validation-result.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));if(cleanupErrors.length)process.exitCode=1;
}
