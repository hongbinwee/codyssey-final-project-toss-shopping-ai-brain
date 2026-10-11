import { setupRestrictedE2EDb } from "../helpers/testdb.ts";

// PMQA-044-A — 승인 한정 restricted reset.
// 기존 setupTestDb(4)의 broad upsert와 cleanUserData의 전체 비-seed 삭제를
// 대체한다: 감사된 13주문+직접종속만 삭제하고 실측 drift fixture만 복원한다.
// 승인 목록·baseline·보존 지문이 정확히 일치하지 않으면 write 0건으로 중단한다.
export default async function () {
  await setupRestrictedE2EDb();
}
