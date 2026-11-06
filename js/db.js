// IndexedDB layer. Every stored record carries a stable id and timestamps
// so a later cloud sync (phase 2) can merge without a migration.

const DB_NAME = 'spotscore';
const DB_VERSION = 1;
export const STORES = ['tracks', 'albums', 'artists', 'ratings', 'elo', 'suggestions', 'brackets', 'meta'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'tracks') store.createIndex('addedAt', 'addedAt');
          if (name === 'ratings' || name === 'elo' || name === 'suggestions') store.createIndex('type', 'type');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, id) => tx(store, 'readonly', s => wrap(s.get(id))),
  all: (store) => tx(store, 'readonly', s => wrap(s.getAll())),
  count: (store) => tx(store, 'readonly', s => wrap(s.count())),
  put: (store, value) => tx(store, 'readwrite', s => wrap(s.put(value))),
  putMany: (store, values) => tx(store, 'readwrite', s => { values.forEach(v => s.put(v)); }),
  delete: (store, id) => tx(store, 'readwrite', s => wrap(s.delete(id))),
  clear: (store) => tx(store, 'readwrite', s => wrap(s.clear())),
  async getMeta(key, fallback = null) {
    const row = await this.get('meta', key);
    return row ? row.value : fallback;
  },
  setMeta(key, value) {
    return this.put('meta', { id: key, value, updatedAt: Date.now() });
  },
  async clearAll() {
    for (const s of STORES) await this.clear(s);
  },
};

export const now = () => Date.now();
