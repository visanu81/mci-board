/* =============================================================================
   MCI 통합 상황판 — Cloudflare Worker
   역할:
   1) 정적 파일 서빙 (기존 그대로 — assets 폴스루)
   2) POST /api/ocr — 사상자 카드 사진을 Claude Vision으로 분석하는 중계(프록시)

   보안 구조:
   - Anthropic API 키는 Worker Secret(ANTHROPIC_API_KEY)에만 존재.
     클라이언트(index.html)에는 절대 노출되지 않음.
   - 호출 자격: Firebase 익명 인증 토큰(Bearer)을 서버에서 직접 서명 검증.
     우리 앱(disester-f3669 프로젝트)에서 발급된 유효 토큰만 통과.
   - 추가 가드: 요청 크기 제한 + 사용자(uid)별 분당 호출 제한.

   키 등록(1회): Cloudflare 대시보드 → Workers & Pages → mci →
   Settings → Variables and Secrets → Add → Type: Secret,
   Name: ANTHROPIC_API_KEY, Value: (Anthropic 키)
   ============================================================================= */

const FIREBASE_PROJECT_ID = 'disester-f3669';
const FIREBASE_JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// 기본 모델 — 손글씨 카드 판독 정확도와 속도의 균형. Worker 환경변수 OCR_MODEL로 교체 가능.
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
    'mechanism', 'hospital', 'notes',
  ],
  properties: {
    triage:        { enum: ['emergency', 'urgent', 'nonurgent', 'dead', null] },
    name:          { type: ['string', 'null'] },
    age:           { type: ['string', 'null'], description: '숫자만, 예 "47"' },
    gender:        { enum: ['남', '여', null] },
    isPediatric:   { type: ['boolean', 'null'] },
    location:      { type: ['string', 'null'], description: '발견 장소' },
    symptom:       { type: ['string', 'null'], description: '주증상' },
    consciousness: { enum: ['A', 'V', 'P', 'U', null] },
    rr:            { type: ['string', 'null'], description: '호흡수, 숫자만' },
    pulse:         { type: ['string', 'null'], description: '맥박, 숫자만' },
    bpSys:         { type: ['string', 'null'], description: '수축기 혈압, 숫자만' },
    bpDia:         { type: ['string', 'null'], description: '이완기 혈압, 숫자만' },
    spo2:          { type: ['string', 'null'], description: 'SpO2 %, 숫자만' },
    temp:          { type: ['string', 'null'], description: '체온 °C, 숫자만(소수 가능)' },
    mechanism:     { type: ['string', 'null'], description: '손상기전' },
    hospital:      { type: ['string', 'null'], description: '이송병원' },
    notes:         { type: ['string', 'null'], description: '처치 내용 등 기타 특이사항' },
  },
};

const OCR_PROMPT = `이 사진은 한국 소방의 다수사상자(MCI) 현장에서 사용하는 종이 사상자 분류표(트리아지 카드)입니다.
손글씨, 체크박스(✓·V), 동그라미 표시를 모두 판독하여 카드에 실제 기재된 정보만 JSON으로 추출하세요.

규칙:
- 카드에 없거나 판독이 어려운 항목은 null. 절대 추측해서 채우지 마세요.
- triage: 긴급/적색/빨강/I/Immediate → "emergency", 응급/황색/노랑/II/Delayed → "urgent", 비응급/녹색/초록/III/Minor → "nonurgent", 사망/지연(사망)/흑색/검정/IV/Expectant/Deceased → "dead". 체크·동그라미·색칠 등으로 선택 표시된 분류를 고르세요.
- age: 숫자만 (예: "47"). "40대"로 적혀 있으면 "40".
- gender: "남" 또는 "여".
- isPediatric: 연령이 14세 이하로 확인되면 true, 성인으로 확인되면 false, 불명확하면 null.
- consciousness(의식수준): AVPU 중 하나. GCS 점수만 적혀 있으면 환산 — 14~15 → "A", 9~13 → "V", 4~8 → "P", 3 → "U".
- 생체징후는 숫자 문자열만: rr(호흡수), pulse(맥박), bpSys/bpDia(혈압 — "120/80"이면 bpSys "120", bpDia "80"), spo2(%), temp(체온 °C).
- mechanism(손상기전): 가능하면 다음 중 하나로 — 낙상, 교통사고, 추락, 둔상, 관통상, 연소가스, 화상, 중독, 익수, 감전, 폭발, 압좌, 동상, 기타.
- location: 환자 발견 장소. symptom: 주증상. hospital: 이송병원명. notes: 처치 내용 등 기타 특이사항.
- 개인정보 보호: 주민등록번호·전화번호·주소는 추출하지 말고 해당 항목을 null로 두세요.`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/ocr') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'POST 요청만 지원합니다' }, 405);
      }
      try {
        return await handleOcr(request, env);
      } catch (err) {
        return jsonResponse({ error: '서버 오류: ' + (err && err.message ? err.message : '알 수 없음') }, 500);
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

  const payload = await verifyFirebaseToken(token);
  if (!payload) return jsonResponse({ error: '인증에 실패했습니다. 앱을 새로고침 후 다시 시도해주세요.' }, 401);

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
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: OCR_PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!anthropicRes.ok) {
    // 상세 오류는 서버 로그로만 — 클라이언트에는 일반화된 메시지
    let detail = '';
    try { detail = JSON.stringify(await anthropicRes.json()); } catch {}
    console.error('[OCR] Anthropic 오류', anthropicRes.status, detail);
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
    fields,
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

async function verifyFirebaseToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = b64urlToJson(parts[0]);
    const payload = b64urlToJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);

    if (header.alg !== 'RS256' || !header.kid) return null;
    if (payload.aud !== FIREBASE_PROJECT_ID) return null;
    if (payload.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT_ID) return null;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    if (typeof payload.iat !== 'number' || payload.iat > now + 300) return null;
    if (!payload.sub) return null;

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
