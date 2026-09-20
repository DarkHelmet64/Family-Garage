// Same two vehicles as standard.mjs's dashboard-relevant data, except one
// read -- v2's fillups -- always throws, the same way Firestore rejects a
// read the security rules don't allow. Both vehicles carry a pre-computed
// `nextService` on their own document (the same field recomputeSummary()
// keeps fresh in production), so the garage card list needs nothing from
// the denied subcollection to show correctly; only a page that reads
// subcollections directly (Coming Up) is actually exercised by the denial.
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
      statsVersion: 999,
      nextService: { title: "Oil change", dueOn: iso(-5), dueOdometerMiles: 98000 }, // overdue
    },
    {
      id: "v2",
      name: "Red Tacoma",
      year: 2019,
      make: "Toyota",
      model: "Tacoma",
      avgMpg: 19.1,
      odometerMiles: 51200,
      statsVersion: 999,
      nextService: { title: "State inspection", dueOn: iso(10), dueOdometerMiles: null }, // due soon
    },
  ],
  parts: [],
  "vehicles/v1/services": [{ id: "s1", title: "Oil change", status: "scheduled", dueOn: iso(-5), dueOdometerMiles: 98000, partsNeeded: [] }],
  "vehicles/v1/schedule": [],
  "vehicles/v1/fillups": [],
  "vehicles/v2/services": [{ id: "s2", title: "State inspection", status: "scheduled", dueOn: iso(10), dueOdometerMiles: null, partsNeeded: [] }],
  "vehicles/v2/schedule": [],
  "vehicles/v2/fillups": [],
};

const DENIED_PATH = "vehicles/v2/fillups";

const rows = (path) => (store[path] = Array.isArray(store[path]) ? store[path] : []);
const snapFor = (path) => {
  const docs = rows(path).map((r) => ({ id: r.id, data: () => ({ ...r }), ref: { path, id: r.id } }));
  return { empty: !docs.length, docs, forEach: (fn) => docs.forEach(fn) };
};
const docSnapFor = (path, id) => {
  const row = rows(path).find((r) => r.id === id);
  return { exists: () => !!row, id, data: () => (row ? { ...row } : null) };
};
const store = DATA;

if (typeof window !== "undefined") window.__db = store;

export const initializeApp = () => ({});
export const getFirestore = () => ({});
export const initializeFirestore = () => ({});
export const persistentLocalCache = (opts) => opts;
export const persistentMultipleTabManager = () => ({});
export const collection = (_db, ...s) => ({ kind: "collection", path: s.join("/") });
export const doc = (_db, ...s) => ({ kind: "doc", path: s.slice(0, -1).join("/"), id: s[s.length - 1] });
export const getDocs = async (ref) => {
  if (ref.path === DENIED_PATH) throw new Error("Missing or insufficient permissions.");
  return snapFor(ref.path);
};
export const getDoc = async (ref) => docSnapFor(ref.path, ref.id);
export const onSnapshot = (ref, onNext) => {
  if (ref.kind === "doc") setTimeout(() => onNext(docSnapFor(ref.path, ref.id)), 0);
  else setTimeout(() => onNext(snapFor(ref.path)), 0);
  return () => {};
};
export const addDoc = async (ref, data) => {
  const id = `new${(store.__seq = (store.__seq || 0) + 1)}`;
  rows(ref.path).push({ id, ...data });
  return { id };
};
export const updateDoc = async (ref, patch) => {
  const row = rows(ref.path).find((r) => r.id === ref.id);
  if (!row) throw new Error(`no doc ${ref.path}/${ref.id}`);
  for (const [k, v] of Object.entries(patch)) {
    row[k] = v && typeof v === "object" && v.__inc !== undefined ? (Number(row[k]) || 0) + v.__inc : v;
  }
};
export const deleteDoc = async (ref) => {
  store[ref.path] = rows(ref.path).filter((r) => r.id !== ref.id);
};
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
    },
  };
};
