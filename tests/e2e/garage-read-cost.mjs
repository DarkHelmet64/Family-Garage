// loadGarage() reads services/schedule/fillups as one collection-group query
// each, covering every vehicle in the garage -- not a fan-out of three reads
// per vehicle. With two vehicles in the fixture, the old per-vehicle
// approach would show 2 of each; this proves it's actually 1 of each,
// regardless of how many vehicles there are, while Coming Up still renders
// the right, correct result from the grouped-back data.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".vehicle-row");
await page.waitForTimeout(500);

const reads = await page.evaluate(() => window.__reads.getDocs);
check("services read as exactly one collection-group query for both vehicles, not one each", reads["collectionGroup:services"] === 1);
check("schedule read as exactly one collection-group query for both vehicles, not one each", reads["collectionGroup:schedule"] === 1);
check("fill-ups read as exactly one collection-group query for both vehicles, not one each", reads["collectionGroup:fillups"] === 1);
check("no leftover per-vehicle services/schedule/fillups reads alongside the collection-group ones", !Object.keys(reads).some((k) => /^vehicles\/.+\/(services|schedule|fillups)$/.test(k)));

// The grouped-back-by-vehicle result should still be the right, correct
// data -- fewer reads, same answer -- not just fewer reads.
const comingUpBody = await page.textContent("#coming-up-body");
check("Coming Up still shows the right overdue/soon counts from the grouped data", /3 overdue/.test(comingUpBody) && /2 due soon/.test(comingUpBody));
check("Blue Odyssey's own group still renders", await page.$('.plan-vehicle:has-text("Blue Odyssey")') !== null);

report(app.errors);
await app.close();
