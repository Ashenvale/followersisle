// Capa de persistencia para la simulación de Evermark (IndexedDB → escala a miles de registros).
// Stores: 'humans' (un registro por follower) y 'meta' (clave/valor: hitos, contadores, ajustes).
const DB_NAME = 'evermark-sim';
const DB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('humans')) db.createObjectStore('humans', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

export async function dbInit() { if (!_db) await openDB(); return _db; }
function store(name, mode) { return _db.transaction(name, mode).objectStore(name); }

export function dbPut(name, value) {
  return new Promise((res, rej) => { const r = store(name, 'readwrite').put(value); r.onsuccess = () => res(value); r.onerror = () => rej(r.error); });
}
export function dbDelete(name, key) {
  return new Promise((res, rej) => { const r = store(name, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
export function dbGet(name, key) {
  return new Promise((res, rej) => { const r = store(name, 'readonly').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
export function dbGetAll(name) {
  return new Promise((res, rej) => { const r = store(name, 'readonly').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
}
export function dbCount(name) {
  return new Promise((res, rej) => { const r = store(name, 'readonly').count(); r.onsuccess = () => res(r.result || 0); r.onerror = () => rej(r.error); });
}
export function dbClear(name) {
  return new Promise((res, rej) => { const r = store(name, 'readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
// meta helpers (clave/valor)
export async function metaGet(k, def) { const v = await dbGet('meta', k); return v === undefined ? def : v.v; }
export function metaSet(k, v) { return dbPut('meta', { k, v }); }
