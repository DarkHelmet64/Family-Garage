import { inferPartJobs } from "../../stats.js";
import assert from "node:assert/strict";
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

const visit = (parts, extra = {}) => ({
  id: "visit",
  vehicleId: "v1",
  status: "done",
  title: "Oil change",
  servicedOn: "2026-05-01",
  items: [{ title: "Oil change" }, { title: "Wiper blades" }],
  parts,
  ...extra,
});
const oil = { partId: "oil", name: "Oil", quantity: 5 };
const blades = { partId: "blades", name: "Blades", quantity: 2 };

ok("a part only one job's usual parts include goes on that job", () => {
  const usual = (vehicleId, job) => (job === "Wiper blades" ? ["blades"] : job === "Oil change" ? ["oil"] : []);
  const { fixes, unclear } = inferPartJobs([visit([oil, blades])], usual);
  assert.deepEqual(fixes[0].parts.map((p) => p.forJob), ["Oil change", "Wiper blades"]);
  assert.equal(fixes[0].filled, 2);
  assert.equal(unclear.length, 0);
});

ok("history on the same vehicle counts as evidence", () => {
  const earlier = { id: "e", vehicleId: "v1", status: "done", title: "Wiper blades", parts: [blades] };
  const { fixes } = inferPartJobs([earlier, visit([blades])]);
  assert.equal(fixes[0].parts[0].forJob, "Wiper blades");
});

ok("garage-wide history is used only when the vehicle's own says nothing", () => {
  const elsewhere = { id: "e", vehicleId: "v2", status: "done", title: "Wiper blades", parts: [blades] };
  const { fixes } = inferPartJobs([elsewhere, visit([blades])]);
  assert.equal(fixes[0].parts[0].forJob, "Wiper blades");
});

ok("a part two jobs both claim is left alone and reported", () => {
  const usual = () => ["oil"];
  const { fixes, unclear } = inferPartJobs([visit([oil])], usual);
  assert.equal(fixes.length, 0);
  assert.deepEqual(unclear[0].parts, ["Oil"]);
});

ok("a part no job claims is left alone and reported", () => {
  const { fixes, unclear } = inferPartJobs([visit([oil])]);
  assert.equal(fixes.length, 0);
  assert.equal(unclear.length, 1);
});

ok("a part that already says its job is never changed", () => {
  const usual = () => ["oil"];
  const { fixes, unclear } = inferPartJobs([visit([{ ...oil, forJob: "Wiper blades" }])], usual);
  assert.equal(fixes.length, 0);
  assert.equal(unclear.length, 0);
});

ok("single-job and scheduled records are never touched", () => {
  const single = { id: "s", vehicleId: "v1", status: "done", title: "Oil change", parts: [oil] };
  const scheduled = visit([oil], { status: "scheduled" });
  assert.deepEqual(inferPartJobs([single, scheduled], () => ["oil"]), { fixes: [], unclear: [] });
});

ok("a scheduled job's parts aren't evidence unless they name their job", () => {
  const booked = { id: "b", vehicleId: "v1", status: "scheduled", title: "Wiper blades", partsNeeded: [oil] };
  assert.equal(inferPartJobs([booked, visit([oil])]).fixes.length, 0);
  const named = { ...booked, partsNeeded: [{ ...oil, forJob: "Oil change" }] };
  assert.equal(inferPartJobs([named, visit([oil])]).fixes[0].parts[0].forJob, "Oil change");
});

ok("malformed parts lists don't throw", () => {
  const bad = visit("oil");
  assert.deepEqual(inferPartJobs([bad, visit([null, oil])], () => []).fixes, []);
});

console.log(`\n${passed} assertions passed`);
