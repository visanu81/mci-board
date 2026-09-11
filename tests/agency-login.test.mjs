import {test,before} from 'node:test';
import assert from 'node:assert/strict';
import {handleAgencyLogin} from '../security/agency-login.mjs';
const code='test-only-code-128bits-minimum';
let env,publicKey;
const b64=v=>Buffer.from(v).toString('base64url');
before(async()=>{
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 publicKey=keys.publicKey;
 const key=Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64');
 const pepper='temporary-test-pepper-at-least-32-bytes';
 const hmac=await crypto.subtle.importKey('raw',new TextEncoder().encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const codeHash=b64(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(code)));
 env={FIREBASE_PROJECT_ID:'mci2-unit-test',FIREBASE_DATABASE_URL:'https://mci2-unit-test-default-rtdb.firebaseio.com',PUBLIC_ORIGIN:'https://mci2.visanu81.workers.dev',FIREBASE_SERVICE_ACCOUNT:JSON.stringify({project_id:'mci2-unit-test',client_email:'login@mci2-unit-test.iam.gserviceaccount.com',private_key:`-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`}),MCI_CODE_PEPPER:pepper,MCI_LOGIN_RECORDS:JSON.stringify([{codeHash,active:true,agencyId:'a',agencyName:'가상관서',role:'normal',expiresAt:Date.now()+86400000}]),AUTH_RATE_LIMIT:{limit:async()=>({success:true})}};
});
const request=(body={code},headers={})=>new Request('https://mci2.visanu81.workers.dev/api/auth/login',{method:'POST',headers:{Origin:'https://mci2.visanu81.workers.dev','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',...headers},body:JSON.stringify(body)});
const forbidden=()=>{throw Error('unexpected external request');};
for(const field of ['FIREBASE_PROJECT_ID','FIREBASE_DATABASE_URL','FIREBASE_SERVICE_ACCOUNT','MCI_CODE_PEPPER','MCI_LOGIN_RECORDS','AUTH_RATE_LIMIT']){
 test(`missing ${field} fails closed`,async()=>assert.equal((await handleAgencyLogin(request(),{...env,[field]:undefined},forbidden)).status,503));
}
test('production project cannot be configured',async()=>assert.equal((await handleAgencyLogin(request(),{...env,FIREBASE_PROJECT_ID:'disester-f3669'},forbidden)).status,503));
test('production database cannot be configured',async()=>assert.equal((await handleAgencyLogin(request(),{...env,FIREBASE_DATABASE_URL:'https://disester-f3669-default-rtdb.firebaseio.com'},forbidden)).status,503));
test('foreign origin rejected',async()=>assert.equal((await handleAgencyLogin(request({code},{Origin:'https://evil.example'}),env,forbidden)).status,403));
test('client cannot nominate an admin role',async()=>assert.equal((await handleAgencyLogin(request({code,role:'admin'}),env,forbidden)).status,400));
test('incorrect code rejected',async()=>assert.equal((await handleAgencyLogin(request({code:'incorrect-code-at-least-16'}),env,forbidden)).status,401));
test('expired code rejected',async()=>{const records=JSON.parse(env.MCI_LOGIN_RECORDS);records[0].expiresAt=0;assert.equal((await handleAgencyLogin(request(),{...env,MCI_LOGIN_RECORDS:JSON.stringify(records)},forbidden)).status,401);});
test('rate limit blocks before token mint',async()=>assert.equal((await handleAgencyLogin(request(),{...env,AUTH_RATE_LIMIT:{limit:async()=>({success:false})}},forbidden)).status,429));
test('actual oversized body rejected without trusting content-length',async()=>assert.equal((await handleAgencyLogin(request({code:'x'.repeat(2048)}),env,forbidden)).status,400));
test('grant persistence failure never returns token',async()=>{
 let n=0;const transport=async()=>++n===1?new Response(JSON.stringify({access_token:'fixture-oauth'})):new Response('',{status:503});
 const r=await handleAgencyLogin(request(),env,transport);assert.equal(r.status,503);assert.equal((await r.json()).token,undefined);
});
test('server error details are not returned',async()=>{
 const r=await handleAgencyLogin(request(),env,()=>{throw Error('PRIVATE SECRET DETAIL');});assert.equal(r.status,503);assert.ok(!(await r.text()).includes('PRIVATE SECRET'));
});
test('valid code creates limited grant before returning verifiable custom token',async()=>{
 const calls=[];
 const transport=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('oauth2')?{access_token:'fixture-oauth'}:{ok:true}));};
 const r=await handleAgencyLogin(request(),env,transport);assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');
 const {token,expiresAt}=await r.json();const parts=token.split('.');
 assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,Buffer.from(parts[2],'base64url'),new TextEncoder().encode(parts[0]+'.'+parts[1])));
 const payload=JSON.parse(Buffer.from(parts[1],'base64url'));
 assert.deepEqual(payload.claims,{mci_env:'test'});assert.equal(payload.exp-payload.iat,300);assert.ok(payload.uid.startsWith('mci2-'));
 assert.equal(calls.length,2);assert.equal(calls[1].url,'https://mci2-unit-test-default-rtdb.firebaseio.com/access/'+payload.uid+'.json');
 const grant=JSON.parse(calls[1].options.body);assert.equal(grant.role,'normal');assert.equal(grant.agencyId,'a');assert.equal(grant.expiresAt,expiresAt);assert.ok(expiresAt<=Date.now()+12*3600000);assert.equal(calls[1].options.headers.Authorization,'Bearer fixture-oauth');
 assert.ok(!token.includes(code));
});
