import {test} from 'node:test';
import assert from 'node:assert/strict';
import {closeIncident} from '../security/incident-close.mjs';
function fixture(options={}){
 let incident={agencyId:'a',createdByUid:'alice',title:'fixture',startedAt:1,mciCasualties:{one:{name:'before'}}},version=1,archives={},calls=[],fail=options.fail;
 const db=async(path,method='GET',body,headers={})=>{
  calls.push({path,method});
  if(method==='GET')return Response.json(incident,{headers:{etag:'"'+version+'"'}});
  if(method==='PUT' && path.includes('/incidents/')){
   if(options.race){incident.mciCasualties.one.name='latest';version++;options.race=false;}
   if(headers['if-match']!=='"'+version+'"')return new Response(null,{status:412});
   incident=structuredClone(body);version++;
   if(fail==='freeze-response'){fail=null;throw Error('lost response');}
  } else if(path.includes('/archives/')){
   if(fail==='archive'){fail=null;return new Response(null,{status:503});}
   archives[path]=structuredClone(body);
   if(fail==='archive-response'){fail=null;throw Error('lost response');}
  } else if(method==='PATCH'){
   if(fail==='final'){fail=null;return new Response(null,{status:503});}
   Object.assign(incident,body);
   if(fail==='final-response'){fail=null;throw Error('lost response');}
  } else throw Error('unexpected write');
  return Response.json({});
 };
 return {run:(input={incidentId:'one'},auth=async()=>true)=>closeIncident(input,db,'admin',auth),get:()=>({incident,archives,calls})};
}
test('freeze, archive and finish preserve original records',async()=>{const f=fixture();assert.equal((await f.run()).status,200);const {incident,archives,calls}=f.get();assert(incident.closedAt);assert.equal(incident.mciCasualties.one.name,'before');assert.equal(Object.values(archives)[0].data.mciCasualties[0].name,'before');assert.deepEqual(calls.map(c=>c.method),['GET','PUT','PUT','PATCH']);});
test('concurrent edit causes conflict and is included on retry',async()=>{const f=fixture({race:true});assert.equal((await f.run()).status,409);assert.equal(Object.keys(f.get().archives).length,0);assert.equal((await f.run()).status,200);assert.equal(Object.values(f.get().archives)[0].data.mciCasualties[0].name,'latest');});
for(const fail of ['freeze-response','archive','archive-response','final','final-response'])test('retry recovers '+fail+' with one archive and intact source',async()=>{const f=fixture({fail});assert.equal((await f.run()).status,503);assert.equal(f.get().incident.mciCasualties.one.name,'before');assert.equal((await f.run()).status,200);assert.equal(Object.keys(f.get().archives).length,1);assert(f.get().incident.closedAt);});
test('lost authorization does not freeze data',async()=>{const f=fixture();assert.equal((await f.run(undefined,async()=>false)).status,403);assert(!f.get().incident.closure);});
test('authorization revoked after freeze retains resumable original',async()=>{const f=fixture();let n=0;assert.equal((await f.run(undefined,async()=>++n===1)).status,403);assert(f.get().incident.closure);assert(!f.get().incident.closedAt);assert.equal((await f.run()).status,200);});
test('malicious paths and unexpected input cannot touch database',async()=>{const f=fixture();assert.equal((await f.run({incidentId:'../other'})).status,400);assert.equal((await f.run({incidentId:'one',role:'admin'})).status,400);assert.equal(f.get().calls.length,0);});
