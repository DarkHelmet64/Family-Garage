// A part counted in one unit (Coolant: gal) but used in a smaller one (oz,
// 128 to the gal) should let a parts-used row be entered in the smaller
// unit, warn about shortfalls in that unit, and convert to the buy unit for
// the actual shelf math and the saved record.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(300);

await page.click('[data-act="log-service"]');
await page.waitForSelector(".picker-list");
await page.click('.picker-option:has-text("Log service already done")');
await page.waitForSelector(".modal");
await page.fill('[data-list-rows="items"] [data-item-title]', "Coolant flush");
await page.click("[data-parts-add]");
await page.selectOption("[data-part-id]", "p3");
await page.dispatchEvent("[data-part-id]", "change");

const unitLabel = await page.textContent(".part-qty-unit");
check("the qty box labels itself with the use unit (oz), not the buy unit (gal)", unitLabel.trim() === "oz");

await page.fill("[data-part-qty]", "300"); // more than the 256 oz (2 gal) on hand
await page.dispatchEvent("[data-part-qty]", "change");
const overWarning = await page.textContent(".field-hint.short");
check("the shortfall warning speaks in the use unit too", /256 oz/.test(overWarning));

await page.fill("[data-part-qty]", "32"); // a quarter gallon
await page.dispatchEvent("[data-part-qty]", "change");
await page.click('.modal button:text-is("Save")');
await page.waitForTimeout(300);

const coolantAfter = await page.evaluate(() => window.__db.parts.find((p) => p.id === "p3").quantity);
check("the shelf came down by a quarter gallon (32 oz / 128), not by 32 gal", coolantAfter === 1.75);

const created = await page.evaluate(() => window.__db["vehicles/v1/services"].find((s) => s.title === "Coolant flush"));
check("the record keeps the buy-unit amount (0.25 gal), not the typed 32", created?.parts?.find((p) => p.partId === "p3")?.quantity === 0.25);

report(app.errors);
await app.close();
