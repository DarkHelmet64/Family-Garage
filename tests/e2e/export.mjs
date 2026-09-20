// "Export data" in the garage's More menu should download one JSON file
// with every vehicle (and its services/schedule/fill-ups), every part,
// every purchase and every service name -- and Firestore's own Timestamp
// objects should come out as plain, readable ISO strings.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE, { acceptDownloads: true });
const { page, base } = app;

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".vehicle-row");
await page.waitForTimeout(300);

await page.click("#more-btn");
await page.waitForSelector(".picker-list");
const [download] = await Promise.all([page.waitForEvent("download"), page.click('.picker-option:has-text("Export data")')]);

check("filename looks like a dated backup file", /^family-garage-export-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()));

const data = JSON.parse(readFileSync(await download.path(), "utf8"));
check("has an exportedAt timestamp", typeof data.exportedAt === "string" && !isNaN(Date.parse(data.exportedAt)));
check("both vehicles are included", data.vehicles?.length === 2);
const v1 = data.vehicles.find((v) => v.id === "v1");
check("v1's services/schedule/fill-ups are all included", v1.services.length > 0 && v1.schedule.length > 0 && v1.fillups.length > 0);
check("parts are included", data.parts?.some((p) => p.name === "0W-20 oil"));
check("purchases are included", data.purchases?.some((p) => p.partName === "0W-20 oil"));
check("serviceNames key exists", Array.isArray(data.serviceNames));

// Any createdAt/updatedAt found anywhere should be a plain ISO string, not
// the fake SDK's Timestamp-shaped object (which would have silently lost
// its toDate function to JSON.stringify if this hadn't been converted first).
const flatten = (obj, out = []) => {
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if ((k === "createdAt" || k === "updatedAt") && v != null) out.push(v);
      flatten(v, out);
    }
  }
  return out;
};
const timestamps = flatten(data);
check("at least one timestamp field was found to check", timestamps.length > 0);
check("every one is a clean ISO string, not a leftover SDK object", timestamps.every((v) => typeof v === "string" && !isNaN(Date.parse(v))));

report(app.errors);
await app.close();
