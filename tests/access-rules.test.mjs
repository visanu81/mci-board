import fs from 'node:fs';
import { before, after, test } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, get, set, update, remove, query, orderByChild, equalTo } from 'firebase/database';

// Safety: these tests must never target a live Firebase project.
const endpoint = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (endpoint !== '127.0.0.1:19000') throw new Error('Use the loopback database emulator on port 19000');
const projectId = 'demo-mci-access';
let env;
const now = Date.now();
const card = (uid, name = '가상환자') => ({createdByUid:uid,updatedByUid:uid,timestamp:now-1000,name,triage:'urgent',rr:0,notes:'원본',cardPhoto:'PHOTO'});
const record = (agencyId, uid) => ({agencyId,createdByUid:uid,title:'가상 재난',startedAt:now-10000,mciCasualties:{one:card(uid)},casualties:{one:card(uid)}});
const session = (agencyId,role='normal',extra={}) => ({agencyId,role,active:true,environment:'test',expiresAt:now+3600000,...extra});
const db = (uid, claims = {mci_env:'test'}) => uid ? env.authenticatedContext(uid,claims).database() : env.unauthenticatedContext().database();
const at = (uid,path) => ref(db(uid),path);
before(async()=>{
 env=await initializeTestEnvironment({projectId,database:{host:'127.0.0.1',port:19000,rules:fs.readFileSync('security/database.test.rules.json','utf8')}});
 await env.withSecurityRulesDisabled(async ctx=>set(ref(ctx.database()),{access:{alice:session('a'),bob:session('b'),peer:session('a'),reader:session('a','observer'),display:session('a','display'),admin:session('hq','admin'),expired:session('a','normal',{expiresAt:now-1}),revoked:session('a','normal',{active:false}),wrongEnv:session('a','normal',{environment:'production'})},mci2:{incidents:{a:record('a','alice'),b:record('b','bob'),closed:{...record('a','alice'),closedAt:now-10}},archives:{sample:{data:'가상 보관함'}},config:{agencyCodes:{secret:'fixture-only'}}}}));
});
after(async()=>{if(env)await env.cleanup();});
for(const uid of [null,'unapproved','expired','revoked','wrongEnv']) {
 test(`${uid || 'unauthenticated'} cannot read patient data`,()=>assertFails(get(at(uid,'mci2/incidents/a'))));
 test(`${uid || 'unauthenticated'} cannot write patient data`,()=>assertFails(update(at(uid,'mci2/incidents/a/mciCasualties/one'),{notes:'blocked',updatedByUid:uid||'x'})));
}
test('anonymous Firebase identity without environment claim cannot read',()=>assertFails(get(ref(db('alice',{}),'mci2/incidents/a'))));
test('production environment token cannot read test data',()=>assertFails(get(ref(db('alice',{mci_env:'production'}),'mci2/incidents/a'))));
test('member can read own agency incident',()=>assertSucceeds(get(at('alice','mci2/incidents/a'))));
test('member cannot read another agency incident',()=>assertFails(get(at('alice','mci2/incidents/b'))));
test('member cannot fetch unfiltered incident root',()=>assertFails(get(at('alice','mci2/incidents'))));
test('agency-filtered query is permitted',()=>assertSucceeds(get(query(at('alice','mci2/incidents'),orderByChild('agencyId'),equalTo('a')))));
test('query for another agency is rejected',()=>assertFails(get(query(at('alice','mci2/incidents'),orderByChild('agencyId'),equalTo('b')))));
for(const uid of ['reader','display']) {
 test(`${uid} can read assigned agency`,()=>assertSucceeds(get(at(uid,'mci2/incidents/a'))));
 test(`${uid} cannot edit patient`,()=>assertFails(update(at(uid,'mci2/incidents/a/mciCasualties/one'),{notes:'blocked',updatedByUid:uid})));
 test(`${uid} cannot delete patient`,()=>assertFails(remove(at(uid,'mci2/incidents/a/mciCasualties/one'))));
 test(`${uid} cannot create incident`,()=>assertFails(set(at(uid,'mci2/incidents/read-only-created'),record('a',uid))));
}
test('forged admin token claim cannot override server grant',()=>assertFails(get(ref(db('bob',{mci_env:'test',role:'admin',agencyId:'a'}),'mci2/incidents/a'))));
test('member cannot promote own grant',()=>assertFails(update(at('alice','access/alice'),{role:'admin'})));
test('admin client cannot issue grants',()=>assertFails(set(at('admin','access/new'),session('a','admin'))));
test('member can check own revocation state',()=>assertSucceeds(get(at('alice','access/alice'))));
test('member cannot enumerate other grants',()=>assertFails(get(at('alice','access'))));
test('member cannot read another grant',()=>assertFails(get(at('alice','access/bob'))));
for(const uid of ['alice','admin']) {
 test(`${uid} cannot download login codes`,()=>assertFails(get(at(uid,'mci2/config/agencyCodes'))));
 test(`${uid} cannot replace login codes`,()=>assertFails(set(at(uid,'mci2/config/agencyCodes'),{code:'injected'})));
}
test('member can create own agency incident',()=>assertSucceeds(set(at('alice','mci2/incidents/new'),record('a','alice'))));
test('member cannot create foreign agency incident',()=>assertFails(set(at('alice','mci2/incidents/foreign'),record('b','alice'))));
test('member cannot change incident ownership',()=>assertFails(update(at('alice','mci2/incidents/a'),{agencyId:'b'})));
test('member cannot remove incident ownership',()=>assertFails(remove(at('alice','mci2/incidents/a/agencyId'))));
test('member cannot delete entire incident',()=>assertFails(remove(at('alice','mci2/incidents/a'))));
test('member cannot edit a closed incident',()=>assertFails(update(at('alice','mci2/incidents/closed/mciCasualties/one'),{notes:'blocked',updatedByUid:'alice'})));
test('member cannot reopen closed incident',()=>assertFails(remove(at('alice','mci2/incidents/closed/closedAt'))));
for(const collection of ['casualties','mciCasualties']) {
 test(`${collection}: colleague may update notes with verified editor UID`,()=>assertSucceeds(update(at('peer',`mci2/incidents/a/${collection}/one`),{notes:'동료 수정',updatedByUid:'peer'})));
 test(`${collection}: cannot forge editor`,()=>assertFails(update(at('peer',`mci2/incidents/a/${collection}/one`),{notes:'spoof',updatedByUid:'alice'})));
 test(`${collection}: cannot replace original author`,()=>assertFails(update(at('peer',`mci2/incidents/a/${collection}/one`),{createdByUid:'peer',updatedByUid:'peer'})));
 test(`${collection}: cannot remove required author`,()=>assertFails(update(at('peer',`mci2/incidents/a/${collection}/one`),{createdByUid:null,updatedByUid:'peer'})));
 test(`${collection}: colleague cannot delete someone else's card`,()=>assertFails(remove(at('peer',`mci2/incidents/a/${collection}/one`))));
 test(`${collection}: foreign agency cannot update`,()=>assertFails(update(at('bob',`mci2/incidents/a/${collection}/one`),{notes:'blocked',updatedByUid:'bob'})));
}
test('atomic cross-agency update is rejected as a whole',async()=>{
 await assertFails(update(ref(db('alice')),{ 'mci2/incidents/a/title':'should not commit','mci2/incidents/b/title':'forbidden' }));
 const snap=await assertSucceeds(get(at('alice','mci2/incidents/a/title')));if(snap.val()!=='가상 재난')throw Error('Partial commit');
});
test('oversized notes rejected',()=>assertFails(update(at('alice','mci2/incidents/a/mciCasualties/one'),{notes:'x'.repeat(3001),updatedByUid:'alice'})));
test('unknown card privilege field rejected',()=>assertFails(update(at('alice','mci2/incidents/a/mciCasualties/one'),{role:'admin',updatedByUid:'alice'})));
test('admin can read all incidents',()=>assertSucceeds(get(at('admin','mci2/incidents'))));
test('admin can access archive',()=>assertSucceeds(get(at('admin','mci2/archives'))));
test('member cannot access archive',()=>assertFails(get(at('alice','mci2/archives'))));
test('test grants cannot read legacy production paths',()=>assertFails(get(at('admin','incidents'))));
test('revocation takes effect without changing token',async()=>{
 const r=at('peer','mci2/incidents/a/title');await assertSucceeds(get(r));
 await env.withSecurityRulesDisabled(ctx=>update(ref(ctx.database(),'access/peer'),{active:false}));
 await assertFails(update(at('peer','mci2/incidents/a/mciCasualties/one'),{notes:'after revoke',updatedByUid:'peer'}));
});
