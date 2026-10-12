import { chromium } from "@playwright/test";
import { assertEntryRunnable } from "../tests/helpers/pw-config-gate.ts";
// PMQA-055: 고정명 덮어쓰기 경로 — 보호 전환 전 launch를 차단한다.
assertEntryRunnable("scripts/shoot-themes.mjs");
// Light/Dark 검증 스크린샷 — 출력은 playwright가 비우지 않는 shots/compare/.
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3200/#/");
  await page.getByPlaceholder("접근 코드").fill("demo-a");
  await page.getByRole("button", { name: "시작하기" }).click();
  await page.waitForSelector(".product-card", { timeout: 10000 });
  await page.screenshot({ path: "shots/compare/" + scheme + "_home.png" });
  await page.goto("http://localhost:3200/#/search");
  await page.getByPlaceholder("검색어를 입력하세요").fill("모니터");
  await page.getByPlaceholder("검색어를 입력하세요").press("Enter");
  await page.waitForSelector(".product-card");
  await page.screenshot({ path: "shots/compare/" + scheme + "_search_results.png" });
  await page.goto("http://localhost:3200/#/search");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "shots/compare/" + scheme + "_search_idle.png" });
  await page.goto("http://localhost:3200/#/search?q=%EB%83%89%EC%9E%A5%EA%B3%A0");
  await page.waitForTimeout(700);
  await page.screenshot({ path: "shots/compare/" + scheme + "_search_empty.png" });
  await page.goto("http://localhost:3200/#/?cat=monitor");
  await page.waitForSelector(".product-card");
  await page.screenshot({ path: "shots/compare/" + scheme + "_home_cat.png" });
  await ctx.close();
}
await b.close();
console.log("done");

