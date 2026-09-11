import {before,test} from 'node:test';
import assert from 'node:assert/strict';
import {handleAccessManagement} from '../security/access-management.mjs';
let account;
before(async()=>{const p=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);account={project_id:'mci2-unit',client_email:'server@mci2-unit.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',p.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----'};});
function fixture({role='admin',conflict=false}={}){
 const id='a'.repeat(43),other='b'.repeat(43),grant={agencyId:'a',agencyName:'A',role,environment:'test',active:true,expiresAt:Date.now()+60000,codeId:id};
 let records={[id]:{...grant},[other]:{...grant}},written;
 const env={FIREBASE_PROJECT_ID:'mci2-unit',FIREBASE_DATABASE_URL:'https://mci2-unit-default-rtdb.firebaseio.com',FIREBASE_SERVICE_ACCOUNT:JSON.stringify(account),MCI_CODE_STORE:'database',MCI_CODE_PEPPER:'x'.repeat(32),PUBLIC_ORIGIN:'https://mci2.visanu81.workers.dev',AUTH_RATE_LIMIT:{limit:async()=>({success:true})}};
 const transport=async(url,opt={})=>{const u=String(url),method=opt.method||'GET';if(u.includes('oauth2.googleapis.com'))return Response.json({access_token:'fixture'});if(u.includes('/access/admin.json'))return Response.json(grant);if(u.includes('/serverCodes.json')){if(method==='PUT'){assert.equal(opt.headers['if-match'],'"version1"');if(conflict)return new Response(null,{status:412});records=JSON.parse(opt.body);}return Response.json(records,{headers:{etag:'"version1"'}});}if(u.includes('/mci2/incidents/'))return Response.json({agencyId:u.includes('/foreign.')?'b':'a'});if(u.includes('/access/')){written=JSON.parse(opt.body);return Response.json(written);}throw Error('unexpected request');};
 const call=(body,path='/api/admin/codes',origin=env.PUBLIC_ORIGIN)=>handleAccessManagement(new Request(env.PUBLIC_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Authorization:'Bearer fixture','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,async()=>({sub:'admin',mci_env:'test'}),transport);
 return {call,id,other,grant,getWritten:()=>written,getRecords:()=>records};
}
test('normal cannot list administrative codes',async()=>assert.equal((await fixture({role:'normal'}).call()).status,403));
test('foreign origin rejected before code creation',async()=>assert.equal((await fixture().call({action:'create'},undefined,'https://other.invalid')).status,403));
test('list exposes only metadata',async()=>{const f=fixture(),r=await f.call();assert.equal(r.status,200);const b=await r.json();assert(!JSON.stringify(b).includes('codeId'));assert(!JSON.stringify(b).includes('codeHash'));});
test('create random code and persist no plaintext',async()=>{const f=fixture(),r=await f.call({action:'create',agencyId:'a',agencyName:'A',role:'normal',days:7});assert.equal(r.status,200);const b=await r.json();assert.equal(b.code.length,48);assert.equal(b.id.length,43);assert(!JSON.stringify(f.getRecords()).includes(b.code));});
test('cannot provide chosen code or arbitrary fields',async()=>assert.equal((await fixture().call({action:'create',agencyId:'a',agencyName:'A',role:'normal',days:7,code:'guessable'})).status,400));
test('reject overlong code validity',async()=>assert.equal((await fixture().call({action:'create',agencyId:'a',agencyName:'A',role:'normal',days:31})).status,400));
test('self revoke denied',async()=>{const f=fixture();assert.equal((await f.call({action:'revoke',id:f.id})).status,409);});
test('revoke deactivates record',async()=>{const f=fixture();assert.equal((await f.call({action:'revoke',id:f.other})).status,200);assert.equal(f.getRecords()[f.other].active,false);});
test('ETag conflict reported without overwrite',async()=>{const f=fixture({conflict:true});assert.equal((await f.call({action:'revoke',id:f.other})).status,409);});
test('display issue forces read-only and incident scope',async()=>{const f=fixture({role:'normal'}),r=await f.call({incidentId:'own'},'/api/auth/display');assert.equal(r.status,200);const g=f.getWritten();assert.equal(g.role,'display');assert.equal(g.incidentId,'own');assert.equal(g.parentUid,'admin');assert.equal(g.codeId,f.id);assert(g.expiresAt<=f.grant.expiresAt);});
test('cannot issue display for another agency',async()=>assert.equal((await fixture({role:'normal'}).call({incidentId:'foreign'},'/api/auth/display')).status,403));
test('observer cannot issue delegated display',async()=>assert.equal((await fixture({role:'observer'}).call({incidentId:'own'},'/api/auth/display')).status,403));
test('display role cannot forge delegation role',async()=>assert.equal((await fixture().call({incidentId:'own',role:'admin'},'/api/auth/display')).status,400));
test('HQ cannot manage codes',async()=>assert.equal((await fixture({role:'hq'}).call()).status,403));
