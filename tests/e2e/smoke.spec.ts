import { expect, test } from "@playwright/test";

test("login screen renders", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "AI Commerce" }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("접근 코드")).toBeVisible();
});
