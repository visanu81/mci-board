// OCR produces candidates only. No clinical inference or storage side effects.
export const OCR_LABELS = {triage:'중증도',name:'이름',age:'나이',gender:'성별',isPediatric:'소아 표시',location:'발견장소',symptom:'주증상',consciousness:'의식',rr:'호흡수',pulse:'맥박',bpSys:'수축기 혈압',bpDia:'이완기 혈압',spo2:'SpO₂',temp:'체온',mechanism:'손상기전',hospital:'이송 병원',departTime:'출발 시각',notes:'처치·특이사항'};
const enums={triage:['emergency','urgent','nonurgent','dead'],gender:['남','여'],consciousness:['A','V','P','U']};
const numeric={age:[0,130],rr:[0,80],pulse:[0,250],bpSys:[0,300],bpDia:[0,200],spo2:[0,100],temp:[20,50]};
export function normalizeOcrCandidates(input) {
  const result={};
  if(!input || typeof input!=='object' || Array.isArray(input))return result;
  for(const key of Object.keys(OCR_LABELS)) {
    const value=input[key];
    if(value===null || value===undefined || value==='')continue;
    if(key==='isPediatric'){if(typeof value==='boolean')result[key]=value;continue;}
    if(typeof value!=='string' && typeof value!=='number')continue;
    const text=String(value).trim();if(!text || text.length>1000)continue;
    if(enums[key] && !enums[key].includes(text))continue;
    if(numeric[key]){const [min,max]=numeric[key];if(!/^\d+(?:\.\d+)?$/.test(text)||Number(text)<min||Number(text)>max||(key!=='temp'&&!Number.isInteger(Number(text))))continue;}
    if(key==='departTime' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text))continue;
    result[key]=text;
  }
  return result;
}
export function ocrContextMatches(expected,current) {
  return !!expected && !!current && ['uid','incidentId','mode','editKey','epoch'].every(k=>expected[k]===current[k]);
}
export function selectedOcrPatch(candidates,selected,draft) {
  const valid=normalizeOcrCandidates(candidates),patch={};
  for(const key of selected) {
    if(!Object.hasOwn(valid,key))continue;
    const old=draft[key];
    if(old!==null && old!==undefined && old!=='' && old!==false && !(Array.isArray(old)&&old.length===0))continue;
    patch[key]=valid[key];
  }
  return patch;
}
export function extractLocalOcrCandidates(text) {
  // Text-only OCR cannot distinguish printed legends from selected checkboxes.
  // Never extract triage, gender, pediatric status or AVPU from the local fallback.
  const fields={};
  for(const [key,pattern] of Object.entries({age:/(?:나이|연령)\s*[:|]?\s*(\d{1,3})\s*세(?:\s|$)/,rr:/(?:호흡수|RR)\s*[:|]?\s*(\d{1,2})(?!\d)/i,pulse:/(?:맥박|HR)\s*[:|]?\s*(\d{1,3})(?!\d)/i,spo2:/SpO[2₂]\s*[:|]?\s*(\d{1,3})(?!\d)/i,temp:/(?:체온|BT)\s*[:|]?\s*(\d{2}\.\d)(?!\d)/i,departTime:/(?:출발시간|이송시간|출발시각)\s*[:|]?\s*(\d{2}:\d{2})/})) {const match=pattern.exec(text);if(match)fields[key]=match[1];}
  const bp=/(?:혈압|BP)\s*[:|]?\s*(\d{1,3})\s*\/\s*(\d{1,3})(?!\d)/i.exec(text);if(bp){fields.bpSys=bp[1];fields.bpDia=bp[2];}
  for(const [key,label] of Object.entries({name:'이름',location:'발견장소',symptom:'주증상',hospital:'이송의료기관',notes:'특이사항'})){const match=new RegExp('(?:^|\\n)\\s*'+label+'\\s*[:|]\\s*([^\\n]+)').exec(text);if(match)fields[key]=match[1].trim();}
  return normalizeOcrCandidates(fields);
}
