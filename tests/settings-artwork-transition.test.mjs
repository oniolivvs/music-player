import test from "node:test";
import assert from "node:assert/strict";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("artwork transition duration defaults to 500 ms and clamps persisted values", async () => {
  globalThis.window = { __TAURI__: null };
  globalThis.localStorage = storage({ "mp.settings": JSON.stringify({ artworkTransitionMs: 9001 }) });
  const settings = await import(`../src/settings.js?transition=${Date.now()}`);

  assert.equal(typeof settings.normalizeArtworkTransitionMs, "function");
  assert.equal(settings.normalizeArtworkTransitionMs(-1), 0);
  assert.equal(settings.normalizeArtworkTransitionMs(750), 750);
  assert.equal(settings.normalizeArtworkTransitionMs(9001), 5000);

  await settings.loadSettings();
  assert.equal(settings.getSettings().artworkTransitionMs, 5000);
  settings.resetSettings();
  assert.equal(settings.getSettings().artworkTransitionMs, 500);
});
