import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

await mkdir(".test-artifacts", { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(process.env.TEST_URL ?? "http://localhost:5178/?debug=ai", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Watch CPU vs CPU/ }).click();
  await page.locator("canvas").waitFor();
  await page.waitForTimeout(9000);
  await page.getByRole("button", { name: "data", exact: true }).click();
  await page.getByText("Match Data", { exact: true }).waitFor();
  await page.getByText(/pivot \(/i).first().waitFor({ timeout: 12000 });
  await page.getByText("Receiver options", { exact: true }).first().waitFor({ timeout: 12000 });
  const body = await page.locator("body").innerText();
  assert(body.includes("Delivered:") && body.includes("GK foot controls"));
  assert(/PIVOT|pivot/.test(body));
  assert(/RUNNER|runner/.test(body));
  await page.screenshot({ path: ".test-artifacts/browser-match.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Resume match" }).waitFor();
  await page.getByRole("button", { name: "Resume match" }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: /Play Match/ }).click();
  await page.locator("canvas").waitFor();
  await page.waitForTimeout(3500);
  await page.keyboard.down("d");
  await page.waitForTimeout(500);
  await page.keyboard.up("d");
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("PASS browser: spectator startup, tactical jobs/counters/options, pause/resume, menu, player startup; no JS errors");
} finally {
  await browser.close();
}