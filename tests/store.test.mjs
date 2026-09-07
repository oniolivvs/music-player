import test from "node:test";
import assert from "node:assert/strict";

async function importNativeStore(invoke) {
  const previousWindow = globalThis.window;
  globalThis.window = { __TAURI__: { core: { invoke } } };
  const module = await import(`../src/store.js?store-order-test=${crypto.randomUUID()}`);
  return { module, restore: () => { globalThis.window = previousWindow; } };
}

function controlledInvoke() {
  const calls = [];
  return {
    calls,
    invoke(command, payload) {
      return new Promise((resolve, reject) => calls.push({ command, payload, resolve, reject }));
    },
  };
}

test("native saves for one key finish in invocation order", async () => {
  const native = controlledInvoke();
  const { module: { storeSave }, restore } = await importNativeStore(native.invoke);
  try {
    const first = storeSave("playback", "old");
    const second = storeSave("playback", "new");
    await Promise.resolve();
    assert.equal(native.calls.length, 1);
    assert.equal(native.calls[0].payload.data, "old");
    native.calls[0].resolve();
    await first;
    await Promise.resolve();
    assert.equal(native.calls.length, 2);
    assert.equal(native.calls[1].payload.data, "new");
    native.calls[1].resolve();
    await second;
  } finally { restore(); }
});

test("native saves for different keys remain concurrent", async () => {
  const native = controlledInvoke();
  const { module: { storeSave }, restore } = await importNativeStore(native.invoke);
  try {
    const playback = storeSave("playback", "state");
    const queue = storeSave("playbackq", "queue");
    await Promise.resolve();
    assert.equal(native.calls.length, 2);
    native.calls.forEach(call => call.resolve());
    await Promise.all([playback, queue]);
  } finally { restore(); }
});

test("a failed save does not block the next save for that key", async () => {
  const native = controlledInvoke();
  const { module: { storeSave }, restore } = await importNativeStore(native.invoke);
  try {
    const first = storeSave("dlqueue", "stale");
    const second = storeSave("dlqueue", "");
    await Promise.resolve();
    native.calls[0].reject(new Error("disk full"));
    await assert.rejects(first, /disk full/);
    await Promise.resolve();
    assert.equal(native.calls.length, 2);
    native.calls[1].resolve();
    await second;
  } finally { restore(); }
});

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
