// Every place that says which job a part went on names that part's own job,
// not just the first job on the visit or the first one typed.
//
// The standard garage has two scheduled jobs on Blue Odyssey: Brake pads
// (2 qt oil) and Wiper blades (3 qt oil + the oil filter).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;
const historyOf = async (partId) => {
  await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-act=add-part]");
  await page.click(`.part-row[data-id="${partId}"]`);
  await page.waitForSelector(".modal");
  await page.click('.modal button:text-is("View purchase & usage history")');
  await page.waitForSelector('.modal:has-text("Used on jobs")');
  return page.locator(".modal").last().locator(".section-title:has-text('Used on jobs') + .list").textContent();
};

// 1. Log both scheduled jobs as one visit. The filter came from Wiper blades.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(400);
await page.click("[data-act=log-visit]");
await page.waitForSelector(".modal");
const jobPicks = await page.$$eval("[data-part-row]", (rows) =>
  rows.map((row) => ({
    part: row.querySelector("[data-part-id]").selectedOptions[0]?.textContent || "",
    job: row.querySelector("[data-part-job]")?.selectedOptions[0]?.textContent || "",
  }))
);
check(
  "a visit made of scheduled jobs keeps each part on the job it was booked for",
  jobPicks.some((r) => /Oil filter/.test(r.part) && r.job === "Wiper blades") &&
    jobPicks.some((r) => /0W-20 oil/.test(r.part) && r.job === "Brake pads") &&
    jobPicks.some((r) => /0W-20 oil/.test(r.part) && r.job === "Wiper blades")
);
await page.fill("#field-odometer", "98500").catch(() => {});
await page.click('.modal button:text-is("Log the visit")');
await page.waitForTimeout(500);
const visit = await page.evaluate(() => window.__db["vehicles/v1/services"].find((s) => s.status === "done" && (s.parts || []).length));
check(
  "the saved visit says which job each part went on",
  visit?.parts.some((p) => p.partId === "p2" && p.forJob === "Wiper blades") && visit?.parts.some((p) => p.partId === "p1" && p.forJob === "Brake pads")
);

// 2. The filter's history names Wiper blades, not the visit's first job.
const filterHistory = await historyOf("p2");
check("a part's history names the job it went on", /Wiper blades/.test(filterHistory) && !/Brake pads/.test(filterHistory));

// 3. Scheduling two jobs at once: each part goes on the job picked for it.
await page.goto(`${base}?vehicle=v2`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.click("[data-act=log-service]");
await page.click('.picker-option:has-text("Schedule something")');
await page.waitForSelector(".modal");
await page.fill('[data-list-rows="titles"] [data-item-title]', "Oil change");
await page.click('[data-list-add="titles"]');
await page.locator('[data-list-rows="titles"] [data-item-title]').nth(1).fill("Engine air filter");
await page.click("[data-parts-add]");
await page.selectOption("[data-part-row] [data-part-id]", "p2");
await page.selectOption("[data-part-row] [data-part-job]", { label: "Engine air filter" });
await page.click('.modal button:text-is("Schedule it")');
await page.waitForTimeout(400);
const v2 = await page.evaluate(() => window.__db["vehicles/v2/services"]);
const oilChange = v2.find((s) => s.title === "Oil change");
const airFilter = v2.find((s) => s.title === "Engine air filter");
check(
  "scheduling several jobs books each part onto the job picked for it",
  airFilter?.partsNeeded?.some((p) => p.partId === "p2") && !(oilChange?.partsNeeded || []).length
);
const logged = await page.evaluate(() => window.__db.purchases.filter((e) => e.kind === "job" && e.vehicleId === "v2"));
check("…and the stock log names that job", logged.length === 1 && logged[0].serviceTitle === "Engine air filter");

report(app.errors);
await app.close();
