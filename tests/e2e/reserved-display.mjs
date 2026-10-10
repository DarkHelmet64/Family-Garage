// The Parts & Supplies shelf's bold figure is what's physically on the
// shelf, with what's set aside for scheduled jobs and what's free on the
// line under it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

// p1 (0W-20 oil) is reserved by b1 (2 qt) and b2 (3 qt) -- 5 qt total spoken
// for, out of 8 -- 3 free. p2 (Oil filter) is only reserved by b2 (1 each),
// out of 4 -- 3 free. Coolant (p3) has nothing scheduled against it at all.
// Visiting v1 first runs the reservation-migration sweep (b1/b2 -> reserved:
// true, and the 5 qt / 1 each actually taken off the shelf) -- without it
// neither the shelf numbers nor reservedByPart would reflect them yet, the
// same as any fresh, never-visited vehicle in production.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(500);
await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");
await page.waitForTimeout(400);

const oilRow = await page.locator('.part-row:has(.row-title-text:text-is("0W-20 oil"))').textContent();
const oilFigure = await page.locator('.part-row:has(.row-title-text:text-is("0W-20 oil")) .part-qty').textContent();
check("the bold figure is what's physically on the shelf", oilFigure.trim() === "8 qt");
check("the line under it splits that into set aside and free", /5 qt set aside for jobs · 3 qt free/.test(oilRow));
check("each row has a line of recent history", /Booked onto/.test(oilRow));

const filterRow = await page.locator('.part-row:has(.row-title-text:text-is("Oil filter"))').textContent();
check("a part reserved by only one job shows that job's amount, not the other part's", /1 each set aside for jobs · 3 each free/.test(filterRow));

const coolantRow = await page.locator('.part-row:has(.row-title-text:text-is("Coolant"))').textContent();
check("a part with nothing scheduled against it has no set-aside line at all", !/set aside/.test(coolantRow));

report(app.errors);
await app.close();
