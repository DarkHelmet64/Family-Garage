// A service name's kit is shared across the whole garage, but the parts a
// job actually takes often aren't -- an oil filter almost never fits two
// different engines. A vehicle's own schedule entry for that job can carry
// its own "Parts needed", and that's meant to win over the shared kit
// wherever the job's name is typed, not just when booked via "Add to list".
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

// The shared kit: "Oil change" defaults to 0W-20 oil everywhere there's no
// more specific answer.
await page.goto(`${base}?names`, { waitUntil: "networkidle" });
await page.waitForSelector("h1");
await page.waitForTimeout(400);
await page.click('.row:has(.row-title-text:text-is("Oil change")) [data-act="edit-name"]');
await page.waitForSelector(".modal");
await page.click("[data-parts-add]");
await page.locator("[data-part-id]").nth(0).selectOption("p1"); // 0W-20 oil
await page.locator("[data-part-qty]").nth(0).fill("5");
await page.locator("[data-part-qty]").nth(0).dispatchEvent("change");
await page.click('.modal button:text-is("Save changes")');
await page.waitForTimeout(400);

// v1's own "Oil change" entry (sc1) overrides it with the filter this
// particular van actually takes.
await page.goto(`${base}?vehicle=v1&schedule`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-plan]");
await page.click('.service-row:has(.row-title-text:text-is("Oil change"))');
await page.waitForSelector(".modal");
await page.click("[data-parts-add]");
await page.locator("[data-part-id]").nth(0).selectOption("p2"); // Oil filter
await page.locator("[data-part-qty]").nth(0).fill("1");
await page.locator("[data-part-qty]").nth(0).dispatchEvent("change");
await page.click('.modal button:text-is("Save changes")');
await page.waitForTimeout(400);

const savedEntry = await page.evaluate(() => window.__db["vehicles/v1/schedule"].find((e) => e.id === "sc1")?.partsNeeded);
check("v1's own schedule entry saved its own parts", savedEntry?.length === 1 && savedEntry[0].partId === "p2");

// Scheduling an ad hoc job on v1 -- not via "Add to list" -- and typing the
// exact same name should still find v1's own answer first, ignoring the
// shared kit entirely rather than mixing the two in.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(400);
await page.click('[data-act="log-service"]');
await page.waitForSelector(".picker-list");
await page.click('.picker-option:has-text("Schedule something coming up")');
await page.waitForSelector(".modal");
await page.fill('[data-list-rows="titles"] [data-item-title]', "Oil change");
await page.dispatchEvent('[data-list-rows="titles"] [data-item-title]', "input");
await page.waitForTimeout(150);
const v1Parts = await page.$$eval("[data-part-id]", (els) => els.map((el) => el.value));
check("v1's own schedule entry wins over the shared kit", v1Parts.length === 1 && v1Parts[0] === "p2");
await page.click('.modal button:text-is("Cancel")');
await page.waitForTimeout(150);

// v2 has an "Oil change" entry too (sd1), but never got its own parts --
// so the same ad hoc flow should fall back to the shared kit, same as
// before this vehicle-specific lookup existed.
await page.goto(`${base}?vehicle=v2`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(400);
await page.click('[data-act="log-service"]');
await page.waitForSelector(".picker-list");
await page.click('.picker-option:has-text("Schedule something coming up")');
await page.waitForSelector(".modal");
await page.fill('[data-list-rows="titles"] [data-item-title]', "Oil change");
await page.dispatchEvent('[data-list-rows="titles"] [data-item-title]', "input");
await page.waitForTimeout(150);
const v2Parts = await page.$$eval("[data-part-id]", (els) => els.map((el) => el.value));
check("a vehicle with no override of its own still falls back to the shared kit", v2Parts.length === 1 && v2Parts[0] === "p1");

report(app.errors);
await app.close();
