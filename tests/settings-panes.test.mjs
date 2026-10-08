import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The 2026-09-15 settings restructure dropped the Playback, YouTube and
// Library tab buttons while their panes stayed: ~30 settings became
// unreachable ghosts (removed 2026-10-08). Every pane needs a tab, and every
// tab a pane.
test("every settings pane has a tab and every tab opens a pane", async () => {
  const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  const tabs = new Set([...main.matchAll(/class="set-tab[^"]*" data-tab="([a-z]+)"/g)].map(match => match[1]));
  const panes = new Set([...main.matchAll(/class="set-pane[^"]*" data-pane="([a-z]+)"/g)].map(match => match[1]));
  assert.ok(panes.size >= 8, "settings panes were not found");
  assert.deepEqual([...panes].filter(pane => !tabs.has(pane)), []);
  assert.deepEqual([...tabs].filter(tab => !panes.has(tab)), []);
});
