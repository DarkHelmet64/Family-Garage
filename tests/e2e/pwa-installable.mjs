// The app should qualify as an installable PWA: a linked, valid manifest
// with real icons, and a service worker that actually registers and
// activates -- not just files that exist but are never wired up.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, check, report } from "../helpers/serve.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "standard.mjs");

const app = await launchApp(FIXTURE);
const { page, base } = app;

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".vehicle-row");

const manifestHref = await page.getAttribute('link[rel="manifest"]', "href");
check("index.html links a manifest", !!manifestHref);

const manifestRes = await page.request.get(`${base}${manifestHref}`);
check("the linked manifest is actually fetchable", manifestRes.ok());
const manifest = await manifestRes.json();
check("it has a name and short_name", !!manifest.name && !!manifest.short_name);
check("standalone display, so it opens without browser chrome once installed", manifest.display === "standalone");
check("start_url and icon paths are relative, not rooted, for subpath hosting", manifest.start_url === "." && manifest.icons.every((i) => !i.src.startsWith("/")));
check("has both a 192 and a 512 icon, the sizes installers actually ask for", manifest.icons.some((i) => i.sizes === "192x192") && manifest.icons.some((i) => i.sizes === "512x512"));

for (const icon of manifest.icons) {
  const res = await page.request.get(`${base}${icon.src}`);
  check(`icon ${icon.src} is actually fetchable`, res.ok());
}

// The service worker should reach "activated", not just "installing" --
// register() resolving only means the browser accepted it, not that it's
// actually running yet.
const swState = await page.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return "unsupported";
  const reg = await navigator.serviceWorker.ready;
  return reg.active?.state ?? "no active worker";
});
check("the service worker reaches the active state", swState === "activated" || swState === "activating");

report(app.errors);
await app.close();
