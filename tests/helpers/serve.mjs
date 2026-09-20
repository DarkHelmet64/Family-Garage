// Shared setup for a browser test: serves the app's own files from disk,
// launches Chromium, and routes every Firebase SDK request to a fixture --
// a .mjs file that exports the same surface the app imports from the real
// SDK, backed by an in-memory store instead of a real project. Nothing here
// talks to a real Firebase project or the network.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function startServer() {
  const server = http.createServer((req, res) => {
    const reqPath = req.url.split("?")[0];
    const file = path.join(ROOT, reqPath === "/" ? "index.html" : reqPath);
    try {
      res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] || "text/plain" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// executablePath is left undefined by default so a normal `npx playwright
// install` on the machine running these tests is all that's needed. Sandboxes
// that pre-install Chromium somewhere else can point PLAYWRIGHT_EXECUTABLE_PATH
// at it instead of touching this file.
export async function launchApp(fixturePath, { viewport = { width: 420, height: 1300 }, acceptDownloads = false } = {}) {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  const ctx = await browser.newContext({ viewport, acceptDownloads });
  const errors = [];

  const fixtureBody = readFileSync(fixturePath, "utf8");
  // Both firebase-app.js and firebase-firestore.js get routed to the same
  // fixture body -- it exports everything either real file would, and which
  // one a given import statement asks for doesn't matter to a fake.
  await ctx.route("https://www.gstatic.com/firebasejs/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: fixtureBody })
  );
  // The QR code library is unrelated to anything under test and only loaded
  // lazily if the QR modal is opened; an empty stub satisfies the import.
  await ctx.route("https://unpkg.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));

  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  // A deliberately denied read (fault-isolation tests) logs its own console
  // warning as the expected result, not a real error.
  page.on("console", (m) => {
    if (m.type() === "error" && !/insufficient permissions/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });

  return {
    page,
    base,
    errors,
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}

// Every check for the whole file collects here rather than stopping at the
// first failure, so one run shows everything that's wrong instead of one
// thing at a time across several runs. check() is truthy-only, matching how
// every test in this suite already reads; for a value comparison, pass the
// comparison's result in directly (e.g. check("...", a === b)).
const checks = [];
export function check(label, ok) {
  checks.push([label, !!ok]);
}

// Prints every check plus any page/console errors the run picked up, then
// sets the process exit code -- called once, at the end of a test file.
export function report(errors = []) {
  for (const [label, ok] of checks) console.log(ok ? "PASS" : "FAIL", "-", label);
  const allPass = checks.every(([, ok]) => ok);
  console.log(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} checks passed.`);
  if (errors.length) console.log("ERRORS:", errors);
  if (!allPass || errors.length) process.exitCode = 1;
  return allPass && !errors.length;
}
