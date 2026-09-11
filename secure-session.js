// Firebase SDK is injected so the same session lifecycle can be tested without a server.
export function validateTestConfig(value) {
  const c=value?.firebase;
  if(!c || !/^mci2-[a-z0-9-]+$/.test(c.projectId || '') || c.projectId==='disester-f3669')throw Error('테스트 Firebase 설정이 필요합니다.');
  const url=new URL(c.databaseURL);
  if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash || !(url.hostname===c.projectId+'-default-rtdb.firebaseio.com' || url.hostname.startsWith(c.projectId+'-default-rtdb.') && url.hostname.endsWith('.firebasedatabase.app')))throw Error('테스트 데이터베이스 설정이 올바르지 않습니다.');
  if(typeof c.apiKey!=='string' || !c.apiKey || c.authDomain!==c.projectId+'.firebaseapp.com')throw Error('테스트 인증 설정이 올바르지 않습니다.');
  return Object.freeze({...c});
}
export function isActiveGrant(grant,now=Date.now()) {
  return !!grant && grant.active===true && grant.environment==='test' && Number.isFinite(grant.expiresAt) && grant.expiresAt>now && ['normal','observer','display','admin'].includes(grant.role) && /^[a-z0-9_-]{1,50}$/.test(grant.agencyId || '');
}
export function mayReplay(op,identity,projectId) {
  return !!identity && isActiveGrant(identity) && ['normal','admin'].includes(identity.role) && op?.securityContext?.projectId===projectId && op.securityContext.uid===identity.uid && op.securityContext.agencyId===identity.agencyId && typeof op.path==='string' && /^mci2\/incidents\/[^/]+\/(casualties|mciCasualties)\/[^/]+$/.test(op.path);
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
export async function sendBoundOperation(op,{currentIdentity,currentUser,projectId,databaseURL},fetcher=fetch) {
  const identity=currentIdentity(),user=currentUser();
  if(!mayReplay(op,identity,projectId) || user?.uid!==identity.uid)throw Error('permission_denied: 로그인 문맥이 변경되었습니다.');
  const token=await user.getIdToken();
  if(!mayReplay(op,currentIdentity(),projectId) || currentUser()?.uid!==user.uid)throw Error('permission_denied: 로그인 문맥이 변경되었습니다.');
  const url=new URL(op.path+'.json',databaseURL.endsWith('/')?databaseURL:databaseURL+'/');
  url.searchParams.set('auth',token);
  const method={set:'PUT',update:'PATCH',remove:'DELETE'}[op.method];if(!method)throw Error('unsupported operation');
  const r=await fetcher(url,{method,headers:{'Content-Type':'application/json'},body:op.method==='remove'?undefined:JSON.stringify(op.payload),signal:AbortSignal.timeout(12000)});
  if(!r.ok)throw Error(r.status===401 || r.status===403?'permission_denied':'카드 전송 실패 ('+r.status+')');
}
