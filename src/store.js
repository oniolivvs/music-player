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

export async function storeSave(key, data) {
  if (IS_NATIVE) {
    try { await T.core.invoke("store_save", { key, data }); }
    catch (e) { console.error(`[store] save ${key}:`, e); }
  } else {
    localStorage.setItem("mp." + key, data);
  }
}
