// The service worker used to answer from its cache first and refresh in the
// background, so a device could end up holding app.js from one release and
// stats.js from another -- and a page whose modules don't match never runs,
// leaving "Loading…" up on that device only. Online, whatever the cache
// holds, the page should load the current files; offline, it should still
// open from the cache.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

await page.goto(`${base}?parts`, { waitUntil: "networkidle" });
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload({ waitUntil: "networkidle" });
check("the page is controlled by the service worker", await page.evaluate(() => !!navigator.serviceWorker.controller));

// Plant a stats.js from "an older release" -- missing every export the
// current app.js imports -- in the worker's own cache.
await page.evaluate(async () => {
  const cache = await caches.open("family-garage-shell-v2");
  await cache.put(new Request(new URL("stats.js", location.href)), new Response("export const STATS_VERSION = 1;", { headers: { "content-type": "text/javascript" } }));
});
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("[data-act=add-part]", { timeout: 5000 }).catch(() => {});
check("online, a stale cached file doesn't stop the page loading", (await page.locator("[data-act=add-part]").count()) === 1);

await page.context().setOffline(true);
await page.goto(`${base}?vehicle=v1`).catch(() => {});
await page.waitForSelector(".hero-figure", { timeout: 5000 }).catch(() => {});
check("offline, a page address never visited still opens from the cache", (await page.locator(".hero-figure").count()) === 1);

report(app.errors);
await app.close();
