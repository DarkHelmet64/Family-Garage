// "Start from an existing part" in the Add Part sheet should load every
// field but quantity from the picked part, clear back to blank when picking
// "start blank" again, and always save as a genuinely separate part.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.click('[data-act="add-part"]');
await page.waitForSelector(".modal");

const focusedId = await page.evaluate(() => document.activeElement.id);
check("Name still gets first focus, not the copy-from select", focusedId === "field-name");

await page.selectOption("#field-copyFrom", { label: "0W-20 oil" });
await page.waitForTimeout(100);
const filled = await page.evaluate(() => ({
  name: document.querySelector("#field-name").value,
  unit: document.querySelector("#field-unit").value,
  minQuantity: document.querySelector("#field-minQuantity").value,
  quantity: document.querySelector("#field-quantity").value,
}));
check("name copied", filled.name === "0W-20 oil");
check("unit copied", filled.unit === "qt");
check("minQuantity copied", filled.minQuantity === "5");
check("quantity is left blank for the new batch's real count", filled.quantity === "");

await page.selectOption("#field-copyFrom", { label: "— start blank —" });
await page.waitForTimeout(100);
const cleared = await page.evaluate(() => document.querySelector("#field-name").value);
check("switching back to blank clears what the template filled in", cleared === "");

await page.selectOption("#field-copyFrom", { label: "0W-20 oil" });
await page.waitForTimeout(100);
await page.fill("#field-name", "0W-20 oil (backup case)");
await page.fill("#field-quantity", "4");
await page.click('.modal button:text-is("Add it")');
await page.waitForTimeout(300);

const parts = await page.evaluate(() => window.__db.parts.map((p) => ({ name: p.name, quantity: p.quantity, unit: p.unit })));
const original = parts.find((p) => p.name === "0W-20 oil");
const copy = parts.find((p) => p.name === "0W-20 oil (backup case)");
check("the original part is untouched", original?.quantity === 8);
check("the new one is a real, separate part carrying the copied fields", copy?.unit === "qt" && copy?.quantity === 4);

report(app.errors);
await app.close();
