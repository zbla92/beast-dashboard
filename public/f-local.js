'use strict';
window.LOCAL = (() => {
  const DB = 'bd-local', STORE = 'kv', MAX_BYTES = 1048576;
  const st = { opening: null, stopped: false };

  const open = () => {
    if (st.opening) return st.opening;
    st.opening = new Promise(resolve => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
        r.onsuccess = () => {
          const db = r.result;
          db.onversionchange = () => { st.stopped = true; db.close(); st.opening = null; };
          db.onclose = () => { st.opening = null; };
          resolve(db);
        };
        r.onerror = r.onblocked = () => { st.opening = null; resolve(null); };
      } catch { st.opening = null; resolve(null); }
    });
    return st.opening;
  };

  const run = (mode, fn) => (st.stopped ? Promise.resolve(undefined) : open()).then(db => new Promise(resolve => {
    if (!db) return resolve(undefined);
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  }));

  const del = key => run('readwrite', s => s.delete(key)).then(() => undefined);

  const read = key => run('readonly', s => s.get(key)).then(rec => {
    if (rec === undefined) return null;
    if (!rec || rec.f !== 1) { del(key); return null; }
    return rec;
  });

  const keys = () => run('readonly', s => s.getAllKeys()).then(k => Array.isArray(k) ? k : []);

  const capped = (p, ms) => ms ? Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]) : p;

  const get = (key, capMs) => capped(read(key), capMs);

  const toJson = d => { try { return JSON.stringify(d); } catch { return undefined; } };

  const put = (key, data, ver) => {
    if (st.stopped) return Promise.resolve(false);
    const json = toJson(data);
    if (json === undefined || json.length > MAX_BYTES) return Promise.resolve(false);
    return run('readwrite', s => s.put({ f: 1, at: Date.now(), ver: ver || null, data }, key)).then(r => r !== undefined);
  };

  const stop = () => { st.stopped = true; if (st.opening) st.opening.then(db => { if (db) db.close(); }); st.opening = null; };

  return { get, put, del, keys, stop, MAX_BYTES };
})();
