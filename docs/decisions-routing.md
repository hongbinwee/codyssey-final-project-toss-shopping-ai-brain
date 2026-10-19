# OpenAI Decisions 라우팅 실험 (feature/jev)

`feature/brain-core`는 기본적으로 규칙 라우터(`routeBrainMessage`)를 유지합니다. `feature/jev`는 OpenAI Decisions API를 명시적으로 활성화할 수 있는 독립 실험입니다.

## 설정

- `BRAIN_ROUTE_MODE=rules` (기본): 기존 동기 정규식 라우터
- `BRAIN_ROUTE_MODE=decisions`: 모든 정상 사용자 메시지를 Decisions choice 분류로 전송
- `OPENAI_DECISIONS_API_KEY` 또는 `OPENAI_API_KEY`: **서버 전용** 키. 기존 Claude `LLM_API_KEY`와 별개
- `BRAIN_DECISIONS_TIMEOUT_MS=4000` (250–30000)
- `BRAIN_DECISIONS_CONFIDENCE=0.35` (0–1, 실측 QA 결과로 조정)

공식 API: https://developers.openai.com/api/docs/guides/decisions
`POST https://api.openai.com/v1/decisions` / `model=gpt-6-luna`. SDK 패키지 추가 없음.

Decisions는 **분류만** 하고 Commerce Tool 권한, Memory 갱신, 구매/결제 수행 권한을 부여하지 않습니다. `GREETING / SOCIAL / CAPABILITY / CS_REQUEST / UNCERTAIN`는 기존처럼 서버 고정 텍스트로 응답하고, 검색 여부는 기존 Graph 조건 분기를 그대로 사용합니다. **자연스러운 답변 생성은 별도 Hermes/LLM 대화 개선 과제**입니다.

### 안전성

- 최신 메시지 + 이전 상품 검색 계획의 **쿼리·예산·필수 조건만** 전송. 인증 정보, 사용자 ID, 전체 대화/Memory/Checkpoint는 전송하지 않습니다.
- 거절, 타임아웃, 429/5xx, 파싱 실패, 확신도 미달은 `UNCERTAIN / search:false`로 종료하며 다른 라우터로 무단 전환하지 않습니다.
- 정답 후보의 실제 선택 확률도 최소 0.45여야 합니다. 이 수치는 QA로 보정할 임시 기준입니다.
- 선택 결과는 Tool 권한이 아닙니다. 인증/권한/CSRF/구매 차단 및 RAG 근거 검증은 기존 서버에서 수행합니다.
- 기존 공개 QA(3112)에 **자동 활성화하지 않습니다**.

### 검증

- Mock Unit: `node --test tests/unit/brain-decisions-route.test.ts`
- 전체: `npm run check && npm run build && npm run test:unit`
- 실제 API QA: 승인된 독립 환경에 키를 넣고 테스트, Mock 결과와 분리 보고
- 비교 평가: 15개 이상의 실제 한국어 QA 문장, 혼합 의도, 이전 Shopping Plan, 인젝션/CS 분리를 기준으로 기존 룰 대비 정확도·오호출률·평균/p95 지연·비용/토큰 기록

API 키 미제공 시 실제 호출·지연·비용은 미검증 상태로 남습니다.
