// Coming Up reads services/schedule/fillups as three independent
// collection-group queries covering the whole garage. One of them being
// denied (the shape of a Firestore permissions error -- e.g. a
// collection-group rule not yet published) shouldn't blank the section or
// take the other two down with it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "denied.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

// The fixture denies the fill-ups collection-group specifically -- the
// lowest-stakes of the three, since fill-ups barely feed Coming Up's own
// math (just one of several sources for a vehicle's current odometer
// reading). Both vehicles' overdue/soon status comes from services and
// schedule, neither of which is denied here, so both should show correctly;
// the claim under test is that the denied read doesn't cascade.
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".vehicle-row");
await page.waitForTimeout(500);

const comingUpBody = await page.textContent("#coming-up-body");
check("Coming Up doesn't collapse into a blanket error", !/Couldn't work out what's coming up/.test(comingUpBody));
check("Blue Odyssey's real overdue job still shows", /Blue Odyssey/.test(comingUpBody) && /Overdue/.test(comingUpBody));
check("Red Tacoma's due-soon job still shows too -- fillups failing doesn't touch either vehicle's status", /Red Tacoma/.test(comingUpBody));

const groups = await page.evaluate(() => [...document.querySelectorAll(".plan-vehicle")].map((el) => el.querySelector(".section-title")?.textContent));
check("both vehicles have their own Coming Up group", groups.includes("Blue Odyssey") && groups.includes("Red Tacoma"));

report(app.errors);
await app.close();
