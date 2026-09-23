import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.TEST_URL || "http://localhost:5187";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/api/meta?*", (route) => route.fulfill({
    json: { hosts: [], sync: [], scanMs: 0, sessionCount: 0, projectCount: 0, projectNames: [], hostNames: [] },
  }));
  await page.route("**/api/overview?*", (route) => route.fulfill({
    json: { totals: { cost: 0, allTok: 0, prompts: 0, asst: 0, subagents: 0, errors: 0, toolUses: 0, sessions: 0 },
      costLastHour: 0, buckets: [], models: [], projects: [], tools: [] },
  }));
  await page.goto(base);
  await page.evaluate(() => {
    localStorage.setItem("overviewGranularity", "hour");
    localStorage.setItem("overviewDayRange", "all");
    localStorage.setItem("overviewHourRange", "48h");
  });
  await page.goto(`${base}/?granularity=day&range=1w#/overview`);
  await page.getByRole("heading", { name: "Estimated cost per day (by model) (1W)", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Daily", exact: true }).getAttribute("class"), "active");
  assert.equal(await page.evaluate(() => localStorage.getItem("overviewGranularity")), "hour");
  assert.equal(await page.evaluate(() => localStorage.getItem("overviewDayRange")), "all");
  await page.reload();
  await page.getByRole("heading", { name: "Estimated cost per day (by model) (1W)", exact: true }).waitFor();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Estimated cost per day (by model) (1W)", exact: true }).waitFor();
  await page.goto(`${base}/?granularity=invalid&range=invalid#/overview`);
  await page.getByRole("heading", { name: "Estimated cost per hour (by model) (48H)", exact: true }).waitFor();
  await page.goto(`${base}/?granularity=hour&range=168h&modelView=simple#/overview`);
  await page.getByRole("heading", { name: "Estimated cost per hour (by model) (1W)", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Simple", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  assert.equal(new URL(page.url()).search, "");
  await page.getByRole("heading", { name: "Estimated cost per day (by model) (1M)", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Estimated cost per day (by model) (1M)", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?granularity=day&range=1w#/overview`);
  await page.getByRole("heading", { name: "Estimated cost per day (by model) (1W)", exact: true }).waitFor();
  console.log("PASS: URL precedence, preference preservation, reload, tab navigation, invalid values, hourly range, model view, reset, mobile.");
} finally {
  await browser.close();
}
