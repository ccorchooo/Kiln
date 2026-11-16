import { expect, test } from "@playwright/test";

const password = process.env.KILN_TEST_PASSWORD ?? "";

test.skip(!password, "set KILN_TEST_PASSWORD to run the smoke test");

test("lock screen → wrong password → unlock → lock", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(m.text()));

  await page.goto("/");
  const pill = page.getByLabel("Password");
  await expect(pill).toBeVisible();

  await pill.fill("definitely wrong");
  await pill.press("Enter");
  await expect(pill).toHaveValue("");
  await expect(page.getByText(/Good (morning|afternoon|evening|night)/)).toHaveCount(0);

  await pill.fill(password);
  await pill.press("Enter");
  await expect(page.getByText(/Good (morning|afternoon|evening|night)/)).toBeVisible();
  await expect(page.getByLabel(/^Ask /)).toBeVisible();

  await page.keyboard.press("Control+Alt+l");
  await expect(page.getByLabel("Password")).toBeVisible();
  const state = await page.evaluate(() => fetch("/api/auth/state").then((r) => r.json()));
  expect(state.locked).toBe(true);
  expect(errors).toEqual([]);
});

test("security headers are present", async ({ request }) => {
  const res = await request.get("/");
  const csp = res.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
});
