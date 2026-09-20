import { totalServiceCostCents } from "../../stats.js";
import assert from "node:assert/strict";
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

ok("a record with no labor cost behaves exactly as before -- items only", () => {
  const services = [
    { status: "done", items: [{ title: "Oil change", costCents: 6500 }], costCents: 6500 },
  ];
  assert.equal(totalServiceCostCents(services), 6500);
});

ok("labor cost is added on top of the items total", () => {
  const services = [
    { status: "done", items: [{ title: "Detail wash", costCents: 8000 }], costCents: 12500, laborCostCents: 4500 },
  ];
  assert.equal(totalServiceCostCents(services), 12500);
});

ok("sums labor-inclusive costCents across several done visits", () => {
  const services = [
    { status: "done", items: [{ title: "Oil change", costCents: 6500 }], costCents: 6500 },
    { status: "done", items: [{ title: "Brake pads", costCents: 4000 }], costCents: 6000, laborCostCents: 2000 },
  ];
  assert.equal(totalServiceCostCents(services), 12500);
});

ok("a scheduled (not yet done) record never counts, labor cost or not", () => {
  const services = [
    { status: "scheduled", items: [{ title: "Tire rotation", costCents: 2500 }], costCents: 2500, laborCostCents: 1000 },
  ];
  assert.equal(totalServiceCostCents(services), 0);
});

ok("a record with only labor cost and free items still counts", () => {
  const services = [
    { status: "done", items: [{ title: "Diagnostic", costCents: null }], costCents: 3000, laborCostCents: 3000 },
  ];
  assert.equal(totalServiceCostCents(services), 3000);
});

console.log(`\n${passed} assertions passed`);
