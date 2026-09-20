import { scheduleRows, nextDueFor, vehicleStartBaseline, upcomingWork } from "../../stats.js";
import assert from "node:assert/strict";

const today = new Date(2026, 7, 28); // 2026-08-28
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

console.log("vehicleStartBaseline");
ok("a model year becomes Jan 1 at zero miles", () =>
  assert.deepEqual(vehicleStartBaseline(2016), { servicedOn: "2016-01-01", odometerMiles: 0 }));
ok("a year stored as a string works too", () =>
  assert.deepEqual(vehicleStartBaseline("2016"), { servicedOn: "2016-01-01", odometerMiles: 0 }));
for (const bad of [null, undefined, "", "abc", 0, 16, 20160, 2016.5, NaN])
  ok(`no baseline from ${JSON.stringify(bad)}`, () => assert.equal(vehicleStartBaseline(bad), null));

console.log("\nnextDueFor with no history");
ok("counts both intervals from the vehicle's beginning", () => {
  const due = nextDueFor({ everyMiles: 5000, everyMonths: 6 }, null, { vehicleYear: 2016 });
  assert.equal(due.dueOn, "2016-07-01");
  assert.equal(due.dueOdometerMiles, 5000);
  assert.equal(due.neverDone, true);
  assert.deepEqual(due.countedFrom, { servicedOn: "2016-01-01", odometerMiles: 0 });
});
ok("a mileage-only interval gets no date", () => {
  const due = nextDueFor({ everyMiles: 60000 }, null, { vehicleYear: 2016 });
  assert.equal(due.dueOn, null);
  assert.equal(due.dueOdometerMiles, 60000);
});
ok("no model year leaves it unmeasurable, as before", () => {
  const due = nextDueFor({ everyMiles: 5000, everyMonths: 6 }, null, { vehicleYear: null });
  assert.deepEqual(due, { dueOn: null, dueOdometerMiles: null, neverDone: true, countedFrom: null });
});
ok("real history still wins over the vehicle's age", () => {
  const due = nextDueFor({ everyMiles: 5000, everyMonths: 6 },
    { servicedOn: "2026-02-09", odometerMiles: 93000 }, { vehicleYear: 2016 });
  assert.equal(due.dueOn, "2026-08-09");
  assert.equal(due.dueOdometerMiles, 98000);
  assert.equal(due.neverDone, false);
  assert.equal(due.countedFrom, null);
});

console.log("\nscheduleRows");
const schedule = [
  { id: "a", title: "Oil change", everyMiles: 5000, everyMonths: 6 },
  { id: "b", title: "Cabin air filter", everyMonths: 12 },
];
const services = [{ id: "s", title: "Oil change", status: "done", servicedOn: "2026-02-09", odometerMiles: 93000 }];

ok("a never-logged entry is now overdue, not unknown", () => {
  const rows = scheduleRows(schedule, services, { odometerMiles: 98450, today, vehicleYear: 2016 });
  const filter = rows.find((r) => r.id === "b");
  assert.equal(filter.status.key, "overdue");
  assert.equal(filter.dueOn, "2017-01-01");
  assert.deepEqual(filter.countedFrom, { servicedOn: "2016-01-01", odometerMiles: 0 });
});
ok("without a model year it stays 'Not logged yet'", () => {
  const rows = scheduleRows(schedule, services, { odometerMiles: 98450, today, vehicleYear: null });
  const filter = rows.find((r) => r.id === "b");
  assert.equal(filter.status.key, "unknown");
  assert.equal(filter.status.label, "Not logged yet");
  assert.equal(filter.dueOn, null);
});
ok("a logged entry is unaffected", () => {
  const rows = scheduleRows(schedule, services, { odometerMiles: 98450, today, vehicleYear: 2016 });
  const oil = rows.find((r) => r.id === "a");
  assert.equal(oil.dueOn, "2026-08-09");
  assert.equal(oil.dueOdometerMiles, 98000);
  assert.equal(oil.countedFrom, null);
});

console.log("\nupcomingWork");
const garage = (year) => [{ id: "v", name: "Odyssey", year, odometerMiles: 98450, services, schedule, fillups: [] }];

ok("a never-logged job is counted, and counted as overdue", () => {
  const { overdue, soon } = upcomingWork(garage(2016), { today });
  assert.deepEqual(overdue.map((r) => r.title), ["Cabin air filter", "Oil change"]);
  assert.deepEqual(soon.map((r) => r.title), []);
  const filter = overdue.find((r) => r.title === "Cabin air filter");
  assert.equal(filter.neverDone, true);
  assert.equal(filter.status.key, "overdue");
  assert.deepEqual(filter.countedFrom, { servicedOn: "2016-01-01", odometerMiles: 0 });
});

ok("longest overdue leads", () => {
  const { overdue } = upcomingWork(garage(2016), { today });
  assert.deepEqual(overdue.map((r) => r.on), ["2017-01-01", "2026-08-09"]);
});

ok("work comfortably ahead is left out entirely", () => {
  const far = [{ id: "v", name: "Odyssey", year: 2016, odometerMiles: 10, fillups: [], schedule: [],
    services: [{ id: "f", title: "Inspection", status: "scheduled", dueOn: "2027-06-01", dueOdometerMiles: null }] }];
  const { overdue, soon } = upcomingWork(far, { today });
  assert.deepEqual([...overdue, ...soon], []);
});

ok("due soon is its own group, by date or by mileage", () => {
  const near = [{ id: "v", name: "Odyssey", year: 2016, odometerMiles: 1000, fillups: [], schedule: [],
    services: [
      { id: "d", title: "By date", status: "scheduled", dueOn: "2026-09-10", dueOdometerMiles: null },
      { id: "m", title: "By mileage", status: "scheduled", dueOn: null, dueOdometerMiles: 1400 },
      { id: "x", title: "Neither", status: "scheduled", dueOn: "2027-01-01", dueOdometerMiles: 9000 },
    ] }];
  const { overdue, soon } = upcomingWork(near, { today });
  assert.deepEqual(overdue.map((r) => r.title), []);
  assert.deepEqual(soon.map((r) => r.title).sort(), ["By date", "By mileage"]);
});

ok("a job with no due date at all is neither", () => {
  const g = garage(2016);
  g[0].services = [...services, { id: "n", title: "Wipers", status: "scheduled", dueOn: null, dueOdometerMiles: null }];
  const { overdue, soon } = upcomingWork(g, { today });
  assert.equal([...overdue, ...soon].some((r) => r.title === "Wipers"), false);
});

ok("without a model year a never-logged job can't be dated, so it isn't counted", () => {
  const { overdue, soon } = upcomingWork(garage(null), { today });
  assert.deepEqual([...overdue, ...soon].map((r) => r.title), ["Oil change"]);
});

console.log(`\n${passed} assertions passed`);
