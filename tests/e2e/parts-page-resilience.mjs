// The Parts & Supplies page draws inside snapshot callbacks, where a throw is
// swallowed -- so one malformed record (say, hand-edited in the Firebase
// console) used to leave the whole page on "Loading…" for good. It should
// still show the shelf, and never sit there saying nothing.
import path from "node:path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

// The standard garage, plus records in shapes the app never writes itself
// but a person editing the database by hand easily could.
const source = readFileSync(FIXTURE, "utf8")
  .replace("  parts: [", `  parts: [ { id: "px", name: "Shop rags", quantity: 1, fitsVehicleIds: "v1" },`)
  .replace(
    `"vehicles/v2/services": [`,
    `"vehicles/v2/services": [
      { id: "sx", title: "Odd one", status: "scheduled", reserved: true, partsNeeded: { p1: 2 } },
      { id: "sy", title: "Odder one", status: "scheduled", reserved: true, partsNeeded: [null, { partId: "p3", quantity: 1 }] },`
  );
const malformed = path.join(mkdtempSync(path.join(tmpdir(), "garage-")), "malformed.mjs");
writeFileSync(malformed, source);

const app = await launchApp(malformed);
const { page, base } = app;

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);
const listText = await page.locator("#parts-list").textContent();
check("the shelf draws instead of hanging on Loading…", !/Loading/.test(listText));
check("the malformed part itself is still listed", /Shop rags/.test(listText));
check("the well-formed parts are all still listed", /0W-20 oil/.test(listText) && /Oil filter/.test(listText) && /Coolant/.test(listText));
const coolantRow = await page.locator('.part-row:has(.row-title-text:text-is("Coolant"))').textContent();
check("a valid entry beside a null one still counts as reserved", /1 gal reserved/.test(coolantRow));

// The keep-above field had a placeholder-sounding label.
await page.click("[data-act=add-part]");
await page.waitForSelector(".modal");
const modalText = await page.locator(".modal").textContent();
check("the running-low field is labelled for what it does", /Running low at/.test(modalText) && !/Tell me below/.test(modalText));

report(app.errors);
await app.close();
