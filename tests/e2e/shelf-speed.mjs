// The parts pages read only what they show: scheduled jobs (not every
// service ever logged) for what's set aside, the last 90 days of the stock
// log for history lines and the Purchases page, and one part's own entries
// for its history. A project without the collection-group index falls back
// to reading every service. Plus search and a category filter on the shelf.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;
const reads = () => page.evaluate(() => window.__reads);
const keys = (r, kind) => Object.keys(r[kind] || {});

// Sweep b1/b2's parts onto their jobs first, so something is set aside.
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");
await page.waitForTimeout(300);
let r = await reads();
check("the shelf reads scheduled jobs only", keys(r, "onSnapshot").includes("collectionGroup:services?status==scheduled"));
check("…not every service ever logged", !keys(r, "onSnapshot").includes("collectionGroup:services"));
check("the shelf reads only the recent stock log", keys(r, "onSnapshot").some((k) => k.startsWith("purchases?purchasedOn>=")) && !keys(r, "onSnapshot").includes("purchases"));
check("set-aside figures still show", /5 qt set aside for jobs/.test(await page.locator('.part-row[data-id="p1"]').textContent()));

// A part's history reads its own entries, not the whole log.
await page.click('.part-row[data-id="p1"]');
await page.waitForSelector(".modal");
await page.click('.modal button:text-is("View purchase & usage history")');
await page.waitForSelector('.modal:has-text("Used on jobs")');
r = await reads();
check("a part's history reads only that part's log entries", keys(r, "getDocs").includes("purchases?partId==p1") && !keys(r, "getDocs").includes("purchases"));
check("…and still finds an old purchase", /NAPA/.test(await page.locator(".modal").last().textContent()));
await page.click("#history-close");
await page.click('.modal button:text-is("Cancel")');

// Search and categories.
await page.fill("#parts-search", "filter");
await page.waitForTimeout(100);
let names = await page.locator(".part-row .row-title-text").allTextContents();
check("search narrows the shelf", names.length === 1 && names[0] === "Oil filter");
await page.fill("#parts-search", "zzz");
check("a search with no match says so", /Nothing on the shelf matches/.test(await page.locator("#parts-list").textContent()));
await page.fill("#parts-search", "");

for (const [id, category] of [["p1", "Fluids"], ["p3", "Fluids"], ["p2", "Filters"]]) {
  await page.click(`.part-row[data-id="${id}"]`);
  await page.waitForSelector(".modal");
  await page.fill(".modal #field-category", category);
  await page.click('.modal button:text-is("Save changes")');
  await page.waitForTimeout(200);
}
check("a chip per category once there's more than one", (await page.locator('[data-act="filter-category"]').count()) === 3);
await page.click('[data-act="filter-category"][data-id="Fluids"]');
names = await page.locator(".part-row .row-title-text").allTextContents();
check("a category chip narrows the shelf to it", names.length === 2 && names.every((n) => n !== "Oil filter"));
await page.click('[data-act="filter-category"][data-id="Fluids"]');
check("tapping it again shows everything", (await page.locator(".part-row").count()) === 3);

// The Purchases page: recent first, older on request. The seeded purchase
// is 200 days old.
await page.goto(`${base}?purchases`, { waitUntil: "networkidle" });
await page.waitForTimeout(200);
check("the Purchases page starts with the last 90 days", (await page.locator(".purchase-row").count()) === 0 && /last 90 days/.test(await page.locator("#purchases-list").textContent()));
await page.click('[data-act="show-older-purchases"]');
await page.waitForTimeout(200);
check("Show older brings in everything", (await page.locator(".purchase-row").count()) === 1);

report(app.errors);
await app.close();

// A project without the collection-group index on services.status: the
// filtered query is refused, and the shelf falls back to reading them all.
const fallback = await launchApp(FIXTURE);
await fallback.page.addInitScript(() => {
  window.__noGroupIndex = true;
});
await fallback.page.goto(fallback.base, { waitUntil: "networkidle" });
await fallback.page.waitForTimeout(600);
await fallback.page.goto(`${fallback.base}?parts`, { waitUntil: "networkidle" });
await fallback.page.waitForTimeout(400);
const fr = await fallback.page.evaluate(() => window.__reads);
check("without the index, it falls back to reading every service", Object.keys(fr.onSnapshot).includes("collectionGroup:services"));
check("…and the set-aside figures still show", /5 qt set aside for jobs/.test(await fallback.page.locator('.part-row[data-id="p1"]').textContent()));
report(fallback.errors);
await fallback.close();
