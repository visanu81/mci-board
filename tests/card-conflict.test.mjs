import {test} from 'node:test';import assert from 'node:assert/strict';import {sendBoundOperation} from '../secure-session.js';
function fixture(current={notes:'before',hospital:'original'},options={}){
 let state=structuredClone(current),version=1,writes=0,reads=0;
 const identity={uid:'one',active:true,environment:'test',role:'normal',agencyId:'a',expiresAt:Date.now()+60000};
 const context={projectId:'mci2-unit',databaseURL:'https://mci2-unit-default-rtdb.firebaseio.com',currentIdentity:()=>identity,currentUser:()=>({uid:identity.uid,getIdToken:async()=> 'fixture-token'})};
 const operation={path:'mci2/incidents/one/mciCasualties/one',method:'update',expected:{notes:'before'},payload:{notes:'mine',updatedByUid:'one'},securityContext:{uid:'one',agencyId:'a',projectId:'mci2-unit'}};
 const fetcher=async(url,request)=>{
  assert.equal(new URL(url).searchParams.get('auth'),'fixture-token');
  if(request.method!=='PUT'){reads++;if(options.switchUser)identity.uid='two';return Response.json(state,{headers:{etag:'"'+version+'"'}});}
  writes++;
  if(options.race){Object.assign(state,options.race);options.race=null;version++;return new Response(null,{status:412});}
  assert.equal(request.headers['if-match'],'"'+version+'"');state=JSON.parse(request.body);version++;
  if(options.lost){options.lost=false;throw Error('lost response');}return Response.json(state);
 };
 return {run:(patch={})=>sendBoundOperation({...operation,...patch},context,fetcher),get:()=>({state,reads,writes})};
}
test('conflicting field stops without mutation and carries current values',async()=>{const f=fixture({notes:'colleague'});await assert.rejects(f.run(),e=>e.code==='write_conflict' && e.current.notes==='colleague');assert.equal(f.get().writes,0);});
test('non-overlapping edit merges latest colleague data',async()=>{const f=fixture({notes:'before',hospital:'colleague'});await f.run();assert.deepEqual(f.get().state,{notes:'mine',hospital:'colleague',updatedByUid:'one'});});
test('ETag race on same field cannot overwrite colleague',async()=>{const f=fixture(undefined,{race:{notes:'late colleague'}});await assert.rejects(f.run(),e=>e.code==='write_conflict');assert.equal(f.get().state.notes,'late colleague');});
test('ETag race on other field retries and preserves it',async()=>{const f=fixture(undefined,{race:{hospital:'late hospital'}});await f.run();assert.equal(f.get().state.hospital,'late hospital');assert.equal(f.get().state.notes,'mine');});
test('lost success response can safely retry',async()=>{const f=fixture(undefined,{lost:true});await assert.rejects(f.run());await f.run();assert.equal(f.get().state.notes,'mine');});
test('deleted card is never recreated by stale edit',async()=>{const f=fixture(null);await assert.rejects(f.run(),e=>e.code==='write_conflict');assert.equal(f.get().writes,0);});
test('old unbound edit is blocked',async()=>{const f=fixture();await assert.rejects(f.run({expected:undefined}),e=>e.code==='write_conflict');assert.equal(f.get().reads,0);});
test('identity change during latest-value read prevents mutation',async()=>{const f=fixture(undefined,{switchUser:true});await assert.rejects(f.run(),/permission_denied/);assert.equal(f.get().writes,0);});
test('user-selected current baseline remains guarded',async()=>{const f=fixture({notes:'changed again'});await assert.rejects(f.run({expected:{notes:'colleague'}}),e=>e.code==='write_conflict');assert.equal(f.get().writes,0);});
test('explicit null removes only selected field',async()=>{const f=fixture();await f.run({payload:{notes:null},expected:{notes:'before'}});assert.equal(f.get().state.notes,null);assert.equal(f.get().state.hospital,'original');});
