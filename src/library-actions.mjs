export function buildLibraryActions({ downloadableCount = 0, blockedCount = 0 } = {}) {
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
      label: `Delete blocked tracks${blockedCount ? ` (${blockedCount})` : ""}`,
      handler: "deleteBlocked",
    },
  ];
}

export function bindLibraryActions(find, actions, handlers) {
  for (const action of actions) {
    const handler = handlers[action.handler];
    if (typeof handler !== "function") continue;
    find(`#${action.id}`)?.addEventListener("click", handler);
  }
}
