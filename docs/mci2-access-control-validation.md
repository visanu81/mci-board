# mci2 서버 인증 연결 검증

2026-09-11. 브랜치 `codex/mci2-access-control`, PR #3.

## 상태

서버 로그인 모듈을 Worker에, 서버 승인 세션을 실제 진입 화면에 연결했다. 이 브랜치는 아직 배포하지 않았다. 운영 mci와 현재 mci2는 이전 배포 상태를 유지한다.

사용자의 새 프로젝트 생성 승인에 따라 `mci2-secure-visanu81`(MCI2 Secure Test)을 생성했다. 웹 앱과 싱가포르(asia-southeast1) Realtime Database를 만들고, `firebase.secure.json`으로 테스트 규칙을 배포했다. 서버에서 다시 읽은 규칙이 로컬 파일과 일치한다. Firebase Authentication을 초기화하고 이메일·익명 가입을 비활성화했다. 과금 연결은 비활성 상태(billingEnabled=false)다. 서비스 계정·키·새 진입 코드는 아직 생성하지 않았으며 Worker 보안 버전도 미배포다.

`security/database.test.rules.json`은 별도 테스트 프로젝트용이다. 기존 운영 프로젝트 disester-f3669에 적용하면 운영 접근을 차단하므로 적용하면 안 된다.

## 연결한 동작

- `/api/auth/config`: 공개 Firebase 웹 설정만 반환한다. mci2- 접두사의 별도 프로젝트와 일치하는 DB/인증 도메인만 허용한다. 미설정·운영 설정은 503으로 거부한다.
- `/api/auth/login`: 브라우저가 보낸 코드만 서버 Secret의 HMAC와 비교한다. 클라이언트가 role/agencyId를 지정할 수 없다. 승인 권한 기록 저장 후 5분 유효 custom token을 발급한다. 코드 유효기간과 12시간 중 짧은 시간까지 단말별 권한을 승인한다.
- 화면은 custom token으로 로그인하고 `/access/{uid}`의 서버 권한을 구독한다. 기존 익명 로그인, 공개 SEED 코드, localStorage 역할 복원을 제거했다. 재난 목록은 관서 조건으로 조회하고 보관함은 관리자만 구독한다.
- 만료·회수·로그아웃 때 데이터 구독을 중단하고 목록을 비운다. 이전 구독에서 늦게 도착한 응답도 세대 번호로 차단한다.
- 작성 중이던 MCI/일반 사상자 카드 초안은 복구용 JSON으로 보관한다. 저장소 오류 시 메모리 복구본을 유지하며 로그인 화면에서 내려받을 수 있다. 사고개요·피해·동원 등 모든 입력 폼의 복구를 구현한 것은 아니다.
- 카드 신규 작성자/수정자 UID와 재난 생성자 UID를 기록한다. 다른 로그인·프로젝트·관서에 속한 미전송 작업은 보내지 않는다. 구형 mci2_outbox_v1은 건드리지 않고 mci2_secure_outbox_v1을 사용한다.
- 카드 전송은 Firebase SDK의 지연 쓰기 대신 원래 사용자 ID 토큰을 고정한 REST 요청을 쓴다. 토큰 갱신 중 계정이 바뀌면 요청을 보내지 않는다. 서버에 이미 도착한 요청은 취소를 보장할 수 없지만 다른 로그인 토큰으로 재발행되지 않는다.
- OCR는 테스트 Firebase 서명 토큰 외에 현재 서버 권한을 조회한다. 만료/회수 또는 읽기 전용 역할은 Anthropic 호출 전에 거부한다.
- 인증 API는 no-store이며 서비스 워커도 /api/를 캐시하지 않는다. 앱 모듈 secure-session.js를 앱 셸에 추가했다. 초안 캐시 버전은 v95-secure-test다.

## 검증

- `npm run test:rules`: Database Emulator 4.11.2, 62/62 통과(규칙 변경 없음).
- `npm run test:auth`: 서버 코드 확인/토큰 발급, 17/17 통과(모듈 변경 없음).
- `npm run test:safety`: 실제 HTML 저장 함수 회귀 검사, 19/19 통과.
- `npm run test:session`: 브라우저 세션/재전송 및 Worker 인증·OCR 검사, 32/32 통과. 실제 생성한 일회성 RSA 키로 토큰 서명을 검증하고 외부 응답을 모의 구현한다.
- 로컬 브라우저: 잘못된 코드 거부 → 정상 코드 로그인 → 관서 로비 → 재난 합류 → 구급팀장 선택 → 카드 메모 저장 → 사진·작성자 유지 확인. 권한 회수 후 로그인 화면과 카드 입력 복구 버튼 확인. REST 토큰 고정 전송 후에도 실제 화면 저장 결과 확인.
- Workers dry-run 통과: AUTH_RATE_LIMIT(120회/60초), ASSETS, 27.23KiB Worker 번들. 실제 배포는 안 했다.
- 모든 시험은 가상 데이터로 실행했다. 실제 환자 데이터 조회·복사는 하지 않았다.

## 구성한 리소스와 남은 서버 설정

생성한 프로젝트 ID: `mci2-secure-visanu81`, 표시 이름 `MCI2 Secure Test`.
기존 Firebase 프로젝트와 별개로 테스트 DB와 웹 앱을 구성했다. Firebase가 실제 발급한 인증 도메인은 `mci2--visanu81.firebaseapp.com`이며 해당 프로젝트에만 허용한다. 공개 웹 설정은 `security/firebase-web-config.json`과 Worker vars에 반영했다. 요금제 업그레이드·결제 연결·운영 데이터 복사는 하지 않는다.

Worker Secret: FIREBASE_SERVICE_ACCOUNT(테스트 전용), MCI_CODE_PEPPER, MCI_LOGIN_RECORDS.
공개 설정: FIREBASE_PROJECT_ID, FIREBASE_DATABASE_URL, FIREBASE_WEB_CONFIG, PUBLIC_ORIGIN.
PUBLIC_ORIGIN은 https://mci2.visanu81.workers.dev만 허용한다.

진입 코드는 암호학적으로 무작위인 최소 128비트 값을 새로 발급한다. 기존 공개 관서명/관리자명 기반 코드는 재사용하지 않는다. 코드 폐기 시 이미 발급된 UID 권한도 회수해야 한다. 레이트 리미터 namespace_id 2026091101은 실제 적용 전에 계정 내 충돌 여부를 확인한다. 제한은 Cloudflare 위치별이며 전역의 정확한 제한이 아니다. 다수 단말이 같은 IP를 사용하는 현장 특성도 검증해야 한다.

## 배포 전 남은 기능 검증

1. 실제 별도 Firebase에서 custom token 교환, 권한 구독, CRUD 및 재로그인을 종합 검증한다. 현재 테스트 규칙은 관리자 외 모든 역할을 단일 관서에 제한한다. 본부의 전 관서 모니터링은 승인된 읽기 범위에 맞춘 추가 설계가 필요하다.
2. 관서 코드 관리 UI는 기존 DB 직접 변경을 막고 안내만 표시한다. 안전한 서버 관리 API·새 코드 발급 UI는 아직 연결하지 않았다. 관리자 관서 디렉터리도 새 서버 설정에서 제공해야 한다.
3. 기존 팝아웃은 원창 Firebase 로그인을 공유한다. 독립된 표출 전용 서버 세션 발급과 원창 로그인 보존은 아직 검증되지 않았다. 이 흐름을 완료하기 전 기존 표출 기능과 동등하다고 볼 수 없다.
4. 완전 오프라인 상태에서 앱을 새로 여는 경우 설정/서버 권한을 확인할 수 없어 새 로그인을 허용하지 않는다. 이미 열린 승인 세션의 카드 오프라인 큐와 별도로 현장 재시작 요구를 검토해야 한다.
5. 새 프로젝트로 이전 데이터/미전송 작업을 자동 복사하지 않는다. 기존 큐를 보존하며 UID가 달라진 작업의 수동 확인·이관 절차가 필요하다. 사고개요·피해·동원 등 카드 외 쓰기는 기존 SDK 경로이므로 계정 변경·오프라인 재전송까지 별도 검증해야 한다.
6. 모바일 두 단말, 권한 만료 중 입력, 동일 필드 충돌, 관리자 종료/보관/재개 흐름, 단말 공유 시 복구 파일 보존 정책을 검증한다. 이번 변경만으로 전체 운영 전환 준비가 끝난 것은 아니다.

## 공식 참고

- [Firebase custom token](https://firebase.google.com/docs/auth/admin/create-custom-tokens)
- [Realtime Database 규칙](https://firebase.google.com/docs/database/security/rules-conditions)
- [Database Emulator](https://firebase.google.com/docs/emulator-suite/connect_rtdb)
- [Workers 호출 제한](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
