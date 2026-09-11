import {test} from 'node:test';import assert from 'node:assert/strict';import {sendBoundOperation} from '../secure-session.js';
const original={createdByUid:'one',updatedByUid:'one',timestamp:123,name:'fixture',triage:'urgent',notes:'before'};
function fixture(current=null,{race,storageFail=false,lost=false}={}){
 let record=current,attempted=false,writes=0,version=1;
 const identity={uid:'one',active:true,environment:'test',role:'normal',agencyId:'a',expiresAt:Date.now()+60000};
 const context={projectId:'mci2-unit',databaseURL:'https://mci2-unit-default-rtdb.firebaseio.com',currentIdentity:()=>identity,currentUser:()=>({uid:'one',getIdToken:async()=> 'fixture'}),beforeCreate:async()=>{if(storageFail)throw Error('storage');attempted=true;}};
 const fetcher=async(url,request)=>{
  if(!request.method)return Response.json(record,{headers:{etag:'"'+version+'"'}});
  if(race){record={...original,notes:'late edit'};race=false;version++;return new Response(null,{status:412});}
  assert.equal(request.headers['if-match'],'"'+version+'"');writes++;
  record=request.method==='DELETE'?null:JSON.parse(request.body);version++;
  if(lost){lost=false;throw Error('lost');}return Response.json(record);
 };
 return {run:(method='set',extra={})=>sendBoundOperation({path:'mci2/incidents/one/mciCasualties/one',method,payload:original,expected:original,creationGuard:true,creationAttempted:attempted,securityContext:{uid:'one',agencyId:'a',projectId:'mci2-unit'},...extra},context,fetcher),get:()=>({record,attempted,writes}),erase:()=>{record=null;version++;}};
}
test('first create records attempt before conditional write',async()=>{const f=fixture();await f.run();assert(f.get().attempted);assert.equal(f.get().writes,1);});
test('retry preserves colleague changes to already-created card',async()=>{const f=fixture({...original,notes:'colleague'});await f.run();assert.equal(f.get().writes,0);assert.equal(f.get().record.notes,'colleague');});
test('lost create response retries without overwriting',async()=>{const f=fixture(null,{lost:true});await assert.rejects(f.run());await f.run();assert.equal(f.get().writes,1);});
test('retry cannot resurrect card deleted after lost create response',async()=>{const f=fixture(null,{lost:true});await assert.rejects(f.run());f.erase();await assert.rejects(f.run(),e=>e.code==='write_conflict');assert.equal(f.get().record,null);});
test('legacy create without attempt tracking stops if absent',async()=>{const f=fixture();await assert.rejects(f.run('set',{creationGuard:undefined}),e=>e.code==='write_conflict');assert.equal(f.get().writes,0);});
test('failure to persist attempt prevents create',async()=>{const f=fixture(null,{storageFail:true});await assert.rejects(f.run(),/storage/);assert.equal(f.get().writes,0);});
test('unrelated key collision is not overwritten',async()=>{const f=fixture({...original,createdByUid:'other'});await assert.rejects(f.run(),e=>e.code==='write_conflict');assert.equal(f.get().writes,0);});
test('delete unchanged snapshot uses conditional delete',async()=>{const f=fixture(original);await f.run('remove');assert.equal(f.get().record,null);});
test('delete changed snapshot stops for review',async()=>{const f=fixture({...original,notes:'new'});await assert.rejects(f.run('remove'),e=>e.code==='write_conflict' && e.current.notes==='new');assert.equal(f.get().writes,0);});
test('delete race after read preserves newer record',async()=>{const f=fixture(original,{race:true});await assert.rejects(f.run('remove'));await assert.rejects(f.run('remove'),e=>e.code==='write_conflict');assert.equal(f.get().record.notes,'late edit');});
test('lost delete response can safely retry',async()=>{const f=fixture(original,{lost:true});await assert.rejects(f.run('remove'));await f.run('remove');assert.equal(f.get().writes,1);});
test('delete without original snapshot is blocked',async()=>{const f=fixture(original);await assert.rejects(f.run('remove',{expected:undefined}),e=>e.code==='write_conflict');assert.equal(f.get().writes,0);});
