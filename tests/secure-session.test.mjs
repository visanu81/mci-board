import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionController,isActiveGrant,mayReplay,validateTestConfig} from '../secure-session.js';
const grant=()=>({active:true,environment:'test',agencyId:'a',role:'normal',expiresAt:Date.now()+3600000});
const op=()=>({path:'mci2/incidents/one/mciCasualties/card',securityContext:{uid:'one',projectId:'mci2-test',agencyId:'a'}});
const identity=()=>({...grant(),uid:'one'});
const cfg={firebase:{projectId:'mci2-test',databaseURL:'https://mci2-test-default-rtdb.firebaseio.com',authDomain:'mci2-test.firebaseapp.com',apiKey:'public-fixture'}};
test('accept separate test Firebase configuration',()=>assert.equal(validateTestConfig(cfg).projectId,'mci2-test'));
test('reject legacy production project',()=>assert.throws(()=>validateTestConfig({firebase:{...cfg.firebase,projectId:'disester-f3669'}})));
test('reject production database with test label',()=>assert.throws(()=>validateTestConfig({firebase:{...cfg.firebase,databaseURL:'https://disester-f3669-default-rtdb.firebaseio.com'}})));
test('grant expiry enforced locally',()=>assert.equal(isActiveGrant({...grant(),expiresAt:Date.now()-1}),false));
test('same identity may replay',()=>assert.equal(mayReplay(op(),identity(),'mci2-test'),true));
for(const [label,operation,current,project] of [
 ['missing identity',op(),null,'mci2-test'],['different login',op(),{...identity(),uid:'two'},'mci2-test'],['different project',op(),identity(),'mci2-other'],['different agency',op(),{...identity(),agencyId:'b'},'mci2-test'],['read-only session',op(),{...identity(),role:'observer'},'mci2-test'],['unbound legacy record',{path:op().path},identity(),'mci2-test'],['production path',{...op(),path:'incidents/one/mciCasualties/card'},identity(),'mci2-test'],['arbitrary config path',{...op(),path:'mci2/config/agencyCodes/one'},identity(),'mci2-test']]){
 test('block replay: '+label,()=>assert.equal(mayReplay(operation,current,project),false));
}
function harness(){
 const changes=[],callbacks=[],timers=[],requests=[];let authCallback;
 const sdk={ref:(_,path)=>path,onAuthStateChanged:(_,cb)=>{authCallback=cb;return()=>{};},onValue:(r,cb,err)=>{callbacks.push({r,cb,err,stopped:false});const index=callbacks.length-1;return()=>{callbacks[index].stopped=true;};},signInWithCustomToken:async(a,token)=>{requests.push({token});},signOut:async()=>{requests.push({logout:true});}};
 const c=createSessionController({auth:{},db:{},sdk,onChange:x=>changes.push(x),setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{},fetcher:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({token:'fixture-custom-token'}));}});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 return {c,changes,callbacks,timers,requests,async user(uid,claims={mci_env:'test'}){authCallback(uid?{uid,getIdTokenResult:async()=>({claims})}:null);await tick();}};
}
test('restored Firebase identity requires a server grant',async()=>{const h=harness();h.c.start();await h.user('one');assert.equal(h.c.current(),null);h.callbacks[0].cb({val:grant});assert.equal(h.c.current().uid,'one');});
test('unclaimed Firebase identity never subscribes to grant',async()=>{const h=harness();h.c.start();await h.user('one',{});assert.equal(h.callbacks.length,0);assert.equal(h.c.current(),null);});
test('revocation immediately clears current session',async()=>{const h=harness();h.c.start();await h.user('one');h.callbacks[0].cb({val:grant});h.callbacks[0].cb({val:()=>({...grant(),active:false})});assert.equal(h.c.current(),null);});
test('expiry timer clears current session',async()=>{const h=harness();h.c.start();await h.user('one');h.callbacks[0].cb({val:grant});h.timers[0]();assert.equal(h.c.current(),null);});
test('stale previous-user callbacks cannot restore permission',async()=>{const h=harness();h.c.start();await h.user('one');const old=h.callbacks[0];old.cb({val:grant});await h.user('two');old.cb({val:grant});assert.equal(h.c.current(),null);assert.equal(old.stopped,true);});
test('logout invalidates permission before SDK completes',async()=>{const h=harness();h.c.start();await h.user('one');h.callbacks[0].cb({val:grant});await h.c.logout();assert.equal(h.c.current(),null);assert.ok(h.requests.some(x=>x.logout));});
test('browser sends only code, then exchanges custom token',async()=>{const h=harness();await h.c.login('fixture-code');assert.deepEqual(h.requests[0],{url:'/api/auth/login',body:{code:'fixture-code'}});assert.deepEqual(h.requests[1],{token:'fixture-custom-token'});});
import {sendBoundOperation} from '../secure-session.js';
test('card REST request carries the original identity token',async()=>{
 let sent;
 await sendBoundOperation({...op(),method:'set',payload:{notes:'fixture'}},{currentIdentity:identity,currentUser:()=>({uid:'one',getIdToken:async()=> 'original-token'}),projectId:'mci2-test',databaseURL:cfg.firebase.databaseURL},async(url,options)=>{sent={url:new URL(url),options};return new Response('{}');});
 assert.equal(sent.url.searchParams.get('auth'),'original-token');assert.equal(sent.options.method,'PUT');
});
test('identity change during token refresh prevents network send',async()=>{
 let current=identity(),sent=false;
 await assert.rejects(sendBoundOperation({...op(),method:'remove'},{currentIdentity:()=>current,currentUser:()=>({uid:current.uid,getIdToken:async()=>{current={...identity(),uid:'two'};return 'old-token';}}),projectId:'mci2-test',databaseURL:cfg.firebase.databaseURL},async()=>{sent=true;return new Response('{}');}));
 assert.equal(sent,false);
});

for (const suffix of ['incident','damages/medical','mobilizations/medical','actions/log']) {
  test('field write '+suffix+' is bound to the original session',async()=>{
    const operation={...op(),path:'mci2/incidents/one/'+suffix,method:'set',payload:{fixture:true}};
    assert.equal(mayReplay(operation,identity(),'mci2-test'),true);
    let current=identity(),sent=false;
    await assert.rejects(sendBoundOperation(operation,{currentIdentity:()=>current,currentUser:()=>({uid:current.uid,getIdToken:async()=>{current={...identity(),uid:'two'};return 'old-token';}}),projectId:'mci2-test',databaseURL:cfg.firebase.databaseURL},async()=>{sent=true;return new Response('{}');}));
    assert.equal(sent,false);
  });
}
for (const path of ['mci2/incidents/one','mci2/archives/one','mci2/incidents/one/actions/../incident','mci2/incidents/one/actions/key?auth=x','mci2/incidents/one/actions/key/child']) {
  test('field queue rejects unsafe or administrative path '+path,()=>assert.equal(mayReplay({...op(),path},identity(),'mci2-test'),false));
}
