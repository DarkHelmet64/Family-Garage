// A brand-new garage with nothing in it yet should say so clearly on every
// screen that reads from an empty collection, not show a blank space or an
// error -- the very first thing a new user sees.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "empty.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
const garageText = await page.textContent("#vehicle-list");
check("an empty garage says so instead of showing nothing", /no vehicles|add a vehicle/i.test(garageText));
check("Coming Up section doesn't appear at all with an empty garage", await page.isHidden("#coming-up"));

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");
await page.waitForTimeout(200);
const partsText = await page.textContent("#parts-list");
check("an empty shelf says so", /nothing on the shelf/i.test(partsText));
check("no copy-from-existing-part picker when there's nothing to copy from", (await page.$("#field-copyFrom")) === null);

await page.goto(`${base}?purchases`, { waitUntil: "networkidle" });
await page.waitForSelector("h1");
await page.waitForTimeout(200);
const purchasesText = await page.textContent("#purchases-list");
check("an empty purchase log says so", /nothing logged yet/i.test(purchasesText));

report(app.errors);
await app.close();
