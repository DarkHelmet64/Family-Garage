// A stand-in for the Firebase Firestore web SDK: a real, in-memory,
// writable store with a realistic-ish dataset seeded in, wired up to the
// same functions app.js imports. Routed in for the app's own Firebase SDK
// URLs by tests/helpers/serve.mjs, so the app under test never touches a
// real project.
//
// Two vehicles -- Blue Odyssey has an overdue oil change and a couple of
// scheduled jobs with parts reserved against them; Red Tacoma is caught up,
// so there's always at least one vehicle with nothing due. Parts include one
// with a buy-unit/use-unit conversion (Coolant: counted in gal, used in oz)
// so that feature has something to exercise it against.
//
// Every write is logged (window.__writeLog) and every read counted
// (window.__reads), so a test can assert not just on the end state but on
// how many times something was actually read, or the order two writes
// happened in -- not just that both eventually landed.
const pad = (n) => String(n).padStart(2, "0");
const iso = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const DATA = {
  vehicles: [
    {
      id: "v1",
      name: "Blue Odyssey",
      year: 2016,
      make: "Honda",
      model: "Odyssey",
      avgMpg: 22.4,
      odometerMiles: 98450,
      startOdometerMiles: 90000,
      statsVersion: 999,
    },
    {
      id: "v2",
      name: "Red Tacoma",
      year: 2019,
      make: "Toyota",
      model: "Tacoma",
      avgMpg: 19.1,
      odometerMiles: 45300,
      startOdometerMiles: 39000,
      statsVersion: 999,
    },
  ],
  "vehicles/v1/services": [
    {
      id: "s1",
      title: "Oil change",
      status: "done",
      servicedOn: iso(-200),
      odometerMiles: 93000,
      items: [{ title: "Oil change", costCents: 6500, notes: null }],
      costCents: 6500,
    },
    {
      id: "b1",
      title: "Brake pads",
      status: "scheduled",
      dueOn: iso(10),
      dueOdometerMiles: null,
      shop: "Dave's Auto",
      notes: "fronts squealing",
      partsNeeded: [{ partId: "p1", name: "0W-20 oil", unit: "qt", quantity: 2 }],
    },
    {
      id: "b2",
      title: "Wiper blades",
      status: "scheduled",
      dueOn: iso(14),
      dueOdometerMiles: null,
      shop: "Dave's Auto",
      notes: null,
      partsNeeded: [
        { partId: "p1", name: "0W-20 oil", unit: "qt", quantity: 3 },
        { partId: "p2", name: "Oil filter", unit: "each", quantity: 1 },
      ],
    },
  ],
  "vehicles/v1/schedule": [
    { id: "sc1", title: "Oil change", everyMiles: 5000, everyMonths: 6 }, // overdue
    { id: "sc2", title: "Tire rotation", everyMiles: 7500, everyMonths: 12 },
    { id: "sc3", title: "State inspection", everyMonths: 12 },
  ],
  "vehicles/v1/fillups": [
    { id: "f1", filledOn: iso(-180), odometerMiles: 92000, gallons: 14.2, totalCents: 4800, fullTank: true },
    { id: "f2", filledOn: iso(-90), odometerMiles: 95100, gallons: 15.0, totalCents: 5100, fullTank: true },
    { id: "f3", filledOn: iso(-5), odometerMiles: 98450, gallons: 14.8, totalCents: 5000, fullTank: true },
  ],
  "vehicles/v2/services": [
    {
      id: "t1",
      title: "Oil change",
      status: "done",
      servicedOn: iso(-60),
      odometerMiles: 44000,
      items: [{ title: "Oil change", costCents: 5500, notes: null }],
      costCents: 5500,
    },
  ],
  "vehicles/v2/schedule": [{ id: "sd1", title: "Oil change", everyMiles: 5000, everyMonths: 6 }],
  "vehicles/v2/fillups": [
    { id: "g1", filledOn: iso(-200), odometerMiles: 40100, gallons: 16.0, totalCents: 5600, fullTank: true },
    { id: "g2", filledOn: iso(-4), odometerMiles: 45300, gallons: 17.1, totalCents: 5900, fullTank: true },
  ],
  parts: [
    { id: "p1", name: "0W-20 oil", quantity: 8, unit: "qt", minQuantity: 5 },
    { id: "p2", name: "Oil filter", quantity: 4, unit: "each" },
    { id: "p3", name: "Coolant", quantity: 2, unit: "gal", useUnit: "oz", unitsPerBuyUnit: 128, minQuantity: 0.25 },
  ],
  purchases: [
    { id: "pu1", partId: "p1", partName: "0W-20 oil", quantity: 8, unit: "qt", totalCents: 7192, unitCostCents: 899, vendor: "NAPA", purchasedOn: iso(-200), notes: null },
  ],
  serviceNames: [],
};

const listeners = [];
const rows = (path) => (store[path] = Array.isArray(store[path]) ? store[path] : []);
const snapFor = (path) => {
  const docs = rows(path).map((r) => ({ id: r.id, data: () => ({ ...r }), ref: { path, id: r.id } }));
  return { empty: !docs.length, docs, forEach: (fn) => docs.forEach(fn) };
};
const docSnapFor = (path, id) => {
  const row = rows(path).find((r) => r.id === id);
  return { exists: () => !!row, id, data: () => (row ? { ...row } : null) };
};
const notify = () => listeners.forEach((l) => (l.type === "doc" ? l.cb(docSnapFor(l.path, l.id)) : l.cb(snapFor(l.path))));

// A handful of actions in the app navigate by setting location.search, which
// is a real page reload -- and would otherwise reset this store to its
// seed data on every navigation. Kept in sessionStorage instead, so a test
// that logs a purchase and then follows the app to the Purchases page still
// sees it.
const STORAGE_KEY = "family-garage-test-standard";
const saved = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null;
const store = saved ? JSON.parse(saved) : DATA;
const persist = () => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Private browsing or a disabled sessionStorage -- state just won't
    // survive a reload in that one run, nothing to do about it here.
  }
};
persist();

const reads = { getDocs: {}, getDoc: {}, onSnapshot: {}, updateDoc: {} };
const count = (kind, path) => {
  reads[kind][path] = (reads[kind][path] || 0) + 1;
};
let writeLog = [];
const logWrite = (kind, path, id, patch) => writeLog.push({ kind, path, id, keys: patch ? Object.keys(patch) : [] });

if (typeof window !== "undefined") {
  window.__db = store;
  window.__reads = reads;
  window.__writeLog = writeLog;
  window.__clearWriteLog = () => {
    writeLog.length = 0;
  };
}

export const initializeApp = () => ({});
export const getFirestore = () => ({});
export const initializeFirestore = () => ({});
export const persistentLocalCache = (opts) => opts;
export const persistentMultipleTabManager = () => ({});
export const collection = (_db, ...s) => ({ kind: "collection", path: s.join("/") });
export const doc = (_db, ...s) => ({ kind: "doc", path: s.slice(0, -1).join("/"), id: s[s.length - 1] });
export const getDocs = async (ref) => {
  count("getDocs", ref.path);
  return snapFor(ref.path);
};
export const getDoc = async (ref) => {
  count("getDoc", ref.path);
  return docSnapFor(ref.path, ref.id);
};
export const onSnapshot = (ref, onNext) => {
  count("onSnapshot", ref.path);
  if (ref.kind === "doc") {
    listeners.push({ type: "doc", path: ref.path, id: ref.id, cb: onNext });
    setTimeout(() => onNext(docSnapFor(ref.path, ref.id)), 0);
  } else {
    listeners.push({ type: "collection", path: ref.path, cb: onNext });
    setTimeout(() => onNext(snapFor(ref.path)), 0);
  }
  return () => {};
};
export const addDoc = async (ref, data) => {
  const id = `new${(store.__seq = (store.__seq || 0) + 1)}`;
  logWrite("addDoc", ref.path, id, data);
  rows(ref.path).push({ id, ...data });
  persist();
  notify();
  return { id };
};
export const updateDoc = async (ref, patch) => {
  count("updateDoc", `${ref.path}/${ref.id}`);
  logWrite("updateDoc", ref.path, ref.id, patch);
  const row = rows(ref.path).find((r) => r.id === ref.id);
  if (!row) throw new Error(`no doc ${ref.path}/${ref.id}`);
  for (const [k, v] of Object.entries(patch)) {
    row[k] = v && typeof v === "object" && v.__inc !== undefined ? (Number(row[k]) || 0) + v.__inc : v;
  }
  persist();
  notify();
};
export const deleteDoc = async (ref) => {
  logWrite("deleteDoc", ref.path, ref.id, null);
  store[ref.path] = rows(ref.path).filter((r) => r.id !== ref.id);
  persist();
  notify();
};
// A real Firestore Timestamp has a toDate() method; anything reading one
// back (export, mainly) should see exactly that shape, not a bare null.
export const serverTimestamp = () => ({ toDate: () => new Date() });
export const increment = (n) => ({ __inc: n });
export const writeBatch = () => {
  const ops = [];
  return {
    set(ref, data) {
      ops.push(() => rows(ref.path).push({ id: ref.id, ...data }));
    },
    update(ref, patch) {
      ops.push(() => {
        const row = rows(ref.path).find((r) => r.id === ref.id);
        if (!row) throw new Error(`no doc ${ref.path}/${ref.id}`);
        for (const [k, v] of Object.entries(patch)) {
          row[k] = v && typeof v === "object" && v.__inc !== undefined ? (Number(row[k]) || 0) + v.__inc : v;
        }
      });
    },
    delete(ref) {
      ops.push(() => {
        store[ref.path] = rows(ref.path).filter((r) => r.id !== ref.id);
      });
    },
    commit: async () => {
      for (const op of ops) op();
      persist();
      notify();
    },
  };
};
