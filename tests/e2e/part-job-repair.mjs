// More > "Fill in which job parts went on" fills in, for visits saved before
// each part recorded its job, only what the evidence settles; asks first;
// lists what's left; renames the matching stock-log entries; and never moves
// a count.
import path from "node:path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

// Two old visits on the Tacoma, parts saved without a job. "Oil change" has
// a saved kit of oil + filter; nothing says where the coolant went.
const source = readFileSync(FIXTURE, "utf8")
  .replace(
    `"vehicles/v2/services": [`,
    `"vehicles/v2/services": [
      { id: "old1", title: "Oil change", status: "done", servicedOn: "2026-05-01", odometerMiles: 40000, costCents: 9000,
        items: [{ title: "Oil change", costCents: 6000 }, { title: "Wiper blades", costCents: 3000 }],
        parts: [{ partId: "p1", name: "0W-20 oil", unit: "qt", quantity: 5 }, { partId: "p2", name: "Oil filter", unit: "each", quantity: 1 }] },
      { id: "old2", title: "Brake pads", status: "done", servicedOn: "2026-06-01", odometerMiles: 41000, costCents: 20000,
        items: [{ title: "Brake pads", costCents: 15000 }, { title: "Tire rotation", costCents: 5000 }],
        parts: [{ partId: "p3", name: "Coolant", unit: "gal", quantity: 0.5 }] },`
  )
  .replace(`serviceNames: [],`, `serviceNames: [{ id: "n1", name: "Oil change", defaultParts: [{ partId: "p1" }, { partId: "p2" }] }],`)
  .replace(
    `  purchases: [`,
    `  purchases: [
    { id: "j1", partId: "p2", partName: "Oil filter", kind: "job", change: -1, quantity: 1, unit: "each", vehicleId: "v2", serviceTitle: "Wiper blades", purchasedOn: "2026-05-01" },`
  );
const fixture = path.join(mkdtempSync(path.join(tmpdir(), "garage-")), "old-visits.mjs");
writeFileSync(fixture, source);

const app = await launchApp(fixture);
const { page, base } = app;
const shelf = () => page.evaluate(() => JSON.stringify(window.__db.parts.map((p) => p.quantity)));
const visit = (id) => page.evaluate((id) => window.__db["vehicles/v2/services"].find((s) => s.id === id), id);

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
const shelfBefore = await shelf();

const openRepair = async () => {
  await page.click('[data-act="garage-menu"], button:has-text("More")');
  await page.click('.picker-option:has-text("Fill in which job parts went on")');
};

// Cancelling changes nothing.
await openRepair();
await page.waitForSelector('.modal:has-text("Fill in which job parts went on?")');
check("it says what it found before changing anything", /2 parts on 1 visit/.test(await page.locator(".modal").textContent()));
await page.click('.modal button:text-is("Cancel")');
check("cancelling changes nothing", !(await visit("old1")).parts.some((p) => p.forJob));

await openRepair();
await page.waitForSelector('.modal:has-text("Fill in which job parts went on?")');
await page.click('.modal button:text-is("Fill them in")');
await page.waitForSelector('.modal:has-text("Which job parts went on")');
const result = await page.locator(".modal").textContent();

const old1 = await visit("old1");
check("parts the evidence settles get their job", old1.parts.every((p) => p.forJob === "Oil change"));
check("a part nothing settles is left alone", !(await visit("old2")).parts[0].forJob);
check("…and listed for picking by hand", /Red Tacoma · Brake pads/.test(result) && /Coolant/.test(result));
check("the matching stock-log entry is renamed", (await page.evaluate(() => window.__db.purchases.find((e) => e.id === "j1"))).serviceTitle === "Oil change");
check("no count moved", (await shelf()) === shelfBefore);

report(app.errors);
await app.close();
