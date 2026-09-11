import {OCR_PROMPT, ocrImageBlocks} from './security/ocr-prompt.mjs';
import {normalizeOcrCandidates} from './ocr-core.js';
import { handleAccessManagement } from './security/access-management.mjs';
import { handleAgencyLogin } from './security/agency-login.mjs';
import { validateTestConfig, isActiveGrant } from './secure-session.js';
/* =============================================================================
   MCI 통합 상황판 — Cloudflare Worker
   역할:
   1) 정적 파일 서빙 (기존 그대로 — assets 폴스루)
   2) POST /api/ocr — 사상자 카드 사진을 Claude Vision으로 분석하는 중계(프록시)

   보안 구조:
   - Anthropic API 키는 Worker Secret(ANTHROPIC_API_KEY)에만 존재.
     클라이언트(index.html)에는 절대 노출되지 않음.
   - 호출 자격: Firebase 테스트 인증 토큰(Bearer)의 서명과 현재 서버 권한 검증.
     별도 mci2 테스트 프로젝트의 승인된 쓰기 역할만 통과.
   - 추가 가드: 요청 크기 제한 + 사용자(uid)별 분당 호출 제한.

   키 등록(1회): Cloudflare 대시보드 → Workers & Pages → mci →
   Settings → Variables and Secrets → Add → Type: Secret,
   Name: ANTHROPIC_API_KEY, Value: (Anthropic 키)
   ============================================================================= */

const FIREBASE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// 기본 모델 — 손글씨 카드(이름·병원명) 판독 정확도가 핵심이라 Sonnet 사용.
// (Haiku로 내려봤더니 이름/병원명을 자주 틀려 복구함. 비용은 Anthropic 월 지출 한도로 관리.)
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MAX_IMAGE_BASE64_CHARS = 5_000_000;   // base64 약 5MB ≈ 원본 3.7MB (Anthropic 한도 5MB 이내)
const RATE_LIMIT_PER_MIN = 12;              // uid당 분당 분석 횟수 (현장 사용엔 충분, 남용 방지)

// 사상자 카드에서 추출할 항목 — index.html의 mciDraft 필드와 1:1 매핑.
// 모든 항목 nullable: 카드에 없으면 null (추측 금지를 스키마로도 강제).
const OCR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'triage', 'name', 'age', 'gender', 'isPediatric', 'location', 'symptom',
    'consciousness', 'rr', 'pulse', 'bpSys', 'bpDia', 'spo2', 'temp',
    'mechanism', 'hospital', 'departTime', 'notes',
  ],
  properties: {
    triage:        { enum: ['emergency', 'urgent', 'nonurgent', 'dead', null] },
    name:          { type: ['string', 'null'] },
    age:           { type: ['string', 'null'], description: '숫자만, 예 "47"' },
    gender:        { enum: ['남', '여', null] },
    isPediatric:   { type: ['boolean', 'null'] },
    location:      { type: ['string', 'null'], description: '발견 장소' },
    symptom:       { type: ['string', 'null'], description: '주요 손상/주증상 (예: "후두부 열상", "우측 다리골절")' },
    consciousness: { enum: ['A', 'V', 'P', 'U', null] },
    rr:            { type: ['string', 'null'], description: '호흡수, 숫자만' },
    pulse:         { type: ['string', 'null'], description: '맥박, 숫자만' },
    bpSys:         { type: ['string', 'null'], description: '수축기 혈압, 숫자만' },
    bpDia:         { type: ['string', 'null'], description: '이완기 혈압, 숫자만' },
    spo2:          { type: ['string', 'null'], description: 'SpO2 %, 숫자만' },
    temp:          { type: ['string', 'null'], description: '체온 °C, 숫자만(소수 가능)' },
    mechanism:     { type: ['string', 'null'], description: '손상기전(있으면)' },
    hospital:      { type: ['string', 'null'], description: '이송의료기관명' },
    departTime:    { type: ['string', 'null'], description: '이송(출발)시간, "HH:MM" 형식' },
    notes:         { type: ['string', 'null'], description: '처치 내용 등 기타 특이사항' },
  },
};


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/auth/config') {
      try {
        const firebase = validateTestConfig({firebase:JSON.parse(env.FIREBASE_WEB_CONFIG || 'null')});
        if (firebase.projectId !== env.FIREBASE_PROJECT_ID) throw Error('project mismatch');
        return new Response(JSON.stringify({firebase}), {headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      } catch { return jsonResponse({error:'테스트 로그인이 아직 설정되지 않았습니다.'},503); }
    }
    if (['/api/admin/codes','/api/admin/close','/api/auth/display'].includes(url.pathname)) return handleAccessManagement(request,env,verifyFirebaseToken);
    if (url.pathname === '/api/auth/login') return handleAgencyLogin(request,env);
    if (url.pathname === '/api/ocr') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'POST 요청만 지원합니다' }, 405);
      }
      try {
        return await handleOcr(request, env);
      } catch (err) {
        return jsonResponse({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 500);
      }
    }

    // 그 외 모든 경로 → 정적 자산 (index.html, sw.js, PDF 등)
    return env.ASSETS.fetch(request);
  },
};

// ==================== /api/ocr 처리 ====================
async function handleOcr(request, env) {
  // 0) 키 미설정 — 운영자가 Secret을 아직 등록 안 한 상태
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'AI 분석이 아직 설정되지 않았습니다 (관리자: API 키 등록 필요)' }, 503);
  }

  // 1) 인증 — Firebase 익명 토큰 서명 검증
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return jsonResponse({ error: '인증 토큰이 없습니다' }, 401);

  const payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
  if (!payload) return jsonResponse({ error: '인증에 실패했습니다. 앱을 새로고침 후 다시 시도해주세요.' }, 401);

  if (payload.mci_env !== 'test') return jsonResponse({error:'테스트 접근 권한이 없습니다.'},403);
  let grant;
  try {
    const cfg=validateTestConfig({firebase:JSON.parse(env.FIREBASE_WEB_CONFIG || 'null')});
    if(cfg.projectId!==env.FIREBASE_PROJECT_ID)throw Error('project');
    const grantUrl=new URL('access/'+encodeURIComponent(payload.sub)+'.json',cfg.databaseURL);
    grantUrl.searchParams.set('auth',token);
    const r=await fetch(grantUrl,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw Error('grant');
    grant=await r.json();
  }catch{return jsonResponse({error:'접근 권한을 확인할 수 없습니다.'},403);}
  if(!isActiveGrant(grant) || !['normal','admin'].includes(grant.role))return jsonResponse({error:'분석 권한이 없습니다.'},403);

  // 2) 사용자별 호출 제한 (남용 방지 — 인스턴스 메모리 기준 best-effort)
  if (!checkRateLimit(payload.user_id || payload.sub)) {
    return jsonResponse({ error: '요청이 너무 잦습니다. 1분 후 다시 시도해주세요.' }, 429);
  }

  // 3) 본문 파싱 + 크기 검증
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '잘못된 요청 형식입니다' }, 400);
  }
  const image = typeof body.image === 'string' ? body.image : '';
  const mediaType = typeof body.mediaType === 'string' ? body.mediaType : 'image/jpeg';
  if (!image) return jsonResponse({ error: '이미지가 없습니다' }, 400);
  if (image.length > MAX_IMAGE_BASE64_CHARS) {
    return jsonResponse({ error: '이미지가 너무 큽니다 (다시 촬영해주세요)' }, 413);
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) {
    return jsonResponse({ error: '지원하지 않는 이미지 형식입니다' }, 400);
  }

  let imageBlocks;
  try { imageBlocks=ocrImageBlocks(body,MAX_IMAGE_BASE64_CHARS); } catch(error) { return jsonResponse({error:error.message},400); }

  // 4) Claude Vision 호출 — 구조화 출력(json_schema)으로 형식 보장
  const anthropicRes = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: env.OCR_MODEL || DEFAULT_MODEL,
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: OCR_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: OCR_PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!anthropicRes.ok) {
    // 상세 오류는 서버 로그로만 — 클라이언트에는 일반화된 메시지
    console.error('[OCR] Anthropic 오류', anthropicRes.status);
    if (anthropicRes.status === 401) return jsonResponse({ error: 'AI 분석 설정 오류 (관리자: API 키 확인 필요)' }, 502);
    if (anthropicRes.status === 429) return jsonResponse({ error: 'AI 분석 사용량 한도 초과. 잠시 후 다시 시도해주세요.' }, 502);
    if (anthropicRes.status === 529) return jsonResponse({ error: 'AI 서버가 혼잡합니다. 잠시 후 다시 시도해주세요.' }, 502);
    return jsonResponse({ error: 'AI 분석 요청에 실패했습니다 (' + anthropicRes.status + ')' }, 502);
  }

  const result = await anthropicRes.json();
  const textBlock = Array.isArray(result.content) ? result.content.find((b) => b.type === 'text') : null;
  if (!textBlock || !textBlock.text) {
    return jsonResponse({ error: 'AI 응답이 비어 있습니다' }, 502);
  }

  let fields;
  try {
    fields = JSON.parse(textBlock.text);
  } catch {
    return jsonResponse({ error: 'AI 응답 해석에 실패했습니다' }, 502);
  }

  return jsonResponse({
    fields: normalizeOcrCandidates(fields),
    engine: 'claude',
    model: result.model,
    usage: result.usage ? { input: result.usage.input_tokens, output: result.usage.output_tokens } : null,
  });
}

// ==================== Firebase ID 토큰 검증 (RS256) ====================
// Google 공개키(JWK)로 서명을 직접 검증 — 외부 라이브러리 없이 Web Crypto 사용.
let _jwkCache = { keys: null, expiresAt: 0 };

async function getFirebaseJwks() {
  const now = Date.now();
  if (_jwkCache.keys && now < _jwkCache.expiresAt) return _jwkCache.keys;
  const res = await fetch(FIREBASE_JWK_URL);
  if (!res.ok) throw new Error('인증 키 조회 실패');
  const data = await res.json();
  let maxAge = 3600;
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  if (m) maxAge = parseInt(m[1], 10);
  _jwkCache = { keys: data.keys || [], expiresAt: now + maxAge * 1000 };
  return _jwkCache.keys;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function verifyFirebaseToken(token, projectId) {
  if (!/^mci2-[a-z0-9-]+$/.test(projectId || '')) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = b64urlToJson(parts[0]);
    const payload = b64urlToJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);

    if (header.alg !== 'RS256' || !header.kid) return null;
    if (payload.aud !== projectId) return null;
    if (payload.iss !== 'https://securetoken.google.com/' + projectId) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.iat !== 'number' || payload.iat > now + 300) return null;
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) return null;

    const jwks = await getFirebaseJwks();
    const jwk = jwks.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify'],
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]),
    );
    return ok ? payload : null;
  } catch {
    return null;
  }
}

// ==================== 호출 제한 (uid별, 인스턴스 메모리) ====================
const _rateMap = new Map();

function checkRateLimit(uid) {
  if (!uid) return false;
  const now = Date.now();
  const windowStart = now - 60_000;
  let times = _rateMap.get(uid) || [];
  times = times.filter((t) => t > windowStart);
  if (times.length >= RATE_LIMIT_PER_MIN) return false;
  times.push(now);
  _rateMap.set(uid, times);
  // 메모리 무한 증가 방지
  if (_rateMap.size > 5000) _rateMap.clear();
  return true;
}

// ==================== 헬퍼 ====================
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
