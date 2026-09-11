import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {sendBoundOperation} from '../secure-session.js';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function mciTransportStatus('),html.indexOf('function workspaceConnectionText('));
const {mciTransportStatus,buildTransportChange}=new Function(source+';return {mciTransportStatus,buildTransportChange}')();
const baseline={hospital:'',departTime:'',arriveTime:'',name:'TEST',notes:'keep',createdByUid:'u',timestamp:1,patientPhoto:'preserve'};
test('assignment differs from departure',()=>{assert.equal(mciTransportStatus({hospital:'A'}),'assigned');assert.equal(mciTransportStatus({hospital:'A',departTime:'09:00'}),'in-transit');assert.equal(mciTransportStatus({arriveTime:'09:30'}),'arrived');assert.equal(mciTransportStatus({notTransported:true}),'not-transported');});
test('patch only contains transport fields and normalizes time',()=>{const {payload}=buildTransportChange({hospital:' A ',departTime:'0900',arriveTime:''},baseline);assert.equal(payload.departTime,'09:00');assert.equal(payload.hospital,'A');assert(!('name' in payload));assert(!('patientPhoto' in payload));});
test('invalid clock rejected',()=>{for(const time of ['2500','12:65','abc'])assert.throws(()=>buildTransportChange({hospital:'A',departTime:time,arriveTime:''},baseline));});
test('arrival requires departure and hospital',()=>{assert.throws(()=>buildTransportChange({hospital:'A',departTime:'',arriveTime:'1200'},baseline));assert.throws(()=>buildTransportChange({hospital:'',departTime:'1100',arriveTime:''},baseline));});
test('midnight crossing allowed without dates',()=>{assert.equal(buildTransportChange({hospital:'A',departTime:'2355',arriveTime:'0010'},baseline).payload.arriveTime,'00:10');});
test('unchanged form has no operation',()=>{assert.deepEqual(buildTransportChange(baseline,baseline).payload,{});});
const identity={uid:'u',agencyId:'a',active:true,environment:'test',role:'normal',expiresAt:Date.now()+60000};
const context={projectId:'mci2-test',databaseURL:'https://fixture.invalid',currentIdentity:()=>identity,currentUser:()=>({uid:'u',getIdToken:async()=>'fixture'})};
function op(){return {method:'update',path:'mci2/incidents/test/mciCasualties/card',securityContext:{uid:'u',agencyId:'a',projectId:'mci2-test'},...buildTransportChange({hospital:'A',departTime:'0900',arriveTime:''},baseline)};}
test('actual sender blocks concurrent transport change',async()=>{let writes=0;await assert.rejects(sendBoundOperation(op(),context,async(url,init)=>{if(init.method)writes++;return new Response(JSON.stringify({...baseline,hospital:'B'}),{headers:{ETag:'"1"'}});}),{code:'write_conflict'});assert.equal(writes,0);});
test('actual sender preserves photos and colleague notes',async()=>{let saved;await sendBoundOperation(op(),context,async(url,init)=>{if(init.method){saved=JSON.parse(init.body);return new Response('{}');}return new Response(JSON.stringify({...baseline,notes:'colleague edit'}),{headers:{ETag:'"1"'}});});assert.equal(saved.notes,'colleague edit');assert.equal(saved.patientPhoto,'preserve');assert.equal(saved.hospital,'A');});
