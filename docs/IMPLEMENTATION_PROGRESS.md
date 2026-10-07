# Implementation Progress

> 표기 규칙: Phase 0~5의 '완료'는 **로컬 구현 + 로컬 검증**(unit·integration·e2e·stub eval·holdout·Docker 빌드) 기준이다. 실제 LLM live eval·외부 배포·실사용자 테스트는 미완료이며 프로젝트 로드맵 12~13에서 수행한다(PROJECT_CONTEXT.md §현재 프로젝트 방향).

| Phase | 상태 | 메모 |
| --- | --- | --- |
| 0 | 완료 (2026-10-06 Docker DB로 재검증) | node 스택 셸, migrate/seed/verify, 세션·health 테스트, e2e smoke. `.env`→Docker 5432 확인 |
| 1 | 완료 (2026-10-06) | T1 slice: 카탈로그/옵션/리뷰/카트/멱등 action/Agent Tool·A01 패널/stub eval. live LLM eval은 키 없어 BLOCKED |
| 2 | 완료 (2026-10-06) | T1 완성: 카트 수량 수정/삭제·멱등 복구·비교 카드(A01)·인용 근거 검증·주입 리뷰 방어 시드. migration 없음. live eval BLOCKED(키 없음) |
| 3 | 완료 (2026-10-06) | T2: migration 002(주문/결제/배송), 시나리오 seed, 견적(5분 서명 토큰)→원자 confirm, W04/W05/W06, CS Brain 3 Tool(brain 분리), simulate CLI. verify --phase=3 통과(unit9/int40/e2e7/eval12). live eval BLOCKED(키 없음) |
| 4 | 완료 (2026-10-07) | T3: migration 003(cancel_requests), 자격/견적 READ + 승인(UI)→실행(Tool) 분리, A02 취소 시트, W05/W06 취소 표시, 시뮬레이터 cancel/refund. verify --phase=4 통과(tsc/unit18/int58/e2e9/eval stub16). live eval BLOCKED(키 없음) |
| 5 | 로컬 구현·검증 완료 / 외부 검증 미완료 | core-journeys 스펙(필수 상태 5종), holdout 6케이스×3회, eval --repeat, Dockerfile+실기동 검증, USER_TEST_REPORT 준비, README. 외부 배포 실행·실사용자 5명 테스트·피드백 반영은 미완료. live eval BLOCKED(키 없음) |
| UI-1 (=로드맵 04-A) | 1차 기능 구현 완료 — Visual 목표 미달, 04 진행 중으로 재분류 (2026-10-07) | 토스쇼핑 유사 구매자 UI 1차: 홈·검색·목록·카테고리 탐색. dark 토큰/모바일 컬럼, 카테고리 탭, 검색 3상태+정렬 바텀시트, 상품 이미지(webp convention), /assets 정적 서빙. Backend·DB·Tool 계약 무수정. 회귀 PASS, live eval BLOCKED. **Visual QA 결과 구조적 유사성 부족 — 04-C 재구성 대상** |
| UI-1b | 완료 (2026-10-07) | 디자인 시스템 정본화+Visual 보정: COMMERCE_DESIGN_SYSTEM v2(Light/Dark semantic 토큰·Iconography·상태 스펙), prefers-color-scheme Light/Dark 자동 전환, 이모지→icons.tsx SVG 통일, 홈 카테고리 pill 칩화, 검색 카트 아이콘·시트 grabber. 상세→옵션→카트 후속 스펙을 COMMERCE_UI_SPEC 7-1에 기록. tsc/unit18/int 전체/e2e14 PASS. live eval BLOCKED(키 없음) |
| 04 Toss Shopping Shell | 🟡 진행 중 | 04-A 기본 UI ✅(위 UI-1/1b) / 04-B Demo Catalog 확장(20~30개·다중 카테고리·section tag — 스키마 변경 승인 대기) / 04-C Home 재구성(화면 단위 IA·밀도) / 04-D Navigation 재구성(레퍼런스 최대 충실) / 04-E Screenshot·Visual QA. 완료 조건: 첫 화면에서 토스쇼핑 기반임이 명확한 수준의 구조적 유사성. 근거: PROJECT_CONTEXT.md §현재 프로젝트 방향 |
