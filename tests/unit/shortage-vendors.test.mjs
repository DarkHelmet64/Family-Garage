import { shelfShortages, shortageVendors } from "../../stats.js";
import assert from "node:assert/strict";
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

ok("no shortages, no vendors", () => {
  assert.deepEqual(shortageVendors([]), []);
});

ok("a part with no vendor set contributes nothing", () => {
  const shortages = shelfShortages([{ id: "p1", name: "Shop rags", quantity: 0, unit: "each" }]);
  assert.deepEqual(shortageVendors(shortages), []);
});

ok("distinct vendors, one entry each even if several parts share one", () => {
  const shortages = shelfShortages([
    { id: "p1", name: "0W-20 oil", quantity: 0, unit: "qt", vendor: "NAPA" },
    { id: "p2", name: "Oil filter", quantity: 0, unit: "each", vendor: "NAPA" },
    { id: "p3", name: "Wiper blades", quantity: 0, unit: "pair", vendor: "AutoZone" },
  ]);
  const vendors = shortageVendors(shortages);
  assert.equal(vendors.length, 2);
  assert.ok(vendors.includes("NAPA"));
  assert.ok(vendors.includes("AutoZone"));
});

ok("order follows shelfShortages' own worst-first sort, not insertion order", () => {
  // p2 (AutoZone) is negative -- sorts first regardless of catalogue order.
  const shortages = shelfShortages([
    { id: "p1", name: "0W-20 oil", quantity: 0, unit: "qt", vendor: "NAPA" },
    { id: "p2", name: "Wiper blades", quantity: -1, unit: "pair", vendor: "AutoZone" },
  ]);
  assert.deepEqual(shortageVendors(shortages), ["AutoZone", "NAPA"]);
});

ok("a vendor only on a part that's NOT short doesn't show up", () => {
  const shortages = shelfShortages([
    { id: "p1", name: "Fine on the shelf", quantity: 10, minQuantity: 5, unit: "each", vendor: "NAPA" },
    { id: "p2", name: "Actually short", quantity: 0, unit: "each", vendor: "AutoZone" },
  ]);
  assert.deepEqual(shortageVendors(shortages), ["AutoZone"]);
});

console.log(`\n${passed} assertions passed`);
