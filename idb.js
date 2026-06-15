/* Tiny IndexedDB wrapper for user-uploaded plant photos.
   localStorage is too small for images, so photos live here as data URLs
   keyed by plant name. Everything else (plants, tasks, settings) stays in
   localStorage. */
"use strict";
const Photos = (() => {
  const DBNAME = "gardencare-photos", STORE = "photos";
  let _db = null;
  function open() {
    return new Promise((res, rej) => {
      if (_db) return res(_db);
      const r = indexedDB.open(DBNAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => { _db = r.result; res(_db); };
      r.onerror = () => rej(r.error);
    });
  }
  function tx(mode) { return open().then(db => db.transaction(STORE, mode).objectStore(STORE)); }
  return {
    get: key => tx("readonly").then(s => new Promise((res, rej) => {
      const r = s.get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
    })),
    set: (key, val) => tx("readwrite").then(s => new Promise((res, rej) => {
      const r = s.put(val, key); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    })),
    del: key => tx("readwrite").then(s => new Promise((res, rej) => {
      const r = s.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
    })),
    all: () => tx("readonly").then(s => new Promise((res, rej) => {
      const out = {}; const r = s.openCursor();
      r.onsuccess = () => { const c = r.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
      r.onerror = () => rej(r.error);
    })),
  };
})();
