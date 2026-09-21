// A service name can carry a "usual parts" kit (Service Names page), which
// should load into any form's own parts field the moment that name is
// picked or typed -- as long as the parts field is still empty. Never
// clobbers rows someone's already started on.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

// "Oil change" already exists as a derived name (from v1/v2's schedule and
// history) with no explicit serviceNames doc yet -- editing it here is what
// creates one, same as the existing rename/favorite flow already does.
await page.goto(`${base}?names`, { waitUntil: "networkidle" });
await page.waitForSelector("h1");
await page.waitForTimeout(400);
await page.click('.row:has(.row-title-text:text-is("Oil change")) [data-act="edit-name"]');
await page.waitForSelector(".modal");
await page.click("[data-parts-add]");
await page.locator("[data-part-id]").nth(0).selectOption("p1"); // 0W-20 oil
await page.locator("[data-part-qty]").nth(0).fill("4");
await page.locator("[data-part-qty]").nth(0).dispatchEvent("change");
await page.click("[data-parts-add]");
await page.locator("[data-part-id]").nth(1).selectOption("p2"); // Oil filter
await page.locator("[data-part-qty]").nth(1).fill("1");
await page.locator("[data-part-qty]").nth(1).dispatchEvent("change");
await page.click('.modal button:text-is("Save changes")');
await page.waitForTimeout(400);

const savedKit = await page.evaluate(() => window.__db.serviceNames.find((n) => n.name === "Oil change")?.defaultParts);
check("the kit actually saved onto the service name", savedKit?.length === 2);

// Plain title field (openPlanForm, the Schedule page) -- typing the exact
// name should trigger the same lookup as picking a suggestion would.
await page.goto(`${base}?vehicle=v1&schedule`, { waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-plan]");
await page.click("[data-act=add-plan]");
await page.waitForSelector(".modal");
await page.fill("#field-title", "Oil change");
await page.dispatchEvent("#field-title", "change");
await page.waitForTimeout(150);
const planParts = await page.$$eval("[data-part-id]", (els) => els.map((el) => el.value));
check("typing a name with a kit fills the plan's own parts field", planParts.length === 2 && planParts.includes("p1") && planParts.includes("p2"));
await page.click('.modal button:text-is("Cancel")');

// List field (openCompletedServiceForm's "items") -- picking the suggestion
// exercises the actual dropdown-pick path, not just typing.
await page.goto(`${base}?vehicle=v1`, { waitUntil: "networkidle" });
await page.waitForSelector(".hero-figure");
await page.waitForTimeout(400);
await page.click('[data-act="log-service"]');
await page.waitForSelector(".picker-list");
await page.click('.picker-option:has-text("Log service already done")');
await page.waitForSelector(".modal");
await page.fill('[data-list-rows="items"] [data-item-title]', "Oil change");
await page.dispatchEvent('[data-list-rows="items"] [data-item-title]', "input");
await page.waitForTimeout(150);
const loggedParts = await page.$$eval("[data-part-id]", (els) => els.map((el) => el.value));
check("typing a name into the multi-job list field fills partsUsed too", loggedParts.length === 2 && loggedParts.includes("p1") && loggedParts.includes("p2"));

// Never clobbers a row someone's already picked by hand.
await page.click("[data-part-remove]"); // drop one of the two auto-filled rows
await page.waitForTimeout(100);
const afterManualEdit = await page.$$eval("[data-part-id]", (els) => els.map((el) => el.value));
check("removing a row leaves exactly one -- the auto-fill isn't fighting the edit", afterManualEdit.length === 1);
await page.fill('[data-list-rows="items"] [data-item-title]', "Oil change again");
await page.dispatchEvent('[data-list-rows="items"] [data-item-title]', "input");
await page.waitForTimeout(150);
const stillOneRow = await page.$$eval("[data-part-id]", (els) => els.map((el) => el.value));
check("further typing doesn't re-fill or clobber what's already there", stillOneRow.length === 1);

report(app.errors);
await app.close();
