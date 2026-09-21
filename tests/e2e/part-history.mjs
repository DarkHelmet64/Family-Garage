// "View purchase & usage history" on a part's edit sheet should open a
// read-only ledger: every purchase of that part, and every service (done or
// still scheduled) that's used or reserved it -- without losing whatever
// was mid-edit in the sheet underneath.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

// p1 (0W-20 oil): one purchase (pu1, 8 qt) in the fixture, and referenced by
// b1 (2 qt) and b2 (3 qt) -- both still scheduled, so both should read as
// "reserved", not "used". Visiting v1 first runs the reservation-migration
// sweep (marks b1/b2 reserved: true), which is what actually makes them
// count -- currentlyReserved (and so this ledger) ignores a scheduled job's
// partsNeeded until that's happened, the same as production data would.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(500);
await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]");
await page.click('.part-row:has(.row-title-text:text-is("0W-20 oil"))');
await page.waitForSelector(".modal");
// Change something first, to prove the edit survives the side trip.
await page.fill("#field-notes", "checking history mid-edit");
await page.click('button:text-is("View purchase & usage history")');
await page.waitForTimeout(200);

const modals = await page.locator(".overlay").count();
check("history opens as its own overlay, stacked on the edit sheet", modals === 2);

const historyText = await page.locator(".overlay").last().textContent();
check("shows the one logged purchase", /8 qt/.test(historyText) && /NAPA/.test(historyText));
check("shows both jobs that reserved it, each naming its job and vehicle", /Brake pads/.test(historyText) && /Wiper blades/.test(historyText) && /Blue Odyssey/.test(historyText));
check("both read as reserved, not used -- neither job is actually done", (historyText.match(/· reserved/g) || []).length === 2 && !/· used\b/.test(historyText));

await page.click(".overlay:last-of-type #history-close");
await page.waitForTimeout(150);
const modalsAfterClose = await page.locator(".overlay").count();
check("closing history leaves the edit sheet open underneath", modalsAfterClose === 1);
const noteStillThere = await page.inputValue("#field-notes");
check("the in-progress edit survived the side trip", noteStillThere === "checking history mid-edit");

report(app.errors);
await app.close();
