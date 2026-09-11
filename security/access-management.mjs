import {closeIncident} from './incident-close.mjs';
import {config,serviceToken,signJwt,boundedJson} from './agency-login.mjs';
import {isActiveGrant} from '../secure-session.js';
const enc=new TextEncoder();
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const hash=async(pepper,code)=>{
 const key=await crypto.subtle.importKey('raw',enc.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(code))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const randomCode=()=>Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
export async function handleAccessManagement(request,env,verify,transport=fetch){
 try{
  const settings=config(env),path=new URL(request.url).pathname;
  if(env.MCI_CODE_STORE!=='database')return reply({error:'서버 코드 관리가 아직 설정되지 않았습니다.'},503);
  if(request.method!=='GET' && request.headers.get('Origin')!==env.PUBLIC_ORIGIN)return reply({error:'허용되지 않은 요청입니다.'},403);
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
  const payload=await verify(token,settings.project);
  if(!payload || payload.mci_env!=='test')return reply({error:'로그인이 필요합니다.'},401);
  const url=new URL(settings.database+'/access/'+encodeURIComponent(payload.sub)+'.json');url.searchParams.set('auth',token);
  const gr=await transport(url,{signal:AbortSignal.timeout(10000)});
  if(!gr.ok)return reply({error:'접근 권한이 없습니다.'},403);
  const grant=await gr.json();
  if(!isActiveGrant(grant) || typeof grant.codeId!=='string')return reply({error:'접근 권한이 없습니다.'},403);
  if(path==='/api/auth/display'?!['normal','admin'].includes(grant.role):grant.role!=='admin')return reply({error:'이 작업의 권한이 없습니다.'},403);
  const limited=await env.AUTH_RATE_LIMIT.limit({key:'manage:'+payload.sub});if(!limited.success)return reply({error:'잠시 후 다시 시도하세요.'},429);
  const service=await serviceToken(settings.account,transport);
  const db=async(p,method='GET',body,extra={})=>transport(settings.database+'/'+p+'.json',{method,headers:{Authorization:'Bearer '+service,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  let input={};
  if(request.method==='POST'){
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))return reply({error:'JSON 요청이 필요합니다.'},415);
   try{input=await boundedJson(request);}catch{return reply({error:'입력 내용을 확인하세요.'},400);}
  }
  if(path==='/api/admin/close'){
   if(request.method!=='POST')return reply({error:'POST 요청이 필요합니다.'},405);
   return closeIncident(input,db,payload.sub,async()=>{
    const latest=await transport(url,{signal:AbortSignal.timeout(10000)});
    if(!latest.ok)return false;const current=await latest.json();
    return isActiveGrant(current) && current.role==='admin' && current.codeId===grant.codeId;
   });
  }
  if(path==='/api/auth/display'){
   if(request.method!=='POST')return reply({error:'POST 요청이 필요합니다.'},405);
   if(Object.keys(input).some(k=>k!=='incidentId') || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.incidentId||''))return reply({error:'재난을 선택하세요.'},400);
   const ir=await db('mci2/incidents/'+input.incidentId);if(!ir.ok)throw Error('incident');const incident=await ir.json();
   if(!incident || incident.closedAt || incident.closure || (grant.role!=='admin' && incident.agencyId!==grant.agencyId))return reply({error:'표출할 재난의 권한이 없습니다.'},403);
   const uid='mci2-'+crypto.randomUUID(),seconds=Math.floor(Date.now()/1000),expiresAt=Math.min(grant.expiresAt,Date.now()+12*3600000);
   const child={agencyId:incident.agencyId,agencyName:grant.agencyName,role:'display',environment:'test',active:true,expiresAt,parentUid:payload.sub,incidentId:input.incidentId,...(grant.codeId?{codeId:grant.codeId}:{})};
   const saved=await db('access/'+uid,'PUT',child);if(!saved.ok)throw Error('grant');
   const custom=await signJwt(settings.account,{iss:settings.account.client_email,sub:settings.account.client_email,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iat:seconds,exp:seconds+120,uid,claims:{mci_env:'test'}});
   return reply({token:custom,expiresAt});
  }
  if(path!=='/api/admin/codes')return reply({error:'없는 경로입니다.'},404);
  if(!['GET','POST'].includes(request.method))return reply({error:'지원하지 않는 요청입니다.'},405);
  // Serialize code-list changes with Firebase ETags, including last-admin protection.
  const all=await db('serverCodes','GET',undefined,{'X-Firebase-ETag':'true'});if(!all.ok)throw Error('store');
  const records=await all.json()||{};
  if(request.method==='GET')return reply({codes:Object.entries(records).map(([id,r])=>({id,agencyId:r.agencyId,agencyName:r.agencyName,role:r.role,active:r.active,expiresAt:r.expiresAt,createdAt:r.createdAt}))});
  const currentCode=records[grant.codeId];
  if(!currentCode?.active || currentCode.expiresAt<=Date.now())return reply({error:'관리자 코드가 만료되거나 폐기됐습니다.'},403);
  let code=null,id;
  if(input.action==='create'){
   if(Object.keys(input).some(k=>!['action','agencyId','agencyName','role','days'].includes(k)) || !/^[a-z0-9_-]{1,50}$/.test(input.agencyId||'') || typeof input.agencyName!=='string' || !input.agencyName.trim() || input.agencyName.length>50 || !['normal','observer','display','admin','hq'].includes(input.role) || !Number.isInteger(input.days) || input.days<1 || input.days>30)return reply({error:'관서 ID·표시명·역할·유효기간(1~30일)을 확인하세요.'},400);
   if(Object.keys(records).length>=500)return reply({error:'코드 보관 한도에 도달했습니다.'},409);
   code=randomCode();id=await hash(env.MCI_CODE_PEPPER,code);
   records[id]={agencyId:input.agencyId,agencyName:input.agencyName.trim(),role:input.role,active:true,expiresAt:Date.now()+input.days*86400000,createdAt:Date.now(),createdByUid:payload.sub};
  }else if(input.action==='revoke'){
   if(Object.keys(input).some(k=>!['action','id'].includes(k)) || !/^[A-Za-z0-9_-]{43}$/.test(input.id||''))return reply({error:'코드를 확인하세요.'},400);
   id=input.id;const record=records[id];if(!record)return reply({error:'코드를 찾을 수 없습니다.'},404);
   if(id===grant.codeId)return reply({error:'현재 로그인에 사용한 관리자 코드는 다른 관리자 계정에서 폐기하세요.'},409);
   if(record.role==='admin' && Object.entries(records).filter(([key,r])=>key!==id && r.role==='admin' && r.active && r.expiresAt>Date.now()).length===0)return reply({error:'유효한 관리자 코드를 하나 이상 유지해야 합니다.'},409);
   records[id]={...record,active:false,revokedAt:Date.now(),revokedByUid:payload.sub};
  }else return reply({error:'지원하지 않는 작업입니다.'},400);
  const saved=await db('serverCodes','PUT',records,{'if-match':all.headers.get('etag')});
  if(saved.status===412)return reply({error:'다른 관리자가 변경했습니다. 새로고침 후 다시 시도하세요.'},409);
  if(!saved.ok)throw Error('store');return reply({ok:true,id,...(code?{code,expiresAt:records[id].expiresAt}:{})});
 }catch{return reply({error:'서버 작업에 실패했습니다. 잠시 후 다시 시도하세요.'},503);}
}
