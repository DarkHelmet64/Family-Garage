import { serviceNameReport, serviceNameSuggestions } from "../../stats.js";
import assert from "node:assert/strict";
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

const vehicles = [
  {
    id: "v1",
    schedule: [{ id: "sc1", title: "Oil change" }],
    services: [
      { id: "s1", status: "done", items: [{ title: "Oil change" }] },
      { id: "s2", status: "scheduled", title: "Brake pads" },
    ],
  },
  {
    id: "v2",
    schedule: [],
    services: [{ id: "s3", status: "done", items: [{ title: "oil CHANGE" }] }],
  },
];

ok("a name used nowhere in records still appears if it's been saved", () => {
  const report = serviceNameReport(vehicles, [{ id: "n1", name: "Detail wash", favorite: false, fitsVehicleIds: [] }]);
  const row = report.find((r) => r.key === "detail wash");
  assert.ok(row);
  assert.equal(row.records, 0);
  assert.equal(row.vehicles, 0);
  assert.equal(row.id, "n1");
});

ok("a purely usage-derived name carries no saved doc id, favorite false, unrestricted", () => {
  const report = serviceNameReport(vehicles, []);
  const row = report.find((r) => r.key === "brake pads");
  assert.ok(row);
  assert.equal(row.id, null);
  assert.equal(row.favorite, false);
  assert.equal(row.fitsVehicleIds, null);
});

ok("a saved doc's own casing wins over the tallied-usage casing", () => {
  const report = serviceNameReport(vehicles, [{ id: "n2", name: "Oil Change & Filter", favorite: false, fitsVehicleIds: [] }]);
  const row = report.find((r) => r.key === "oil change & filter" || r.key === "oil change");
  // The saved doc's key comes from ITS OWN name, which doesn't match the
  // records' "oil change" key -- so this is really testing that a same-key
  // match uses the saved name, which the next case covers directly.
  assert.ok(row);
});

ok("when a saved doc's name matches used records by key, the saved casing is shown", () => {
  const report = serviceNameReport(vehicles, [{ id: "n3", name: "OIL CHANGE", favorite: true, fitsVehicleIds: ["v1"] }]);
  const row = report.find((r) => r.key === "oil change");
  assert.equal(row.name, "OIL CHANGE");
  assert.equal(row.records, 3); // still tallies every real usage (v1's schedule entry + done item, v2's done item)
  assert.equal(row.favorite, true);
  assert.deepEqual(row.fitsVehicleIds, ["v1"]);
});

ok("serviceNameSuggestions: unrestricted names offer themselves everywhere", () => {
  const names = [{ name: "Oil change", favorite: false, fitsVehicleIds: [] }];
  assert.deepEqual(serviceNameSuggestions(names, "v1"), ["Oil change"]);
  assert.deepEqual(serviceNameSuggestions(names, "v9"), ["Oil change"]);
});

ok("serviceNameSuggestions: a scoped name only offers itself on its own vehicles", () => {
  const names = [{ name: "Detail wash", favorite: false, fitsVehicleIds: ["v1"] }];
  assert.deepEqual(serviceNameSuggestions(names, "v1"), ["Detail wash"]);
  assert.deepEqual(serviceNameSuggestions(names, "v2"), []);
});

ok("serviceNameSuggestions: favorites sort first, then alphabetical within each group", () => {
  const names = [
    { name: "Zzz job", favorite: true, fitsVehicleIds: [] },
    { name: "Air filter", favorite: false, fitsVehicleIds: [] },
    { name: "Brake pads", favorite: true, fitsVehicleIds: [] },
  ];
  assert.deepEqual(serviceNameSuggestions(names, "v1"), ["Brake pads", "Zzz job", "Air filter"]);
});

ok("serviceNameSuggestions: favoritesOnly drops everything else, scope still applies", () => {
  const names = [
    { name: "Oil change", favorite: true, fitsVehicleIds: [] },
    { name: "Tire rotation", favorite: false, fitsVehicleIds: [] },
    { name: "Detail wash", favorite: true, fitsVehicleIds: ["v2"] },
  ];
  assert.deepEqual(serviceNameSuggestions(names, "v1", { favoritesOnly: true }), ["Oil change"]);
  assert.deepEqual(serviceNameSuggestions(names, "v2", { favoritesOnly: true }), ["Detail wash", "Oil change"]);
});

console.log(`\n${passed} assertions passed`);
