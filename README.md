# AI Commerce Environment

구매자용 Commerce Environment를 먼저 완성하고, 이후 Shopping Brain / CS Agent를 결합하는 프로젝트입니다. 이 문서는 RAG·시스템 프롬프트 팀을 위한 **WIP 맥락 공유**이며 Brain 통합이나 Commerce Freeze 완료를 뜻하지 않습니다. 쇼핑 AI의 실험용 Responses API 연결과 v0.6 읽기 전용 시연 모드가 포함되어 있습니다. CS Brain은 미지원이며 전체 통합 검증·최종 Visual QA는 미완료입니다. 현재 범위는 [CORE_TASK_SCOPE.md](CORE_TASK_SCOPE.md), 최상위 방향은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)를 참고하세요.

## 쇼핑 AI 시연 실행

기존 DB 연결과 세션 설정을 유지한 별도 서버에서 로컬 비공개 환경 변수로 다음을 설정합니다. 실제 값은 Git에 저장하지 않습니다.

- `AI_LIVE_DEMO=1`, `LLM_PROVIDER=live`, `LLM_MODEL=gpt-6-luna`, `LLM_REASONING_EFFORT=xhigh`
- `LLM_API_KEY`: 서버 환경 변수로만 주입합니다. `key.md`, `.env`, `.secrets/`는 추적하지 않습니다.
- `HOST=127.0.0.1`, `PORT=3110`: 기존 Preview 3105와 분리합니다. 필요한 원격 DB CA는 `DATABASE_SSL_CA_FILE`로 지정합니다.
- 기존 `TEST_USER_CODES`에는 시연 사용자별 비공개 접근 코드를 설정합니다. 세션이 있어야 AI를 호출할 수 있습니다.

`npm start` 후 `http://127.0.0.1:3110`에서 로그인하고 AI 버튼을 엽니다. 프롬프트는 루트의 `SHOPPING_BRAIN_SYSTEM_v0.6.txt`를 원문 그대로 로드하고 Commerce Tool Adapter를 덧붙입니다. 제공되는 Tool은 상품 검색·상세·리뷰 조회 3개입니다. 이 모드에서는 DB 연결이 읽기 전용이며 일반 카트·주문·취소 변경도 차단됩니다. 일반 쇼핑은 기존 Commerce 서버에서 확인합니다. 키가 없으면 실제 모델 대신 stub이 선택됩니다.

호출 한도는 프로세스당 20턴/사용자당 6턴, 모델 호출 30회/사용자당 15회, 동시 사용자 2명입니다. 서버 재시작 시 초기화되므로 공개 무제한 서비스용 제한으로 사용하지 않습니다. 저장된 리뷰 수를 상품 전체 리뷰 수로 간주하지 않으며, 전체 수를 검증할 수 없는 상품은 추천이 아닌 참고 정보로 표시합니다.

이번 main 통합에서는 Typecheck, DB 없는 관련 Unit/Mock 회귀 82건과 메모리 프런트 빌드를 확인했습니다. 실제 LLM·DB·브라우저·전체 Unit·Integration·E2E를 새로 실행한 결과는 아닙니다. 기존 실행 증거와 Commerce Freeze 완료 여부는 별도로 관리합니다.

## 개발자별 로컬 실행 체크리스트

요구 환경: Node.js 24+, npm, Docker.

1. `.env.example`을 `.env`로 복사합니다.
2. 개인별 새 임의 비밀번호를 `.secrets/pg-password`에 저장하고 파일 접근을 본인 계정으로 제한합니다. 비밀 값을 출력·공유·커밋하지 마세요. Compose PostgreSQL role과 앱은 같은 파일을 사용합니다. 기존 DB volume은 파일 교체만으로 role 암호가 바뀌지 않습니다.
3. 본인이 소유한 새 loopback 로컬 DB와 Compose volume만 사용합니다. 금지 대상은 **현재 오케스트레이션 호스트/volume의 보호 DB와 보존 scratch**입니다. 팀원이 별도 호스트와 새 volume에 만든 DB가 같은 이름 `commerce`를 쓰는 것은 별개입니다. scratch 2/2는 현재 오케스트레이션 환경의 할당 상태이지 팀 전체 상한이 아닙니다. 같은 호스트에서 `5432`가 이미 사용 중이면 기존 프로세스/DB를 재사용·종료하거나 자격을 바꾸지 말고 준비를 멈춰 별도 로컬 환경을 조율하세요.
4. 아래 기본 명령은 `compose.yaml`의 PostgreSQL 17 (`127.0.0.1:5432`)을 사용합니다. 본인이 소유한 새 DB/volume에서 최초 한 번 실행합니다.

```powershell
docker compose -p codyssey-yourname up -d
npm ci
npm run db:migrate -- --phase=6
npm run db:seed -- --phase=4
npm run dev
```

Full Commerce는 migration phase 6(`001`–`004`), 상품·카트만의 schema 범위는 phase 1입니다. Base fixture seed는 개발 DB 최초 적재용입니다. 재실행하면 상품 재고/version과 시드 주문·취소·결제/환불 상태가 초기값으로 되돌아갈 수 있습니다. 선택적 `db:seed:demo`도 본인의 새 개발 DB임을 먼저 확인하세요. 앱 주소는 `http://localhost:3000`이며 접근 코드는 로컬 `.env`에서 관리합니다.

### PostgreSQL 18.6 병렬 개발 환경

PostgreSQL 18.6은 현재 기본 DB 전환이 아니라 별도 loopback 환경입니다. `compose.yaml`, PG17의 `5432` 포트와 volume은 그대로 둡니다. PG18 설정은 확인된 image digest, `127.0.0.1:5433`, PG18 전용 `codyssey_pg18_verify_data` volume 및 `PGDATA=/var/lib/postgresql/18/docker`를 사용하는 [`compose.pg18.yaml`](compose.pg18.yaml)입니다. 이 파일은 고정 `container_name`과 volume 이름을 쓰는 단일 인스턴스이므로 `-p`만 바꿔도 같은 Docker host에서 분리되지 않습니다. 각 팀원은 자기 Docker host와 새 volume에서만 실행하고, 같은 host에서 이름이 겹치면 멈춰 별도 PC/구성을 조율하세요. 기존 container/volume은 재사용하지 마세요.

자기 소유의 새 PG18 volume을 처음 만들 때만 다음을 실행합니다. Compose는 관리 DB `postgres`를 먼저 만들므로, 앱용 `commerce` DB도 이 새 PG18 인스턴스에만 생성합니다.

```powershell
docker compose -f compose.pg18.yaml up -d
docker compose -f compose.pg18.yaml exec -T db18 createdb -U commerce -O commerce commerce
```

앱과 migration/seed CLI를 실행하는 프로세스 환경(로컬 `.env`)에 두 값을 명시하고, 이 새 DB에만 초기 migration/fixture를 적용합니다. `.env.example`은 PG17 `5432` 기본값으로 유지됩니다. 비밀번호는 개인 `.secrets/pg-password` 파일에서 읽으며 값을 기록하거나 공유하지 않습니다.

```dotenv
DATABASE_URL=postgres://commerce@127.0.0.1:5433/commerce
DATABASE_PASSWORD_FILE=.secrets/pg-password
```

```powershell
npm run db:migrate -- --phase=6
npm run db:seed -- --phase=4
npm run dev
```

복원된 검증 DB와 보호 DB는 팀원 개발용 대상이 아닙니다. 여기에 migration·seed·테스트 쓰기를 하지 마세요. `SCRATCH_DB_TARGET=pg18`에 쓰이는 cluster system identifier pin은 현재 오케스트레이션 호스트의 안전 검증값이며 팀별 기본 설정이 아닙니다. 5433, container 이름 또는 volume 이름이 이미 사용 중이면 기존 대상을 종료·재사용하지 말고 멈춰 별도 로컬 구성을 조율하세요.

현재 `npm run verify`와 legacy Playwright 진입점은 `NOT_READY` fail-closed guard로 실행이 제한됩니다. 우회하거나 전체 PASS 경로로 안내하지 말고 최신 판정은 [VERIFICATION_LOG.md](docs/VERIFICATION_LOG.md)를 확인하세요.

## 기존 구조와 팀 handoff

- `src/catalog.ts`, `src/cart.ts`, `src/checkout.ts`, `src/orders.ts`, `src/cancellation.ts`가 Commerce 데이터·정책의 서버 정본입니다. 화면과 Agent Tool은 같은 Backend 규칙을 사용합니다.
- Product–Variant–Review ID/FK 연결을 보존합니다. 가격은 정수 KRW, 평점은 1–5이며 Review는 `source_kind`와 `source_ref`로 REAL/SYNTHETIC 및 출처를 구분합니다. 근거 없는 실리뷰를 만들지 않습니다.
- 세션에서 검증한 actor만 신뢰합니다. `GET /api/cart`는 카트를 upsert할 수 있고, 변경 요청은 예상 cart/variant version과 idempotency key를 사용합니다.
- 기본 경로는 `POST /api/session`(세션 쿠키 발급) → `GET /api/products` → `GET /api/products/:id`(variants 포함) / `GET /api/products/:id/reviews` → `GET /api/cart` → `POST /api/cart/items`, `PATCH`·`DELETE /api/cart/items/:cart_item_id`입니다.
- RAG 문서는 Commerce `product_id`, 선택된 `variant_id`, 근거 `review_id`의 원본 매핑을 유지합니다. Vector DB는 검색용이며 Commerce ID와 관계의 정본을 대체하지 않습니다.
- 기존 deterministic fixture `p-a/p-b/p-c`와 Demo namespace를 Amazon 등 외부 데이터와 분리합니다. 외부 데이터는 이용 권한 확인 후 새 namespace와 독립 적재 계획으로 다루며 importer는 아직 없습니다. 직접 scraping하거나 기존 seed를 덮어쓰지 마세요.

## 현재 WIP

PG18 작업 착수 전에 확인한 `main` 기준은 `0a81c8ae9e5857764a25853a99ded15678ec7422`이며, 그 시점에 PM이 local/origin SHA 일치를 확인했습니다. 이 값은 이번 문서·PG18 변경 이후의 현재 HEAD를 뜻하지 않습니다. PG17은 기본 `5432` 환경으로 유지되고, PG18.6은 별도 `5433` 병렬 환경으로 복원 정합성 및 실제 Preview를 확인했습니다. 기본 연결 cutover는 수행하지 않았습니다. 최신 check/build와 전체 Unit 727/727은 PASS이며, 실제 E2E는 58 PASS / 1 FAIL / 14 NOT_RUN, Integration은 NOT_RUN입니다. 실패 후 리뷰 탭 안내 assertion을 로컬에서 한 줄 보완했으나 E2E로 재검증하지 않았습니다. Preview는 이 오케스트레이션 host 전용 `http://127.0.0.1:3105/`이며 팀 공통 서비스 주소가 아닙니다. Commerce Freeze와 Visual 승인은 미완료입니다. 최신 상태는 [IMPLEMENTATION_PROGRESS.md](docs/IMPLEMENTATION_PROGRESS.md)와 [VERIFICATION_LOG.md](docs/VERIFICATION_LOG.md)를 확인하세요.
