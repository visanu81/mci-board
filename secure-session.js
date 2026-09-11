// Firebase SDK is injected so the same session lifecycle can be tested without a server.
export function validateTestConfig(value) {
  const c=value?.firebase;
  if(!c || !/^mci2-[a-z0-9-]+$/.test(c.projectId || '') || c.projectId==='disester-f3669')throw Error('테스트 Firebase 설정이 필요합니다.');
  const url=new URL(c.databaseURL);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash || !(url.hostname===c.projectId+'-default-rtdb.firebaseio.com' || url.hostname.startsWith(c.projectId+'-default-rtdb.') && url.hostname.endsWith('.firebasedatabase.app')))throw Error('테스트 데이터베이스 설정이 올바르지 않습니다.');
  if(typeof c.apiKey!=='string' || !c.apiKey || (c.authDomain!==c.projectId+'.firebaseapp.com' && !(c.projectId==='mci2-secure-visanu81' && c.authDomain==='mci2--visanu81.firebaseapp.com')))throw Error('테스트 인증 설정이 올바르지 않습니다.');
  return Object.freeze({...c});
}
export function isActiveGrant(grant,now=Date.now()) {
  return !!grant && grant.active===true && grant.environment==='test' && Number.isFinite(grant.expiresAt) && grant.expiresAt>now && ['normal','observer','display','admin','hq'].includes(grant.role) && /^[a-z0-9_-]{1,50}$/.test(grant.agencyId || '');
}
export function mayReplay(op,identity,projectId) {
  return !!identity && isActiveGrant(identity) && ['normal','admin'].includes(identity.role) && op?.securityContext?.projectId===projectId && op.securityContext.uid===identity.uid && op.securityContext.agencyId===identity.agencyId && typeof op.path==='string' && /^mci2\/incidents\/[A-Za-z0-9_-]+\/(incident|(casualties|mciCasualties|damages|mobilizations|actions)\/[A-Za-z0-9_-]+)$/.test(op.path);
}
export function createSessionController({auth,db,sdk,onChange,fetcher=fetch,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let epoch=0,unsubscribeGrant=null,unsubscribeAuth=null,timer=null,identity=null;
  const clear=()=>{if(unsubscribeGrant)unsubscribeGrant();unsubscribeGrant=null;if(timer)clearTimer(timer);timer=null;};
  const publish=value=>{identity=value;onChange(value);};
  async function observe(user) {
    const current=++epoch;clear();publish(null);
    if(!user)return;
    try {
      const token=await user.getIdTokenResult();
      if(current!==epoch || token.claims.mci_env!=='test')return;
      const target=sdk.ref(db,'access/'+user.uid);
      const accept=snap=>{
        if(current!==epoch)return;
        const grant=snap.val();
        if(timer)clearTimer(timer);timer=null;
        if(!isActiveGrant(grant)){publish(null);return;}
        publish(Object.freeze({...grant,uid:user.uid}));
        timer=setTimer(()=>{if(current===epoch)publish(null);},Math.min(grant.expiresAt-Date.now(),2147483647));
      };
      // Subscribe before returning; every later revocation replaces the current grant.
      unsubscribeGrant=sdk.onValue(target,accept,()=>{if(current===epoch)publish(null);});
    }catch{if(current===epoch)publish(null);}
  }
  return {
    start(){if(!unsubscribeAuth)unsubscribeAuth=sdk.onAuthStateChanged(auth,user=>void observe(user));},
    current(){return identity && isActiveGrant(identity)?identity:null;},
    async login(code){
      const r=await fetcher('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code}),cache:'no-store'});
      const body=await r.json();if(!r.ok || typeof body.token!=='string')throw Error(body.error || '로그인에 실패했습니다.');
      await sdk.signInWithCustomToken(auth,body.token);
    },
    async logout(){++epoch;clear();publish(null);await sdk.signOut(auth);},
    stop(){++epoch;clear();unsubscribeAuth?.();unsubscribeAuth=null;publish(null);}
  };
}
export async function sendBoundOperation(op,{currentIdentity,currentUser,projectId,databaseURL,beforeCreate=async()=>{}},fetcher=fetch) {
  const identity=currentIdentity(),user=currentUser();
  if(!mayReplay(op,identity,projectId) || user?.uid!==identity.uid)throw Error('permission_denied: 로그인 문맥이 변경되었습니다.');
  const token=await user.getIdToken();
  if(!mayReplay(op,currentIdentity(),projectId) || currentUser()?.uid!==user.uid)throw Error('permission_denied: 로그인 문맥이 변경되었습니다.');
  const url=new URL(op.path+'.json',databaseURL.endsWith('/')?databaseURL:databaseURL+'/');
  url.searchParams.set('auth',token);
  const method={set:'PUT',update:'PATCH',remove:'DELETE'}[op.method];if(!method)throw Error('unsupported operation');
  if(['set','remove'].includes(op.method) && /\/(casualties|mciCasualties)\//.test(op.path)) {
    const conflict=(message,current)=>Object.assign(Error(message),{code:'write_conflict',current});
    const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
    const signal=AbortSignal.timeout(12000);
    const snapshot=await fetcher(url,{headers:{'X-Firebase-ETag':'true'},cache:'no-store',signal});
    if(!snapshot.ok)throw Error(snapshot.status===401||snapshot.status===403?'permission_denied':'최신 카드 조회 실패');
    const current=await snapshot.json(),etag=snapshot.headers.get('etag');
    if(op.method==='set' && current){
      if(typeof op.payload.createdByUid==='string' && Number.isFinite(op.payload.timestamp) && current.createdByUid===op.payload.createdByUid && current.timestamp===op.payload.timestamp)return;
      throw conflict('같은 번호의 서버 기록이 있습니다. 새 카드로 다시 입력하세요. 기존 기록은 변경하지 않았습니다.');
    }
    if(op.method==='set' && (!op.creationGuard || op.creationAttempted))throw conflict('등록 요청 이후 서버에서 카드를 찾을 수 없습니다. 삭제 여부를 확인하고 필요하면 새 카드로 입력하세요.');
    if(op.method==='remove'){
      if(!current)return;
      if(!op.expected)throw conflict('삭제 전 기록이 없습니다. 최신 카드를 확인한 뒤 다시 삭제하세요.');
      const expected={...op.expected};delete expected._key;
      if(!same(current,expected))throw conflict('삭제하려던 카드가 수정됐습니다. 최신 내용을 확인하고 삭제 여부를 다시 선택하세요.',current);
    }
    if(!etag)throw Error('서버 버전을 확인하지 못했습니다. 다시 시도하세요.');
    if(op.method==='set')await beforeCreate();
    if(!mayReplay(op,currentIdentity(),projectId) || currentUser()?.uid!==user.uid)throw Error('permission_denied: 로그인 문맥이 변경되었습니다.');
    const saved=await fetcher(url,{method,headers:{'Content-Type':'application/json','if-match':etag},body:op.method==='remove'?undefined:JSON.stringify(op.payload),signal});
    if(saved.status===412)throw Error('다른 저장이 먼저 반영됐습니다. 최신 기록을 다시 확인합니다.');
    if(!saved.ok)throw Error(saved.status===401||saved.status===403?'permission_denied':'기록 전송 실패 ('+saved.status+')');
    return;
  }
  if(op.method==='update' && /\/(casualties|mciCasualties)\//.test(op.path)) {
    const metadata=new Set(['updatedByUid','_updatedBy','_updatedTeamId','_updatedAt']);
    const keys=Object.keys(op.payload).filter(key=>!metadata.has(key));
    const conflict=(message,current)=>Object.assign(Error(message),{code:'write_conflict',current});
    if(!op.expected)throw conflict('수정 전 기록이 없는 이전 입력입니다. 최신 카드를 확인하고 다시 수정하세요.');
    const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
    const signal=AbortSignal.timeout(12000);
    for(let attempt=0;attempt<3;attempt++) {
      const snapshot=await fetcher(url,{headers:{'X-Firebase-ETag':'true'},cache:'no-store',signal});
      if(!snapshot.ok)throw Error(snapshot.status===401||snapshot.status===403?'permission_denied':'최신 카드 조회 실패');
      const current=await snapshot.json(),etag=snapshot.headers.get('etag');
      if(!current)throw conflict('다른 사용자가 이 카드를 삭제했습니다. 입력 내용은 기기에 보관됩니다.');
      const expectedNow=Object.fromEntries(keys.map(key=>[key,current[key]??null]));
      if(keys.some(key=>!same(current[key],op.expected[key]) && !same(current[key],op.payload[key])))throw conflict('다른 사용자가 같은 항목을 수정했습니다. 충돌 확인에서 저장할 내용을 선택하세요.',expectedNow);
      if(!etag)throw Error('서버 버전을 확인하지 못했습니다. 다시 시도하세요.');
      if(!mayReplay(op,currentIdentity(),projectId) || currentUser()?.uid!==user.uid)throw Error('permission_denied: 로그인 문맥이 변경되었습니다.');
      const saved=await fetcher(url,{method:'PUT',headers:{'Content-Type':'application/json','if-match':etag},body:JSON.stringify({...current,...op.payload}),signal});
      if(saved.status===412)continue;
      if(!saved.ok)throw Error(saved.status===401||saved.status===403?'permission_denied':'기록 전송 실패 ('+saved.status+')');
      return;
    }
    throw Error('다른 저장이 진행 중입니다. 잠시 후 재시도합니다.');
  }
  const r=await fetcher(url,{method,headers:{'Content-Type':'application/json'},body:op.method==='remove'?undefined:JSON.stringify(op.payload),signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error(r.status===401 || r.status===403?'permission_denied':'기록 전송 실패 ('+r.status+')');
}
function canonical(value) {
  if(value===undefined || value===null)return null;
  if(typeof value!=='object')return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
