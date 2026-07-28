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

export async function storeSave(key, data) {
  if (IS_NATIVE) {
    try { await T.core.invoke("store_save", { key, data }); }
    catch (e) { console.error(`[store] save ${key}:`, e); }
  } else {
    localStorage.setItem("mp." + key, data);
  }
}
