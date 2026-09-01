import test from "node:test";
import assert from "node:assert/strict";

let libraryActions = {};
try {
  libraryActions = await import("../src/library-actions.mjs");
} catch {}

test("library actions keep blocked deletion fifth with a stable label", () => {
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
    label: "Delete blocked tracks",
    handler: "deleteBlocked",
    cleanup: true,
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
  let guardedAction = null;

  libraryActions.bindLibraryActions(find, actions, {
    refresh() {},
    addUrl() {},
    download() {},
    cleanDuplicates() {},
    deleteBlocked,
  }, action => { guardedAction = action; });

  listeners.get("#libDeleteBlockedBtn:click")();
  assert.equal(guardedAction, deleteBlocked);
});

test("blocked cleanup stays visible at zero and renders as a guarded action", () => {
  assert.equal(typeof libraryActions.renderLibraryActions, "function", "library action renderer must exist");
  const actions = libraryActions.buildLibraryActions({ downloadableCount: 0, blockedCount: 0 });
  assert.equal(actions.length, 5);
  assert.equal(actions.at(-1).label, "Delete blocked tracks");

  const markup = libraryActions.renderLibraryActions(
    actions,
    icon => `<svg data-icon="${icon}"></svg>`,
    value => String(value),
  );
  assert.match(markup, /id="libDeleteBlockedBtn"[^>]*data-cleanup-action/);
  assert.match(markup, /data-icon="trash"/);
  assert.match(markup, /> Delete blocked tracks<\/button>/);
});
