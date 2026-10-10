// The garage screen's look-ahead (Coming Up) reads as little as it can.
//
// First visit with summaries older than this app: everything is read, as
// one collection-group query per collection (not one per vehicle), and each
// vehicle's summary is refreshed. Every visit after: the summaries already
// say each vehicle's odometer, miles a day and when each job was last done,
// so only the jobs still booked and the schedules are read -- no fill-ups
// and no finished services at all -- and Coming Up says exactly the same.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;
const comingUp = () => page.textContent("#coming-up-body");

// 1. Stale summaries: the full read, grouped.
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".vehicle-row");
await page.waitForTimeout(600);
let reads = await page.evaluate(() => window.__reads.getDocs);
check("services read as exactly one collection-group query for both vehicles, not one each", reads["collectionGroup:services"] === 1);
check("schedule read as exactly one collection-group query for both vehicles, not one each", reads["collectionGroup:schedule"] === 1);
check("fill-ups read as exactly one collection-group query for both vehicles, not one each", reads["collectionGroup:fillups"] === 1);
const firstComingUp = await comingUp();
check("Coming Up shows the right overdue/soon counts", /3 overdue/.test(firstComingUp) && /2 due soon/.test(firstComingUp));
const summaries = await page.evaluate(() =>
  window.__db.vehicles.map((v) => ({ version: v.statsVersion, hasRate: "milesPerDay" in v, jobs: v.lastDoneByJob }))
);
check(
  "each vehicle's summary is refreshed with miles a day and when each job was last done",
  summaries.every((s) => s.version === 3 && s.hasRate && s.jobs && typeof s.jobs === "object")
);

// 2. Current summaries: only what's still booked, and the schedules.
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".vehicle-row");
await page.waitForTimeout(600);
reads = await page.evaluate(() => window.__reads.getDocs);
check("with current summaries, only booked jobs are read", reads["collectionGroup:services?status==scheduled"] === 1 && !reads["collectionGroup:services"]);
check("…and no fill-ups at all", !Object.keys(reads).some((k) => /fillups/.test(k)));
check("…and nothing read per vehicle", !Object.keys(reads).some((k) => /^vehicles\/.+\/(services|schedule|fillups)$/.test(k)));
check("Coming Up says exactly the same from the summaries", (await comingUp()) === firstComingUp);
check("Blue Odyssey's own group still renders", (await page.$('.plan-vehicle:has-text("Blue Odyssey")')) !== null);

report(app.errors);
await app.close();
