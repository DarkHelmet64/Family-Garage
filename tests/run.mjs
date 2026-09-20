// Runs every test file under tests/unit/ (fast, pure-function, no browser)
// and tests/e2e/ (Playwright against a fake Firestore fixture), each as its
// own process -- exactly like running them by hand with `node <file>` --
// and prints one pass/fail summary at the end. Each test file already
// decides its own pass/fail (an uncaught exception, or an explicit
// process.exitCode = 1 from tests/helpers/serve.mjs's report()); this just
// collects the results.
//
// Usage: node tests/run.mjs [--unit-only | --e2e-only]
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const unitOnly = args.includes("--unit-only");
const e2eOnly = args.includes("--e2e-only");

const listFiles = (dir, suffix) => {
  try {
    return readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith(suffix))
      .sort()
      .map((f) => path.join(ROOT, dir, f));
  } catch {
    return [];
  }
};

const suites = [
  ...(e2eOnly ? [] : listFiles("unit", ".test.mjs").map((file) => ({ file, kind: "unit" }))),
  ...(unitOnly ? [] : listFiles("e2e", ".mjs").map((file) => ({ file, kind: "e2e" }))),
];

if (!suites.length) {
  console.error("No test files found.");
  process.exit(1);
}

function runOne({ file, kind }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ file, kind, code, output, ms: Date.now() - started }));
  });
}

console.log(`Running ${suites.length} test file${suites.length === 1 ? "" : "s"}...\n`);

const results = [];
for (const suite of suites) {
  process.stdout.write(`▶ ${path.relative(ROOT, suite.file)} ... `);
  const result = await runOne(suite);
  results.push(result);
  console.log(result.code === 0 ? `ok (${result.ms}ms)` : `FAILED (${result.ms}ms)`);
  if (result.code !== 0) console.log(result.output.trim().replace(/^/gm, "    "));
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} test files passed.`);
if (failed.length) {
  console.log("Failed:", failed.map((r) => path.relative(ROOT, r.file)).join(", "));
  process.exit(1);
}
