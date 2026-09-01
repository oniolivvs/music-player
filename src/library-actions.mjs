export function buildLibraryActions({ downloadableCount = 0 } = {}) {
  return [
    {
      id: "libRefreshBtn",
      title: "Refresh titles, covers, and icons",
      icon: "refresh",
      label: "Refresh",
      handler: "refresh",
    },
    {
      id: "libUrlBtn",
      title: "Add a YouTube video or playlist by URL",
      icon: "link",
      label: "Add from URL",
      handler: "addUrl",
    },
    {
      id: "libDlBtn",
      title: downloadableCount
        ? ""
        : "Nothing left to download — everything is local or already known unavailable",
      icon: "save",
      label: `Save locally${downloadableCount ? ` (${downloadableCount} mp3)` : ""}`,
      handler: "download",
    },
    {
      id: "libDupsBtn",
      title: "Check and remove duplicate songs",
      icon: "filter",
      label: "Clean duplicates",
      handler: "cleanDuplicates",
    },
    {
      id: "libDeleteBlockedBtn",
      title: "Delete blocked tracks permanently",
      icon: "trash",
      label: "Delete blocked tracks",
      handler: "deleteBlocked",
      cleanup: true,
    },
  ];
}

export function renderLibraryActions(actions, renderIcon, escapeHtml) {
  return actions.map(action => `<button id="${escapeHtml(action.id)}" class="btn-line sm"${action.title ? ` title="${escapeHtml(action.title)}"` : ""}${action.cleanup ? " data-cleanup-action" : ""}>${renderIcon(action.icon)} ${escapeHtml(action.label)}</button>`).join("");
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
