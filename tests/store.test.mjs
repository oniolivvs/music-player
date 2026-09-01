import test from "node:test";
import assert from "node:assert/strict";

test("native storeSave propagates a persistence failure to cleanup callers", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async () => { throw new Error("disk full"); },
      },
    },
  };
  try {
    const { storeSave } = await import(`../src/store.js?store-save-test=${Date.now()}`);
    await assert.rejects(storeSave("cleanup", "{}"), /disk full/);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("playlist cleanup can await and receive a native persistence failure", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async () => { throw new Error("disk full"); },
      },
    },
  };
  try {
    const playlists = await import(`../src/playlists.js?playlist-save-test=${Date.now()}`);
    await assert.rejects(playlists.persist({ strict: true }), /disk full/);
  } finally {
    globalThis.window = previousWindow;
  }
});
