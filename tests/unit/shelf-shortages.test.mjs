import { shelfShortages, isLowStock } from "../../stats.js";
import assert from "node:assert/strict";
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };

ok("a part above its minimum isn't listed", () => {
  const parts = [{ id: "p1", name: "0W-20 oil", quantity: 8, minQuantity: 5, unit: "qt" }];
  assert.deepEqual(shelfShortages(parts), []);
});

ok("a part at or below its minimum is listed, with a real target", () => {
  const parts = [{ id: "p1", name: "0W-20 oil", quantity: 3, minQuantity: 5, unit: "qt" }];
  const [need] = shelfShortages(parts);
  assert.equal(need.quantity, 3);
  assert.equal(need.floor, 5);
  assert.equal(need.short, 2);
});

ok("no minimum set -- only actually running out counts, floor comes back null", () => {
  const parts = [
    { id: "p1", name: "Shop rags", quantity: 4, unit: "each" }, // not low, no floor
    { id: "p2", name: "Oil filter", quantity: 0, unit: "each" }, // exactly out
  ];
  const shortages = shelfShortages(parts);
  assert.equal(shortages.length, 1);
  assert.equal(shortages[0].partId, "p2");
  assert.equal(shortages[0].floor, null);
  assert.equal(shortages[0].short, 0);
});

ok("a negative (over-booked) part reports how far past zero it is", () => {
  const parts = [{ id: "p1", name: "Brake fluid", quantity: -2, unit: "qt" }];
  const [need] = shelfShortages(parts);
  assert.equal(need.floor, null);
  assert.equal(need.short, 2);
});

ok("a negative part WITH a minimum counts the full distance back up to it", () => {
  const parts = [{ id: "p1", name: "0W-20 oil", quantity: -1, minQuantity: 5, unit: "qt" }];
  const [need] = shelfShortages(parts);
  assert.equal(need.short, 6);
});

ok("the negative flag is set correctly either way", () => {
  const parts = [
    { id: "p1", name: "A", quantity: -1, unit: "each" },
    { id: "p2", name: "B", quantity: 0, unit: "each" },
  ];
  const [a, b] = shelfShortages(parts);
  assert.equal(a.negative, true);
  assert.equal(b.negative, false);
});

ok("negative sorts first regardless of how short anything else is", () => {
  const parts = [
    { id: "p1", name: "Way short", quantity: 0, minQuantity: 20, unit: "each" }, // short 20, not negative
    { id: "p2", name: "Barely negative", quantity: -1, unit: "each" }, // short 1, negative
  ];
  const names = shelfShortages(parts).map((n) => n.name);
  assert.deepEqual(names, ["Barely negative", "Way short"]);
});

ok("sorted worst-short first, then by name", () => {
  const parts = [
    { id: "p1", name: "B part", quantity: 4, minQuantity: 5, unit: "each" }, // short 1
    { id: "p2", name: "A part", quantity: 0, minQuantity: 10, unit: "each" }, // short 10
    { id: "p3", name: "C part", quantity: 4, minQuantity: 5, unit: "each" }, // short 1, ties with B
  ];
  const names = shelfShortages(parts).map((n) => n.name);
  assert.deepEqual(names, ["A part", "B part", "C part"]);
});

ok("model/size/vendor come straight from the part, no fallback needed", () => {
  const parts = [{
    id: "p1", name: "0W-20 oil", quantity: 0, unit: "qt",
    modelNumber: "M1-0W20", size: "0W-20", vendor: "NAPA",
  }];
  const [need] = shelfShortages(parts);
  assert.equal(need.modelNumber, "M1-0W20");
  assert.equal(need.size, "0W-20");
  assert.equal(need.vendor, "NAPA");
});

ok("shelfShortages agrees with isLowStock on which parts qualify", () => {
  const parts = [
    { id: "p1", name: "A", quantity: 10, minQuantity: 5, unit: "each" },
    { id: "p2", name: "B", quantity: 5, minQuantity: 5, unit: "each" },
    { id: "p3", name: "C", quantity: 4, minQuantity: 5, unit: "each" },
  ];
  const ids = new Set(shelfShortages(parts).map((n) => n.partId));
  for (const part of parts) assert.equal(ids.has(part.id), isLowStock(part));
});

console.log(`\n${passed} assertions passed`);
