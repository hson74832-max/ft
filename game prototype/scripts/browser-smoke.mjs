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

  // The FPS readout is a setting: on by default, off from the Settings panel.
  await page.getByRole("button", { name: /Settings/ }).click();
  await page.getByRole("button", { name: /FPS counter/ }).click();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Watch CPU vs CPU/ }).click();
  await page.locator("canvas").waitFor();
  await page.waitForTimeout(9000);
  const hud = await page.locator("body").innerText();
  assert(!/FPS/.test(hud), "the FPS counter must stay hidden while it is switched off");
  // The old chrome is gone: no bottom panels, no in-match Menu / Pause buttons, no
  // seed or possession strip, no logo.
  assert(!/IN PLAY|INPLAY/.test(hud), "no phase strip in the HUD");
  assert(!/who has the ball/i.test(hud), "no possession strip in the HUD");
  assert(!/seed/i.test(hud), "no seed readout in the HUD");
  assert.equal(await page.getByRole("button", { name: "Menu", exact: true }).count(), 0,
    "no Menu button during play — Start/Escape pauses instead");
  assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).count(), 0,
    "no Pause button during play — Start/Escape pauses instead");
  await page.getByRole("button", { name: "data", exact: true }).click();
  await page.getByText("Match Data", { exact: true }).waitFor();
  await page.getByText(/pivot \(/i).first().waitFor({ timeout: 12000 });
  await page.getByText("Receiver options", { exact: true }).first().waitFor({ timeout: 12000 });
  const body = await page.locator("body").innerText();
  assert(body.includes("Delivered:") && body.includes("GK foot controls"));
  assert(/PIVOT|pivot/.test(body));
  assert(/RUNNER|runner/.test(body));
  await page.screenshot({ path: ".test-artifacts/browser-match.png" });

  // Start/Escape pauses and opens the menu.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Resume match" }).waitFor();
  await page.getByRole("button", { name: /FPS counter/ }).click();     // turn it back on
  await page.getByRole("button", { name: "Resume match" }).click();
  await page.getByText(/^\d+ FPS$/).waitFor({ timeout: 4000 });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Return to menu" }).click();

  await page.getByRole("button", { name: /Play Match/ }).click();
  await page.locator("canvas").waitFor();
  await page.waitForTimeout(3500);
  // Keyboard controls reach the match: holding pass / shoot shows its power meter
  // (the reported bug was that neither the bar nor the kick ever happened).
  await page.keyboard.down("Space");
  await page.getByText("PASS", { exact: true }).waitFor({ timeout: 3000 });
  await page.keyboard.up("Space");
  await page.keyboard.down("e");
  await page.getByText("SHOOT", { exact: true }).waitFor({ timeout: 3000 });
  await page.keyboard.up("e");
  // [X] switches the controlled player instead of doing nothing.
  await page.keyboard.press("x");
  await page.keyboard.down("d");
  await page.waitForTimeout(500);
  await page.keyboard.up("d");
  assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`);
  console.log("PASS browser: settings FPS toggle, spectator startup, tactical jobs/counters/options, pause/menu flow, keyboard controls; no JS errors");
} finally {
  await browser.close();
}
