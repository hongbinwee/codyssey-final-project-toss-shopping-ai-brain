# AI Commerce Environment

구매자용 Commerce Environment를 먼저 완성하고, 이후 Shopping Brain / CS Agent를 결합하는 프로젝트입니다. 이 문서는 RAG·시스템 프롬프트 팀을 위한 **WIP 맥락 공유**이며 Brain 통합이나 Commerce Freeze 완료를 뜻하지 않습니다. AI stub/scaffolding과 화면의 `준비중` 상태를 유지합니다. 현재 범위는 [CORE_TASK_SCOPE.md](CORE_TASK_SCOPE.md), 최상위 방향은 [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)를 참고하세요.

## 개발자별 로컬 실행 체크리스트

요구 환경: Node.js 24+, npm, Docker.

1. `.env.example`을 `.env`로 복사합니다.
2. 개인별 새 임의 비밀번호를 `.secrets/pg-password`에 저장하고 파일 접근을 본인 계정으로 제한합니다. 비밀 값을 출력·공유·커밋하지 마세요. Compose PostgreSQL role과 앱은 같은 파일을 사용합니다. 기존 DB volume은 파일 교체만으로 role 암호가 바뀌지 않습니다.
3. 본인이 소유한 새 loopback 로컬 DB와 Compose volume만 사용합니다. 금지 대상은 **현재 오케스트레이션 호스트/volume의 보호 DB와 보존 scratch**입니다. 팀원이 별도 호스트와 새 volume에 만든 DB가 같은 이름 `commerce`를 쓰는 것은 별개입니다. scratch 2/2는 현재 오케스트레이션 환경의 할당 상태이지 팀 전체 상한이 아닙니다. 같은 호스트에서 `5432`가 이미 사용 중이면 기존 프로세스/DB를 재사용·종료하거나 자격을 바꾸지 말고 준비를 멈춰 별도 로컬 환경을 조율하세요.
4. 새 개발 DB에서 아래 명령을 최초 한 번 실행합니다.

```powershell
docker compose -p codyssey-yourname up -d
npm ci
npm run db:migrate -- --phase=6
npm run db:seed -- --phase=4
npm run dev
```

Full Commerce는 migration phase 6(`001`–`004`), 상품·카트만의 schema 범위는 phase 1입니다. Base fixture seed는 개발 DB 최초 적재용입니다. 재실행하면 상품 재고/version과 시드 주문·취소·결제/환불 상태가 초기값으로 되돌아갈 수 있습니다. 선택적 `db:seed:demo`도 본인의 새 개발 DB임을 먼저 확인하세요. 앱 주소는 `http://localhost:3000`이며 접근 코드는 로컬 `.env`에서 관리합니다.

현재 `npm run verify`와 legacy Playwright 진입점은 `NOT_READY` fail-closed guard로 실행이 제한됩니다. 우회하거나 전체 PASS 경로로 안내하지 말고 최신 판정은 [VERIFICATION_LOG.md](docs/VERIFICATION_LOG.md)를 확인하세요.

## 기존 구조와 팀 handoff

- `src/catalog.ts`, `src/cart.ts`, `src/checkout.ts`, `src/orders.ts`, `src/cancellation.ts`가 Commerce 데이터·정책의 서버 정본입니다. 화면과 Agent Tool은 같은 Backend 규칙을 사용합니다.
- Product–Variant–Review ID/FK 연결을 보존합니다. 가격은 정수 KRW, 평점은 1–5이며 Review는 `source_kind`와 `source_ref`로 REAL/SYNTHETIC 및 출처를 구분합니다. 근거 없는 실리뷰를 만들지 않습니다.
- 세션에서 검증한 actor만 신뢰합니다. `GET /api/cart`는 카트를 upsert할 수 있고, 변경 요청은 예상 cart/variant version과 idempotency key를 사용합니다.
- 기본 경로는 `POST /api/session`(세션 쿠키 발급) → `GET /api/products` → `GET /api/products/:id`(variants 포함) / `GET /api/products/:id/reviews` → `GET /api/cart` → `POST /api/cart/items`, `PATCH`·`DELETE /api/cart/items/:cart_item_id`입니다.
- RAG 문서는 Commerce `product_id`, 선택된 `variant_id`, 근거 `review_id`의 원본 매핑을 유지합니다. Vector DB는 검색용이며 Commerce ID와 관계의 정본을 대체하지 않습니다.
- 기존 deterministic fixture `p-a/p-b/p-c`와 Demo namespace를 Amazon 등 외부 데이터와 분리합니다. 외부 데이터는 이용 권한 확인 후 새 namespace와 독립 적재 계획으로 다루며 importer는 아직 없습니다. 직접 scraping하거나 기존 seed를 덮어쓰지 마세요.

## 현재 WIP

Checkpoint `checkpoint/commerce-20261014`의 `74effc7`은 원격 반영됐고 `main`은 `75f2eef`로 보존됐습니다(PM 확인). Core UI·검증은 미완료입니다: check/build PASS, 전체 unit 15분 timeout(INCOMPLETE), E2E 52 PASS / 5 FAIL / 16 NOT_RUN, Integration NOT_RUN, Preview OFF. 네 E2E spec은 로컬 수정됐지만 실제 E2E 재실행은 없습니다. 이 네 파일 수정은 이번 5파일 공유 커밋에 포함되지 않습니다. 06-C Visual 승인과 Commerce Freeze가 남아 있습니다. 자세한 현재 상태는 [IMPLEMENTATION_PROGRESS.md](docs/IMPLEMENTATION_PROGRESS.md)를 참고하세요.
