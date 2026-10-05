import { expect, test } from "@playwright/test";

test("app shell renders and db is connected", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "AI Commerce" }),
  ).toBeVisible();
  await expect(page.getByText(/DB 상태: 연결됨/)).toBeVisible();
});
