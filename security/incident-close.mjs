// A frozen incident remains the recovery source; closing never deletes patient records.
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
async function readRecord(response) {
  if(!response.ok)throw Error('read');
  const reader=response.body.getReader(),parts=[];let size=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024)throw Error('size');parts.push(value);} }
  finally { await reader.cancel(); }
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function closeIncident(input,db,uid,authorize) {
  if(Object.keys(input).some(k=>!['incidentId','label'].includes(k)) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.incidentId||'') || (input.label!==undefined && (typeof input.label!=='string' || input.label.length>200)))return reply({error:'재난과 백업 이름을 확인하세요.'},400);
  const base='mci2/incidents/'+input.incidentId;
  try {
    const response=await db(base,'GET',undefined,{'X-Firebase-ETag':'true'});
    let incident=await readRecord(response);
    if(!incident)return reply({error:'재난을 찾을 수 없습니다.'},404);
    if(incident.closedAt)return reply({ok:true,archived:!!incident.closure,alreadyClosed:true});
    if(!incident.closure){
      const etag=response.headers.get('etag');if(!etag)throw Error('etag');
      incident={...incident,closure:{id:crypto.randomUUID(),at:Date.now(),by:uid,label:input.label||incident.title||'재난 백업'}};
      if(!await authorize())return reply({error:'관리자 권한이 변경됐습니다.'},403);
      const frozen=await db(base,'PUT',incident,{'if-match':etag});
      if(frozen.status===412)return reply({error:'새 기록이 들어왔습니다. 최신 기록으로 종료를 다시 실행하세요.'},409);
      if(!frozen.ok)throw Error('freeze');
    }
    const c=incident.closure;
    if(!/^[a-f0-9-]{36}$/.test(c.id||'') || !Number.isFinite(c.at) || typeof c.by!=='string')throw Error('closure');
    const rows=value=>Object.entries(value||{}).map(([key,item])=>({...item,_key:key}));
    const archive={label:c.label,archivedAt:c.at,archivedBy:c.by,sourceIncidentId:input.incidentId,closureId:c.id,data:{incident:incident.incident||null,damages:incident.damages||{},mobilizations:incident.mobilizations||{},actions:rows(incident.actions),casualties:rows(incident.casualties),mciCasualties:rows(incident.mciCasualties),exportedAt:c.at,exportedBy:c.by,_incidentMeta:{title:incident.title||'',type:incident.type||'',agencyId:incident.agencyId,startedAt:incident.startedAt}}};
    if(!await authorize())return reply({error:'종료 대기 중입니다. 유효한 관리자 계정에서 종료를 재시도하세요.'},403);
    // Deterministic key makes retries after lost responses idempotent.
    const saved=await db('mci2/archives/close-'+c.id,'PUT',archive);
    if(!saved.ok)throw Error('archive');
    if(!await authorize())return reply({error:'백업은 보존됐습니다. 유효한 관리자 계정에서 종료를 재시도하세요.'},403);
    const completed=await db(base,'PATCH',{closedAt:c.at,closedBy:c.by});
    if(!completed.ok)throw Error('complete');
    return reply({ok:true,archived:true});
  } catch {return reply({error:'종료가 완료되지 않았습니다. 원본은 보존됩니다. 연결을 확인하고 같은 재난의 종료를 재시도하세요.'},503);}
}
