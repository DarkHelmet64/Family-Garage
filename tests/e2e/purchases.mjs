// Logging a purchase should move the shelf and write a dated log entry;
// adding a brand-new part with a starting quantity should log itself the
// same way, without double-counting the shelf; deleting a purchase should
// put its quantity back.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");

const qtyBefore = await page.evaluate(() => window.__db.parts.find((p) => p.id === "p1").quantity);
await page.click('[data-act="log-purchase"][data-id="p1"]');
await page.waitForSelector(".modal");
await page.fill("#field-quantity", "4");
await page.fill("#field-totalCost", "35.96"); // 4 qt @ $8.99
await page.fill("#field-vendor", "NAPA");
await page.click('.modal button:text-is("Log it")');
await page.waitForTimeout(300);

const qtyAfter = await page.evaluate(() => window.__db.parts.find((p) => p.id === "p1").quantity);
check("logging a purchase adds the quantity onto the shelf", qtyAfter === qtyBefore + 4);

const logged = await page.evaluate(() => window.__db.purchases.find((p) => p.id?.startsWith("new")));
check("a purchase entry was created", !!logged);
check("cost-each is correctly derived from total / quantity", logged?.unitCostCents === 899);

// A brand-new part with a starting quantity should log its own first
// purchase, without a second shelf increment on top of addDoc's own quantity.
await page.click('[data-act="add-part"]');
await page.waitForSelector(".modal");
await page.fill("#field-name", "Cabin air filter");
await page.selectOption("#field-unit", "each");
await page.fill("#field-quantity", "2");
await page.click('.modal button:text-is("Add it")');
await page.waitForTimeout(300);

const newPart = await page.evaluate(() => window.__db.parts.find((p) => p.name === "Cabin air filter"));
const autoLogged = await page.evaluate(() => window.__db.purchases.find((p) => p.partName === "Cabin air filter"));
check("the new part's shelf quantity is exactly what was typed, not doubled", newPart?.quantity === 2);
check("adding it with stock auto-logs a matching purchase", autoLogged?.quantity === 2);

// Deleting the original oil purchase should put its 4 qt back off the shelf.
await page.click('[data-act="view-purchases"]');
await page.waitForTimeout(200);
await page.click('.purchase-row:has(.row-title-text:text-is("0W-20 oil"))');
await page.waitForSelector(".modal");
await page.click('.modal button:text-is("Delete")');
await page.waitForTimeout(300);

const qtyAfterDelete = await page.evaluate(() => window.__db.parts.find((p) => p.id === "p1").quantity);
check("deleting a purchase reverses its shelf adjustment", qtyAfterDelete === qtyBefore);

report(app.errors);
await app.close();
