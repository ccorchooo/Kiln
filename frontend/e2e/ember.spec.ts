import { expect, test, type Page } from "@playwright/test";

// Needs a live model server (AXION) and, for the image test, ComfyUI. KILN_E2E_IMAGES=1 enables it.
const password = process.env.KILN_TEST_PASSWORD ?? "";
test.skip(!password, "set KILN_TEST_PASSWORD to run the Ember tests");

async function unlockAndOpen(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("kiln.wm.v1"));
  await page.reload();
  const pill = page.getByLabel("Password");
  await pill.fill(password);
  await pill.press("Enter");
  const orb = page.getByRole("button", { name: "Open Ember" });
  await expect(orb).toBeVisible();
  await expect(page.getByText(/Good (morning|afternoon|evening|night)/)).toHaveCount(0);
  await orb.click();
  const panel = page.getByRole("complementary", { name: "Ember" });
  await expect(panel).toBeVisible();
  return panel;
}

test("orb opens the sidebar; chat streams an answer; model picker lists AXION models", async ({ page }) => {
  test.setTimeout(120_000);
  const panel = await unlockAndOpen(page);
  await panel.getByRole("button", { name: /qwen|Model/i }).click();
  await expect(panel.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await panel.getByLabel("Message Ember").fill("Reply with exactly one word: pong");
  await panel.getByLabel("Message Ember").press("Enter");
  await expect(panel.locator(".kiln-prose").last()).toContainText(/pong/i, { timeout: 90_000 });
  await panel.getByRole("button", { name: "Close Ember" }).click();
  await expect(panel).toBeHidden();
});

test("a command that changes files waits for approval", async ({ page }) => {
  test.setTimeout(150_000);
  const panel = await unlockAndOpen(page);
  const name = `e2e-${Date.now()}.txt`;
  await panel
    .getByLabel("Message Ember")
    .fill(`Use run_command to run exactly this command and nothing else: touch ${name}`);
  await panel.getByLabel("Message Ember").press("Enter");
  const allow = panel.getByRole("button", { name: "Allow" });
  await expect(allow).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByText(`$ touch ${name}`)).toBeVisible();
  await allow.click();
  await expect(panel.getByText("Done").first()).toBeVisible({ timeout: 30_000 });
  const listing = await page.evaluate(() =>
    fetch("/api/fs/list?path=~").then((r) => r.json() as Promise<{ entries: { name: string }[] }>),
  );
  expect(listing.entries.map((e) => e.name)).toContain(name);
});

test("image mode generates a picture with ComfyUI", async ({ page }) => {
  test.skip(!process.env.KILN_E2E_IMAGES, "set KILN_E2E_IMAGES=1 (needs ComfyUI)");
  test.setTimeout(240_000);
  const panel = await unlockAndOpen(page);
  await panel.getByRole("radio", { name: "Image" }).click();
  await panel.getByLabel("Describe an image").fill("a tiny clay kiln glowing at dusk, minimal illustration");
  await panel.getByRole("button", { name: "Generate" }).click();
  await expect(panel.locator("figure img").first()).toBeVisible({ timeout: 200_000 });
  const ok = await panel
    .locator("figure img")
    .first()
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(ok).toBe(true);
});
