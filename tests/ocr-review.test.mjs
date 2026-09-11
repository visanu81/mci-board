import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOcrCandidates,extractLocalOcrCandidates,selectedOcrPatch,ocrContextMatches} from '../ocr-core.js';
import {ocrImageBlocks,OCR_PROMPT} from '../security/ocr-prompt.mjs';

test('local OCR never treats printed triage legends or GCS as selected clinical values',()=>{
  const result=extractLocalOcrCandidates('긴급 응급 비응급 사망 I II III IV\n보행 가능 O\nGCS 15\n성별 남 여\n소아 성인');
  assert.deepEqual(result,{});
});
test('local OCR preserves measured numbers and rejects approximate age',()=>{
  const result=extractLocalOcrCandidates('나이 40대\n혈압: 130/90\n맥박: 89\n호흡수: 24');
  assert.deepEqual(result,{rr:'24',pulse:'89',bpSys:'130',bpDia:'90'});
});
test('candidate normalization rejects impossible values, objects and unknown keys',()=>{
  assert.deepEqual(normalizeOcrCandidates({rr:'-1',pulse:'999',spo2:'120',age:'40대',notes:{bad:true},extra:'bad',departTime:'25:00',isPediatric:'false'}),{});
  assert.deepEqual(normalizeOcrCandidates({pulse:'0',isPediatric:false,temp:'36.5'}),{isPediatric:false,pulse:'0',temp:'36.5'});
});
test('only individually selected values enter the draft patch',()=>{
  const fields={age:'42',pulse:'89',hospital:'TEST'};
  assert.deepEqual(selectedOcrPatch(fields,[],{}),{});
  assert.deepEqual(selectedOcrPatch(fields,['pulse'],{}),{pulse:'89'});
});
test('review never overwrites existing values including zero, arrays and pediatric status',()=>{
  assert.deepEqual(selectedOcrPatch({pulse:'89',hospital:'NEW',isPediatric:false,mechanism:'낙상'},['pulse','hospital','isPediatric','mechanism'],{pulse:0,hospital:'OLD',isPediatric:true,mechanism:['기존']}),{});
});
test('review is scoped to login, incident, mode, card and modal epoch',()=>{
  const original={uid:'u',incidentId:'i',mode:'mci',editKey:null,epoch:1};
  assert(ocrContextMatches(original,{...original}));
  for(const key of Object.keys(original))assert(!ocrContextMatches(original,{...original,[key]:'different'}));
});
test('one request supports whole card and two detail images within aggregate limit',()=>{
  assert.equal(ocrImageBlocks({image:'abc',details:['def','ghi'],mediaType:'image/jpeg'},9).length,3);
  assert.throws(()=>ocrImageBlocks({image:'abc',details:['def','ghi']},8));
  assert.throws(()=>ocrImageBlocks({image:'a',details:['b','c','d']}));
  assert.throws(()=>ocrImageBlocks({image:'a',details:[{}]}));
});
test('OCR prompt explicitly prohibits clinical conversions',()=>{
  assert(OCR_PROMPT.includes('등급을 계산하지 마세요'));
  assert(OCR_PROMPT.includes('GCS 점수나 정상·비정상을 AVPU로 환산하지 마세요'));
  assert(OCR_PROMPT.includes("'40대'"));
});
