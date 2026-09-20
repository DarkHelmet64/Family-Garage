// The parts shelf works like an actual cabinet: booking a job's parts takes
// them off the shelf immediately, editing the quantity moves only the
// difference, and deleting the job releases the full reservation. This is
// the core promise the rest of the parts feature set is built on.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;
const oilQty = () => page.evaluate(() => window.__db.parts.find((p) => p.id === "p1").quantity);

// v1 already has b1/b2 referencing 0W-20 oil in partsNeeded, pre-migration --
// read the real baseline after the sweep settles rather than assuming 8 qt.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(500);
const baseline = await oilQty();

// 1. Creating a new scheduled job with parts reserves immediately.
await page.click('[data-act="log-service"]');
await page.waitForSelector(".picker-list");
await page.click('.picker-option:has-text("Schedule something")');
await page.waitForSelector(".modal");
await page.fill('[data-list-rows="titles"] [data-item-title]', "Belt replacement");
await page.fill("#field-dueOn", "2030-01-01");
await page.click("[data-parts-add]");
await page.selectOption("[data-part-id]", { label: `0W-20 oil (${baseline} qt)` });
await page.fill("[data-part-qty]", "3");
await page.dispatchEvent("[data-part-qty]", "change");
await page.click('.modal button:text-is("Schedule it")');
await page.waitForTimeout(400);
check("creating reserves immediately", (await oilQty()) === baseline - 3);

// 2. Editing to a HIGHER quantity takes the extra off the shelf.
await page.click('.service-row:has(.row-title-text:text-is("Belt replacement"))');
await page.waitForSelector(".modal");
await page.fill("[data-part-qty]", "5");
await page.dispatchEvent("[data-part-qty]", "change");
await page.click('.modal button:text-is("Save changes")');
await page.waitForTimeout(400);
check("editing up takes the delta off the shelf", (await oilQty()) === baseline - 5);

// 3. Editing to a LOWER quantity puts the difference back.
await page.click('.service-row:has(.row-title-text:text-is("Belt replacement"))');
await page.waitForSelector(".modal");
await page.fill("[data-part-qty]", "1");
await page.dispatchEvent("[data-part-qty]", "change");
await page.click('.modal button:text-is("Save changes")');
await page.waitForTimeout(400);
check("editing down puts the delta back on the shelf", (await oilQty()) === baseline - 1);

// 4. Deleting the job releases the whole reservation.
await page.click('.service-row:has(.row-title-text:text-is("Belt replacement"))');
await page.waitForSelector(".modal");
await page.click('.modal button:text-is("Delete this service")');
await page.waitForSelector('.modal:has-text("Delete service?")');
await page.click('.modal button:text-is("Delete")');
await page.waitForTimeout(400);
check("deleting releases the full reservation -- back to baseline", (await oilQty()) === baseline);

report(app.errors);
await app.close();
