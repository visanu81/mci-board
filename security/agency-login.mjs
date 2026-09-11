// Server-only login foundation. Not wired into the deployed Worker yet.
// All bindings are required; absence never falls back to anonymous authorization.
const PROD_PROJECT = 'disester-f3669';
const encoder = new TextEncoder();
const response = (data, status = 200) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const encoded = obj => b64(encoder.encode(JSON.stringify(obj)));
const decode = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function boundedJson(request) {
  const reader=request.body?.getReader(); if(!reader)throw Error('body');
  const chunks=[]; let size=0;
  try { for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024){await reader.cancel();throw Error('size');}chunks.push(value);} }
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
function config(env) {
  const account=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || 'null');
  const records=JSON.parse(env.MCI_LOGIN_RECORDS || 'null');
  const project=env.FIREBASE_PROJECT_ID;
  if(!project || project===PROD_PROJECT || !/^mci2-[a-z0-9-]+$/.test(project))throw Error('test project required');
  if(account?.project_id!==project || !account?.private_key || !account?.client_email?.endsWith('@'+project+'.iam.gserviceaccount.com'))throw Error('test service account required');
  const database=new URL(env.FIREBASE_DATABASE_URL);
  if(database.protocol!=='https:' || database.username || database.password || database.pathname!=='/' || database.search || database.hash || !(database.hostname===project+'-default-rtdb.firebaseio.com' || database.hostname.startsWith(project+'-default-rtdb.') && database.hostname.endsWith('.firebasedatabase.app')))throw Error('test database required');
  if(env.PUBLIC_ORIGIN!=='https://mci2.visanu81.workers.dev')throw Error('test origin required');
  if(!env.AUTH_RATE_LIMIT?.limit || typeof env.MCI_CODE_PEPPER!=='string' || env.MCI_CODE_PEPPER.length<32 || !Array.isArray(records) || records.length>100)throw Error('bindings required');
  return {account,records,database:database.origin,project};
}
async function signJwt(account,payload) {
  const der=decode(account.private_key.replace(/-----[^-]+-----|\s/g,''));
  const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const data=encoded({alg:'RS256',typ:'JWT'})+'.'+encoded(payload);
  return data+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(data)));
}
export async function handleAgencyLogin(request,env,transport=fetch) {
  if(request.method!=='POST')return response({error:'POST 요청만 지원합니다.'},405);
  let settings;try{settings=config(env);}catch{return response({error:'테스트 로그인이 아직 설정되지 않았습니다.'},503);}
  if(request.headers.get('Origin')!==env.PUBLIC_ORIGIN)return response({error:'허용되지 않은 요청입니다.'},403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return response({error:'요청 형식을 확인하세요.'},415);
  try {
    const ip=request.headers.get('CF-Connecting-IP');
    if(!ip)return response({error:'허용되지 않은 요청입니다.'},403);
    const limit=await env.AUTH_RATE_LIMIT.limit({key:'login:'+ip});
    if(!limit.success)return response({error:'잠시 후 다시 시도하세요.'},429);
    let body;try{body=await boundedJson(request);}catch{return response({error:'입력 내용을 확인하세요.'},400);}
    if(typeof body.code!=='string' || Object.keys(body).some(k=>k!=='code'))return response({error:'입력 내용을 확인하세요.'},400);
    const code=body.code.trim().normalize('NFC');
    if(code.length<16 || code.length>128)return response({error:'진입 코드를 확인하세요.'},401);
    const key=await crypto.subtle.importKey('raw',encoder.encode(env.MCI_CODE_PEPPER),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    let match=null;
    // Verify every entry; neither plaintext codes nor role from the browser are trusted.
    for(const record of settings.records){
      let ok=false;try{ok=await crypto.subtle.verify('HMAC',key,decode(record.codeHash),encoder.encode(code));}catch{}
      if(ok)match=record;
    }
    const now=Date.now();
    if(!match || match.active!==true || !Number.isFinite(match.expiresAt) || match.expiresAt<=now || !['normal','observer','display','admin'].includes(match.role) || !/^[a-z0-9_-]{1,50}$/.test(match.agencyId) || typeof match.agencyName!=='string' || match.agencyName.length>50)return response({error:'진입 코드를 확인하세요.'},401);
    const {account,database}=settings;
    const seconds=Math.floor(now/1000);
    const assertion=await signJwt(account,{iss:account.client_email,scope:'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',aud:'https://oauth2.googleapis.com/token',iat:seconds,exp:seconds+300});
    const oauth=await transport('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(10000)});
    if(!oauth.ok)throw Error('oauth');
    const {access_token}=await oauth.json();if(typeof access_token!=='string' || !access_token)throw Error('oauth');
    const uid='mci2-'+crypto.randomUUID();
    const expiresAt=Math.min(now+12*60*60*1000,match.expiresAt);
    const grant={agencyId:match.agencyId,agencyName:match.agencyName,role:match.role,environment:'test',active:true,expiresAt};
    const saved=await transport(database+'/access/'+encodeURIComponent(uid)+'.json',{method:'PUT',headers:{Authorization:'Bearer '+access_token,'Content-Type':'application/json'},body:JSON.stringify(grant),signal:AbortSignal.timeout(10000)});
    if(!saved.ok)throw Error('grant');
    const token=await signJwt(account,{iss:account.client_email,sub:account.client_email,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iat:seconds,exp:seconds+300,uid,claims:{mci_env:'test'}});
    return response({token,expiresAt});
  }catch{return response({error:'로그인 연결에 실패했습니다. 잠시 후 다시 시도하세요.'},503);}
}
