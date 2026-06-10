/* =============================================================================
   MCI 통합 상황판 — Service Worker
   - 앱 셸(HTML/매니페스트/아이콘) 사전 캐시 → 오프라인에서도 화면 뜸
   - 외부 CDN(Tailwind/Lucide/XLSX/Pretendard) → 캐시 우선, 네트워크 폴백
   - Firebase 통신은 캐시 안 함 (실시간 동기화 보장)
   ============================================================================= */

// 캐시 이름 — 코드 수정 시 버전을 올려서 사용자 디바이스의 옛 캐시를 무효화
const CACHE_VERSION = 'v22';
const CACHE_NAME    = `mci-${CACHE_VERSION}`;

// 사전 캐시 대상 (앱 셸)
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg',
];

// ─── 설치: 앱 셸 사전 캐시 ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())   // 새 SW 즉시 활성화
  );
});

// ─── 활성화: 옛 버전 캐시 삭제 ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())  // 열려있는 탭 즉시 인계
  );
});

// ─── fetch: 요청 종류별 전략 분기 ───
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;     // POST/PUT 등은 SW 가로채지 않음

  const url = new URL(req.url);

  // 1) Firebase / Google 인증·DB는 캐시 안 함 (실시간 데이터)
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('gstatic.com')
  ) {
    return;  // 그냥 통과 — 브라우저 기본 네트워크 처리
  }

  // 2) 같은 출처(앱 셸 + 자체 파일): 캐시 우선
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 3) 외부 CDN (Tailwind, Lucide, XLSX, Pretendard 등): 캐시 우선 + 네트워크 폴백
  //    한 번 받으면 다음부터 오프라인에서도 동작
  event.respondWith(cacheFirst(req));
});

// ─── 헬퍼: 캐시 우선, 없으면 네트워크에서 받고 캐시 저장 ───
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // 성공한 응답만 캐시 (오류 응답은 캐시 안 함)
    if (response && response.ok) {
      const clone = response.clone();
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, clone).catch(() => {});  // 캐시 저장 실패는 무시
    }
    return response;
  } catch (err) {
    // 네트워크 실패 + 캐시도 없음 → 빈 응답
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}
