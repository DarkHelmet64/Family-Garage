// Every change to the shelf leaves a dated log entry saying what moved it:
// Use (straight off the shelf, no service record needed), Recount (what's
// physically there, with the difference logged rather than typed over), and
// parts booked onto a job. Editing a part no longer touches its count at all.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;
const part = (id) => page.evaluate((id) => window.__db.parts.find((p) => p.id === id), id);
const entries = () => page.evaluate(() => window.__db.purchases);

// The garage screen sweeps b1/b2's parts onto their scheduled jobs (5 qt of
// oil, 1 filter) -- the realistic starting point, with something set aside.
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const jobEntries = (await entries()).filter((e) => e.kind === "job");
check("booking parts onto a job logs where they went", jobEntries.some((e) => e.partId === "p1" && e.change === -2 && e.serviceTitle && e.vehicleId === "v1"));

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");
await page.waitForTimeout(300);
check("the silent − and + buttons are gone", (await page.locator('[data-act="part-minus"], [data-act="part-plus"]').count()) === 0);

// 1. Use, in the unit it's used in: 32 oz of a coolant counted in gallons.
await page.click('[data-act="use-part"][data-id="p3"]');
await page.waitForSelector(".modal");
await page.fill("#field-amount", "32");
await page.selectOption("#field-vehicleId", "v1");
await page.fill("#field-notes", "Topped off");
await page.click('.modal button:text-is("Log it")');
await page.waitForTimeout(300);
check("Use takes it off the shelf in the unit it's counted in", (await part("p3")).quantity === 1.75);
const used = (await entries()).find((e) => e.kind === "used");
check(
  "Use logs how much, on what, and why",
  used?.partId === "p3" && used.change === -0.25 && used.amount === 32 && used.amountUnit === "oz" && used.vehicleName === "Blue Odyssey" && used.notes === "Topped off"
);

// 2. Recount counts what's physically there, set-aside parts included.
const oilBefore = (await part("p1")).quantity; // free: 8 - 5 set aside
await page.click('.part-row[data-id="p1"]');
await page.waitForSelector(".modal");
check("editing a part no longer offers to type over its count", (await page.locator(".modal #field-quantity").count()) === 0);
await page.click('.modal button:text-is("Recount what\'s on the shelf")');
await page.waitForSelector('.modal:has-text("Recount 0W-20 oil")');
check("Recount starts from what's physically on the shelf", (await page.inputValue("#field-counted")) === String(oilBefore + 5));
await page.fill("#field-counted", String(oilBefore + 5 - 1));
await page.click('.modal button:text-is("Save count")');
await page.waitForTimeout(300);
check("Recount moves the shelf by the difference", (await part("p1")).quantity === oilBefore - 1);
const recount = (await entries()).find((e) => e.kind === "recount");
check("Recount logs the difference and what it was counted to", recount?.change === -1 && recount.countedTo === oilBefore + 4);

// The edit sheet underneath saves without touching the count.
await page.fill(".modal #field-brand", "Mobil 1");
await page.click('.modal button:text-is("Save changes")');
await page.waitForTimeout(300);
const oil = await part("p1");
check("saving an edit leaves the count alone", oil.quantity === oilBefore - 1 && oil.brand === "Mobil 1");

// 3. The part's history shows the hand-made changes.
await page.click('.part-row[data-id="p3"]');
await page.waitForSelector(".modal");
await page.click('.modal button:text-is("View purchase & usage history")');
await page.waitForSelector('.modal:has-text("Used & recounted")');
const history = await page.locator(".modal").last().textContent();
check("history lists a Use with what it was used on", /Used on Blue Odyssey/.test(history) && /−32 oz/.test(history));

report(app.errors);
await app.close();
