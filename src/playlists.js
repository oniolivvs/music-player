// Playlist store, persisted as JSON via the generic store ("playlists").
// A synchronous in-memory cache backs getPlaylists(); mutations update it and
// fire-and-forget a save. Call initPlaylists() once at startup before rendering.

import { storeLoad, storeSave } from "./store.js";

let _cache = [];
let _loaded = false;

function _persist() { storeSave("playlists", JSON.stringify(_cache)); }

export async function initPlaylists() {
  if (_loaded) return;
  const raw = await storeLoad("playlists");
  if (raw) { try { _cache = JSON.parse(raw); } catch {} }
  if (!Array.isArray(_cache)) _cache = [];
  _loaded = true;
}

export function getPlaylists() { return _cache; }
// Persist after a direct mutation of the array returned by getPlaylists()
// (used by cloud-sync merge, which appends/edits in place).
export function persist() { _persist(); }

export function createPlaylist(name) {
  const pl = { id: crypto.randomUUID(), name: (name || "").trim() || "New playlist", paths: [] };
  _cache.push(pl);
  _persist();
  return pl;
}

export function deletePlaylist(id) { _cache = _cache.filter(p => p.id !== id); _persist(); }

export function renamePlaylist(id, name) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.name = (name || "").trim() || pl.name; _persist(); }
}

// Remember where an imported playlist came from (enables follow-after-import).
export function setSourceUrl(id, url) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.sourceUrl = url; _persist(); }
}

// Custom cover image for a playlist (absolute local path, or "" to clear and
// fall back to the auto mosaic from the first tracks' artwork).
export function setImage(id, path) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { if (path) pl.image = path; else delete pl.image; _persist(); }
}

// allowDup: push even if the path is already present (creates a duplicate entry).
export function addToPlaylist(id, path, allowDup = false) {
  const pl = _cache.find(p => p.id === id);
  if (pl && (allowDup || !pl.paths.includes(path))) { pl.paths.push(path); _persist(); }
}

// How many of `paths` are already in the playlist (for the duplicate prompt).
export function countExisting(id, paths) {
  const pl = _cache.find(p => p.id === id);
  if (!pl) return 0;
  const set = new Set(pl.paths);
  return paths.filter(p => set.has(p)).length;
}

export function removeFromPlaylist(id, path) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.paths = pl.paths.filter(p => p !== path); _persist(); }
}

// Swap a path in every playlist (e.g. online "yt:<id>" → downloaded local file).
export function replacePath(oldPath, newPath) {
  for (const pl of _cache) {
    const i = pl.paths.indexOf(oldPath);
    if (i < 0) continue;
    if (pl.paths.includes(newPath)) pl.paths.splice(i, 1);
    else pl.paths[i] = newPath;
  }
  _persist();
}

// Bulk path-prefix rewrite (source folder canonicalized/renamed): one pass over
// every playlist, entries that collide after the rewrite are dropped.
export function rewritePrefix(oldPrefix, newPrefix) {
  if (!oldPrefix || oldPrefix === newPrefix) return 0;
  const oldDir = oldPrefix.endsWith("/") ? oldPrefix : oldPrefix + "/";
  let changed = 0;
  for (const pl of _cache) {
    const seen = new Set();
    const out = [];
    for (const p of pl.paths) {
      let np = p;
      if (p === oldPrefix || p.startsWith(oldDir)) { np = newPrefix + p.slice(oldPrefix.length); changed++; }
      if (!seen.has(np)) { seen.add(np); out.push(np); }
    }
    pl.paths = out;
  }
  if (changed) _persist();
  return changed;
}

// Bulk path replacement (startup migration): map of oldPath → newPath applied
// in one pass over every playlist, one persist, collisions de-duplicated.
export function replaceMany(map) {
  if (!map || !map.size) return 0;
  let changed = 0;
  for (const pl of _cache) {
    const seen = new Set();
    const out = [];
    for (const p of pl.paths) {
      const np = map.get(p) || p;
      if (np !== p) changed++;
      if (!seen.has(np)) { seen.add(np); out.push(np); }
    }
    pl.paths = out;
  }
  if (changed) _persist();
  return changed;
}

export function reorderPlaylist(id, fromIdx, toIdx) {
  const pl = _cache.find(p => p.id === id);
  if (!pl) return;
  const [moved] = pl.paths.splice(fromIdx, 1);
  if (moved === undefined) return;
  pl.paths.splice(toIdx, 0, moved);
  _persist();
}
