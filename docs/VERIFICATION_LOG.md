# Verification Log

명령 실행과 결과를 기록한다.

## 2026-10-05 Phase 0

### 환경 복구 후 재검증 (Docker PostgreSQL 5432)

| 명령 | 결과 |
| --- | --- |
| `npm run db:migrate -- --phase=0` | PASS — `_migrations` 테이블 생성, 적용 파일 0개 (Phase 0은 업무 migration 없음) |
| `npm run db:seed -- --phase=0` | PASS — "no seeds defined for phase <= 0" (예상 동작) |
| `npm run check` (tsc --noEmit) | PASS — 오류 0 |
| `npm run build` (esbuild) | PASS — web/app.js 생성 |
| `npm run test:unit` | PASS — 3/3 (session 서명·위조 거부·actor 스푸핑 차단) |
| `npm run test:integration` | PASS — 2/2 (health connected, db down -> 503) |
| `npm run test:e2e` | PASS — 1/1 (앱 셸 + DB 연결 표시, chromium) |
| `npm run verify -- --phase=0` | PASS — 위 전체 순차 통과 |

메모:
- `.env`의 `DATABASE_URL=postgres://commerce:commerce@localhost:5432/commerce` (Docker compose 컨테이너 `codyssey_final-db-1`) 사용 확인.
- `src/config.ts`가 `.env`를 로드하며, 이미 설정된 환경 변수는 덮어쓰지 않음(테스트 주입 가능).
- `src/devdb.ts`는 `config.ts`를 먼저 import해 `.env`를 읽은 뒤 `DATABASE_URL` 유무로 embedded fallback 여부를 결정.
