const VIDEO_TAG = /\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/i;
const fileNameOf = path => String(path).split(/[\\/]/).pop();

// Where a dead playlist path points now: the library file with the same "[videoId]"
// tag, or else the same file name. A name shared by several files proves nothing
// ("01 Intro.mp3" exists in many albums), so those paths stay dead rather than
// silently and permanently become another song.
export function createRelinker(libraryPaths, deadPaths) {
  const byVideo = new Map(), byName = new Map(), deadNames = new Map();
  for (const path of libraryPaths) {
    const tag = String(path).match(VIDEO_TAG);
    if (tag && !byVideo.has(tag[1])) byVideo.set(tag[1], path);
    const name = fileNameOf(path);
    byName.set(name, byName.has(name) ? null : path);
  }
  for (const path of deadPaths) {
    const name = fileNameOf(path);
    deadNames.set(name, (deadNames.get(name) || 0) + 1);
  }
  return deadPath => {
    const tag = String(deadPath).match(VIDEO_TAG);
    if (tag && byVideo.has(tag[1])) return byVideo.get(tag[1]);
    const name = fileNameOf(deadPath);
    return deadNames.get(name) === 1 ? byName.get(name) || null : null;
  };
}

// The same five actions head the library and every playlist; in a playlist they
// act on that playlist only.
export function buildLibraryActions({ downloadableCount = 0, scope = "library" } = {}) {
  const playlist = scope === "playlist";
  const id = name => (playlist ? "pl" : "lib") + name;
  return [
    {
      id: id("RefreshBtn"),
      title: playlist ? "Refresh the titles and covers of this playlist" : "Refresh titles, covers, and icons",
      icon: "refresh",
      label: "Refresh",
      handler: "refresh",
    },
    {
      id: id("UrlBtn"),
      title: playlist ? "Add one YouTube video to this playlist" : "Import one YouTube video",
      icon: "link",
      label: "Import video",
      handler: "addUrl",
    },
    {
      id: id("DlBtn"),
      title: downloadableCount
        ? ""
        : "Nothing left to download — everything is local or already known unavailable",
      icon: "save",
      label: `Save locally${downloadableCount ? ` (${downloadableCount} mp3)` : ""}`,
      handler: "download",
    },
    {
      id: id("DupsBtn"),
      title: playlist ? "Check and remove duplicate songs in this playlist" : "Check and remove duplicate songs",
      icon: "filter",
      label: "Clean duplicates",
      handler: "cleanDuplicates",
    },
    {
      id: id("DeleteBlockedBtn"),
      title: playlist ? "Delete the blocked tracks of this playlist permanently" : "Delete blocked tracks permanently",
      icon: "trash",
      label: "Delete blocked tracks",
      handler: "deleteBlocked",
      cleanup: true,
    },
  ];
}

// The label doubles as the tooltip: when the row only has room for icons, the
// tooltip is all that names the button.
export function renderLibraryActions(actions, renderIcon, escapeHtml) {
  return actions.map(action => `<button id="${escapeHtml(action.id)}" class="btn-line sm" title="${escapeHtml(action.title || action.label)}"${action.cleanup ? " data-cleanup-action" : ""}>${renderIcon(action.icon)} ${escapeHtml(action.label)}</button>`).join("");
}

export function bindLibraryActions(find, actions, handlers, runCleanup) {
  for (const action of actions) {
    const handler = handlers[action.handler];
    if (typeof handler !== "function") continue;
    if (action.cleanup && typeof runCleanup !== "function") continue;
    const listener = action.cleanup ? () => runCleanup(handler) : handler;
    find(`#${action.id}`)?.addEventListener("click", listener);
  }
}
