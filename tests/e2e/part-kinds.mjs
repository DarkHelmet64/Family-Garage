// A shelf item is counted (filters), measured (oil bought by the jug, used by
// the quart) or reusable (tools: never used up, only logged where they've
// been used). A part saved before kinds existed keeps behaving as it did.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;
const byName = (name) => page.evaluate((name) => window.__db.parts.find((p) => p.name === name), name);
const rowText = (name) => page.locator(`.part-row:has(.row-title-text:text-is("${name}"))`).textContent();
const visible = (name) => page.locator(`.modal #field-${name}`).isVisible();

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");

// A part saved before kinds: coolant with a smaller unit to use it in.
await page.click('.part-row[data-id="p3"]');
await page.waitForSelector(".modal");
check("an older part with a use-in unit opens as measured", (await page.inputValue("#field-kind")) === "measure");
await page.click('.modal button:text-is("Cancel")');

// Measured: a 5 qt jug.
await page.click("[data-act=add-part]");
await page.waitForSelector(".modal");
check("a counted item doesn't ask for a second unit", !(await visible("useUnit")) && !(await visible("unitsPerBuyUnit")));
await page.selectOption("#field-kind", "measure");
await page.fill("#field-name", "Synthetic 5W-30");
await page.selectOption("#field-unit", "jug");
await page.selectOption("#field-useUnit", "qt");
check("a measured item asks how much is in one container", await visible("unitsPerBuyUnit"));
check("…worded for the container", /How many qt in one jug/.test(await page.locator(".modal").textContent()));
await page.fill("#field-unitsPerBuyUnit", "5");
await page.fill("#field-quantity", "2");
await page.click('.modal button:text-is("Add it")');
await page.waitForTimeout(300);
const jug = await byName("Synthetic 5W-30");
check("saved as measured, in jugs of 5 qt", jug?.kind === "measure" && jug.unit === "jug" && jug.useUnit === "qt" && jug.unitsPerBuyUnit === 5 && jug.quantity === 2);
check("the shelf shows containers and the amount", /2 jugs · 10 qt/.test(await rowText("Synthetic 5W-30")));

await page.click(`[data-act="use-part"][data-id="${jug.id}"]`);
await page.waitForSelector(".modal");
await page.fill("#field-amount", "3");
await page.click('.modal button:text-is("Log it")');
await page.waitForTimeout(300);
check("using 3 qt leaves 1.4 jugs", (await byName("Synthetic 5W-30")).quantity === 1.4);
check("…shown as 1.4 jugs · 7 qt", /1\.4 jugs · 7 qt/.test(await rowText("Synthetic 5W-30")));

// Reusable: a torque wrench.
await page.click("[data-act=add-part]");
await page.waitForSelector(".modal");
await page.selectOption("#field-kind", "tool");
check("a tool has no count, unit or low-stock floor", !(await visible("quantity")) && !(await visible("unit")) && !(await visible("minQuantity")));
await page.fill("#field-name", "Torque wrench");
await page.click('.modal button:text-is("Add it")');
await page.waitForTimeout(300);
const wrench = await byName("Torque wrench");
check("saved as a tool", wrench?.kind === "tool" && wrench.quantity === 0);
check("the shelf says it's reusable, not running low", /Reusable/.test(await rowText("Torque wrench")) && !(await page.locator(`.part-row.low[data-id="${wrench.id}"]`).count()));

await page.click(`[data-act="use-part"][data-id="${wrench.id}"]`);
await page.waitForSelector(".modal");
check("using a tool doesn't ask how much", !(await visible("amount")));
await page.selectOption("#field-vehicleId", "v2");
await page.click('.modal button:text-is("Log it")');
await page.waitForTimeout(300);
const toolUse = await page.evaluate((id) => window.__db.purchases.find((e) => e.partId === id && e.kind === "used"), wrench.id);
check("a tool's use is logged without touching any count", toolUse?.vehicleName === "Red Tacoma" && toolUse.change === 0 && (await byName("Torque wrench")).quantity === 0);

await page.click(`[data-act="log-purchase"][data-id="${wrench.id}"]`);
await page.waitForSelector(".modal");
await page.fill("#field-quantity", "1");
await page.fill("#field-totalCost", "89.99");
await page.click('.modal button:text-is("Log it")');
await page.waitForTimeout(300);
check("buying a tool logs the cost without counting it", (await byName("Torque wrench")).quantity === 0);

// Tools aren't offered for booking onto a job.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.click("[data-act=log-service]");
await page.click('.picker-option:has-text("Schedule something")');
await page.waitForSelector(".modal");
await page.click("[data-parts-add]");
const options = await page.locator("[data-part-id] option").allTextContents();
check("a tool isn't offered in a job's parts picker", !options.some((o) => /Torque wrench/.test(o)) && options.some((o) => /Synthetic 5W-30/.test(o)));

report(app.errors);
await app.close();
