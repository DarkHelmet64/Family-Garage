// One vehicle's subcollection read being denied (the shape of a Firestore
// permissions error) shouldn't blank the Coming Up section for the rest of
// the garage -- only that one vehicle should be missing from it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "denied.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

// Red Tacoma (v2) has one denied subcollection read; Blue Odyssey (v1) reads
// fine and has a real overdue "Oil change" in its own schedule.
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".vehicle-row");
await page.waitForTimeout(500);

const comingUpBody = await page.textContent("#coming-up-body");
check("Coming Up doesn't collapse into a blanket error", !/Couldn't work out what's coming up/.test(comingUpBody));
check("Coming Up still shows Blue Odyssey's real overdue job", /Blue Odyssey/.test(comingUpBody) && /Overdue/.test(comingUpBody));

const groups = await page.evaluate(() => [...document.querySelectorAll(".plan-vehicle")].map((el) => el.querySelector(".section-title")?.textContent));
check("Blue Odyssey (the healthy vehicle) has its own Coming Up group", groups.includes("Blue Odyssey"));
check("Red Tacoma (the one with the denied read) is simply left out, not blanking the rest", !groups.includes("Red Tacoma"));

report(app.errors);
await app.close();
