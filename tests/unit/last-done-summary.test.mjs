import { lastDoneByJob, lastDoneFor, scheduleRows } from "../../stats.js";
import assert from "node:assert/strict";
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

const services = [
  { status: "done", title: "Oil change", servicedOn: "2025-01-10", odometerMiles: 80000 },
  { status: "done", title: "oil change ", servicedOn: "2025-07-02", odometerMiles: 85000 },
  { status: "done", items: [{ title: "Oil change" }, { title: "Wiper blades" }], servicedOn: "2024-12-01", odometerMiles: 90000 },
  { status: "done", title: "Tire rotation", servicedOn: "2026-03-01", odometerMiles: null },
  { status: "done", title: "Tire rotation", servicedOn: "2025-03-01", odometerMiles: null },
  { status: "scheduled", title: "Oil change", dueOn: "2026-12-01" },
];
const schedule = [
  { id: "a", title: "Oil change", everyMiles: 5000, everyMonths: 6 },
  { id: "b", title: "Tire rotation", everyMonths: 12 },
  { id: "c", title: "Wiper blades", everyMonths: 12 },
  { id: "d", title: "Coolant flush", everyMonths: 24 },
];

ok("the summary gives the same last-done as reading the whole history, job by job", () => {
  const map = lastDoneByJob(services);
  for (const entry of schedule) {
    const full = lastDoneFor(entry.title, services);
    const fromMap = map[entry.title.trim().toLowerCase()] || null;
    assert.deepEqual(
      fromMap && { servicedOn: fromMap.servicedOn, odometerMiles: fromMap.odometerMiles },
      full && { servicedOn: full.servicedOn, odometerMiles: full.odometerMiles },
      entry.title
    );
  }
});

ok("schedule rows come out the same from the summary as from the history", () => {
  const opts = { odometerMiles: 92000, today: new Date(2026, 9, 10), vehicleYear: 2016 };
  const strip = (rows) => rows.map(({ id, dueOn, dueOdometerMiles, neverDone, status }) => ({ id, dueOn, dueOdometerMiles, neverDone, status: status.key }));
  assert.deepEqual(
    strip(scheduleRows(schedule, [], { ...opts, lastDone: lastDoneByJob(services) })),
    strip(scheduleRows(schedule, services, opts))
  );
});

ok("no history is an empty summary", () => {
  assert.deepEqual(lastDoneByJob([]), {});
  assert.deepEqual(lastDoneByJob(undefined), {});
});

console.log(`\n${passed} assertions passed`);
