// The whole app is meant to be used one-handed, standing at the car, so the
// key screens need to render with no horizontal overflow at real phone
// widths -- 320px (a small older phone) and 420px (a typical one).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import http from "node:http";
import { check, report } from "../helpers/serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.resolve(ROOT, "tests", "fixtures", "standard.mjs");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer((req, res) => {
  const reqPath = req.url.split("?")[0];
  const file = path.join(ROOT, reqPath === "/" ? "index.html" : reqPath);
  try {
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "text/plain" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
const errors = [];
const fixtureBody = readFileSync(FIXTURE, "utf8");

const noOverflow = async (label, url, width, waitFor) => {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.route("https://www.gstatic.com/firebasejs/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: fixtureBody })
  );
  await ctx.route("https://unpkg.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  await page.goto(`${base}${url}`, { waitUntil: "networkidle" });
  await page.waitForSelector(waitFor);
  await page.waitForTimeout(400);
  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check(`${label} @ ${width}px has no horizontal overflow`, scrollWidth <= innerWidth);
  await ctx.close();
};

for (const width of [320, 420]) {
  await noOverflow("garage screen", "", width, ".vehicle-row");
  await noOverflow("vehicle page", "?vehicle=v1", width, ".hero-figure");
  await noOverflow("parts & supplies", "?parts", width, "[data-act=add-part]");
}

report(errors);
await browser.close();
server.close();
