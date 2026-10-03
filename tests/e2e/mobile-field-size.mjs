// iOS Safari zooms the page in when a field whose text is under 16px is
// tapped. At phone width every input, select and textarea the app shows
// should be at least 16px -- and that's fixed in the CSS, not by stopping
// the page zooming at all.
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "standard.mjs");

const viewport = readFileSync(path.join(ROOT, "index.html"), "utf8").match(/<meta name="viewport" content="([^"]*)"/)[1];
check("the viewport doesn't stop the page zooming", !/maximum-scale|user-scalable\s*=\s*(no|0)/i.test(viewport));

const app = await launchApp(FIXTURE, { viewport: { width: 390, height: 844 } });
const { page, base } = app;

const tooSmall = [];
let fieldsSeen = 0;
async function screen(label, url, ...steps) {
  await page.goto(`${base}${url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  for (const step of steps) {
    await step();
    await page.waitForTimeout(250);
  }
  const fields = await page.$$eval("input, select, textarea", (els) =>
    els
      .filter((el) => !["checkbox", "radio", "hidden"].includes(el.type))
      .map((el) => ({
        what: `${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ""}${el.name ? ` "${el.name}"` : ""}`,
        px: parseFloat(getComputedStyle(el).fontSize),
      }))
  );
  fieldsSeen += fields.length;
  for (const field of fields) if (field.px < 16) tooSmall.push(`${label}: ${field.what} at ${field.px}px`);
}
const click = (selector) => () => page.click(selector);

await screen("add a part", "?parts", click("[data-act=add-part]"));
await screen("log a purchase", "?parts", click("[data-act=log-purchase] >> nth=0"));
await screen("add a vehicle", "?new");
await screen("log a fill-up", "?vehicle=v1", click("[data-act=log-fuel]"));
await screen(
  "schedule a job, with a part row",
  "?vehicle=v1",
  click("[data-act=log-service]"),
  click('.picker-option:has-text("Schedule something")'),
  click("[data-parts-add]")
);
await screen("schedule page", "?vehicle=v1&schedule", click("[data-act=add-plan]"));
await screen("service names", "?names", click("[data-act=add-name]"));
await screen(
  "import",
  "?vehicle=v1",
  click("[data-act=vehicle-menu]"),
  click('.picker-option:has-text("Import from a spreadsheet")'),
  click('.picker-option:has-text("Fill-ups")')
);
// The file picker had its own smaller size, so make sure it was measured.
check("reached the import's file picker", (await page.locator("input[type=file]").count()) > 0);

check("found the fields to measure", fieldsSeen > 20);
check(`every field is at least 16px at phone width${tooSmall.length ? ` -- ${tooSmall.join("; ")}` : ""}`, tooSmall.length === 0);

report(app.errors);
await app.close();
