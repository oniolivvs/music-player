import test from "node:test";
import assert from "node:assert/strict";

let libraryActions = {};
try {
  libraryActions = await import("../src/library-actions.mjs");
} catch {}

test("library actions keep blocked deletion fifth and expose its count", () => {
  assert.equal(typeof libraryActions.buildLibraryActions, "function", "library action builder must exist");
  const actions = libraryActions.buildLibraryActions({ downloadableCount: 3, blockedCount: 7 });
  assert.deepEqual(actions.map(action => action.id), [
    "libRefreshBtn",
    "libUrlBtn",
    "libDlBtn",
    "libDupsBtn",
    "libDeleteBlockedBtn",
  ]);
  assert.deepEqual(actions.at(-1), {
    id: "libDeleteBlockedBtn",
    title: "Delete blocked tracks permanently",
    icon: "trash",
    label: "Delete blocked tracks (7)",
    handler: "deleteBlocked",
  });
});

test("library actions bind blocked deletion to the existing cleanup handler", () => {
  assert.equal(typeof libraryActions.bindLibraryActions, "function", "library action binder must exist");
  const actions = libraryActions.buildLibraryActions({ blockedCount: 1 });
  const listeners = new Map();
  const find = selector => ({
    addEventListener(type, handler) {
      listeners.set(`${selector}:${type}`, handler);
    },
  });
  const deleteBlocked = () => {};

  libraryActions.bindLibraryActions(find, actions, {
    refresh() {},
    addUrl() {},
    download() {},
    cleanDuplicates() {},
    deleteBlocked,
  });

  assert.equal(listeners.get("#libDeleteBlockedBtn:click"), deleteBlocked);
});
