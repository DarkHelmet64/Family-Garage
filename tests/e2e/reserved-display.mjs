// The Parts & Supplies shelf shows what's reserved for scheduled jobs
// alongside the free count -- not a change to what the bold figure itself
// means (it's always been the free amount), just visible context for why
// it's lower than the full total.
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
check("the free amount still shows as the bold headline figure, unchanged", /3 qt/.test(oilRow));
check("shows what's reserved and the true total alongside it", /5 qt reserved for scheduled jobs/.test(oilRow) && /8 qt total/.test(oilRow));

const filterRow = await page.locator('.part-row:has(.row-title-text:text-is("Oil filter"))').textContent();
check("a part reserved by only one job shows that job's amount, not the other part's", /1 each reserved/.test(filterRow) && /4 each total/.test(filterRow));

const coolantRow = await page.locator('.part-row:has(.row-title-text:text-is("Coolant"))').textContent();
check("a part with nothing scheduled against it shows exactly as it always did -- no reserved line at all", !/reserved/.test(coolantRow));

report(app.errors);
await app.close();
