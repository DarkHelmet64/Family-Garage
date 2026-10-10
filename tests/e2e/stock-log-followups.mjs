// Three follow-ups to the stock log: a mistaken Use or Recount can be undone
// from the part's history; finishing a booked job logs "Used on <job>" (once,
// without moving the shelf again); and the job picker says its figure is
// what's free.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;
const qty = (id) => page.evaluate((id) => window.__db.parts.find((p) => p.id === id).quantity, id);
const log = () => page.evaluate(() => window.__db.purchases);
const openHistory = async (id) => {
  await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-act=add-part]");
  await page.click(`.part-row[data-id="${id}"]`);
  await page.waitForSelector(".modal");
  await page.click('.modal button:text-is("View purchase & usage history")');
  await page.waitForSelector('.modal:has-text("Used on jobs")');
  await page.waitForTimeout(300); // let it finish sliding up
};

// 1. Undo a Use.
await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");
const coolantBefore = await qty("p3");
await page.click('[data-act="use-part"][data-id="p3"]');
await page.waitForSelector(".modal");
await page.fill("#field-amount", "32");
await page.click('.modal button:text-is("Log it")');
await page.waitForTimeout(300);
check("the Use took coolant off", (await qty("p3")) === coolantBefore - 0.25);
await openHistory("p3");
await page.click(".modal [data-undo]");
await page.waitForSelector('.modal:has-text("Undo this?")');
check("undo says what it'll put back", /back up by 0\.25 gal/.test(await page.locator(".modal").last().textContent()));
await page.click("#confirm-ok");
await page.waitForTimeout(300);
check("undoing a Use puts the count back", (await qty("p3")) === coolantBefore);
check("…and takes the entry off the log", !(await log()).some((e) => e.kind === "used"));

// 2. Undo a Recount.
await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.click('.part-row[data-id="p2"]');
await page.waitForSelector(".modal");
await page.click('.modal button:text-is("Recount what\'s on the shelf")');
await page.waitForSelector('.modal:has-text("Recount Oil filter")');
const filterBefore = await qty("p2");
await page.fill("#field-counted", "10");
await page.click('.modal button:text-is("Save count")');
await page.waitForTimeout(300);
await page.click('.modal button:text-is("Cancel")');
check("the recount moved the count", (await qty("p2")) !== filterBefore);
await openHistory("p2");
await page.click(".modal [data-undo]");
await page.click("#confirm-ok");
await page.waitForTimeout(300);
check("undoing a Recount puts the count back", (await qty("p2")) === filterBefore);

// 3. The job picker says its figure is what's free.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(400); // the sweep sets b1/b2's parts aside
await page.click("[data-act=log-service]");
await page.click('.picker-option:has-text("Schedule something")');
await page.waitForSelector(".modal");
await page.click("[data-parts-add]");
const options = await page.locator("[data-part-id] option").allTextContents();
check("the job picker labels its figure as free", options.some((o) => /^0W-20 oil \(\d+(\.\d+)? qt free\)$/.test(o)));
await page.click('.modal button:text-is("Cancel")');

// 4. Marking a booked job done logs "Used on" once, without moving the shelf.
const oilBefore = await qty("p1");
await page.click('.service-row:has(.row-title-text:text-is("Brake pads")) [data-act="complete-service"]');
await page.waitForSelector(".modal");
await page.click('.modal button:text-is("Mark done")');
await page.waitForTimeout(500);
check("finishing a booked job doesn't move the shelf again", (await qty("p1")) === oilBefore);
let done = (await log()).filter((e) => e.kind === "job" && e.done);
check("…but logs what it used, on which job", done.length === 1 && done[0].partId === "p1" && done[0].quantity === 2 && done[0].change === 0 && done[0].serviceTitle === "Brake pads");

// Re-saving the finished record unchanged logs nothing more.
const doneRecord = await page.evaluate(() => window.__db["vehicles/v1/services"].find((s) => s.title === "Brake pads" && s.status === "done"));
await page.click("[data-act=toggle-history]").catch(() => {});
await page.click(`[data-act="edit-service"][data-id="${doneRecord.id}"]`);
await page.waitForSelector(".modal");
await page.click('.modal button:text-is("Save")');
await page.waitForTimeout(400);
done = (await log()).filter((e) => e.kind === "job" && e.done);
check("re-saving a finished visit unchanged logs nothing", done.length === 1);

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForTimeout(300);
check("the shelf's history line reads Used on", /Used on Brake pads/.test(await page.locator('.part-row[data-id="p1"]').textContent()));

report(app.errors);
await app.close();

// 5. Both booked jobs logged as one visit, in a fresh garage: one "Used on"
// entry per part, nothing moving the shelf, and no hand-back entries.
const fresh = await launchApp(FIXTURE);
await fresh.page.goto(`${fresh.base}?vehicle=v1`, { waitUntil: "networkidle" });
await fresh.page.waitForSelector(".hero-figure");
await fresh.page.waitForTimeout(400);
const shelfBefore = await fresh.page.evaluate(() => JSON.stringify(window.__db.parts.map((p) => p.quantity)));
await fresh.page.click("[data-act=log-visit]");
await fresh.page.waitForSelector(".modal");
await fresh.page.click('.modal button:text-is("Log the visit")');
await fresh.page.waitForTimeout(500);
const entries = await fresh.page.evaluate(() => window.__db.purchases.filter((e) => e.kind === "job" && e.done));
check(
  "a visit made of booked jobs logs what each part was used on",
  entries.length === 2 &&
    entries.every((e) => e.change === 0) &&
    entries.find((e) => e.partId === "p1")?.quantity === 5 &&
    /Brake pads/.test(entries.find((e) => e.partId === "p1")?.serviceTitle) &&
    entries.find((e) => e.partId === "p2")?.serviceTitle === "Wiper blades"
);
check("…without hand-back entries", !(await fresh.page.evaluate(() => window.__db.purchases.some((e) => e.kind === "job" && e.change > 0))));
check("…and without moving the shelf", (await fresh.page.evaluate(() => JSON.stringify(window.__db.parts.map((p) => p.quantity)))) === shelfBefore);
report(fresh.errors);
await fresh.close();
