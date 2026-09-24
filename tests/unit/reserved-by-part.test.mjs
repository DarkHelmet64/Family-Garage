import { currentlyReserved, reservedByPart } from "../../stats.js";
import assert from "node:assert/strict";
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

ok("a done record's reservation is what it actually used, not what it needed", () => {
  const record = { status: "done", parts: [{ partId: "p1", quantity: 2 }], partsNeeded: [{ partId: "p1", quantity: 99 }] };
  assert.deepEqual(currentlyReserved(record), [{ partId: "p1", quantity: 2 }]);
});

ok("a scheduled record not yet swept by the migration counts as nothing reserved", () => {
  const record = { status: "scheduled", partsNeeded: [{ partId: "p1", quantity: 3 }] };
  assert.deepEqual(currentlyReserved(record), []);
});

ok("a scheduled record marked reserved counts its partsNeeded", () => {
  const record = { status: "scheduled", reserved: true, partsNeeded: [{ partId: "p1", quantity: 3 }] };
  assert.deepEqual(currentlyReserved(record), [{ partId: "p1", quantity: 3 }]);
});

ok("nothing in, nothing out", () => {
  assert.deepEqual(currentlyReserved(null), []);
});

ok("reservedByPart sums across several scheduled jobs sharing a part", () => {
  const services = [
    { status: "scheduled", reserved: true, partsNeeded: [{ partId: "p1", quantity: 2 }] },
    { status: "scheduled", reserved: true, partsNeeded: [{ partId: "p1", quantity: 3 }, { partId: "p2", quantity: 1 }] },
  ];
  const totals = reservedByPart(services);
  assert.equal(totals.get("p1"), 5);
  assert.equal(totals.get("p2"), 1);
});

ok("a done job never counts toward what's reserved -- its stock is just gone, not spoken for", () => {
  const services = [{ status: "done", parts: [{ partId: "p1", quantity: 10 }] }];
  assert.equal(reservedByPart(services).get("p1"), undefined);
});

ok("a scheduled job never swept by the migration contributes nothing", () => {
  const services = [{ status: "scheduled", partsNeeded: [{ partId: "p1", quantity: 10 }] }];
  assert.equal(reservedByPart(services).get("p1"), undefined);
});

ok("a hand-edited parts list that isn't a list of entries counts as nothing, rather than throwing", () => {
  assert.deepEqual(currentlyReserved({ status: "scheduled", reserved: true, partsNeeded: "oil" }), []);
  assert.deepEqual(currentlyReserved({ status: "scheduled", reserved: true, partsNeeded: { a: 1 } }), []);
  assert.deepEqual(currentlyReserved({ status: "done", parts: [null, { partId: "p1", quantity: 1 }] }), [{ partId: "p1", quantity: 1 }]);
  const services = [{ status: "scheduled", reserved: true, partsNeeded: [null, "x", { partId: "p1", quantity: 2 }] }];
  assert.equal(reservedByPart(services).get("p1"), 2);
});

ok("empty input is a valid, empty map", () => {
  assert.equal(reservedByPart([]).size, 0);
  assert.equal(reservedByPart(undefined).size, 0);
});

console.log(`\n${passed} assertions passed`);
