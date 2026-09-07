// Generic persisted key/value store (JSON strings), backed by the Rust `store_*`
// commands (files in the app data dir). Falls back to localStorage in a browser.

const T = window.__TAURI__;
const IS_NATIVE = !!(T && T.core && typeof T.core.invoke === "function");

export async function storeLoad(key) {
  if (IS_NATIVE) {
    try { return await T.core.invoke("store_load", { key }); }
    catch (e) { console.error(`[store] load ${key}:`, e); return ""; }
  }
  return localStorage.getItem("mp." + key) || "";
}

// Same read, but a FAILURE PROPAGATES instead of looking like an empty store.
// For anything whose emptiness is destructive: coming up with an empty library
// makes the app rebuild one from the playlists' yt: paths and save that over the
// real file. Callers that can lose data must use this and refuse to save when it
// throws; callers with a harmless default can keep using storeLoad.
export async function storeLoadStrict(key) {
  if (IS_NATIVE) return await T.core.invoke("store_load", { key });
  return localStorage.getItem("mp." + key) || "";
}

const saveTails = new Map();

async function rawStoreSave(key, data) {
  if (IS_NATIVE) return await T.core.invoke("store_save", { key, data });
  localStorage.setItem("mp." + key, data);
}

// Native writes are atomic individually, but callers intentionally do not await
// most UI saves. Keep invocation order per key so a slow old snapshot can never
// rename over the newer playback/download state. Unrelated keys stay parallel.
export function storeSave(key, data) {
  const previous = saveTails.get(key);
  const write = previous
    ? previous.catch(() => {}).then(() => rawStoreSave(key, data))
    : rawStoreSave(key, data);
  saveTails.set(key, write);
  return write.finally(() => {
    if (saveTails.get(key) === write) saveTails.delete(key);
  });
}

// Ordinary UI preferences remain best-effort. Cleanup uses storeSave directly
// so it can stop and report a failed persistence operation to the user.
export function storeSaveQuietly(key, data) {
  return storeSave(key, data).catch(error => {
    console.error(`[store] save ${key}:`, error);
  });
}
