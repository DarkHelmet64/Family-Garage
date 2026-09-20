// Same engine as standard.mjs, seeded with nothing -- a brand-new garage
// with no vehicles, parts or purchases yet. For every "what does the empty
// state actually say" check.
const DATA = { vehicles: [], parts: [], purchases: [], serviceNames: [] };

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
const groupSnapFor = (name) => {
  const matchingPaths = Object.keys(store).filter((p) => Array.isArray(store[p]) && p.split("/").pop() === name);
  const docs = matchingPaths.flatMap((p) => rows(p).map((r) => ({ id: r.id, data: () => ({ ...r }), ref: { path: p, id: r.id } })));
  return { empty: !docs.length, docs, forEach: (fn) => docs.forEach(fn) };
};
const notify = () => listeners.forEach((l) => (l.type === "doc" ? l.cb(docSnapFor(l.path, l.id)) : l.cb(snapFor(l.path))));

// See standard.mjs -- some actions in the app navigate with a real page
// reload, which would otherwise reset this store on every navigation.
const STORAGE_KEY = "family-garage-test-empty";
const saved = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null;
const store = saved ? JSON.parse(saved) : DATA;
const persist = () => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Nothing to do if storage isn't available -- state just won't survive
    // a reload in that one run.
  }
};
persist();

if (typeof window !== "undefined") window.__db = store;

export const initializeApp = () => ({});
export const getFirestore = () => ({});
export const initializeFirestore = () => ({});
export const persistentLocalCache = (opts) => opts;
export const persistentMultipleTabManager = () => ({});
export const collection = (_db, ...s) => ({ kind: "collection", path: s.join("/") });
export const collectionGroup = (_db, name) => ({ kind: "collectionGroup", name });
export const doc = (_db, ...s) => ({ kind: "doc", path: s.slice(0, -1).join("/"), id: s[s.length - 1] });
export const getDocs = async (ref) => (ref.kind === "collectionGroup" ? groupSnapFor(ref.name) : snapFor(ref.path));
export const getDoc = async (ref) => docSnapFor(ref.path, ref.id);
export const onSnapshot = (ref, onNext) => {
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
  rows(ref.path).push({ id, ...data });
  persist();
  notify();
  return { id };
};
export const updateDoc = async (ref, patch) => {
  const row = rows(ref.path).find((r) => r.id === ref.id);
  if (!row) throw new Error(`no doc ${ref.path}/${ref.id}`);
  for (const [k, v] of Object.entries(patch)) {
    row[k] = v && typeof v === "object" && v.__inc !== undefined ? (Number(row[k]) || 0) + v.__inc : v;
  }
  persist();
  notify();
};
export const deleteDoc = async (ref) => {
  store[ref.path] = rows(ref.path).filter((r) => r.id !== ref.id);
  persist();
  notify();
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
      persist();
      notify();
    },
  };
};
